/**
 * PunkcodeAI 桌面端余额 widget（M7）。
 *
 * 位置：通过 `<Portal mount=#opencode-titlebar-right>` 渲染到右上角 titlebar 区。
 *
 * 内容：
 *   - "$X.XX"（来自 store.user.balanceUsd）；< $1 时数字标红。
 *   - "today $Y.YY"（来自 store.user.usedTodayUsd）。
 *   - 刷新图标按钮（点 → 立即调 `/cli/me`，转动 spinner）。
 *   - "Top up" 按钮 → 打开 TopupDialog。
 *
 * 自动刷新：
 *   - mount 时立即拉一次（与 bootstrap 中的初拉互补，覆盖 signIn 路径下没拉 /cli/me 的情况）。
 *   - 30s `setInterval` 轮询。
 *   - 订阅 SDK 全局事件流的 `session.status` 事件：当状态变成 idle（chat stream 完成）时立即刷新；
 *     用 debounce 避免短时间内多次 idle 触发暴风刷新。
 *
 * 设计要点：
 *   - 只在已登录时挂载（由 layout.tsx 通过 `<Show when={auth.isLoggedIn()}>` 包裹）。
 *   - 不暴露 access_token / sk- 到 UI。
 *   - dialog open 是 dynamic import + dialog.show()，与现有 dialog-* 风格一致。
 */

import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useAuth } from "@/stores/auth"

const POLL_INTERVAL_MS = 30 * 1000
/** chat 完成事件去抖窗口：1.5s 内多次 idle 只触发一次刷新 */
const IDLE_DEBOUNCE_MS = 1500
/** 数字 < $1 标红警示 */
const LOW_BALANCE_THRESHOLD = 1

export const BalanceWidget: Component = () => {
  const auth = useAuth()
  const language = useLanguage()
  const dialog = useDialog()
  const serverSDK = useServerSDK()

  const [mount, setMount] = createSignal<HTMLElement | null>(null)
  const [spinning, setSpinning] = createSignal(false)

  onMount(() => {
    setMount(document.getElementById("opencode-titlebar-right"))
  })

  /** 刷新一次余额：立刻 spinner，调 /cli/me，无论成败都关 spinner（最短 300ms 给用户视觉反馈）。 */
  const refreshOnce = async () => {
    if (spinning()) return
    setSpinning(true)
    const start = Date.now()
    try {
      await auth.refreshMe()
    } finally {
      const elapsed = Date.now() - start
      const remain = Math.max(300 - elapsed, 0)
      if (remain > 0) await new Promise((r) => setTimeout(r, remain))
      setSpinning(false)
    }
  }

  // 30s 轮询 + mount 时立刻拉一次（覆盖 signIn 直接进来还没拉过 /cli/me 的场景）。
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let lastIdleAt = 0
  let idleDebounce: ReturnType<typeof setTimeout> | undefined

  onMount(() => {
    // 不阻塞首屏，但发起请求让 user 字段尽快补全。
    void refreshOnce()
    pollTimer = setInterval(() => {
      void refreshOnce()
    }, POLL_INTERVAL_MS)
  })

  onCleanup(() => {
    if (pollTimer) clearInterval(pollTimer)
    if (idleDebounce) clearTimeout(idleDebounce)
  })

  // 订阅 SDK 全局事件流，监听 session.status 变 idle（聊天完成 / 出错）时刷新一次余额。
  // 之所以走这条而不是 message.updated：message 事件高频（流式 token 一次次塞），
  // 用 idle 状态信号能精确地"每条会话结束触发一次"。
  createEffect(() => {
    const unsub = serverSDK.event.listen((event) => {
      if (event.details?.type !== "session.status") return
      const props = event.details.properties as { status?: { type?: string } }
      if (props.status?.type !== "idle") return
      const now = Date.now()
      if (now - lastIdleAt < IDLE_DEBOUNCE_MS) return
      lastIdleAt = now
      if (idleDebounce) clearTimeout(idleDebounce)
      idleDebounce = setTimeout(() => {
        idleDebounce = undefined
        void refreshOnce()
      }, IDLE_DEBOUNCE_MS)
    })
    onCleanup(unsub)
  })

  const user = createMemo(() => auth.state()?.user)
  const balanceText = createMemo(() => {
    const u = user()
    if (!u) return "$0.00"
    return `$${u.balanceUsd.toFixed(2)}`
  })
  const todayText = createMemo(() => {
    const u = user()
    if (!u) return "$0.00"
    return `$${u.usedTodayUsd.toFixed(2)}`
  })
  const lowBalance = createMemo(() => {
    const u = user()
    if (!u) return false
    return u.balanceUsd < LOW_BALANCE_THRESHOLD
  })

  function openTopup() {
    void import("@/components/topup-dialog").then((m) => {
      dialog.show(() => <m.TopupDialog />)
    })
  }

  return (
    <Show when={mount() && auth.isLoggedIn()}>
      {(_) => (
        <Portal mount={mount()!}>
          <div
            class="flex items-center gap-2 px-2 h-7 rounded-md bg-surface-base"
            data-component="balance-widget"
            role="group"
            aria-label={language.t("balance.balance")}
          >
            <div class="flex flex-col leading-tight">
              <span
                class="text-12-medium tabular-nums"
                classList={{
                  "text-text-strong": !lowBalance(),
                  "text-text-on-critical-base": lowBalance(),
                }}
                title={lowBalance() ? language.t("balance.lowBalanceWarning") : language.t("balance.balance")}
              >
                {balanceText()}
              </span>
              <span class="text-12-regular text-text-weak tabular-nums">
                {language.t("balance.todayUsed")} {todayText()}
              </span>
            </div>
            <Show
              when={!spinning()}
              fallback={
                <div class="size-6 flex items-center justify-center" aria-label={language.t("balance.refresh")}>
                  <Spinner class="size-4 text-icon-base" />
                </div>
              }
            >
              <IconButton
                icon="reset"
                variant="ghost"
                class="size-6 p-0"
                onClick={() => void refreshOnce()}
                aria-label={language.t("balance.refresh")}
              />
            </Show>
            <Button size="small" variant="ghost" onClick={openTopup}>
              {language.t("topup.openButton")}
            </Button>
          </div>
        </Portal>
      )}
    </Show>
  )
}

export default BalanceWidget
