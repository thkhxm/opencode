/**
 * PunkcodeAI 桌面端登录态（仅内存 + refresh token 本地持久化）。
 *
 * 设计要点（与 §M5/§M6 规范对齐）：
 *   1. access_token / 用户信息 / **sk- API Key** / 模型列表**只在内存**保存；
 *      进程重启即丢，必须用 refresh_token 重新拉。
 *   2. refresh_token + accountID 持久化到 localStorage（renderer 端唯一可靠的持久化通道）。
 *      （opencode 原生 SQLite AccountTable 在 sidecar 进程里，renderer 不能直接访问；
 *      M5 阶段先用 localStorage 兜底——M6/M7 若需要把"已登录"信息暴露给 sidecar，再开 IPC）。
 *   3. 主动 refresh：access_token 过期前 `expires_in / 2` 触发一次刷新；
 *      失败立即 logout，引导用户重新登录。
 *   4. 不暴露 access_token / refresh_token / sk- key 给上层组件，只提供 isLoggedIn / state / signIn / signOut。
 *      sk- 仅通过 IPC `setPunkcodeCredentials` 透传给主进程 → sidecar 用于 LLM 调用；
 *      sidecar 内部存在内存，从不落盘。
 *   5. 调用 sub2api `/api/v1/cli/{register,login,refresh,api-key,llm}` 直接走 fetch；不依赖 opencode sidecar。
 *      （opencode `Account.Service` 的 credentials flow 也走同样的 endpoint，sidecar 端的实现
 *      仅在 CLI 路径上使用——见 packages/opencode/src/account/credentials.ts。）
 *
 * M6 新增字段（apiKey / models / *BaseUrl）的生命周期：
 *   - signIn / signUp / bootstrap 成功 → 拉 /cli/api-key + /cli/llm → 进 store + 推 sidecar
 *   - refresh 成功 → 不重拉 sk-（sub2api 端 sk- 无过期；access_token refresh 只是续期会话）；
 *     但需要确保 sk- 已经在 sidecar 里（启动后第一次 refresh 触发的）
 *   - signOut / refresh 失败 → 清掉 store + 通知 sidecar 清掉
 */

import { createMemo, createSignal } from "solid-js"
import { DEFAULT_API_BASE_URL } from "@/branding"

/** sub2api envelope: `{ code, message, data }` */
interface CredentialsEnvelope<T> {
  code: number
  message: string
  data: T
}

interface CredentialsUser {
  id: number
  email: string
  nickname: string
  balance_usd: number
}

/**
 * `/api/v1/cli/me` 返回的实时用户信息（M7）。
 *
 * 含余额 + 今日/本月用量。30s 轮询 + chat stream 结束钩子调用此接口刷新右上角 balance widget。
 */
interface CliMeResponse {
  id: number
  email: string
  nickname: string
  balance_usd: number
  used_today_usd: number
  used_month_usd: number
}

/**
 * `/api/v1/cli/balance-requests` 申请条目（M7）。
 *
 * status 三态：pending / approved / rejected。
 * rejected 时 admin 可填 `reject_reason` 给用户看。
 */
export type BalanceRequestStatus = "pending" | "approved" | "rejected"

export interface BalanceRequest {
  id: number
  user_id?: number
  amount_usd: number
  note?: string
  status: BalanceRequestStatus
  created_at?: string
  updated_at?: string
  approved_at?: string
  rejected_at?: string
  reject_reason?: string
  admin_note?: string
}

interface CredentialsAuthResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  user: CredentialsUser
}

interface CredentialsTokenPair {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

/** sub2api `/cli/llm` 返回的 model 元数据（PunkcodeAI 真实可用模型列表） */
export type PunkcodeModel = {
  id: string
  name: string
  provider?: string
  context_window?: number
}

/**
 * 登录后的内存态。
 *
 * - `expiry` 是 epoch ms（`Date.now()` 同维度）
 * - `accountID` 与 opencode Account 服务一致：`${url}:${email}`
 *   （详见 packages/opencode/src/account/credentials.ts:buildAccountID）
 * - `apiKey` / `models` / `*BaseUrl` 是 M6 新增；只在内存，绝不入 localStorage。
 *   sk- 一旦丢失，下一次 access_token refresh 不会重新拉；需要手动 signIn 才补回来。
 *   （考虑到 sub2api 端 sk- 无过期，且 refresh 后我们也会重新调一次 syncCredentials，
 *   这个边界条件不会在正常路径出现。）
 */
export type AuthState = {
  server: string
  accountID: string
  accessToken: string
  refreshToken: string
  expiry: number
  user: {
    id: number
    email: string
    nickname: string
    balanceUsd: number
    /** 今日已用（USD）。M7 新增，从 `/cli/me` 实时拉取；未拉到时为 0。 */
    usedTodayUsd: number
    /** 本月已用（USD）。M7 新增，从 `/cli/me` 实时拉取；未拉到时为 0。 */
    usedMonthUsd: number
  }
  apiKey: string
  llmBaseUrl: string
  anthropicBaseUrl: string
  geminiBaseUrl: string
  models: PunkcodeModel[]
}

/** sub2api 业务错误（envelope.code !== 0） */
export class CredentialsError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = "CredentialsError"
    this.code = code
  }
}

/** 网络 / 解码 / 5xx 等传输层错误 */
export class AccountError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = "AccountError"
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause
  }
}

const LOCAL_STORAGE_KEY = "punkcodeai.auth.session"

type PersistedSession = {
  server: string
  accountID: string
  refreshToken: string
}

