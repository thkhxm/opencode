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
