import { describe, expect, test } from "bun:test"
import {
  MAX_TEXT_BYTES,
  byteLength,
  clampText,
  csvCell,
  needsExtraction,
  rowsToCsv,
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