const readPersisted = (): PersistedSession | null => {
  if (typeof localStorage === "undefined") return null
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedSession>
    if (
      typeof parsed.server === "string" &&
      typeof parsed.accountID === "string" &&
      typeof parsed.refreshToken === "string"
    ) {
      return { server: parsed.server, accountID: parsed.accountID, refreshToken: parsed.refreshToken }
    }
    return null
  } catch {
    return null
  }
}

const writePersisted = (value: PersistedSession | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value === null) {
      localStorage.removeItem(LOCAL_STORAGE_KEY)
      return
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // 忽略 quota / 隐私模式异常
  }
}

const normalizeServer = (url: string) => url.replace(/\/+$/, "")

/** 拼 `${url}:${email}` 与 sub2api credentials flow 一致 */
const buildAccountID = (server: string, email: string) => `${normalizeServer(server)}:${email}`

// ============================================================
// 网络容错：超时 + 有限退避重试
// ============================================================
//
// 桌面端启动慢的根因之一：renderer 的鉴权 bootstrap 链对生产后端
// (punkcodeai.myverse.site) 的请求全是裸 fetch、无超时——后端慢/网络抖动时
// 这些请求会无限挂起，把启动 splash 一直 gate 住。
//
// 这里给所有鉴权类 fetch 统一加：
//   1. AbortSignal.timeout(REQUEST_TIMEOUT_MS) —— 单次请求超时即 abort，不再无限等。
//   2. 有限退避重试（默认 2 次额外重试）—— 仅对「瞬时网络错误」重试，
//      业务错（envelope.code !== 0 → CredentialsError）不重试（重试也没用，且可能加重负担）。

/** 单次请求超时（ms）。生产后端慢时 8s 即放弃本次，交给重试/降级。 */
const REQUEST_TIMEOUT_MS = 8000
/** 额外重试次数（首次失败后再试 N 次）。 */
const REQUEST_RETRIES = 2
/** 重试退避基数（ms）：第 k 次重试前等 BASE * 2^(k-1)，上限 maxDelay。 */
const RETRY_BASE_DELAY_MS = 400
const RETRY_MAX_DELAY_MS = 2000

/** 是否瞬时网络错误（值得重试）。业务错 CredentialsError 不在此列。 */
function isRetriableError(error: unknown): boolean {
  if (error instanceof CredentialsError) return false
  if (error instanceof AccountError) return true
  if (error instanceof DOMException) {
    // AbortError（超时）/ TimeoutError 都值得换一次重试。
    return error.name === "AbortError" || error.name === "TimeoutError"
  }
  return true
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 带超时的 fetch。在 caller 传入的 init 上挂 AbortSignal.timeout(REQUEST_TIMEOUT_MS)。
 *
 * 注意：AbortSignal.timeout 触发时 fetch reject 一个 name="TimeoutError" 的 DOMException，
 * 被下面的 retry 包装识别为可重试。
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}

/**
 * 有限退避重试包装。仅对瞬时错误（见 isRetriableError）重试；业务错直接抛。
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === REQUEST_RETRIES || !isRetriableError(error)) throw error
      const wait = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS)
      await sleep(wait)
    }
  }
  throw lastError
}

/**
 * 调 sub2api 某个 endpoint，先解 envelope，再按 data schema 取出业务数据。
 *
 * - HTTP 错误（network / 非 JSON）→ AccountError
 * - HTTP 200 但 envelope.code !== 0 → CredentialsError
 */
async function callApi<T>(url: string, body: unknown, label: string): Promise<T> {
  return withRetry(async () => {
    let response: Response
    try {
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      throw new AccountError(`${label}: HTTP request failed`, { cause })
    }

    let envelope: CredentialsEnvelope<unknown>
    try {
      envelope = (await response.json()) as CredentialsEnvelope<unknown>
    } catch (cause) {
      throw new AccountError(`${label}: failed to decode envelope`, { cause })
    }

    if (typeof envelope.code !== "number" || typeof envelope.message !== "string") {
      throw new AccountError(`${label}: malformed envelope`)
    }

    if (envelope.code !== 0) {
      throw new CredentialsError(envelope.code, envelope.message)
    }

    return envelope.data as T
  })
}

/**
 * 调 sub2api 鉴权后的 GET endpoint（带 Bearer token + envelope 解码）。
 * 与 callApi 共用 envelope/错误约定，但走 GET。
 */
async function callAuthorizedGet<T>(url: string, accessToken: string, label: string): Promise<T> {
  return withRetry(async () => {
    let response: Response
    try {
      response = await fetchWithTimeout(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      })
    } catch (cause) {
      throw new AccountError(`${label}: HTTP request failed`, { cause })
    }

    let envelope: CredentialsEnvelope<unknown>
    try {
      envelope = (await response.json()) as CredentialsEnvelope<unknown>
    } catch (cause) {
      throw new AccountError(`${label}: failed to decode envelope`, { cause })
    }

    if (typeof envelope.code !== "number" || typeof envelope.message !== "string") {
      throw new AccountError(`${label}: malformed envelope`)
    }
    if (envelope.code !== 0) {
      throw new CredentialsError(envelope.code, envelope.message)
    }
    return envelope.data as T
  })
}

// ============================================================
// store
// ============================================================

const [state, setState] = createSignal<AuthState | null>(null)
const isLoggedIn = createMemo(() => state() !== null)

