/**
 * 路由守卫：未登录时把用户重定向到 `/login`。
 *
 * 包裹**所有需登录的路由**（/、/:dir/...）。/login 和 /register 不要套这层。
 *
 * 实现细节（M7 P2-C 修复）：
 *   - bootstrap **进行中**（`auth.bootstrapping() === true`）→ 渲染一个中性的 splash（Logo + Loading），
 *     不再立即 navigate('/login')。这样冷启动时已登录用户不会看到 /login 闪一下再被自动登录回来。
 *   - bootstrap **结束后**：
 *       isLoggedIn() === true  → 渲染 children
 *       isLoggedIn() === false → navigate('/login', { replace: true })
 *   - 用 `createEffect` 观察响应式状态变化，未登录立即跳转；不渲染 children——避免页面闪一下。
 */

import { createEffect, createSignal, onCleanup, type JSX, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { useLanguage } from "@/context/language"
import { useAuth } from "@/stores/auth"

/** splash 显示多久后冒出「连接慢，可重试/去登录」兜底操作（ms）。 */
const SLOW_HINT_DELAY_MS = 5000

export function AuthGate(props: { children?: JSX.Element }): JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()
  const language = useLanguage()

  // splash 显示超过 SLOW_HINT_DELAY_MS 仍在 bootstrap → 给用户「重试 / 去登录」的逃生口，
  // 避免只能干瞪着一颗永久 pulse 的 logo（启动慢/连不上后端时的体验兜底）。
  const [slow, setSlow] = createSignal(false)
  createEffect(() => {
    if (!auth.bootstrapping()) {
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), SLOW_HINT_DELAY_MS)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(() => {
    // bootstrap 还在跑 → 让 splash 兜着，先不跳。
    if (auth.bootstrapping()) return
    if (!auth.isLoggedIn()) {
      navigate("/login", { replace: true })
    }
  })

  // 重试：重载整个 renderer，重新跑 ensureBootstrap（最可靠、零残留）。非浏览器环境 no-op。
  const retry = () => {
    if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
      window.location.reload()
    }
  }

  return (
    <Show
      when={auth.bootstrapping()}
      fallback={<Show when={auth.isLoggedIn()}>{props.children}</Show>}
    >
      <div class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background-base gap-4">
        {/* splash 期间无 Titlebar，补顶部可拖动区保持与 login 一致 */}
        <div data-tauri-drag-region class="absolute top-0 left-0 right-0 h-10" />
        <Splash class="w-40 h-16 opacity-60 animate-pulse" />
        <p class="text-12-regular text-text-weak">
          {slow() ? language.t("bootstrap.slow") : language.t("bootstrap.loading")}
        </p>
        <Show when={slow()}>
          <div class="flex items-center gap-2">
            <Button size="small" variant="secondary" onClick={retry}>
              {language.t("bootstrap.retry")}
            </Button>
            <Button size="small" variant="ghost" onClick={() => navigate("/login", { replace: true })}>
              {language.t("bootstrap.goToLogin")}
            </Button>
          </div>
        </Show>
      </div>
    </Show>
  )
}
