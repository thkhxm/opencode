import { describe, expect, test } from "bun:test"
import { attachmentMime } from "./files"
import { pasteMode } from "./paste"

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })

  test("detects docx by browser mime", async () => {
    const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    const file = new File([Uint8Array.of(0x50, 0x4b, 3, 4)], "doc.docx", { type: mime })
    expect(await attachmentMime(file)).toBe(mime)
  })

  test("detects xlsx by extension when browser mime is empty", async () => {
    const file = new File([Uint8Array.of(0x50, 0x4b, 3, 4)], "sheet.xlsx", { type: "" })
    expect(await attachmentMime(file)).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
  })

  test("detects docx by extension when browser mime is octet-stream", async () => {
    const file = new File([Uint8Array.of(0x50, 0x4b, 3, 4)], "doc.docx", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})