/**
 * bootstrap 是否仍在进行中。
 *
 * 初始值 true：模块加载完到 `ensureBootstrap()` 第一次跑完之前，
 * UI 应当渲染 splash 而不是把用户直接踢去 /login（M5 P2 修复，详见 AuthGate）。
 *
 * 当 localStorage 里没有 refresh_token 或 bootstrap 出错时也会被置为 false。
 */
const [bootstrapping, setBootstrapping] = createSignal(true)

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let bootstrapped = false

const clearRefreshTimer = () => {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

const scheduleRefresh = (current: AuthState) => {
  clearRefreshTimer()
  const now = Date.now()
  const ttl = Math.max(current.expiry - now, 0)
  // 在剩余有效期一半时主动刷新，最少 30s 后才触发（避免抖动）。
  const delay = Math.max(Math.floor(ttl / 2), 30 * 1000)
  refreshTimer = setTimeout(() => {
    void backgroundRefresh()
  }, delay)
}

const applySession = (next: AuthState, options?: { persist?: boolean }) => {
  setState(next)
  if (options?.persist !== false) {
    writePersisted({
      server: next.server,
      accountID: next.accountID,
      refreshToken: next.refreshToken,
    })
  }
  scheduleRefresh(next)

  // M9（session 按账号隔离 / #5 假列表修复）：
  //   renderer 进程的 server-sync / session 列表内存态是在「sidecar 切到本账号隔离 db 之前」
  //   就对着【默认/上一账号 db】bootstrap 出来的。账号确定（sidecar 已 respawn 到本账号 db）后，
  //   必须让 renderer 基于【当前 db】重新同步，否则会出现 #5："列表里有一堆旧会话，点开却是空"
  //   ——列表是切 db 前残留的内存态，session.messages 打到的是切 db 后的空 db。
  //
  //   修法：整窗 reload。reload 后 ensureBootstrap 重跑，server-sync 对着（已是本账号 db 的）
  //   sidecar 重新 bootstrap + session.list，拿到的就是本账号 db 的真实会话（admin 隔离 db 为空 → 列表为空，诚实）。
  //   局部 invalidate 容易漏 children store / sdk cache / query cache / prefetch，reload 是零残留的可靠做法。
  //
  //   防无限 reload（最高优先级）：用 sessionStorage 记「当前 renderer DOM 实例已为哪个 accountID 同步过」。
  //   sessionStorage 跨 `location.reload()` 存活、随窗口销毁而清空——正好满足：
  //     - reload 前把 marker 写成 next.accountID；reload 后 bootstrapInner 重跑 applySession 时
  //       读到 marker === next.accountID → 判定「本实例已为该账号同步」→ 不再 reload（终止循环）。
  //     - 整 app 重启（窗口销毁）→ sessionStorage 清空 → 下次冷启动会为账号 reload 一次（预期：要把
  //       默认 db 上 bootstrap 的内存态换成账号 db 的）。
  //   登录态不丢：reload 前 writePersisted 已落 refresh_token，reload 后 bootstrapInner 用它自动恢复登录态。
  const synced = getSyncedAccountID()
  if (synced !== next.accountID) {
    // P2 熔断：sessionStorage 若持续抛错，marker 永远读不到 → 同一账号每次 reload 后又 reload
    //（死循环白屏）。用 localStorage（bootstrap 已依赖、可靠）记上次 reload 的 {账号, 时刻}：
    // 同账号 5s 内已 reload 过仍要再 reload，判定为该死循环 → 熔断（只设内存态不 reload，
    // 接受内存列表残留也好过白屏死循环）。正常切账号是不同账号，不会误熔断。
    if (reloadTooRecent(next.accountID)) {
      renderedAccountID = next.accountID
      return
    }
    // DOM 当前同步的账号 ≠ 目标账号（含冷启动 marker 缺失：DOM 是对着默认 db bootstrap 的）→ reload 一次。
    markReloadNow(next.accountID)
    setSyncedAccountID(next.accountID)
    renderedAccountID = next.accountID
    reloadRenderer()
    return
  }
  renderedAccountID = next.accountID
}

const clearSession = () => {
  clearRefreshTimer()
  setState(null)
  writePersisted(null)
}

/**
 * M9（session 按账号隔离）：当前 renderer 内存里 server-sync / session 列表所反映的账号。
 *
 * - 切换账号时（accountID 变了）sidecar 会重启到另一账号的隔离 db，
 *   但 renderer 进程不重启——它还揣着上一账号的 session/project 内存缓存。
 * - 用 `location.reload()` 把整个 renderer 重置：reload 后 ensureBootstrap 重跑，
 *   server-sync 重新对着（已切换到新账号 db 的）sidecar bootstrap，拿到新账号自己的 session 列表，
 *   彻底杜绝"看到上一账号会话"。这是最可靠、零残留的做法（局部 invalidate 容易漏 children store / sdk cache）。
 *
 * 注意：本变量是模块级，`location.reload()` 后会重置为 null；真正跨 reload 存活的「已同步账号」
 * 记号在 sessionStorage（见 getSyncedAccountID / setSyncedAccountID），用于防无限 reload。
 */
let renderedAccountID: string | null = null

/**
 * 跨 `location.reload()` 存活的「当前 renderer DOM 实例已为哪个 accountID 同步过」记号。
 *
 * - 存 sessionStorage：跨 reload 存活、随窗口销毁清空，正好契合「reload 一次后不再 reload」的语义。
 * - 用途：applySession 据此判断「DOM 是否已对着本账号 db bootstrap 过」，是防无限 reload 的关键。
 */
const SYNCED_ACCOUNT_KEY = "punkcodeai.synced.accountID"

function getSyncedAccountID(): string | null {
  if (typeof sessionStorage === "undefined") return renderedAccountID
  try {
    return sessionStorage.getItem(SYNCED_ACCOUNT_KEY)
  } catch {
    // 隐私模式 / quota：退回到模块级内存值（同一 DOM 实例内仍能防住「同一账号反复 reload」）。
    return renderedAccountID
  }
}

function setSyncedAccountID(accountID: string | null): void {
  if (typeof sessionStorage === "undefined") return
  try {
    if (accountID === null) {
      sessionStorage.removeItem(SYNCED_ACCOUNT_KEY)
      return
    }
    sessionStorage.setItem(SYNCED_ACCOUNT_KEY, accountID)
  } catch {
    // 隐私模式 / quota：忽略；模块级 renderedAccountID 仍兜底同一 DOM 实例内的防抖。
  }
}

/**
 * 防 reload 死循环的熔断（P2 加固）：localStorage 记上次 reload 的 {账号, 时刻}。
 * 若 sessionStorage marker 持续不可用，会出现同一账号反复 reload；这里据 localStorage
 * 判断「同账号 5s 内刚 reload 过」→ 熔断跳过本次 reload。正常切账号是不同账号、不误伤。
 * 用 localStorage 而非 sessionStorage：bootstrap 已依赖 localStorage 且它在本场景下可靠。
 */
const RELOAD_GUARD_KEY = "punkcodeai.lastReload"
const RELOAD_GUARD_WINDOW_MS = 5000

function reloadTooRecent(accountID: string): boolean {
  if (typeof localStorage === "undefined") return false
  try {
    const raw = localStorage.getItem(RELOAD_GUARD_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { id?: string; at?: number }
    return parsed.id === accountID && typeof parsed.at === "number" && Date.now() - parsed.at < RELOAD_GUARD_WINDOW_MS
  } catch {
    return false
  }
}

function markReloadNow(accountID: string): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ id: accountID, at: Date.now() }))
  } catch {
    // ignore
  }
}

