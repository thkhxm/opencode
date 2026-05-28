/**
 * PunkcodeAI 登录页。
 *
 * 路径：/login（在 app.tsx 中注册）
 * 风格：参考 `pages/error.tsx`——居中卡片 + Logo + TextField + Button。
 * 表单：邮箱 + 密码 → sub2api `/api/v1/cli/login`。
 *
 * 错误处理：
 *   - `CredentialsError`：sub2api 返业务错（密码错、邮箱未注册等），用 `envelope.message`。
 *   - `AccountError`：网络故障 / 5xx，提示通用"无法连接服务"。
 */

import { Component, createEffect, createSignal, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Logo } from "@opencode-ai/ui/logo"
import { useLanguage } from "@/context/language"
import { AccountError, CredentialsError, useAuth } from "@/stores/auth"
import { PRODUCT_NAME } from "@/branding"

const Login: Component = () => {
  const auth = useAuth()
  const navigate = useNavigate()
  const language = useLanguage()

  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)

  // 已登录用户直接拍回首页（防止刷新页面后停留在 /login）。
  createEffect(() => {
    if (auth.isLoggedIn()) navigate("/", { replace: true })
  })

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault()
    if (submitting()) return
    setErrorMessage(null)
    setSubmitting(true)
    try {
      await auth.signIn({ email: email().trim(), password: password() })
      navigate("/", { replace: true })
    } catch (err) {
      if (err instanceof CredentialsError) {
        setErrorMessage(language.t("auth.login.failed", { reason: err.message }))
      } else if (err instanceof AccountError) {
        setErrorMessage(language.t("auth.login.failed", { reason: err.message }))
      } else {
        setErrorMessage(language.t("auth.login.failed", { reason: String(err) }))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-background-base font-sans">
      <div class="w-full max-w-sm flex flex-col items-center justify-center gap-6 px-6">
        <Logo class="w-40 opacity-60 shrink-0" />
        <div class="flex flex-col items-center gap-1 text-center">
          <h1 class="text-lg font-medium text-text-strong">{language.t("auth.login.title")}</h1>
          <p class="text-sm text-text-weak">{PRODUCT_NAME}</p>
        </div>
        <form class="flex flex-col gap-3 w-full" onSubmit={onSubmit}>
          <TextField
            label={language.t("auth.login.email")}
            type="email"
            autocomplete="username"
            required
            value={email()}
            onChange={(value) => setEmail(value)}
            disabled={submitting()}
          />
          <TextField
            label={language.t("auth.login.password")}
            type="password"
            autocomplete="current-password"
            required
            value={password()}
            onChange={(value) => setPassword(value)}
            disabled={submitting()}
          />
          <Show when={errorMessage()}>
            {(msg) => <p class="text-xs text-text-danger-base text-center">{msg()}</p>}
          </Show>
          <Button type="submit" size="large" variant="primary" disabled={submitting()}>
            {language.t("auth.login.submit")}
          </Button>
        </form>
        <button
          type="button"
          class="text-sm text-text-interactive-base hover:underline disabled:opacity-50"
          onClick={() => navigate("/register")}
          disabled={submitting()}
        >
          {language.t("auth.login.toRegister")}
        </button>
      </div>
    </div>
  )
}

export default Login
