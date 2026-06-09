import { Image } from "@/image/image"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import * as Log from "@opencode-ai/core/util/log"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Usage, type LLMEvent } from "@opencode-ai/llm"

const DOOM_LOOP_THRESHOLD = 3
const log = Log.create({ service: "session.processor" })

export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: MessageV2.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
  inputEnded: boolean
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
      }
      let aborted = false
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Reasoning.Ended, {
            sessionID: ctx.sessionID,
            reasoningID,
            text: ctx.reasoningMap[reasoningID].text,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
        if (flags.experimentalEventSystem) {
          yield* events.publish(SessionEvent.Tool.Input.Started, {
            sessionID: ctx.sessionID,
            callID: input.id,
            name: input.name,
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies MessageV2.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
          inputEnded: false,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is MessageV2.FilePart => Schema.is(MessageV2.FilePart)(value)

      // 把模型 provider 端执行的 image_generation 结果（base64 PNG）转成可渲染的 FilePart。
      //
      // 背景：codex /responses 协议下，sub2api image_generation bridge 生成的图片由
      // @ai-sdk/openai 以「image_generation 的 provider-executed tool-result」形式返回，
      // 形如 { result: "<base64>" }（裸 base64，无 data: 前缀），而不是 file stream part。
      // 若不特殊处理，这段 base64 只会被 JSON.stringify 进 tool 输出文本，UI 无法显示成图。
      // 这里把它包成 FilePart 走 attachments 通道：下游 tool-result 分支会对 image/* 附件做
      // image.normalize（限尺寸）并落成 file part，命中 M10 的 assistant file part 内联渲染。
      const imageGenerationAttachment = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): MessageV2.FilePart | undefined => {
        if (value.name !== "image_generation") return undefined
        const raw = value.result.value
        const b64 = isRecord(raw) && typeof raw.result === "string" ? raw.result : undefined
        if (!b64) return undefined
        // OpenAI image_generation 默认返回 PNG 的裸 base64；兼容已带 data: 前缀的情况。
        const url = b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`
        return {
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "file",
          mime: "image/png",
          filename: `${value.id}.png`,
          url,
        }
      }

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: MessageV2.FilePart[] } => {
        const generatedImage = imageGenerationAttachment(value)
        if (generatedImage) {
          return {
            title: value.name,
            // 不把 base64 塞进 metadata（会撑爆 part），只标记产物类型。
            metadata: { generated: "image", mime: generatedImage.mime },
            output: "Generated image.",
            attachments: [generatedImage],
          }
        }
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      const toolInput = (value: unknown): Record<string, any> => (isRecord(value) ? value : { value })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Reasoning.Started, {
                sessionID: ctx.sessionID,
                reasoningID: value.id,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            // AI SDK emits a final `tool-call` with the parsed `input`; accumulating
            // delta fragments into `state.raw` is redundant work for no current consumer.
            return

          case "tool-input-end": {
            const toolCall = yield* ensureToolCall(value)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Input.Ended, {
                sessionID: ctx.sessionID,
                callID: value.id,
                text: "",
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.toolcalls[value.id] = { ...toolCall.call, inputEnded: true }
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            const toolCall = yield* ensureToolCall(value)
            const input = toolInput(value.input)
            if (!toolCall.call.inputEnded) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Tool.Input.Ended, {
                  sessionID: ctx.sessionID,
                  callID: value.id,
                  text: "",
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Called, {
                sessionID: ctx.sessionID,
                callID: value.id,
                tool: value.name,
                input,
                provider: {
                  executed: toolCall.part.metadata?.providerExecuted === true,
                  ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = MessageV2.parts(ctx.assistantMessage.id)
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.id)
            const rawOutput = toolResultOutput(value)
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<MessageV2.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Success, {
                sessionID: ctx.sessionID,
                callID: value.id,
                structured: output.metadata,
                content: [
                  {
                    type: "text",
                    text: output.output,
                  },
                  ...(output.attachments?.map((item: MessageV2.FilePart) => ({
                    type: "file" as const,
                    uri: item.url,
                    mime: item.mime,
                    name: item.filename,
                  })) ?? []),
                ],
                provider: {
                  executed: value.providerExecuted === true || toolCall?.part.metadata?.providerExecuted === true,
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* completeToolCall(value.id, output)

            // 把（已 normalize 的）图片附件额外落成 assistant 的独立 file part，
            // 让 UI 的 PART_MAPPING["file"] 内联渲染成图（tool part 的 state.attachments 只用于
            // 把图回灌给模型做多轮上下文，UI 不渲染它）。
            //
            // 两类来源会触发内联渲染：
            //   1. image_generation：provider 端执行的图片生成工具（codex /responses bridge 返回 base64 PNG）。
            //   2. read 工具读到的图片（mime image/*）：imagegen skill 走 bash 跑 image_gen.py 把图落到本地 PNG，
            //      模型随后用 read 工具读这张 PNG。read 的图片附件原本只进 tool part 的 state.attachments
            //      （UI 只显示文件名、不显示图），这里扩展到 read+image/* 也内联渲染，让 skill 出图能在桌面端可见。
            const shouldRenderInline =
              value.name === "image_generation" ||
              (value.name === "read" && attachments.some((a) => a.mime.startsWith("image/")))
            if (shouldRenderInline) {
              for (const attachment of attachments) {
                if (!attachment.mime.startsWith("image/")) continue
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.assistantMessage.sessionID,
                  type: "file",
                  mime: attachment.mime,
                  // read 的图片附件没有 filename（read.ts 只产 { type, mime, url }），给个稳定回退名，
                  // 避免 UI 文件 part 显示空文件名。
                  filename: attachment.filename ?? `image.${attachment.mime.split("/")[1] ?? "png"}`,
                  url: attachment.url,
                })
              }
            }

            // imagegen skill 走 bash 跑 image_gen.py，脚本只把图落到本地 PNG 并打印 "Wrote
            // <path>"，不会回显图；若模型忘了用 read 回读这张 PNG，用户就只看到一行路径文本。
            // 这里兜底：检测 bash 跑 image_gen.py 的输出，解析 Wrote 行 → 读盘 → normalize →
            // 落成独立 file part 内联渲染，无论模型读不读都能出图。只对 image_gen.py 命令 +
            // Wrote 图片行生效，避免误伤普通 bash 输出；只落 UI file part，不进
            // output.attachments，保持 bash 给模型的输出语义不变。
            if (value.name === "bash") {
              const bashInput = (toolCall?.part.state as { input?: Record<string, unknown> } | undefined)?.input
              const command = typeof bashInput?.command === "string" ? bashInput.command : ""
              if (/image_gen\.py|skills[\\/]imagegen/i.test(command)) {
                const instance = yield* InstanceState.context
                const workdir = typeof bashInput?.workdir === "string" ? bashInput.workdir : ""
                const cwd = workdir ? path.resolve(instance.directory, workdir) : instance.directory
                const stdout = rawOutput.output ?? ""
                const wroteRe = /^Wrote\s+(.+?\.(?:png|jpe?g|webp))\s*$/gim
                const seen = new Set<string>()
                let wrote: RegExpExecArray | null
                while ((wrote = wroteRe.exec(stdout))) {
                  const rawPath = wrote[1].trim()
                  const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath)
                  if (seen.has(abs)) continue
                  seen.add(abs)
                  const ext = path.extname(abs).toLowerCase()
                  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"
                  const part = yield* Effect.tryPromise(() => readFile(abs)).pipe(
                    Effect.map(
                      (bytes): MessageV2.FilePart => ({
                        id: PartID.ascending(),
                        sessionID: ctx.assistantMessage.sessionID,
                        messageID: ctx.assistantMessage.id,
                        type: "file",
                        mime,
                        filename: path.basename(abs),
                        url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
                      }),
                    ),
                    Effect.flatMap((attachment) =>
                      image.normalize(attachment).pipe(Effect.catch(() => Effect.succeed(attachment))),
                    ),
                    Effect.catch(() => Effect.succeed(null)),
                  )
                  if (!part) continue
                  yield* session.updatePart(part)
                }
              }
            }
            return
          }

          case "tool-error": {
            const toolCall = yield* readToolCall(value.id)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            if (flags.experimentalEventSystem) {
              yield* events.publish(SessionEvent.Tool.Failed, {
                sessionID: ctx.sessionID,
                callID: value.id,
                error: {
                  type: "unknown",
                  message: value.message,
                },
                provider: {
                  executed: toolCall?.part.metadata?.providerExecuted === true,
                },
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            throw new Error(value.message)

          case "step-start":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Step.Started, {
                  sessionID: ctx.sessionID,
                  agent: input.assistantMessage.agent,
                  model: {
                    id: ModelV2.ID.make(ctx.model.id),
                    providerID: ProviderV2.ID.make(ctx.model.providerID),
                    variant: ModelV2.VariantID.make(input.assistantMessage.variant ?? "default"),
                  },
                  snapshot: ctx.snapshot,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Step.Ended, {
                  sessionID: ctx.sessionID,
                  finish: value.reason,
                  cost: usage.cost,
                  tokens: usage.tokens,
                  snapshot: completedSnapshot,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Text.Started, {
                  sessionID: ctx.sessionID,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              if (flags.experimentalEventSystem) {
                yield* events.publish(SessionEvent.Text.Ended, {
                  sessionID: ctx.sessionID,
                  text: ctx.currentText.text,
                  timestamp: DateTime.makeUnsafe(Date.now()),
                })
              }
            }
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error)) {
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        if (!ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          if (flags.experimentalEventSystem) {
            yield* events.publish(SessionEvent.Step.Failed, {
              sessionID: ctx.sessionID,
              error: {
                type: "unknown",
                message: errorMessage(e),
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
          }
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream(streamInput)

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                set: (info) => {
                  // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
                  const event = flags.experimentalEventSystem
                    ? events.publish(SessionEvent.Retried, {
                        sessionID: ctx.sessionID,
                        attempt: info.attempt,
                        error: {
                          message: info.message,
                          isRetryable: true,
                        },
                        timestamp: DateTime.makeUnsafe(Date.now()),
                      })
                    : Effect.void
                  return event.pipe(
                    Effect.andThen(
                      status.set(ctx.sessionID, {
                        type: "retry",
                        attempt: info.attempt,
                        message: info.message,
                        action: info.action,
                        next: info.next,
                      }),
                    ),
                  )
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