/** reload 整个 renderer 窗口（非浏览器环境 no-op）。用于账号切换后强制清空内存态。 */
function reloadRenderer(): void {
  if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
    window.location.reload()
  }
}

const handleAuthSuccess = async (server: string, auth: CredentialsAuthResponse) => {
  const url = normalizeServer(server)
  const expiry = Date.now() + auth.expires_in * 1000
  // 先拉 PunkcodeAI sk-key + 模型列表（用刚拿到的 access_token）。
  // 任何一步失败 → 整体抛出，由 UI 提示用户重试（避免半截状态：登录看似成功但聊天不可用）。
  const creds = await syncCredentialsCore(url, auth.access_token)
  const next: AuthState = {
    server: url,
    accountID: buildAccountID(url, auth.user.email),
    accessToken: auth.access_token,
    refreshToken: auth.refresh_token,
    expiry,
    user: {
      id: auth.user.id,
      email: auth.user.email,
      nickname: auth.user.nickname,
      balanceUsd: auth.user.balance_usd,
      // M7: signIn / signUp 接口本身不返用量；先置 0，后续 widget 30s 轮询 `/cli/me` 补上。
      usedTodayUsd: 0,
      usedMonthUsd: 0,
    },
    ...creds,
  }
  // M9（账号隔离修复 / 计费安全）：
  //   1) 先 clearCredentialsOnSidecar —— 消除"旧账号 sk-key 还在 sidecar"的残留窗口。
  //      （切换账号时尤其关键：上一账号 logout 不一定走过，直接登另一账号也要先清旧。）
  //   2) 再 push 新账号凭据。push 带 accountID，主进程发现 accountID 变了会重启 sidecar
  //      切到新账号隔离的 session db。
  //   3) push 失败（Electron 下 IPC 抛错）→ **不 applySession**，回滚 sidecar 凭据并抛错，
  //      让 UI 提示用户重试。绝不允许"renderer 进登录态但 sidecar 揣着别的账号 key"。
  // 顺序同样保证 AuthGate 不会在没有 punkcodeai 凭据的 sidecar 上抢跑 provider query。
  await clearCredentialsOnSidecar()
  const pushed = await pushCredentialsToSidecar(next)
  if (!pushed) {
    // 回滚：把刚塞进去（可能半截）的凭据再清掉，避免脏状态。
    await clearCredentialsOnSidecar()
    throw new AccountError(
      "Credentials.pushToSidecar: 无法把账号凭据同步到本地服务，请重试登录",
    )
  }
  applySession(next)
}

const applyRefreshedPair = (pair: CredentialsTokenPair) => {
  const current = state()
  if (!current) return
  const expiry = Date.now() + pair.expires_in * 1000
  applySession({
    ...current,
    accessToken: pair.access_token,
    refreshToken: pair.refresh_token,
    expiry,
  })
}

/**
 * 每次 refresh 成功后，确保 sk- 已被 sidecar 拿到。
 *
 * 路径 1（正常）：登录时 handleAuthSuccess 已经拉到 sk- 并推给 sidecar，refresh 不需要重拉。
 *                 但仍重推一次 IPC，覆盖 Electron 主进程因故重启丢失内存的边界情况。
 * 路径 2（边界）：bootstrap 没拉到 sk-（极小概率：bootstrap 阶段 /cli/api-key 限流/失败但
 *                 refresh 成功），下次 refresh 检测到 store.apiKey === ""，重新调 syncCredentialsCore。
 */
