/**
 * PunkcodeAI 账户页。
 *
 * 路径：/account（在 app.tsx 中注册，套 AuthGate）
 *
 * 显示：
 *   - 邮箱
 *   - 昵称
 *   - 余额（M7：由右上角 widget 30s 轮询 `/cli/me` 持续刷新，这里实时显示）
 *   - 今日 / 本月用量（M7）
 *
 * 不显示：access_token / refresh_token / 任何 sk- key（按规范要求）。
 *
 * 操作：
 *   - 申请充值：弹出 TopupDialog（M7）
 *   - 退出登录：清 store + localStorage + 跳 /login
 */

import { Component } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useAuth } from "@/stores/auth"

const Account: Component = () => {
  const auth = useAuth()
  const navigate = useNavigate()
  const language = useLanguage()
  const dialog = useDialog()

  async function onLogout() {
    await auth.signOut()
    navigate("/login", { replace: true })
  }

  function openTopup() {
    void import("@/components/topup-dialog").then((m) => {
      dialog.show(() => <m.TopupDialog />)
    })
  }

  const session = () => auth.state()

  return (
    <div class="flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-background-base font-sans">
      <div class="w-full max-w-md flex flex-col gap-6 px-6">
        <header class="flex flex-col gap-1">
          <h1 class="text-lg font-medium text-text-strong">{language.t("account.title")}</h1>
          <p class="text-sm text-text-weak">
            {language.t("account.signedInAs", { email: session()?.user.email ?? "" })}
          </p>
        </header>
        <dl class="flex flex-col gap-3 rounded-lg bg-surface-base p-4">
          <Row label={language.t("account.email")} value={session()?.user.email ?? "—"} />
          <Row label={language.t("account.nickname")} value={session()?.user.nickname ?? "—"} />
          <Row
            label={language.t("account.balance")}
            value={`$${(session()?.user.balanceUsd ?? 0).toFixed(2)}`}
          />
          <Row
            label={language.t("balance.todayUsed")}
            value={`$${(session()?.user.usedTodayUsd ?? 0).toFixed(2)}`}
          />
        </dl>
        <div class="flex gap-3">
          <Button variant="ghost" onClick={() => navigate("/", { replace: true })}>
            {language.t("account.back")}
          </Button>
          <Button variant="ghost" onClick={openTopup}>
            {language.t("topup.openButton")}
          </Button>
          <Button variant="primary" onClick={onLogout}>
            {language.t("account.logout")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Row(props: { label: string; value: string }) {
  return (
    <div class="flex items-center justify-between gap-3">
      <dt class="text-sm text-text-weak">{props.label}</dt>
      <dd class="text-sm text-text-strong font-mono">{props.value}</dd>
    </div>
  )
}

export default Account
