import { Component, For, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { ImageAttachmentPart } from "@/context/prompt"

type PromptImageAttachmentsProps = {
  attachments: ImageAttachmentPart[]
  onOpen: (attachment: ImageAttachmentPart) => void
  onRemove: (id: string) => void
  removeLabel: string
}

const fallbackClass = "size-16 rounded-md bg-surface-base flex items-center justify-center border border-border-base"
const imageClass =
  "size-16 rounded-md object-cover border border-border-base hover:border-border-strong-base transition-colors"
const removeClass =
  "absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
const nameClass = "absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 rounded-b-md"

export const PromptImageAttachments: Component<PromptImageAttachmentsProps> = (props) => {
  // 把同一源文件（PDF/docx/xlsx 提取出的多 part，共享 groupId）折叠成一个代表 chip，
  // 避免 20 页含图 PDF 在附件区炸出 20+ 个缩略图。普通图片（无 groupId）逐个显示。
  const display = createMemo(() => {
    const seen = new Set<string>()
    const out: ImageAttachmentPart[] = []
    for (const att of props.attachments) {
      if (att.groupId) {
        if (seen.has(att.groupId)) continue
        seen.add(att.groupId)
      }
      out.push(att)
    }
    return out
  })

  // 分组代表展示成"源文件"：用源文件名 + 文件图标（即使组内含图片页，也不展缩略图）。
  const isGrouped = (att: ImageAttachmentPart) => !!att.groupId
  const labelOf = (att: ImageAttachmentPart) => att.sourceName ?? att.filename
  const showThumb = (att: ImageAttachmentPart) => !att.groupId && att.mime.startsWith("image/")

  return (
    <Show when={display().length > 0}>
      <div class="flex flex-wrap gap-2 px-3 pt-3">
        <For each={display()}>
          {(attachment) => (
            <Tooltip value={labelOf(attachment)} placement="top" contentClass="break-all">
              <div class="relative group">
                <Show
                  when={showThumb(attachment)}
                  fallback={
                    <div class={fallbackClass}>
                      <Icon name={isGrouped(attachment) ? "open-file" : "folder"} class="size-6 text-text-weak" />
                    </div>
                  }
                >
                  <img
                    src={attachment.dataUrl}
                    alt={labelOf(attachment)}
                    class={imageClass}
                    onClick={() => props.onOpen(attachment)}
                  />
                </Show>
                <button
                  type="button"
                  onClick={() => props.onRemove(attachment.id)}
                  class={removeClass}
                  aria-label={props.removeLabel}
                >
                  <Icon name="close" class="size-3 text-text-weak" />
                </button>
                <div class={nameClass}>
                  <span class="text-10-regular text-white truncate block">{labelOf(attachment)}</span>
                </div>
              </div>
            </Tooltip>
          )}
        </For>
      </div>
    </Show>
  )
}