async function ensureCredentialsAfterRefresh(): Promise<void> {
  const current = state()
  if (!current) return
  if (!current.apiKey) {
    try {
      const creds = await syncCredentialsCore(current.server, current.accessToken)
      const next = { ...current, ...creds }
      // 先推 sidecar 再 applySession，避免 reactive 订阅者抢跑 provider query 拿空数据。
      await pushCredentialsToSidecar(next)
      applySession(next)
    } catch {
      // refresh 路径上不要因为补拉 sk- 失败把用户踢下线；下次 refresh 会再尝试。
    }
    return
  }
  // 已缓存 sk-，只是重推一次，覆盖主进程重启等边界。
  // 此路径下 state 不变，没有 reactive 副作用，无需 swap 顺序。
  await pushCredentialsToSidecar(current)
}

async function callRegister(
  server: string,
  input: { email: string; password: string; nickname: string },
): Promise<CredentialsAuthResponse> {
  const url = `${normalizeServer(server)}/api/v1/cli/register`
  return callApi<CredentialsAuthResponse>(url, input, "Credentials.register")
}

async function callLogin(
  server: string,
  input: { email: string; password: string },
): Promise<CredentialsAuthResponse> {
  const url = `${normalizeServer(server)}/api/v1/cli/login`
  return callApi<CredentialsAuthResponse>(url, input, "Credentials.login")
}

async function callRefresh(server: string, refreshToken: string): Promise<CredentialsTokenPair> {
  const url = `${normalizeServer(server)}/api/v1/cli/refresh`
  return callApi<CredentialsTokenPair>(url, { refresh_token: refreshToken }, "Credentials.refresh")
}

// ============================================================
// M6: sk- API Key + LLM 元数据
// ============================================================

interface CliApiKeyResponse {
  /** sk- 开头的真实 API Key */
  key: string
}

interface CliLlmResponse {
  /** OpenAI-compatible base URL，如 http://localhost:38080/v1 */
  base_url: string
  /** Anthropic 风格 base URL */
  anthropic_base_url: string
  /** Gemini 风格 base URL */
  gemini_base_url: string
  /** 用户当前可见的模型列表（绑定 group 决定） */
  models: PunkcodeModel[]
}

async function callApiKey(server: string, accessToken: string): Promise<CliApiKeyResponse> {
  const url = `${normalizeServer(server)}/api/v1/cli/api-key`
  return callAuthorizedGet<CliApiKeyResponse>(url, accessToken, "Credentials.apiKey")
}

async function callLlm(server: string, accessToken: string): Promise<CliLlmResponse> {
  const url = `${normalizeServer(server)}/api/v1/cli/llm`
  return callAuthorizedGet<CliLlmResponse>(url, accessToken, "Credentials.llm")
}

// ============================================================
// M7: /cli/me + 充值申请
// ============================================================

async function callMe(server: string, accessToken: string): Promise<CliMeResponse> {
  const url = `${normalizeServer(server)}/api/v1/cli/me`
  return callAuthorizedGet<CliMeResponse>(url, accessToken, "Credentials.me")
}

/**
 * 用 Bearer token + envelope 协议调一次鉴权 POST。复用 callApi 的 envelope 错误约定。
 */
async function callAuthorizedPost<T>(
  url: string,
  accessToken: string,
  body: unknown,
  label: string,
): Promise<T> {
  return withRetry(async () => {
    let response: Response
    try {
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      throw new AccountError(`${label}: HTTP request failed`, { cause })
    }

    let envelope: CredentialsEnvelope<unknown>
    try {
      envelope = (await response.json()) as CredentialsEnvelope<unknown>
    } catch (cause) {
      throw new AccountError(`${label}: failed to decode envelope`, { cause })
    }

    if (typeof envelope.code !== "number" || typeof envelope.message !== "string") {
      throw new AccountError(`${label}: malformed envelope`)
    }
    if (envelope.code !== 0) {
      throw new CredentialsError(envelope.code, envelope.message)
    }
    return envelope.data as T
  })
}

async function callCreateBalanceRequest(
  server: string,
  accessToken: string,
  input: { amount_usd: number; note?: string },
): Promise<BalanceRequest> {
  const url = `${normalizeServer(server)}/api/v1/cli/balance-requests`
  return callAuthorizedPost<BalanceRequest>(url, accessToken, input, "Credentials.balanceRequests.create")
}

async function callListBalanceRequests(
  server: string,
  accessToken: string,
  limit = 20,
): Promise<BalanceRequest[]> {
  const url = `${normalizeServer(server)}/api/v1/cli/balance-requests?limit=${encodeURIComponent(String(limit))}`
  const data = await callAuthorizedGet<{ items?: BalanceRequest[] }>(
    url,
    accessToken,
    "Credentials.balanceRequests.list",
  )
  return Array.isArray(data.items) ? data.items : []
}

/**
 * 是否处于 Electron 桌面端（window.api 可用）。
 *
 * dev 浏览器调试模式下 window.api 不存在——此时 IPC 推/清凭据是 no-op，
 * 不应把"IPC 不可用"当成失败（否则浏览器调试永远登录不进去）。
 */
function isDesktopRuntime(): boolean {
  const api = typeof window !== "undefined" ? (window as { api?: unknown }).api : undefined
  return Boolean(api)
}

