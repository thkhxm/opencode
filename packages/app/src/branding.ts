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
 * 注入方式（按优先级）：
 *   1. packages/desktop/.env.production 中的 PUNKCODE_API_BASE_URL
 *      （electron-vite 自动 expose 到 import.meta.env，模板见 packages/desktop/.env.production.example）
 *   2. 默认 fallback：https://punkcodeai.myverse.site
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

/**
 * 是否强制使用 opencode 的「稳定经典布局」，关闭实验性 V2 新布局（newLayoutDesigns）。
 *
 * 背景（#4 打开会话后左右栏都不见了）：
 *   upstream opencode 有一套实验性「new layout designs」(V2)，由 settings.general.
 *   newLayoutDesigns 控制，默认值 = `VITE_OPENCODE_CHANNEL !== "prod"`。
 *   桌面端 renderer 构建（electron.vite.config.ts）并未注入 VITE_OPENCODE_CHANNEL，
 *   所以它恒为 undefined → 默认值恒为 true → 桌面端默认跑 V2 布局。
 *
 *   而 V2 布局在 layout.tsx 里走的是「只渲染 <main>、不渲染左侧 project/session
 *   sidebar nav」的分支，且 session-header 把 search/fileTree/terminal/status 也
 *   默认关掉——表现就是「打开会话后左侧项目栏 + 右侧信息栏都没有」。V2 是上游未完成的
 *   实验设计，不适合作为 PunkcodeAI 产品默认。
 *
 *   因此 PunkcodeAI 桌面端强制用稳定经典布局：左侧项目/会话 sidebar + 右侧 review/
 *   file-tree 面板都正常渲染。该开关把 newLayoutDesigns 的默认值钉死为 false。
 *
 * 注：新建会话空状态页因此走经典 NewSessionView（小号 Mark logo，已在 #1 一并脱敏成
 * PunkcodeAI 文字 logo），不再是 V2 的 opencode 大像素 wordmark 水印。
 */
export const FORCE_STABLE_LAYOUT = true
