/**
 * PunkcodeAI 注册页。
 *
 * 路径：/register（在 app.tsx 中注册）
 * 表单：邮箱 + 密码 + 昵称 → sub2api `/api/v1/cli/register`。
 * 成功后直接登录态写入并跳 /。
 */

import { Component, createEffect, createSignal, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { AccountError, CredentialsError, useAuth } from "@/stores/auth"
import { PRODUCT_NAME } from "@/branding"

const Register: Component = () => {
  const auth = useAuth()
  const navigate = useNavigate()
  const language = useLanguage()

  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [nickname, setNickname] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)

  createEffect(() => {
    if (auth.isLoggedIn()) navigate("/", { replace: true })
  })

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault()
    if (submitting()) return
    setErrorMessage(null)
    setSubmitting(true)
    try {
      await auth.signUp({
        email: email().trim(),
        password: password(),
        nickname: nickname().trim(),
      })
      navigate("/", { replace: true })
    } catch (err) {
      if (err instanceof CredentialsError) {
        setErrorMessage(language.t("auth.register.failed", { reason: err.message }))
      } else if (err instanceof AccountError) {
        setErrorMessage(language.t("auth.register.failed", { reason: err.message }))
      } else {
        setErrorMessage(language.t("auth.register.failed", { reason: String(err) }))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="relative flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-background-base font-sans">
      {/* 同 login.tsx：注册页无 Titlebar，补顶部可拖动区。 */}
      <div data-tauri-drag-region class="absolute top-0 left-0 right-0 h-10" />
      <div class="w-full max-w-sm flex flex-col items-center justify-center gap-6 px-6">
        {/* PunkcodeAI 文字 logo（替换原 opencode 矢量字 logo）：mono 字体呼应原像素/geek 风 */}
        <div class="font-mono text-3xl font-bold tracking-tight text-text-strong select-none shrink-0">
          {PRODUCT_NAME}
        </div>
        <div class="flex flex-col items-center gap-1 text-center">
          <h1 class="text-lg font-medium text-text-strong">{language.t("auth.register.title")}</h1>
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
            autocomplete="new-password"
            required
            value={password()}
            onChange={(value) => setPassword(value)}
            disabled={submitting()}
          />
          <TextField
            label={language.t("auth.register.nickname")}
            type="text"
            autocomplete="nickname"
            required
            value={nickname()}
            onChange={(value) => setNickname(value)}
            disabled={submitting()}
          />
          <Show when={errorMessage()}>
            {(msg) => <p class="text-xs text-text-danger-base text-center">{msg()}</p>}
          </Show>
          <Button type="submit" size="large" variant="primary" disabled={submitting()}>
            {language.t("auth.register.submit")}
          </Button>
        </form>
        <button
          type="button"
          class="text-sm text-text-interactive-base hover:underline disabled:opacity-50"
          onClick={() => navigate("/login")}
          disabled={submitting()}
        >
          {language.t("auth.register.toLogin")}
        </button>
      </div>
    </div>
  )
}

export default Register
