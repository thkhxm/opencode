/**
 * 大文件附件提取（PDF / Word / Excel → 纯文本 [+ 图片]）。
 *
 * 背景（M11）：
 *   - punkcode 模式下模型 modality 只支持 text + image，直接把 PDF data URL 当 file part 发会被
 *     `provider/transform.ts` 的 modality 过滤拒掉（“模型不支持 pdf”）。
 *   - Word / Excel 二进制更是直接被 `prompt-input/files.ts` 的 `attachmentMime()` 拒收。
 *   - codex 走 bash 调 pdftotext / python 依赖本机装了这些工具——最终用户机器大概率没有 → 分析失败。
 *
 * 方案：在 **renderer 本地** 用纯 JS 库提取，产出 text part（绕开 pdf modality）+ 含图 PDF 渲染成
 * image part（走 vision，复用 sidecar 端 image/image.ts 的 5MB 压缩）。完全不依赖本机命令行工具。
 *
 * 提取结果一律表达成若干 `ExtractedAttachment`：
 *   - kind="text"：mime=text/plain 的 data URL，server 端 prompt.ts 见到 data:text/plain 直接 decode 成
 *     synthetic text，从不进 modality 过滤；
 *   - kind="image"：mime=image/jpeg 的 data URL（PDF 页面渲染），走 image modality，sidecar 端 photon
 *     会再压一道（≤5MB / ≤2000px），renderer 这里先做一次缩放降低体积。
 *
 * 调用方（attachments.ts）拿到这些结果后逐个塞成 ImageAttachmentPart（text/plain 的也复用同一壳，
 * build-request-parts.ts 会把它当 file part 发；UI 的 image-attachments.tsx 对非 image/ mime 已有
 * 文件图标兜底，无需改）。
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist"
// pdfjs-dist 体积大（库 + worker 共 ~2MB），用动态 import 让它只在用户真的拖了 PDF 时才进内存，
// 不污染 session 路由初始 chunk（与 xlsx / mammoth 同样懒加载）。
// worker 资源用 `?url` 静态引入——vite 据此把 worker .mjs 产出成独立 hash 资源并返回其 URL 字符串
// （本身不含 worker 代码，体积可忽略）。在 Electron renderer（Chromium）里 pdfjs 内部 new Worker(url)
// 能正常加载该 .mjs（vite worker.format='es' + target esnext）。不依赖 CDN / 本机命令行工具。
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import { MAX_SHEET_ROWS, clampText, needsExtraction, rowsToCsv, utf8ToBase64 } from "./extract-util"

// 转出 needsExtraction，让调用方（attachments.ts）只从 extract.ts 一处引入提取相关 API。
export { needsExtraction }

type PdfjsModule = typeof import("pdfjs-dist")

let pdfjsPromise: Promise<PdfjsModule> | null = null
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      // 用 workerSrc（指向 vite 产出的 worker URL）。pdfjs 内部会 new Worker(workerSrc, {type:'module'})。
      pdfjs.GlobalWorkerOptions.workerSrc = PdfWorker as unknown as string
      return pdfjs
    })
  }
  return pdfjsPromise
}

/** 提取产物的单元。一份文档可能拆成多个（文本 + 多页渲染图）。 */
export type ExtractedAttachment = {
  kind: "text" | "image"
  /** text/plain 或 image/jpeg */
  mime: string
  /** data URL（text/plain;base64 或 image/jpeg;base64） */
  dataUrl: string
  /** 展示用文件名（如 `report.pdf`、`report.pdf (第 3 页)`） */
  filename: string
}

export type ExtractResult = {
  attachments: ExtractedAttachment[]
  /** 软提示（截断 / 分批 / 大表）——调用方用 toast 呈现，可为空。 */
  notices: string[]
}

/** 单个 PDF 一次最多渲染的页数（含图 PDF 走 vision 时）。超出提示分批。
 *  注意：每页图 ≈ 1500~2500 视觉 token，100 页可能占用 ~20 万 token，叠加正文文字后
 *  会逼近 272k context 上限；含图很多的大 PDF 仍建议分批，渲染时会 toast 提示页数。 */
