/**
 * 路由守卫：未登录时把用户重定向到 `/login`。
 *
 * 包裹**所有需登录的路由**（/、/:dir/...）。/login 和 /register 不要套这层。
 *
 * 实现细节：
 *   - 用 `createEffect` 观察 `useAuth().isLoggedIn()` 的反应式变化。
 *   - 未登录立即 `navigate("/login", { replace: true })`，**不渲染 children**——避免
 *     页面闪一下需登录内容再被踢出去。
 *   - bootstrap 还在进行中（refresh token 复活会话）时也算"未登录"——`/login` 页面会
 *     在 bootstrap 完成后被 `/` 抢回控制权（再次 effect 触发）。
 */

import { createEffect, type JSX, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useAuth } from "@/stores/auth"

export function AuthGate(props: { children?: JSX.Element }): JSX.Element {
  const auth = useAuth()
  const navigate = useNavigate()

  createEffect(() => {
    if (!auth.isLoggedIn()) {
      navigate("/login", { replace: true })
    }
  })

  return <Show when={auth.isLoggedIn()}>{props.children}</Show>
}
