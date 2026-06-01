import { describe, expect, test } from "bun:test"
import {
  MAX_PDF_RENDER_PAGES,
  MAX_TEXT_BYTES,
  byteLength,
  clampText,
  csvCell,
  needsExtraction,
  pickRenderDim,
  rowsToCsv,
  sampleEvenly,
  utf8ToBase64,
} from "./extract-util"

describe("utf8ToBase64", () => {
  test("round-trips ASCII", () => {
    expect(atob(utf8ToBase64("hello"))).toBe("hello")
  })

  test("encodes multibyte UTF-8 (中文) without corruption", () => {
    const text = "你好，世界 🌏"
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(utf8ToBase64(text)), (c) => c.charCodeAt(0)))
    expect(decoded).toBe(text)
  })
})

describe("clampText", () => {
  test("keeps small text untouched and adds no notice", () => {
    const notices: string[] = []
    const text = "small text"
    expect(clampText(text, "a.txt", notices)).toBe(text)
    expect(notices).toHaveLength(0)
  })

  test("truncates oversized text within the byte budget and notes it", () => {
    const notices: string[] = []
    const big = "字".repeat(400_000) // ~1.2MB utf-8
    const out = clampText(big, "big.xlsx", notices)
    expect(byteLength(out)).toBeLessThanOrEqual(MAX_TEXT_BYTES + 64) // + 截断提示后缀
    expect(out.endsWith("[... 内容已截断 ...]")).toBe(true)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("已截断")
  })

  test("does not split a multibyte char at the boundary", () => {
    const notices: string[] = []
    const big = "你".repeat(300_000)
    const out = clampText(big, "x", notices).replace("\n\n[... 内容已截断 ...]", "")
    // 每个 "你" 占 3 字节，截断必须落在字符边界（长度 * 3 = 字节数）。
    expect(byteLength(out)).toBe(out.length * 3)
  })
})

describe("csvCell / rowsToCsv", () => {
  test("escapes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""')
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"')
    expect(csvCell("plain")).toBe("plain")
    expect(csvCell(null)).toBe("")
    expect(csvCell(42)).toBe("42")
  })

  test("joins rows into CSV", () => {
    expect(rowsToCsv([["a", "b"], [1, "x,y"]])).toBe('a,b\n1,"x,y"')
  })
})

describe("needsExtraction", () => {
  test("matches pdf / docx / xlsx mimes", () => {
    expect(needsExtraction("application/pdf")).toBe(true)
    expect(needsExtraction("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true)
    expect(needsExtraction("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true)
  })

  test("does not match images / text", () => {
    expect(needsExtraction("image/png")).toBe(false)
    expect(needsExtraction("text/plain")).toBe(false)
  })
})

describe("sampleEvenly", () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

  test("returns input unchanged when within target", () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3])
    expect(sampleEvenly([], 5)).toEqual([])
  })

  test("samples down to exactly target length", () => {
    expect(sampleEvenly(range(300), MAX_PDF_RENDER_PAGES)).toHaveLength(MAX_PDF_RENDER_PAGES)
    expect(sampleEvenly(range(1000), 100)).toHaveLength(100)
  })

  test("keeps ascending order and starts from the first page", () => {
    const out = sampleEvenly(range(300), 100)
    expect(out[0]).toBe(1)
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!)
  })

  test("spreads across the whole document, not just the head", () => {
    const out = sampleEvenly(range(300), 100)
    // 末个抽样页应接近文档尾部（覆盖全文），而不是停在前 100 页。
    expect(out[out.length - 1]!).toBeGreaterThan(250)
  })

  test("returns empty for non-positive target", () => {
    expect(sampleEvenly(range(10), 0)).toEqual([])
    expect(sampleEvenly(range(10), -1)).toEqual([])
  })
})

describe("pickRenderDim", () => {
  test("scales resolution down as page count grows", () => {
    expect(pickRenderDim(1)).toBe(1600)
    expect(pickRenderDim(30)).toBe(1600)
    expect(pickRenderDim(31)).toBe(1100)
    expect(pickRenderDim(60)).toBe(1100)
    expect(pickRenderDim(61)).toBe(800)
    expect(pickRenderDim(90)).toBe(800)
    expect(pickRenderDim(91)).toBe(600)
    expect(pickRenderDim(100)).toBe(600)
  })
})