const MAX_PDF_RENDER_PAGES = 100

/** PDF 渲染缩放后短边目标上限（px）。再大交给 sidecar photon 进一步压。 */
const PDF_RENDER_MAX_DIM = 1600
/** PDF 渲染 JPEG 质量。 */
const PDF_RENDER_JPEG_QUALITY = 0.8

function textAttachment(text: string, filename: string): ExtractedAttachment {
  return {
    kind: "text",
    mime: "text/plain",
    dataUrl: `data:text/plain;base64,${utf8ToBase64(text)}`,
    filename,
  }
}

/**
 * 判定一页 PDF 是否“以图为主”（扫描件 / 大图）——文本极少但页面有大量绘制内容时，
 * 仅靠文本提取会丢信息，需要把页面渲染成图走 vision。
 */
function pageLooksImageHeavy(textLen: number): boolean {
  // 一页正文通常 ≥ 200 字符；远低于此（如扫描件 OCR 前）视为图为主。
  return textLen < 40
}

/**
 * 该页是否含位图图像对象（插图 / 图表截图 / 照片 / 印章 / 扫描页等）。
 *
 * 用 getOperatorList 检测绘制指令里有无 image XObject / inline image / image mask。
 * 矢量图形（path 绘制的 logo、图标、纯文字 logo）不算——它们的信息已由文字/结构承载，
 * 无需渲染走 vision，避免给带页眉矢量 logo 的纯文字文档徒增 token。
 *
 * 这是"智能渲染含图页"策略的核心：图文混排页（既有正文又有位图插图）由此被识别出来，
 * 文字照常抽取，同时整页渲染成图让模型用视觉读图，不再漏掉插图/图表的信息。
 */
