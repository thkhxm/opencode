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

/**
 * 调 sub2api 某个 endpoint，先解 envelope，再按 data schema 取出业务数据。
 *
 * - HTTP 错误（network / 非 JSON）→ AccountError
 * - HTTP 200 但 envelope.code !== 0 → CredentialsError
 */
async function callApi<T>(url: string, body: unknown, label: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
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
}

/**
 * 调 sub2api 鉴权后的 GET endpoint（带 Bearer token + envelope 解码）。
 * 与 callApi 共用 envelope/错误约定，但走 GET。
 */
async function callAuthorizedGet<T>(url: string, accessToken: string, label: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
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
}

// ============================================================
// store
// ============================================================

const [state, setState] = createSignal<AuthState | null>(null)
const isLoggedIn = createMemo(() => state() !== null)

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
}

const clearSession = () => {
  clearRefreshTimer()
  setState(null)
  writePersisted(null)
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
    },
    ...creds,
  }
  // 关键：必须先把 sk- 推到 sidecar，再 applySession 触发 UI 进入登录态。
  // 否则 AuthGate 抢先渲染、provider query 跑在没有 punkcodeai 凭据的 sidecar 上，
  // 拿到空 provider list 缓存，模型下拉空白。
  // pushCredentialsToSidecar 内部已吞错（IPC 失败不抛），所以正常路径不会因此 throw。
  await pushCredentialsToSidecar(next)
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

/**
 * Renderer → main 进程 IPC：推 sk- 凭据给 sidecar。
 *
 * 调用方：登录/注册/bootstrap 成功后、refresh 续期成功后（如果第一次没拉到）。
 * 失败处理：当桌面端不在 Electron 中（如纯浏览器 dev 调试），window.api 为 undefined，
 *           IPC 直接跳过，不影响 store 流程；用户不会被踢下线。
 */
async function pushCredentialsToSidecar(state: AuthState): Promise<void> {
  const api = (typeof window !== "undefined" ? window.api : undefined) as
    | {
        setPunkcodeCredentials?: (input: {
          apiKey: string
          baseUrl: string
          anthropicBaseUrl: string
          geminiBaseUrl: string
          models: PunkcodeModel[]
        }) => Promise<void>
      }
    | undefined
  if (!api?.setPunkcodeCredentials) return
  try {
    await api.setPunkcodeCredentials({
      apiKey: state.apiKey,
      baseUrl: state.llmBaseUrl,
      anthropicBaseUrl: state.anthropicBaseUrl,
      geminiBaseUrl: state.geminiBaseUrl,
      models: state.models,
    })
  } catch {
    // IPC 失败也不要踢用户下线；下次 refresh 会再尝试。
  }
}

/** 通知 sidecar 清掉 PunkcodeAI 凭据（退出登录路径用） */
async function clearCredentialsOnSidecar(): Promise<void> {
  const api = (typeof window !== "undefined" ? window.api : undefined) as
    | { clearPunkcodeCredentials?: () => Promise<void> }
    | undefined
  if (!api?.clearPunkcodeCredentials) return
  try {
    await api.clearPunkcodeCredentials()
  } catch {
    // 清理失败不阻塞退出登录。
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

export const ensureBootstrap = (): Promise<void> => {
  if (bootstrapped) return Promise.resolve()
  if (bootstrapPromise) return bootstrapPromise
  bootstrapPromise = bootstrapInner().finally(() => {
    bootstrapped = true
    bootstrapPromise = null
  })
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
    // bootstrap 阶段拿不到 user 详情（refresh 接口不返 user），
    // 用 accountID 反推 email；nickname / balance 等显示字段先留空，等 M7 接 `/cli/me` 填实。
    const url = normalizeServer(persisted.server)
    const emailFromID = persisted.accountID.startsWith(`${url}:`)
      ? persisted.accountID.slice(url.length + 1)
      : persisted.accountID

    // M6: bootstrap 也要拉 sk-key + 模型列表（用刚刷出来的 access_token）。
    // 失败不阻塞 bootstrap：先把会话恢复出来，UI 仍可登录态；下次 refresh 会触发 ensureCredentialsAfterRefresh 补拉。
    let creds: Awaited<ReturnType<typeof syncCredentialsCore>>
    try {
      creds = await syncCredentialsCore(url, pair.access_token)
    } catch {
      creds = { apiKey: "", llmBaseUrl: "", anthropicBaseUrl: "", geminiBaseUrl: "", models: [] }
    }

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
      },
      ...creds,
    }
    // 同 handleAuthSuccess：先推 sidecar 再 applySession，避免 AuthGate 抢跑 provider query 拿空数据。
    if (creds.apiKey) await pushCredentialsToSidecar(next)
    applySession(next)
  } catch {
    // refresh_token 过期 / 网络故障 → 清掉持久化让用户重新登录。
    writePersisted(null)
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

  /** 退出登录：清内存 + 清 localStorage + 停定时器 + 通知 sidecar 清掉 sk- */
  async signOut(): Promise<void> {
    clearSession()
    await clearCredentialsOnSidecar()
  },

  /** 主动触发一次 refresh（调试 / "余额刷新"按钮 等场景用；UI 层一般不用） */
  async refresh(): Promise<void> {
    await backgroundRefresh()
  },
})

export type UseAuth = ReturnType<typeof useAuth>
