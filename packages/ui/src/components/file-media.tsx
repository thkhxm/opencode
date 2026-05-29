import type { FileContent } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createResource, Match, on, Show, Switch, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"
import {
  dataUrlFromMediaValue,
  hasMediaValue,
  isBinaryContent,
  mediaKindFromPath,
  normalizeMimeType,
  svgTextFromValue,
} from "../pierre/media"

export type FileMediaOptions = {
  mode?: "auto" | "off"
  path?: string
  current?: unknown
  before?: unknown
  after?: unknown
  deleted?: boolean
  readFile?: (path: string) => Promise<FileContent | undefined>
  onLoad?: () => void
  onError?: (ctx: { kind: "image" | "audio" | "svg" }) => void
  /** 覆盖图片 / svg 缩略图的尺寸约束 class，默认 `max-h-[60vh]`（用于在 review 列表里渲染较小的缩略图）。 */
  imageClass?: string
  /** 点击图片 / svg 缩略图时触发，参数是已加载好的 data-url（用于放大预览等场景）。 */
  onActivate?: (src: string) => void
}

function mediaValue(cfg: FileMediaOptions, mode: "image" | "audio") {
  if (cfg.current !== undefined) return cfg.current
  if (mode === "image") return cfg.after ?? cfg.before
  return cfg.after ?? cfg.before
}