async function pageHasBitmapImage(page: PDFPageProxy, OPS: PdfjsModule["OPS"]): Promise<boolean> {
  try {
    const { fnArray } = await page.getOperatorList()
    for (const fn of fnArray) {
      if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintImageXObjectRepeat ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintInlineImageXObjectGroup ||
        fn === OPS.paintImageMaskXObject ||
        fn === OPS.paintImageMaskXObjectGroup ||
        fn === OPS.paintImageMaskXObjectRepeat
      ) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

async function renderPdfPageToJpeg(doc: PDFDocumentProxy, pageNumber: number): Promise<string | null> {
  try {
    const page = await doc.getPage(pageNumber)
    const baseViewport = page.getViewport({ scale: 1 })
    const longest = Math.max(baseViewport.width, baseViewport.height)
    const scale = longest > PDF_RENDER_MAX_DIM ? PDF_RENDER_MAX_DIM / longest : 1
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    return canvas.toDataURL("image/jpeg", PDF_RENDER_JPEG_QUALITY)
  } catch {
    return null
  }
}

/**
 * PDF：逐页抽文本拼成一个 text part；含位图插图 / 图表 / 扫描页的页额外渲染成 image part 走 vision。
 *
 * - 纯文字 PDF（无位图）：只产 1 个 text part。
 * - 图文混排（正文 + 插图 / 图表 / 截图）：text part + 含图页渲染图（≤ MAX_PDF_RENDER_PAGES）。
 * - 扫描件 / 纯图：text part（可能很短 / 空）+ 各页渲染图。
 */
async function extractPdf(file: File): Promise<ExtractResult> {
  const pdfjs = await loadPdfjs()
  const notices: string[] = []
  const attachments: ExtractedAttachment[] = []
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjs.getDocument({ data }).promise
  try {
    const total = doc.numPages
    const textPieces: string[] = []
    const pagesToRender: number[] = []

    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim()
      if (pageText) textPieces.push(`--- 第 ${pageNumber} 页 ---\n${pageText}`)
      // 该页需要渲染成图走 vision 的两种情况（"智能渲染含图页"策略）：
      //  1) 扫描件 / 纯图页（几乎无文字）——仅靠文本会整页丢失；
      //  2) 图文混排但含位图插图 / 图表 / 截图——文字抽到了，但图承载的信息要靠视觉。
      // 矢量 logo / 图标不触发（见 pageHasBitmapImage），避免纯文字文档徒增 token。
      if (pageLooksImageHeavy(pageText.length) || (await pageHasBitmapImage(page, pdfjs.OPS))) {
        pagesToRender.push(pageNumber)
      }
    }

    const joined = textPieces.join("\n\n")
    if (joined.trim().length > 0) {
      attachments.push(textAttachment(clampText(joined, file.name, notices), file.name))
    }

    // 含图页（扫描件 / 图文混排的插图图表）渲染成 vision 图，让模型用视觉读图。
    if (pagesToRender.length > 0) {
      let pages = pagesToRender
      if (pages.length > MAX_PDF_RENDER_PAGES) {
        notices.push(
          `${file.name}：含图页 ${pages.length} 页超过单次 ${MAX_PDF_RENDER_PAGES} 页上限，仅渲染前 ${MAX_PDF_RENDER_PAGES} 页图像，其余请分批上传。`,
        )
        pages = pages.slice(0, MAX_PDF_RENDER_PAGES)
      } else {
        notices.push(`${file.name}：含图 / 图表页 ${pages.length} 页已一并渲染为图像供模型识别（会增加 token 用量）。`)
      }
      for (const pageNumber of pages) {
        const dataUrl = await renderPdfPageToJpeg(doc, pageNumber)
        if (dataUrl) {
          attachments.push({
            kind: "image",
            mime: "image/jpeg",
            dataUrl,
            filename: `${file.name} (第 ${pageNumber} 页)`,
          })
        }
      }
    }

    if (attachments.length === 0) {
      notices.push(`${file.name}：未能从该 PDF 提取到文本或可渲染页面。`)
    }
    return { attachments, notices }
  } finally {
    await doc.destroy()
  }
}

/** docx：mammoth 抽纯文本（extractRawText，浏览器 arrayBuffer 输入）。 */
async function extractDocx(file: File): Promise<ExtractResult> {
  const notices: string[] = []
  const mammoth = (await import("mammoth")).default
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  const text = result.value.trim()
  if (!text) {
    return { attachments: [], notices: [`${file.name}：未能从该 Word 文档提取到文本。`] }
  }
  return {
    attachments: [textAttachment(clampText(text, file.name, notices), file.name)],
    notices,
  }
}

/** xlsx：SheetJS 逐 sheet → CSV 文本拼成一个 text part。 */
async function extractXlsx(file: File): Promise<ExtractResult> {
  const notices: string[] = []
  const XLSX = await import("xlsx")
  const arrayBuffer = await file.arrayBuffer()
  const workbook = XLSX.read(arrayBuffer, { type: "array" })
  const pieces: string[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false }) as unknown[][]
    let used = rows
    if (rows.length > MAX_SHEET_ROWS) {
      used = rows.slice(0, MAX_SHEET_ROWS)
      notices.push(`${file.name} 工作表「${name}」共 ${rows.length} 行，已截断到前 ${MAX_SHEET_ROWS} 行。`)
    }
    pieces.push(`=== 工作表: ${name} ===\n${rowsToCsv(used)}`)
  }
  const text = pieces.join("\n\n").trim()
  if (!text) {
    return { attachments: [], notices: [`${file.name}：未能从该 Excel 提取到数据。`] }
  }
  return {
    attachments: [textAttachment(clampText(text, file.name, notices), file.name)],
    notices,
  }
}

/**
 * 对一个需要提取的文件做本地提取。调用方应先用 needsExtraction(mime) 判定。
 *
 * 失败（库抛错 / 解析不出）时返回带 notices 的空 attachments，由调用方提示用户。
 */
export async function extractAttachment(file: File, mime: string): Promise<ExtractResult> {
  try {
    if (mime === "application/pdf") return await extractPdf(file)
    if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      return await extractDocx(file)
    }
    if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      return await extractXlsx(file)
    }
    return { attachments: [], notices: [] }
  } catch (err) {
    return {
      attachments: [],
      notices: [`${file.name}：提取失败（${err instanceof Error ? err.message : String(err)}）。`],
    }
  }
}
