/**
 * PunkcodeAI 桌面端登录态（仅内存 + refresh token 本地持久化）。
 *
 * 设计要点（与 §M5 规范对齐）：
 *   1. access_token / 用户信息**只在内存**保存；进程重启即丢，必须用 refresh_token 拿回来。
 *   2. refresh_token + accountID 持久化到 localStorage（renderer 端唯一可靠的持久化通道）。
 *      （opencode 原生 SQLite AccountTable 在 sidecar 进程里，renderer 不能直接访问；
 *      M5 阶段先用 localStorage 兜底——M6/M7 若需要把"已登录"信息暴露给 sidecar，再开 IPC）。
 *   3. 主动 refresh：access_token 过期前 `expires_in / 2` 触发一次刷新；
 *      失败立即 logout，引导用户重新登录。
 *   4. 不暴露 access_token / refresh_token / sk- key 给上层组件，只提供 isLoggedIn / state / signIn / signOut。
 *   5. 调用 sub2api `/api/v1/cli/{register,login,refresh}` 直接走 fetch；不依赖 opencode sidecar。
 *      （opencode `Account.Service` 的 credentials flow 也走同样的 endpoint，sidecar 端的实现
 *      仅在 CLI 路径上使用——见 packages/opencode/src/account/credentials.ts。）
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

/**
 * 登录后的内存态。
 *
 * - `expiry` 是 epoch ms（`Date.now()` 同维度）
 * - `accountID` 与 opencode Account 服务一致：`${url}:${email}`
 *   （详见 packages/opencode/src/account/credentials.ts:buildAccountID）
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

const handleAuthSuccess = (server: string, auth: CredentialsAuthResponse) => {
  const url = normalizeServer(server)
  const expiry = Date.now() + auth.expires_in * 1000
  applySession({
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
  })
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
  } catch (err) {
    if (err instanceof CredentialsError) {
      // refresh_token 失效（401 / 业务错），强制退出。
      clearSession()
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
    applySession({
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
    })
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
    handleAuthSuccess(server, auth)
  },

  /** 注册并自动登录 */
  async signUp(
    input: { email: string; password: string; nickname: string },
    server: string = DEFAULT_API_BASE_URL,
  ): Promise<void> {
    const auth = await callRegister(server, input)
    handleAuthSuccess(server, auth)
  },

  /** 退出登录：清内存 + 清 localStorage + 停定时器 */
  async signOut(): Promise<void> {
    clearSession()
  },

  /** 主动触发一次 refresh（调试 / "余额刷新"按钮 等场景用；UI 层一般不用） */
  async refresh(): Promise<void> {
    await backgroundRefresh()
  },
})

export type UseAuth = ReturnType<typeof useAuth>
