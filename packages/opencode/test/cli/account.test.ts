import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"

import { defaultConsoleUrl, formatAccountLabel, formatOrgLine } from "../../src/cli/cmd/account"

describe("console account display", () => {
  test("defaults the login URL to punkcodeai.myverse.site when env var unset", () => {
    // PunkcodeAI 集成：默认 console URL 改为 punkcodeai 后台；
    // dev 通过 PUNKCODE_API_BASE_URL=http://localhost:38080 覆盖。
    // 注意：单测里直接断言 defaultConsoleUrl，若运行测试时已设置 PUNKCODE_API_BASE_URL，
    // 这里允许命中环境变量值，否则必须落到默认 punkcode 域名。
    const expected = process.env["PUNKCODE_API_BASE_URL"] ?? "https://punkcodeai.myverse.site"
    expect(defaultConsoleUrl).toBe(expected)
  })

  test("includes the account url in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, false))).toBe(
      "one@example.com https://one.example.com",
    )
  })

  test("includes the active marker in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, true))).toBe(
      "one@example.com https://one.example.com (active)",
    )
  })

  test("includes the account url in org rows", () => {
    expect(
      stripAnsi(
        formatOrgLine({ email: "one@example.com", url: "https://one.example.com" }, { id: "org-1", name: "One" }, true),
      ),
    ).toBe("  ● One  one@example.com  https://one.example.com  org-1")
  })
})