/**
 * Renderer → main 进程 IPC：推 sk- 凭据给 sidecar。
 *
 * 调用方：登录/注册/bootstrap 成功后、refresh 续期成功后（如果第一次没拉到）。
 *
 * M9（账号隔离修复）：**不再静默吞 IPC 错误**。
 *   - 返回 true：凭据已成功推给 sidecar（或处于非 Electron 浏览器 dev 模式，IPC 是 no-op）。
 *   - 返回 false：处于 Electron 但 IPC push 抛错——调用方据此决定不要进入登录态，
 *     避免出现"renderer 以为登过了，但 sidecar 还揣着旧账号 sk-key"的串号窗口。
 *   - payload 带上 `accountID`，主进程据此决定是否需要重启 sidecar 切到该账号的隔离 db。
 */
async function pushCredentialsToSidecar(state: AuthState): Promise<boolean> {
  const api = (typeof window !== "undefined" ? window.api : undefined) as
    | {
        setPunkcodeCredentials?: (input: {
          accountID: string
          apiKey: string
          baseUrl: string
          anthropicBaseUrl: string
          geminiBaseUrl: string
          models: PunkcodeModel[]
        }) => Promise<void>
      }
    | undefined
  if (!api?.setPunkcodeCredentials) {
    // M6 P2-A：dev 浏览器调试模式下 window.api 不存在；打一条 warn，
    // 让开发者知道 sidecar 凭据没真的推下去（避免 "为什么模型列表是空" 这种排查浪费时间）。
    // 浏览器 dev 模式没有 sidecar，视为成功（no-op），不阻塞登录。
    console.warn(
      "PunkcodeAI: window.api unavailable, sidecar credentials skipped (dev browser mode?)",
    )
    return true
  }
  try {
    await api.setPunkcodeCredentials({
      accountID: state.accountID,
      apiKey: state.apiKey,
      baseUrl: state.llmBaseUrl,
      anthropicBaseUrl: state.anthropicBaseUrl,
      geminiBaseUrl: state.geminiBaseUrl,
      models: state.models,
    })
    return true
  } catch (err) {
    // M9：IPC push 失败必须让调用方感知。绝不能在 sidecar 还揣着旧 key 的情况下进入登录态。
    console.error("PunkcodeAI: failed to push credentials to sidecar", err)
    return false
  }
}

/**
 * 通知 sidecar 清掉 PunkcodeAI 凭据（退出登录 / 切换账号"先清旧"路径用）。
 *
 * M9：返回 boolean 让调用方感知失败（浏览器 dev 模式无 sidecar，视为成功）。
 */
async function clearCredentialsOnSidecar(): Promise<boolean> {
  const api = (typeof window !== "undefined" ? window.api : undefined) as
    | { clearPunkcodeCredentials?: () => Promise<void> }
    | undefined
  if (!api?.clearPunkcodeCredentials) return true
  try {
    await api.clearPunkcodeCredentials()
    return true
  } catch (err) {
    console.error("PunkcodeAI: failed to clear credentials on sidecar", err)
    return false
  }
}

/**
 * 拉 sk- API Key + LLM 元数据并塞进 store + 推 sidecar。
 *
 * @throws 网络/业务错误（同 callApi 的错误约定）
 */
async function syncCredentialsCore(server: string, accessToken: string): Promise<{
  apiKey: string
  llmBaseUrl: string
  anthropicBaseUrl: string
  geminiBaseUrl: string
  models: PunkcodeModel[]
}> {
  const [apiKeyRes, llmRes] = await Promise.all([callApiKey(server, accessToken), callLlm(server, accessToken)])
  return {
    apiKey: apiKeyRes.key,
    llmBaseUrl: llmRes.base_url,
    anthropicBaseUrl: llmRes.anthropic_base_url,
    geminiBaseUrl: llmRes.gemini_base_url,
    models: Array.isArray(llmRes.models) ? llmRes.models : [],
  }
}

/**
 * 后台刷新：定时器到期触发，或者手动调（如启动 bootstrap）。
 *
 * 注意：refresh 失败（refresh_token 过期 / 被吊销）→ 直接 logout，
 *      UI 层会被 auth-gate 检测到并跳回 /login。
 */
async function backgroundRefresh(): Promise<void> {
  const current = state()
  if (!current) return
  try {
    const pair = await callRefresh(current.server, current.refreshToken)
    applyRefreshedPair(pair)
    await ensureCredentialsAfterRefresh()
  } catch (err) {
    if (err instanceof CredentialsError) {
      // refresh_token 失效（401 / 业务错），强制退出。
      clearSession()
      void clearCredentialsOnSidecar()
      return
    }
    // 网络 / 5xx：保留会话，30s 后重试（不让一次 flaky 网络踢用户下线）。
    clearRefreshTimer()
    refreshTimer = setTimeout(() => {
      void backgroundRefresh()
    }, 30 * 1000)
  }
}

/**
 * App 启动时尝试用 localStorage 中的 refresh_token 还原会话。
 *
 * 调用方应在路由挂载前 `await ensureBootstrap()`，避免出现 "未登录闪屏 → 跳 /login → 自动登录回来"
 * 的视觉抖动。但即使没等也安全：auth-gate 会观察 state 变化并自动重定向。
 *
 * 设计：bootstrap **只在第一次**实际执行；后续调用直接 resolve。
 */
let bootstrapPromise: Promise<void> | null = null

/**
 * bootstrap 整体保底超时（ms）。
 *
 * 即便单次请求已有 REQUEST_TIMEOUT_MS + 重试，多步串行（refresh + api-key + llm）
 * 叠加退避后最坏仍可能拖较久。这里给 bootstrap 整体再加一道保底：超过 BOOTSTRAP_TIMEOUT_MS
 * 就强制结束 splash（setBootstrapping(false)），由 AuthGate 兜底 UI 接管，绝不让 splash 无限等。
 *
 * 注意：超时只是「停止 gate splash」，bootstrapInner 仍在后台继续跑——它若随后成功会
 * applySession 进登录态（AuthGate 的 createEffect 监听 isLoggedIn 会自然恢复到主界面）。
 */
