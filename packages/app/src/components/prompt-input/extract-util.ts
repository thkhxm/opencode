/**
 * 大文件提取的纯函数工具（无 vite / pdfjs / DOM 依赖）。
 *
 * 单独成文件的原因：extract.ts 里 `import "...pdf.worker.min.mjs?url"` 是 vite 专属语法，
 * bun test 解析不了。把不依赖 vite 的纯逻辑（base64 / 截断 / CSV / mime 判定）抽到这里，
 * 既能被 extract.ts 复用，也能在 bun 单测里直接 import 验证（见 extract-util.test.ts）。
 */

/**
 * 文本体积软上限（字节）。
 *
 * 取 ~0.55 MB：punkcode 主力 gpt-5 系列 context_window 272000 token，单 token 约 ~4 字符英文 / ~2 中文，
 * 留足 system + 历史 + 输出后，单份附件文本控制在 ~0.5-0.6MB 比较安全，避免 context_length_exceeded。
 */
export const MAX_TEXT_BYTES = 550_000

/** 单个 sheet 最多导出的行数（含表头）。大表截断避免塞爆 context。 */
export const MAX_SHEET_ROWS = 5000

/** UTF-8 安全的 base64 编码（btoa 只接受 latin1，中文会乱码 / 抛错）。 */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * 把文本按字节上限截断（二分按字符回退，避免切坏多字节字符）。
 * 截断时往 notices 追加一条软提示。
 */
export function clampText(text: string, label: string, notices: string[]): string {
  if (byteLength(text) <= MAX_TEXT_BYTES) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (byteLength(text.slice(0, mid)) <= MAX_TEXT_BYTES) lo = mid
    else hi = mid - 1
  }
  // 若截断点正好落在 surrogate pair 中间（末位是孤立高位代理项），回退 1 位，
  // 避免 slice 产生孤立代理项被编码成替换字符（影响 emoji 等星形面字符）。
  if (lo > 0 && text.charCodeAt(lo - 1) >= 0xd800 && text.charCodeAt(lo - 1) <= 0xdbff) lo--
  notices.push(
    `${label}：内容过大已截断到约 ${Math.round(MAX_TEXT_BYTES / 1024)}KB（避免超出模型上下文）。如需完整分析请拆分文件。`,
  )
  return text.slice(0, lo) + "\n\n[... 内容已截断 ...]"
}

/** 一个 CSV 单元格的转义：含逗号 / 引号 / 换行的加引号并把内部引号翻倍。 */
export function csvCell(value: unknown): string {
  const str = value == null ? "" : String(value)
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

/** 把二维数组拼成 CSV 文本。 */
export function rowsToCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n")
}

/** 该 mime 是否需要走本地提取（而非直接 inline 给模型）。 */
export function needsExtraction(mime: string): boolean {
  return (
    mime === "application/pdf" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
}

/** 单个 PDF 一次最多渲染的页数。超出不再要求用户手动分批，而是 sampleEvenly 均匀抽样到这个数覆盖全文。 */
export const MAX_PDF_RENDER_PAGES = 100

/** 单页渲染的最高短边分辨率（px）。少量图时用它，页多时按 pickRenderDim 降档。 */
export const PDF_RENDER_MAX_DIM = 1600

/**
 * 按"实际要渲染的含图页数"自适应选单页短边分辨率（px）：页越多分辨率越低，把整本 PDF
 * 的图压进单次 272k context 的 token 预算内（每页图 token 随分辨率平方下降）。这样含图
 * 特别多的大 PDF 也能单次覆盖全文，不需要用户手动拆分分批（方案 A：智能降采样自适应）。
 */
export function pickRenderDim(pageCount: number): number {
  if (pageCount <= 30) return PDF_RENDER_MAX_DIM // 高清：少量图，正常阅读分辨率
  if (pageCount <= 60) return 1100
  if (pageCount <= 90) return 800
  return 600 // 大量图：低清但仍可辨认图表趋势 / 版面 / 大字
}

/**
 * 从候选页里均匀抽样 target 页（保持升序、均匀分布在整个文档而非只取前半），
 * 保证"覆盖全文"而不是"只看开头"。pages.length ≤ target 时原样返回。
 */
export function sampleEvenly(pages: number[], target: number): number[] {
  if (target <= 0) return []
  if (pages.length <= target) return pages
  const out: number[] = []
  const step = pages.length / target
  for (let i = 0; i < target; i++) out.push(pages[Math.floor(i * step)]!)
  return out
}
