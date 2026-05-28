/**
 * 用户可见品牌常量（PunkcodeAI）。
 *
 * 后期更改品牌只需修改本文件的常量值；所有 UI 字符串均通过 import 引用，
 * 避免在 .vue/.tsx/.ts 中散落硬编码。
 *
 * 注意：内部技术 ID（如 `opencode-cli` 这种 API client_id、SQL 表名）保持不变，
 * 仅修改面向用户的展示字符串。
 */

/** 产品名称，桌面端 window title / About 弹窗 / 文档等显示 */
export const PRODUCT_NAME = "PunkcodeAI"

/**
 * 默认 sub2api 后端 API base URL。
 *
 * dev：通过 Vite define 注入 `import.meta.env.PUNKCODE_API_BASE_URL`
 * prod：默认指向 punkcodeai.myverse.site
 *
 * 用户在登录页可显式输入其他 URL 覆盖（写入 localStorage）。
 */
export const DEFAULT_API_BASE_URL: string =
  (import.meta.env as Record<string, string | undefined>).PUNKCODE_API_BASE_URL ??
  "https://punkcodeai.myverse.site"

/** GitHub Issues 反馈链接（保留 opencode，因为底层框架来自 opencode；用户感知不到这个 URL） */
export const ISSUE_TRACKER_URL = "https://github.com/thkhxm/opencode/issues"

/**
 * 是否隐藏所有 provider / API key / OAuth 配置入口。
 *
 * PunkcodeAI 桌面端用户通过 sub2api 的账号统一计费、统一管理模型，
 * 不需要在 UI 里看到"添加 OpenAI Key / 添加 Anthropic OAuth / 自定义 provider"等入口。
 *
 * 这个开关同时关闭：
 *   - 命令面板的 "connect provider"
 *   - Layout 侧栏的 "getting started → connect provider"
 *   - Settings 弹窗的 Providers / Models 两个 tab
 *   - 模型选择弹窗 / 弹层的"添加 provider / 管理模型"按钮
 *
 * 模型下拉本身保留，让用户能切换模型。M6 接 `/cli/llm` 后下拉会显示真实模型列表。
 */
export const HIDE_PROVIDER_UI = true
