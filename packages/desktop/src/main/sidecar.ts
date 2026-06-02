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
 * 判断一个 punkcode 模型是否支持 reasoning（思考模式）。
 *
 * 背景（#3 思考模式选择器缺失）：UI 的「思考模式」(reasoning effort: minimal/low/
 * medium/high) 选择器由 model.variants 驱动——core 端 `Provider.transform.variants()`
 * 只在 `capabilities.reasoning === true` 时才会自动给 @ai-sdk/openai 的 gpt-5 系列
 * 算出 reasoningEffort 变体（见 provider/transform.ts），否则返回 {}，导致 prompt-input
 * 的 variant 选择器（`<Show when={variants().length > 2}>`）永不出现。
 *
 * 之前所有模型硬编码 reasoning:false，所以思考模式选择器从来不显示。这里按 sub2api
 * `/cli/llm` 上报的模型 id 推断能力（与后端 isReasoningModel 对齐）：
 *   - gpt-5* 系列：reasoning-only 模型，开 reasoning（codex /responses 主力）
 *   - gpt-image* / dall-e*：图片生成模型，无 reasoning
 *   - 其余（gpt-4* 等）：默认无 reasoning
 *
 * 注：reasoning:true 后 variant 由 core 自动算（base gpt-5 → minimal/low/medium/high），
 * 无需在桌面端手写 variants，避免与上游 effort 表脱节。
 */
function modelSupportsReasoning(id: string): boolean {
  const lower = id.toLowerCase()
  if (lower.startsWith("gpt-image") || lower.startsWith("dall-e")) return false
  return lower.startsWith("gpt-5")
}

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
    //    npm 用 @ai-sdk/openai（codex /responses 协议），而非 @ai-sdk/openai-compatible
    //    （后者走 /v1/chat/completions）。理由：sub2api 的 image_generation bridge 只在
    //    【/responses 协议 + codex 识别头(originator/UA 以 codex 开头)】时才注入图片生成工具并真出图。
    //    走 @ai-sdk/openai 后：
    //      - provider.ts 的 custom() punkcodeai 分支用 sdk.responses(id) → 命中 /v1/responses；
    //      - provider/transform.ts options() 对 npm==="@ai-sdk/openai" 自动设 store:false →
    //        既匹配 codex CLI 行为，又保证【不发 previous_response_id】（SDK 只在显式传
    //        previousResponseId 时才发，opencode 从不传），规避 sub2api openai_gateway 对
    //        非 WSv2 请求带 previous_response_id 直接 400 的坑；
    //      - codex 识别头由内置 punkcode 插件的 chat.headers hook 注入（见 plugin/punkcode.ts）。
    //    每个模型尽量给完整 cost/limit/capabilities 字段，避免 Provider.transform 走 NaN 分支。
    const models: Record<string, unknown> = {}
    for (const model of credentials.models) {
      // context_window 由 sub2api /cli/llm 上报（gpt-5=272000 等）。缺失/为 0（如图片生成模型）时
      // 回退 128_000——与后端 contextWindowForCliModel 的 default 对齐，且取保守值，避免重现旧坑
      // （fallback 比真实容量大 → 误判"能塞更多" → context_length_exceeded）。
      const ctx = typeof model.context_window === "number" && model.context_window > 0 ? model.context_window : 128_000
      models[model.id] = {
        id: model.id,
        name: model.name,
        // 计费在 sub2api 网关侧统一结算，cost 字段对桌面端只起 UI 提示作用，全部置 0 即可。
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: { context: ctx, output: Math.min(ctx, 8192) },
        // output 放开 image：sub2api bridge 通过 responses 协议的 image_generation_call 返回真图，
        // 桌面端按 image_generation 工具结果（base64 PNG）渲染。
        modalities: { input: ["text", "image"], output: ["text", "image"] },
        attachment: true,
        // #3：按模型 id 推断 reasoning 能力（gpt-5* 系列开启）。开启后 core 的
        // Provider.transform.variants() 会自动算出思考模式（reasoning effort）变体，
        // UI 的思考模式选择器随之出现。非 reasoning 模型（图片生成等）保持 false。
        reasoning: modelSupportsReasoning(model.id),
        temperature: true,
        tool_call: true,
        provider: { npm: "@ai-sdk/openai", api: credentials.baseUrl },
      }
    }
    // imagegen skill 发现：主进程把 imagegen skill 目录的绝对路径放进 PUNKCODE_SKILLS_DIR
    //（dev 指向 D:/project/sub2api/skills/imagegen，打包指向 resources/skills/imagegen）。
    // 这里把它拼进 config 的 skills.paths——opencode 的 discoverSkills 会对该路径用
    // `**/SKILL.md` 扫描，从而发现并加载 imagegen skill（强 description 让模型在编程上下文也主动调它）。
    // env 缺失时不注入 skills 字段，优雅降级（不影响其它功能）。
    const skillsDir = process.env.PUNKCODE_SKILLS_DIR
    const config: Record<string, unknown> = {
      // 限定只允许 punkcodeai——避免 shell 里残留的 OPENAI_API_KEY / ANTHROPIC_API_KEY 等
      // 通过 env 自动连上原生 provider，污染模型下拉。
      enabled_providers: [PUNKCODE_PROVIDER_ID],
      provider: {
        [PUNKCODE_PROVIDER_ID]: {
          name: "PunkcodeAI",
          npm: "@ai-sdk/openai",
          api: credentials.baseUrl,
          options: {
            // @ai-sdk/openai 默认打 https://api.openai.com/v1；显式 baseURL 指回 sub2api 的 <baseUrl>/v1，
            // 鉴权保持 sk-key（Authorization: Bearer sk-...，sub2api ApiKeyAuth 认得），不切 OAuth。
            baseURL: credentials.baseUrl,
            apiKey: credentials.apiKey,
          },
          models,
        },
      },
    }
    if (skillsDir && skillsDir.length > 0) {
      config.skills = { paths: [skillsDir] }
    }
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)

    // 3) OPENAI_API_KEY / OPENAI_BASE_URL：给 imagegen skill 的 scripts/image_gen.py 用。
    //    背景：桌面端 sk-key 只在本进程 env 的 OPENCODE_AUTH_CONTENT / OPENCODE_CONFIG_CONTENT 里，
    //    image_gen.py 的凭据发现顺序（① OPENAI_API_KEY env → ② opencode.json 文件 → ③ auth.json 文件）
    //    的 ②③ 都读「磁盘配置文件」，拿不到桌面端的 env-only 凭据。所以这里走 ① 直接注入 env。
    //    shell/bash 工具 spawn 子进程时会 spread 整个 process.env（见 tool/shell.ts shellEnv），
    //    image_gen.py 作为 bash 子进程自然继承到这两个 env。
    //    baseUrl 来自 /cli/llm 的 base_url，已含 /v1（如 http://host:38080/v1）；OpenAI SDK 会拼成
    //    <OPENAI_BASE_URL>/images/generations → <baseUrl>/v1/images/generations，命中 sub2api 端点。
    process.env.OPENAI_API_KEY = credentials.apiKey
    process.env.OPENAI_BASE_URL = credentials.baseUrl

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
    // 退出登录 / 切换账号时也清掉 imagegen skill 用的 env 凭据，杜绝上一账号 key 残留。
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL
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
