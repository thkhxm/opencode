import { describe, expect, test } from "bun:test"
import { dedupeImageVariants, imageExt, stemOf } from "./diff-media-dedupe"

const d = (file: string) => ({ file })
const files = (diffs: { file: string }[]) => diffs.map((x) => x.file)

describe("imageExt", () => {
  test("returns lowercased image extension", () => {
    expect(imageExt("a/b.PNG")).toBe("png")
    expect(imageExt("x.jpeg")).toBe("jpeg")
  })
  test("returns null for non-image / no extension", () => {
    expect(imageExt("readme.md")).toBeNull()
    expect(imageExt("Makefile")).toBeNull()
    expect(imageExt("script.ts")).toBeNull()
  })
})

describe("stemOf", () => {
  test("strips the extension but keeps the directory", () => {
    expect(stemOf("dir/sub/img.png")).toBe("dir/sub/img")
    expect(stemOf("img.jpg")).toBe("img")
    expect(stemOf("noext")).toBe("noext")
  })
})

describe("dedupeImageVariants", () => {
  test("collapses same-name png + jpg into the png only", () => {
    const out = dedupeImageVariants([d("out/cat.png"), d("out/cat.jpg")])
    expect(files(out)).toEqual(["out/cat.png"])
  })

  test("keeps png even when jpg appears first, preserving the png's position", () => {
    const out = dedupeImageVariants([d("a.jpg"), d("a.png"), d("notes.md")])
    expect(files(out)).toEqual(["a.png", "notes.md"])
  })

  test("keeps the only available format when there is no png", () => {
    expect(files(dedupeImageVariants([d("x.jpg")]))).toEqual(["x.jpg"])
    expect(files(dedupeImageVariants([d("x.webp"), d("x.jpg")]))).toEqual(["x.webp"]) // webp 优先于 jpg
  })

  test("does not merge same name in different directories", () => {
    const out = dedupeImageVariants([d("a/logo.png"), d("b/logo.jpg")])
    expect(files(out)).toEqual(["a/logo.png", "b/logo.jpg"])
  })

  test("leaves non-image diffs untouched and in order", () => {
    const out = dedupeImageVariants([d("src/main.ts"), d("img.png"), d("img.jpg"), d("README.md")])
    expect(files(out)).toEqual(["src/main.ts", "img.png", "README.md"])
  })

  test("dedupes multiple png of same stem to the first one", () => {
    // 两个同 stem 的 png（理论上不会，但保证幂等不报错）：留先出现的。
    const first = d("x.png")
    const out = dedupeImageVariants([first, d("x.png")])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(first)
  })

  test("handles several independent images", () => {
    const out = dedupeImageVariants([d("a.png"), d("a.jpg"), d("b.png"), d("c.jpg"), d("c.png")])
    expect(files(out)).toEqual(["a.png", "b.png", "c.png"])
  })
})
