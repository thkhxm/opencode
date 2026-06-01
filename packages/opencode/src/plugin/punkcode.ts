import type { Hooks, PluginInput } from "@opencode-ai/plugin"

/**
 * PunkcodeAI（sub2api 桌面端内置 provider）的内置插件。
 *
 * 唯一职责：给 punkcodeai provider 的每次请求注入 **codex 识别头**，
 * 让 sub2api 的 isCodexCLI 判定为 true，从而在 /v1/responses 上触发
 * image_generation bridge（注入图片生成工具 + 真出图）。
 *
 * 背景：
 *   - sub2api 的 image_generation bridge 只在
 *     【请求走 /responses 协议】且【originator / User-Agent 以 "codex" 前缀开头】时才生效。
 *   - 协议侧已由 provider.ts 的 custom() punkcodeai 分支（sdk.responses）+ sidecar
 *     注入的 npm:@ai-sdk/openai 配置保证（命中 /v1/responses）。
 *   - 但 opencode 默认不会给非 openai provider 设 codex 头；codex.ts 内置插件设的
 *     originator:"opencode" / UA:"opencode/<ver>" 又不算 codex 前缀。
 *   - 所以这里专门为 punkcodeai 设 codex_cli_rs 身份头，补齐 bridge 触发条件。
 *
 * 鉴权不受影响：Authorization: Bearer sk-... 仍由 @ai-sdk/openai 按 apiKey 注入，
 * sub2api ApiKeyAuth 正常识别；本插件只追加身份头，不动鉴权。
 *
 * 取值参照实测打通 bridge 的 curl：
 *   originator: codex_cli_rs
 *   User-Agent: codex_cli_rs/0.125.0
 */

const PUNKCODE_PROVIDER_ID = "punkcodeai"

// 与运行时验证（curl 打通 bridge）一致的 codex CLI 身份标识。
// originator 是 sub2api isCodexCLI 主要识别字段；User-Agent 作为兜底（同样 codex 前缀）。
const CODEX_ORIGINATOR = "codex_cli_rs"
const CODEX_USER_AGENT = "codex_cli_rs/0.125.0"

export async function PunkcodeAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== PUNKCODE_PROVIDER_ID) return
      // sub2api isCodexCLI=true 触发 image_generation bridge 的关键身份头。
      output.headers.originator = CODEX_ORIGINATOR
      output.headers["User-Agent"] = CODEX_USER_AGENT
    },
  }
}
