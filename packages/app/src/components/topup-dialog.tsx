/**
 * PunkcodeAI 桌面端充值申请弹窗（M7）。
 *
 * 触发：右上角 balance widget 的"申请充值"按钮。
 * 功能：
 *   - 表单：金额（1-10000 USD，默认 50）+ 备注（可选，最长 1000 字）
 *   - 提交 → POST `/cli/balance-requests`
 *   - 成功 → Toast "已提交，等待管理员审批" + 弹窗底部列表立刻刷新
 *   - 失败 → code=409 "too many pending" 友好提示；其他错误透传 message
 * 我的申请：弹窗 mount 时拉 GET `/cli/balance-requests?limit=20`，展示状态徽章 + 时间 + 金额 + 备注 + 拒绝原因。
 *
 * 设计取舍：把"我的申请"放在 dialog 内底部而不是单独 account 页区块——
 *   - 用户提交后能立刻在同一界面看到自己新加的 pending 条目；
 *   - 避免 account 页变长；
 *   - dialog 关闭后状态自然归零；下次打开重新拉。
 */

import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { AccountError, CredentialsError, useAuth, type BalanceRequest } from "@/stores/auth"

const MIN_AMOUNT = 1
const MAX_AMOUNT = 10000
const DEFAULT_AMOUNT = 50
const MAX_NOTE_LENGTH = 1000

export const TopupDialog: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const auth = useAuth()

  const [amount, setAmount] = createSignal<string>(String(DEFAULT_AMOUNT))
  const [note, setNote] = createSignal<string>("")
  const [submitting, setSubmitting] = createSignal(false)
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)

  /**
   * 加载用户最近 N 条申请。
   *
   * - 弹窗 mount 时跑一次；
   * - 成功提交一条后手动 `refetch()` 让列表即时回填；
   * - 网络/业务错暂时 toast 一下，避免阻塞表单交互。
   */
  const [requests, requestsCtl] = createResource<BalanceRequest[]>(async () => {
    try {
      return await auth.listBalanceRequests(20)
    } catch (err) {
      const message =
        err instanceof CredentialsError || err instanceof AccountError ? err.message : String(err)
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
      return []
    }
  })

  const pendingCount = createMemo(() => (requests() ?? []).filter((r) => r.status === "pending").length)

  const parsedAmount = createMemo(() => {
    const n = Number(amount())
    if (!Number.isFinite(n)) return NaN
    return n
  })

  const amountValid = createMemo(() => {
    const n = parsedAmount()
    return n >= MIN_AMOUNT && n <= MAX_AMOUNT
  })

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault()
    if (submitting()) return
    setErrorMessage(null)

    const n = parsedAmount()
    if (!amountValid()) {
      setErrorMessage(language.t("topup.amountRange"))
      return
    }
    const trimmedNote = note().trim().slice(0, MAX_NOTE_LENGTH)

    setSubmitting(true)
    try {
      await auth.requestTopup({
        amount_usd: n,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      })
      showToast({ variant: "success", title: language.t("topup.success") })
      // 列表刷新 → 用户立刻看到自己刚创建的 pending 条目。
      void requestsCtl.refetch()
      // 表单回退到默认，方便再次提交。
      setAmount(String(DEFAULT_AMOUNT))
      setNote("")
      // 保持弹窗开着——用户通常想看自己刚提交的条目；要主动关再点 X。
    } catch (err) {
      if (err instanceof CredentialsError) {
        // sub2api 网关："too many pending balance requests"（code=409）。
        // 用 message 关键词识别，不要假设 code 数值（envelope.code 由 sub2api 端定义，可能不是 409）。
        if (err.message.toLowerCase().includes("too many pending")) {
          setErrorMessage(language.t("topup.tooManyPending", { count: pendingCount() }))
        } else {
          setErrorMessage(err.message)
        }
      } else if (err instanceof AccountError) {
        setErrorMessage(err.message)
      } else {
        setErrorMessage(String(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog title={language.t("topup.title")} class="w-full max-w-[480px] mx-auto">
      <form onSubmit={onSubmit} class="flex flex-col gap-5 p-6 pt-0">
        <div class="flex flex-col gap-3">
          <TextField
            autofocus
            type="number"
            inputMode="decimal"
            min={MIN_AMOUNT}
            max={MAX_AMOUNT}
            step={1}
            label={language.t("topup.amount")}
            value={amount()}
            onChange={(v) => setAmount(v)}
            disabled={submitting()}
            required
          />
          <TextField
            multiline
            label={language.t("topup.note")}
            placeholder={language.t("topup.note.placeholder")}
            value={note()}
            onChange={(v) => setNote(v.slice(0, MAX_NOTE_LENGTH))}
            disabled={submitting()}
            class="max-h-24 w-full overflow-y-auto"
          />
          <Show when={errorMessage()}>
            {(msg) => <p class="text-12-regular text-text-on-critical-base">{msg()}</p>}
          </Show>
        </div>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={submitting() || !amountValid()}>
            {submitting() ? language.t("common.saving") : language.t("topup.submit")}
          </Button>
        </div>

        <div class="flex flex-col gap-2 border-t border-border-weak-base pt-4">
          <div class="text-12-medium text-text-strong">{language.t("topup.myRequests")}</div>
          <Show
            when={!requests.loading}
            fallback={<div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>}
          >
            <Show
              when={(requests() ?? []).length > 0}
              fallback={<div class="text-12-regular text-text-weak">{language.t("topup.myRequests.empty")}</div>}
            >
              <ul class="flex flex-col gap-2 max-h-60 overflow-y-auto">
                <For each={requests()}>{(item) => <RequestRow item={item} />}</For>
              </ul>
            </Show>
          </Show>
        </div>
      </form>
    </Dialog>
  )
}

function RequestRow(props: { item: BalanceRequest }) {
  const language = useLanguage()

  const statusLabel = createMemo(() => {
    switch (props.item.status) {
      case "approved":
        return language.t("topup.status.approved")
      case "rejected":
        return language.t("topup.status.rejected")
      default:
        return language.t("topup.status.pending")
    }
  })

  // pending=琥珀 / approved=绿 / rejected=红，沿用现有 surface / text token，不引入新色。
  const badgeClass = createMemo(() => {
    switch (props.item.status) {
      case "approved":
        return "bg-surface-success-base text-text-on-success-base"
      case "rejected":
        return "bg-surface-critical-base text-text-on-critical-base"
      default:
        return "bg-surface-warning-base text-text-on-warning-base"
    }
  })

  const time = createMemo(() => {
    const raw = props.item.created_at
    if (!raw) return ""
    const t = new Date(raw)
    if (Number.isNaN(t.getTime())) return raw
    return t.toLocaleString()
  })

  return (
    <li class="flex flex-col gap-1 rounded-md bg-surface-base p-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-12-mono text-text-strong">${props.item.amount_usd.toFixed(2)}</span>
        <span class={`text-12-medium px-2 py-0.5 rounded-full ${badgeClass()}`}>{statusLabel()}</span>
      </div>
      <Show when={props.item.note}>
        <span class="text-12-regular text-text-base whitespace-pre-wrap break-words">{props.item.note}</span>
      </Show>
      <Show when={props.item.reject_reason}>
        {(reason) => (
          <span class="text-12-regular text-text-on-critical-base">
            {language.t("topup.rejectReason", { reason: reason() })}
          </span>
        )}
      </Show>
      <Show when={time()}>{(t) => <span class="text-12-regular text-text-weak">{t()}</span>}</Show>
    </li>
  )
}

export default TopupDialog