const BOOTSTRAP_TIMEOUT_MS = 8000

export const ensureBootstrap = (): Promise<void> => {
  if (bootstrapped) return Promise.resolve()
  if (bootstrapPromise) return bootstrapPromise

  let settled = false
  const finishBootstrapping = () => {
    if (settled) return
    settled = true
    // M5 P2-C：bootstrap 一旦跑完（无论结果），AuthGate 不再 splash，按 isLoggedIn 决定。
    setBootstrapping(false)
  }

  const inner = bootstrapInner().finally(() => {
    bootstrapped = true
    bootstrapPromise = null
    finishBootstrapping()
  })

  // 保底超时：到点即结束 splash，不阻断 inner（后台继续，成功会自动进登录态）。
  const guard = new Promise<void>((resolve) => {
    setTimeout(() => {
      finishBootstrapping()
      resolve()
    }, BOOTSTRAP_TIMEOUT_MS)
  })

  // ensureBootstrap 的 await 方（路由挂载前）等「先完成者」即可——splash 不会被超时卡住。
  bootstrapPromise = Promise.race([inner, guard])
  return bootstrapPromise
}

async function bootstrapInner(): Promise<void> {
  const persisted = readPersisted()
  if (!persisted) return

  // 默认服务器变更：localStorage 里的 server 与当前 DEFAULT_API_BASE_URL 不同时，
  // 清掉旧 session 强制重登（避免跨环境串号）。
  if (normalizeServer(persisted.server) !== normalizeServer(DEFAULT_API_BASE_URL)) {
    writePersisted(null)
    return
  }

  try {
    const pair = await callRefresh(persisted.server, persisted.refreshToken)
    const expiry = Date.now() + pair.expires_in * 1000
    const url = normalizeServer(persisted.server)
    const emailFromID = persisted.accountID.startsWith(`${url}:`)
      ? persisted.accountID.slice(url.length + 1)
      : persisted.accountID

    // M9（账号隔离修复 / 计费安全）：用 localStorage refresh_token 自动恢复时，
    //   必须拉到**该账号的新 sk-key** 才能 push 给 sidecar。
    //   sk-key 拉失败 → clearCredentialsOnSidecar() + 清 localStorage，强制用户重新登录，
    //   绝不允许"会话恢复成功但 sidecar 揣着旧/别的账号 key"导致用错账号扣错钱。
    //   （旧实现里 sk- 拉失败时仍 applySession 进登录态、等下次 refresh 补拉——
    //    这给了"旧账号 token 静默续命串号"的窗口，M9 收紧。）
    const creds = await syncCredentialsCore(url, pair.access_token)

    // 启动慢修复：从 bootstrap 关键链摘除 /cli/me。
    //   旧实现这里 `await callMe(...)` 拉余额/用量再进登录态——后端慢时直接 gate 住启动 splash。
    //   现在 bootstrap 只留 refresh + syncCredentials；user 字段先用 accountID 反推的 email + 占位 0
    //   兜底（避免 widget 显示空白），余额/今日/本月用量由 BalanceWidget onMount 首拉 `/cli/me` 负责
    //   （见 balance-widget.tsx：onMount 立即 refreshOnce() + 30s 轮询）。
    const next: AuthState = {
      server: url,
      accountID: persisted.accountID,
      accessToken: pair.access_token,
      refreshToken: pair.refresh_token,
      expiry,
      user: {
        id: 0,
        email: emailFromID,
        nickname: emailFromID,
        balanceUsd: 0,
        usedTodayUsd: 0,
        usedMonthUsd: 0,
      },
      ...creds,
    }
    // 同 handleAuthSuccess：先清旧再推新，再 applySession，避免 AuthGate 抢跑 provider query 拿空数据，
    // 也避免 sidecar 残留上一账号 key。push 失败 → 不进登录态，清 sidecar + localStorage 重登。
    await clearCredentialsOnSidecar()
    const pushed = await pushCredentialsToSidecar(next)
    if (!pushed) {
      await clearCredentialsOnSidecar()
      writePersisted(null)
      return
    }
    // 治本配套(step3+4)：冷启动用 refresh_token 恢复时, sidecar 首发 db 已据持久化的 lastAccountID
    // 预投为本账号 db(见 index.ts 首个 doSpawn + server.ts getLastAccountID)。renderer 此刻对着的就是
    // 正确账号 db, 无需整窗 reload。预置 synced marker → applySession 判定相等 → 跳过 reloadRenderer,
    // 消除"主界面→loading→主界面"闪烁的 renderer 侧来源。仅冷启动恢复路径如此;
    // 运行期真正切账号(handleAuthSuccess, marker≠新账号)仍会 reload, 不受影响。
    setSyncedAccountID(next.accountID)
    applySession(next)
  } catch {
    // refresh_token 过期 / 网络故障 / sk-key 拉取失败 → 清 sidecar 凭据 + 清持久化，让用户重新登录。
    // 清 sidecar 是 M9 关键：避免上一次会话残留在 sidecar 进程里的旧账号 key 继续被用于聊天。
    await clearCredentialsOnSidecar()
    writePersisted(null)
  }
}

