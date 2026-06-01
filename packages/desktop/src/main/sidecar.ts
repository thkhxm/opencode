import { drizzle } from "drizzle-orm/node-sqlite/driver"
import * as http from "node:http"
import * as tls from "node:tls"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  needsMigration: boolean
}

type StopCommand = { type: "stop" }

/**
 * M6: 主进程把 PunkcodeAI 凭据透传过来。
 *
 * sidecar 收到后:
 *   1. 把 sk-key 注入 process.env.OPENCODE_AUTH_CONTENT（auth.json 的 JSON 字符串形式）
 *   2. 把 provider 定义 + 模型列表注入 process.env.OPENCODE_CONFIG_CONTENT
 *   3. 调 InstanceRuntime.disposeAllInstances() 清掉 Provider/Config 等的 InstanceState cache
 *   4. 回 credentials-updated ACK
 *
 * 之后下一次 Provider.list / Provider.getLanguage 会重新初始化，读到新 env 拿到 PunkcodeAI provider。
 */
type SetCredentialsCommand = {
  type: "set-credentials"
  credentials: {
    accountID: string
    apiKey: string
    baseUrl: string
    anthropicBaseUrl: string
    geminiBaseUrl: string
    models: Array<{ id: string; name: string; provider?: string; context_window?: number }>
  }
}

type ClearCredentialsCommand = { type: "clear-credentials" }

type SidecarCommand = StartCommand | StopCommand | SetCredentialsCommand | ClearCredentialsCommand

type SidecarMessage =
  | { type: "sqlite"; progress: { type: "InProgress"; value: number } | { type: "Done" } }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "credentials-updated" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  switch (command.type) {
    case "stop":
      void stop()
      return
    case "set-credentials":
      void applyPunkcodeCredentials(command.credentials)
      return
    case "clear-credentials":
      void clearPunkcodeCredentials()
      return
    case "start":
      void start(command)
      return
  }
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Database, JsonMigration, Log, Server } = await import("virtual:opencode-server")
    await Log.init({ level: "WARN" })

    if (command.needsMigration) {
      await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
        progress: (event: { current: number; total: number }) => {
          parentPort.postMessage({
            type: "sqlite",
            progress: {
              type: "InProgress",
              value: event.total === 0 ? 100 : Math.round((event.current / event.total) * 100),
            },
          })
        },
      })
      parentPort.postMessage({ type: "sqlite", progress: { type: "Done" } })
    }

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const raw = value as { type?: unknown }
  if (raw.type === "stop") return { type: "stop" }
  if (raw.type === "clear-credentials") return { type: "clear-credentials" }
  if (raw.type === "set-credentials") return parseSetCredentialsCommand(value)
  if (raw.type === "start") return parseStartCommand(value)
  return
}

function parseStartCommand(value: unknown): StartCommand | undefined {
  const command = value as Partial<StartCommand>
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (typeof command.needsMigration !== "boolean") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    needsMigration: command.needsMigration,
  }
}

function parseSetCredentialsCommand(value: unknown): SidecarCommand | undefined {
  const command = value as { credentials?: unknown }
  const creds = command.credentials as Partial<SetCredentialsCommand["credentials"]> | undefined
  if (!creds || typeof creds !== "object") return
  // M9（杜绝旧 key 残留）：空 apiKey 不再"丢弃命令、保留旧 key"——等价于 clear。
  // 任何路径下只要 renderer 拉不到当前账号的 sk-key（push 空字符串），sidecar 立即清掉
  // OPENCODE_AUTH_CONTENT，绝不让上一账号的 key 苟活。
  if (typeof creds.apiKey !== "string" || creds.apiKey.length === 0) {
    return { type: "clear-credentials" }
  }
  if (typeof creds.baseUrl !== "string" || creds.baseUrl.length === 0) {
    // baseUrl 缺失等同凭据不完整，同样清掉而不是保留旧值。
    return { type: "clear-credentials" }
  }
  return {
    type: "set-credentials",
    credentials: {
      accountID: typeof creds.accountID === "string" ? creds.accountID : "",
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
      anthropicBaseUrl: typeof creds.anthropicBaseUrl === "string" ? creds.anthropicBaseUrl : "",
      geminiBaseUrl: typeof creds.geminiBaseUrl === "string" ? creds.geminiBaseUrl : "",
      models: Array.isArray(creds.models)
        ? creds.models
            .filter((m): m is { id: string; name: string; provider?: string; context_window?: number } => {
              if (!m || typeof m !== "object") return false
              const item = m as { id?: unknown; name?: unknown }
              return typeof item.id === "string" && typeof item.name === "string"
            })
            .map((m) => ({
              id: m.id,
              name: m.name,
              provider: typeof m.provider === "string" ? m.provider : undefined,
              context_window: typeof m.context_window === "number" ? m.context_window : undefined,
            }))
        : [],
    },
  }
}

