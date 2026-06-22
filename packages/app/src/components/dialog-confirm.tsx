/**
 * 通用二次确认弹窗（PunkcodeAI）。
 *
 * 用法：`useDialog().show(() => <ConfirmDialog title=... message=... onConfirm=... />)`
 * 确认 → 先关闭弹窗再执行 onConfirm；取消 → 仅关闭，不触发动作。
 *
 * 当前用于"退出登录"二次确认，避免误触直接登出。
 */
import { Component, JSX } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"

export const ConfirmDialog: Component<{
  title: string
  message: JSX.Element
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void | Promise<void>
}> = (props) => {
  const dialog = useDialog()
  return (
    <Dialog title={props.title} size="normal">
      <div class="flex flex-col gap-5 px-2.5 pb-1">
        <p class="text-14-regular text-text-base">{props.message}</p>
        <div class="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {props.cancelLabel}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              dialog.close()
              void props.onConfirm()
            }}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export default ConfirmDialog