/**
 * M7：拉一次 /cli/me 把 user.balance/usedToday/usedMonth 等字段刷新到 store。
 *
 * 用途：右上角 balance widget 的 30s 轮询、点刷新、chat stream 完成钩子。
 *
 * 失败不踢用户下线（网络抖动 / 5xx）；返回 false 让 UI 层决定是否提示。
 * 401 / token 失效会被 callAuthorizedGet 抛成 CredentialsError → 调用方按业务错处理；
 *   注意此时不立刻退出登录（refresh 还有机会救回），让 backgroundRefresh 走它的退出逻辑。
 */
async function refreshMeCore(): Promise<boolean> {
  const current = state()
  if (!current) return false
  try {
    const me = await callMe(current.server, current.accessToken)
    const latest = state()
    // 避免回填竞态：刚 signOut 之后 inflight 请求 settle 不能再写回 state。
    if (!latest || latest.accountID !== current.accountID) return false
    setState({
      ...latest,
      user: {
        ...latest.user,
        id: me.id || latest.user.id,
        email: me.email || latest.user.email,
        nickname: me.nickname || latest.user.nickname,
        balanceUsd: me.balance_usd,
        usedTodayUsd: me.used_today_usd,
        usedMonthUsd: me.used_month_usd,
      },
    })
    return true
  } catch {
    return false
  }
}

// ============================================================
// public API
// ============================================================

/**
 * Renderer 端的 auth hook。
 *
 * 用法（在 SolidJS 组件内）：
 * ```tsx
 * const auth = useAuth()
 * if (!auth.isLoggedIn()) navigate("/login")
 * const email = auth.state()?.user.email
 * await auth.signIn({ email, password })
 * await auth.signOut()
 * ```
 *
 * 注意：所有方法 throw 出来的错误一律是 `CredentialsError`（业务错）或 `AccountError`（网络/解码错），
 * 调用方按类型区分错误提示。
 */
export const useAuth = () => ({
  /** 当前会话；未登录时为 null */
  state,
  /** 是否已登录（reactive） */
  isLoggedIn,
  /**
   * bootstrap 是否仍在跑（reactive）。
   * AuthGate 在 `bootstrapping() === true` 时渲染 splash，避免登录态闪烁后才跳 /login（M5 P2）。
   */
  bootstrapping,

  /**
   * 邮箱 + 密码登录。
   * @param input.email
   * @param input.password
   * @param server 可选；默认指向 `DEFAULT_API_BASE_URL`
   */
  async signIn(input: { email: string; password: string }, server: string = DEFAULT_API_BASE_URL): Promise<void> {
    const auth = await callLogin(server, input)
    await handleAuthSuccess(server, auth)
  },

  /** 注册并自动登录 */
  async signUp(
    input: { email: string; password: string; nickname: string },
    server: string = DEFAULT_API_BASE_URL,
  ): Promise<void> {
    const auth = await callRegister(server, input)
    await handleAuthSuccess(server, auth)
  },

  /**
   * 退出登录：清内存 + 清 localStorage + 停定时器 + 通知 sidecar 清掉 sk-。
   *
   * M9：clear 必须真正送达 sidecar（删 OPENCODE_AUTH_CONTENT + dispose instance），
   *     然后 reload 整个 renderer——把上一账号残留的 session/project 内存态彻底清掉，
   *     再由 AuthGate 把用户带到 /login。reload 前 localStorage 已被 clearSession 清空，
   *     下次启动不会自动恢复上一账号（强制重新登录拉新账号），从而保证不同账号 session 互不可见。
   */
  async signOut(): Promise<void> {
    clearSession()
    renderedAccountID = null
    // 清掉「已同步账号」记号：reload 后 DOM 会重新对着默认 db bootstrap（已无凭据），
    // 下次登录（同/异账号）时 applySession 必定判定「需为该账号同步」→ reload 一次绑到账号 db，
    // 避免登出再登录后又看到上一账号残留列表。
    setSyncedAccountID(null)
    await clearCredentialsOnSidecar()
    reloadRenderer()
  },

  /** 主动触发一次 refresh（调试 / "余额刷新"按钮 等场景用；UI 层一般不用） */
  async refresh(): Promise<void> {
    await backgroundRefresh()
  },

  /**
   * M7：拉一次 `/cli/me` 把余额 / 今日用量 / 本月用量 / 昵称等同步到 store。
   *
   * @returns true=成功；false=未登录 / 网络失败 / envelope 错。
   * 失败不抛错，不踢用户下线；UI 层根据返回值决定是否回滚 spinner、显示提示等。
   */
  async refreshMe(): Promise<boolean> {
    return refreshMeCore()
  },

  /**
   * M7：提交一条充值申请。
   *
   * @throws CredentialsError 业务错（如 code=409 "too many pending balance requests"）
   * @throws AccountError 网络/解码错
   */
  async requestTopup(input: { amount_usd: number; note?: string }): Promise<BalanceRequest> {
    const current = state()
    if (!current) throw new AccountError("Credentials.balanceRequests.create: not signed in")
    return callCreateBalanceRequest(current.server, current.accessToken, input)
  },

  /**
   * M7：列我的最近 N 条充值申请。
   *
   * @throws CredentialsError / AccountError 同上。
   */
  async listBalanceRequests(limit = 20): Promise<BalanceRequest[]> {
    const current = state()
    if (!current) throw new AccountError("Credentials.balanceRequests.list: not signed in")
    return callListBalanceRequests(current.server, current.accessToken, limit)
  },
})

export type UseAuth = ReturnType<typeof useAuth>
