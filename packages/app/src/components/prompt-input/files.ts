import { ACCEPTED_FILE_TYPES, ACCEPTED_IMAGE_TYPES } from "@/constants/file-picker"

export { ACCEPTED_FILE_TYPES }

const IMAGE_MIMES = new Set(ACCEPTED_IMAGE_TYPES)
const IMAGE_EXTS = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

const SAMPLE = 4096

/**
 * 需要 renderer 本地提取的 Office 文档（docx / xlsx）。
 *
 * 这些 OOXML 二进制本来会被 textBytes() 判成二进制而拒收；这里显式识别它们的 mime / 扩展名，
 * 返回真实 mime，交给 attachments.ts 走 extract.ts 本地提取（见 M11 大文件分析增强）。
 * 注意：legacy .doc / .xls（CFB 二进制）不在支持范围（mammoth/SheetJS 对它们支持有限）。
 */
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const OFFICE_MIMES = new Set([DOCX_MIME, XLSX_MIME])
const OFFICE_EXTS = new Map([
  ["docx", DOCX_MIME],
  ["xlsx", XLSX_MIME],
])

function kind(type: string) {
  return type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function ext(name: string) {
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx + 1).toLowerCase()
}

function textMime(type: string) {
  if (!type) return false
  if (type.startsWith("text/")) return true
  if (TEXT_MIMES.has(type)) return true
  if (type.endsWith("+json")) return true
  return type.endsWith("+xml")
}

function textBytes(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  let count = 0
  for (const byte of bytes) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) count += 1
  }
  return count / bytes.length <= 0.3
}

export async function attachmentMime(file: File) {
  const type = kind(file.type)
  if (IMAGE_MIMES.has(type)) return type
  if (type === "application/pdf") return type
  if (OFFICE_MIMES.has(type)) return type

  const suffix = ext(file.name)
  // docx / xlsx：浏览器/系统给的 type 经常是空 / octet-stream / 误判，按扩展名兜底识别真实 mime。
  const officeFallback = OFFICE_EXTS.get(suffix)
  if (officeFallback && (!type || type === "application/octet-stream" || OFFICE_MIMES.has(type))) {
    return officeFallback
  }
  const fallback = IMAGE_EXTS.get(suffix) ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!type || type === "application/octet-stream") && fallback) return fallback

  if (textMime(type)) return "text/plain"
  const bytes = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer())
  if (!textBytes(bytes)) return
  return "text/plain"
}
