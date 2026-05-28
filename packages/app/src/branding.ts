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