export function FileMedia(props: { media?: FileMediaOptions; fallback: () => JSX.Element }) {
  const i18n = useI18n()
  const cfg = () => props.media
  const kind = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return
    return mediaKindFromPath(media.path)
  })

  const isBinary = createMemo(() => {
    const media = cfg()
    if (!media || media.mode === "off") return false
    if (kind()) return false
    return isBinaryContent(media.current as any)
  })

  const onLoad = () => props.media?.onLoad?.()

  const deleted = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || !k) return false
    if (media.deleted) return true
    if (k === "svg") return false
    if (media.current !== undefined) return false
    return !hasMediaValue(media.after as any) && hasMediaValue(media.before as any)
  })

  const direct = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return
    return dataUrlFromMediaValue(mediaValue(media, k), k)
  })

  const request = createMemo(() => {
    const media = cfg()
    const k = kind()
    if (!media || (k !== "image" && k !== "audio")) return
    if (media.current !== undefined) return
    if (deleted()) return
    if (direct()) return
    if (!media.path || !media.readFile) return

    return {
      key: `${k}:${media.path}`,
      kind: k,
      path: media.path,
      readFile: media.readFile,
      onError: media.onError,
    }
  })

  const [loaded] = createResource(request, async (input) => {
    return input.readFile(input.path).then(
      (result) => {
        const src = dataUrlFromMediaValue(result as any, input.kind)
        if (!src) {
          input.onError?.({ kind: input.kind })
          return { key: input.key, error: true as const }
        }

        return {
          key: input.key,
          src,
          mime: input.kind === "audio" ? normalizeMimeType(result?.mimeType) : undefined,
        }
      },
      () => {
        input.onError?.({ kind: input.kind })
        return { key: input.key, error: true as const }
      },
    )
  })

  const remote = createMemo(() => {
    const input = request()
    const value = loaded()
    if (!input || !value || value.key !== input.key) return
    return value
  })

  const src = createMemo(() => {
    const value = remote()
    return direct() ?? (value && "src" in value ? value.src : undefined)
  })
  const status = createMemo(() => {
    if (direct()) return "ready" as const
    if (!request()) return "idle" as const
    if (loaded.loading) return "loading" as const
    if (remote()?.error) return "error" as const
    if (src()) return "ready" as const
    return "idle" as const
  })
  const audioMime = createMemo(() => {
    const value = remote()
    return value && "mime" in value ? value.mime : undefined
  })

  // svg 既可能通过 `current` 内联提供，也可能只给 path + readFile（如 session review
  // 里的工作目录文件），后者需要异步读取文件内容再渲染。
  const svgRequest = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    if (media.current !== undefined) return
    if (deleted()) return
    if (!media.path || !media.readFile) return
    return { key: `svg:${media.path}`, path: media.path, readFile: media.readFile, onError: media.onError }
  })

  const [svgLoaded] = createResource(svgRequest, async (input) => {
    return input.readFile(input.path).then(
      (result) => ({ key: input.key, content: result as unknown }),
      () => {
        input.onError?.({ kind: "svg" })
        return { key: input.key, error: true as const }
      },
    )
  })

  const svgRemote = createMemo(() => {
    const input = svgRequest()
    const value = svgLoaded()
    if (!input || !value || value.key !== input.key) return
    return value
  })

  const svgValue = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    if (media.current !== undefined) return media.current
    const value = svgRemote()
    if (value && "content" in value) return value.content
    return undefined
  })

  const svgSource = createMemo(() => {
    if (kind() !== "svg") return
    return svgTextFromValue(svgValue() as any)
  })
  const svgSrc = createMemo(() => {
    if (kind() !== "svg") return
    return dataUrlFromMediaValue(svgValue() as any, "svg")
  })
  const svgInvalid = createMemo(() => {
    const media = cfg()
    if (!media || kind() !== "svg") return
    if (svgSource() !== undefined) return
    const value = svgValue()
    if (!hasMediaValue(value as any)) return
    return [media.path, value] as const
  })

  createEffect(
    on(
      svgInvalid,
      (value) => {
        if (!value) return
        cfg()?.onError?.({ kind: "svg" })
      },
      { defer: true },
    ),
  )

  const kindLabel = (value: "image" | "audio") =>
    i18n.t(value === "image" ? "ui.fileMedia.kind.image" : "ui.fileMedia.kind.audio")

  return (
    <Switch>
      <Match when={kind() === "image" || kind() === "audio"}>
        <Show
          when={src()}
          fallback={(() => {
            const media = cfg()
            const k = kind()
            if (!media || (k !== "image" && k !== "audio")) return props.fallback()
            const label = kindLabel(k)

            if (deleted()) {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.removed", { kind: label })}
                </div>
              )
            }
            if (status() === "loading") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.loading", { kind: label })}
                </div>
              )
            }
            if (status() === "error") {
              return (
                <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                  {i18n.t("ui.fileMedia.state.error", { kind: label })}
                </div>
              )
            }
            return (
              <div class="flex min-h-40 items-center justify-center px-6 py-4 text-center text-text-weak">
                {i18n.t("ui.fileMedia.state.unavailable", { kind: label })}
              </div>
            )
          })()}
        >
          {(value) => {
            const k = kind()
            if (k !== "image" && k !== "audio") return props.fallback()
            if (k === "image") {
              const activate = cfg()?.onActivate
              const imageClass = cfg()?.imageClass ?? "max-h-[60vh]"
              return (
                <div class="flex justify-center bg-background-stronger px-6 py-4">
                  <img
                    src={value()}
                    alt={cfg()?.path}
                    class={`${imageClass} max-w-full rounded border border-border-weak-base bg-background-base object-contain${activate ? " cursor-zoom-in" : ""}`}
                    onLoad={onLoad}
                    onClick={activate ? () => activate(value()) : undefined}
                  />
                </div>
              )
            }

            return (
              <div class="flex justify-center bg-background-stronger px-6 py-4">
                <audio class="w-full max-w-xl" controls preload="metadata" onLoadedMetadata={onLoad}>
                  <source src={value()} type={audioMime()} />
                </audio>
              </div>
            )
          }}
        </Show>
      </Match>
      <Match when={kind() === "svg"}>
        {(() => {
          if (svgSource() === undefined && svgSrc() == null) return props.fallback()

          return (
            <div class="flex flex-col gap-4 px-6 py-4">
              <Show when={svgSource() !== undefined}>{props.fallback()}</Show>
              <Show when={svgSrc()}>
                {(value) => {
                  const activate = cfg()?.onActivate
                  const imageClass = cfg()?.imageClass ?? "max-h-[60vh]"
                  return (
                    <div class="flex justify-center">
                      <img
                        src={value()}
                        alt={cfg()?.path}
                        class={`${imageClass} max-w-full rounded border border-border-weak-base bg-background-base object-contain${activate ? " cursor-zoom-in" : ""}`}
                        onLoad={onLoad}
                        onClick={activate ? () => activate(value()) : undefined}
                      />
                    </div>
                  )
                }}
              </Show>
            </div>
          )
        })()}
      </Match>
      <Match when={isBinary()}>
        <div class="flex min-h-56 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div class="text-14-semibold text-text-strong">
            {cfg()?.path?.split("/").pop() ?? i18n.t("ui.fileMedia.binary.title")}
          </div>
          <div class="text-14-regular text-text-weak">
            {(() => {
              const path = cfg()?.path
              if (!path) return i18n.t("ui.fileMedia.binary.description.default")
              return i18n.t("ui.fileMedia.binary.description.path", { path })
            })()}
          </div>
        </div>
      </Match>
      <Match when={true}>{props.fallback()}</Match>
    </Switch>
  )
}