/**
 * M6: PunkcodeAI 内置 provider ID。
 * 与 renderer 端约定一致（renderer 侧 dialog-select-model 通过 visibility 过滤，
 * 在 HIDE_PROVIDER_UI 模式下也能让这个 provider 的模型出现在下拉里）。
 */
const PUNKCODE_PROVIDER_ID = "punkcodeai"

/**
 * 把 PunkcodeAI 凭据塞进 process.env 并 dispose 所有 instance state cache,
 * 让下一次 provider.list / config.get 重新初始化。
 *
 * 注：凭据本身**不在本进程内额外缓存**——sidecar 唯一的真理源是 `process.env.OPENCODE_AUTH_CONTENT` /
 * `OPENCODE_CONFIG_CONTENT`，重启进程自然丢失，符合"sk- 仅内存"安全规范。
 */
async function applyPunkcodeCredentials(credentials: SetCredentialsCommand["credentials"]): Promise<void> {
  try {
    // 1) OPENCODE_AUTH_CONTENT：注入 sk-key。该 env 一旦设置就会替换整个 auth.all() 返回值，
    //    所以桌面端只支持 PunkcodeAI 一个 provider 是符合设计的（M5 已隐藏 provider UI）。
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      [PUNKCODE_PROVIDER_ID]: {
        type: "api",
        key: credentials.apiKey,
      },
    })

    // 2) OPENCODE_CONFIG_CONTENT：注入 punkcodeai provider 定义 + 模型列表。
    //    npm 用 @ai-sdk/openai-compatible（sub2api 后端兼容 OpenAI Chat Completions 协议）。
    //    每个模型尽量给完整 cost/limit/capabilities 字段，避免 Provider.transform 走 NaN 分支。
    const models: Record<string, unknown> = {}
    for (const model of credentials.models) {
      const ctx = typeof model.context_window === "number" && model.context_window > 0 ? model.context_window : 200_000
      models[model.id] = {
        id: model.id,
        name: model.name,
        // 计费在 sub2api 网关侧统一结算，cost 字段对桌面端只起 UI 提示作用，全部置 0 即可。
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: ctx, output: Math.min(ctx, 8192) },
        modalities: { input: ["text", "image"], output: ["text"] },
        attachment: true,
        reasoning: false,
        temperature: true,
        tool_call: true,
        provider: { npm: "@ai-sdk/openai-compatible", api: credentials.baseUrl },
      }
    }
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      // 限定只允许 punkcodeai——避免 shell 里残留的 OPENAI_API_KEY / ANTHROPIC_API_KEY 等
      // 通过 env 自动连上原生 provider，污染模型下拉。
      enabled_providers: [PUNKCODE_PROVIDER_ID],
      provider: {
        [PUNKCODE_PROVIDER_ID]: {
          name: "PunkcodeAI",
          npm: "@ai-sdk/openai-compatible",
          api: credentials.baseUrl,
          options: {
            baseURL: credentials.baseUrl,
            apiKey: credentials.apiKey,
          },
          models,
        },
      },
    })

    await reloadProviderState()
  } catch (error) {
    console.warn("failed to apply PunkcodeAI credentials", error)
  } finally {
    parentPort.postMessage({ type: "credentials-updated" })
  }
}

async function clearPunkcodeCredentials(): Promise<void> {
  try {
    delete process.env.OPENCODE_AUTH_CONTENT
    delete process.env.OPENCODE_CONFIG_CONTENT
    await reloadProviderState()
  } catch (error) {
    console.warn("failed to clear PunkcodeAI credentials", error)
  } finally {
    parentPort.postMessage({ type: "credentials-updated" })
  }
}

/**
 * 让 sidecar 内已经缓存的 InstanceState（Provider / Config / ...）作废，
 * 下一次 HTTP 请求触发 instance load 时会读到最新 env。
 *
 * 注意：sidecar 启动早期（start() 还没把 server 立起来）调用此函数也是安全的，
 * 因为还没有任何 instance load 过；virtual:opencode-server 模块此时已 import。
 */
async function reloadProviderState(): Promise<void> {
  try {
    const { InstanceRuntime } = await import("virtual:opencode-server")
    await InstanceRuntime.disposeAllInstances()
  } catch (error) {
    console.warn("failed to dispose instances after credentials change", error)
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
