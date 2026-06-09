/**
 * engram x opencode — adapter plugin.
 *
 * Maps engram's two CLI-agnostic needs onto opencode's plugin surface, leaving the
 * portable kernel (the `engram` binary + redb store + reviewer-prompt.md + SKILL.md)
 * completely untouched:
 *
 *   1. Inject the memory hot-index at session start
 *      -> `experimental.chat.system.transform`: we push `engram hot-index --emit text`
 *         onto the system prompt every turn (cached per directory so we do not re-open
 *         redb on each turn). The hot index thus survives compaction automatically,
 *         since the system prompt is rebuilt after compaction.
 *
 *   2. Consolidate at session end
 *      -> opencode has no SessionEnd. We listen to the `session.idle` event (fires at the
 *         end of every assistant turn, like codex's Stop). On each idle we rebuild a STABLE
 *         append-only JSONL transcript from `client.session.messages(...)`, hand it to
 *         `engram review-prepare` to compute the increment since the last watermark, and
 *         only when that increment is big enough (>= ENGRAM_REVIEW_MIN_LINES, default 40)
 *         do we spin up an independent reviewer. Otherwise the pending marker is left for the
 *         next startup catch-up — so we never review after every single turn, and never lose
 *         an increment to a crash.
 *
 * The reviewer runs as an ISOLATED opencode session (independent context, does not pollute
 * the user's session) created via the in-process SDK client and driven with `promptAsync`
 * (fire-and-forget). Recursion is prevented by tracking reviewer session ids: when a reviewer
 * session itself goes idle we skip it. The durable safety net against crashes is the
 * pending/watermark ledger, replayed by catch-up on the next startup.
 *
 * The store (redb) is SHARED with the Claude Code / Codex adapters: L1-3 in
 * `~/.engram/general.redb`, L4 in `<project>/.engram/engram.redb`, routed by the same
 * `engram resolve`. Only the consolidation LEDGER (watermark / pending / transcripts) is
 * kept per-CLI under `~/.engram/opencode/`, so the three adapters never fight over progress.
 *
 * Best-effort throughout: any failure is swallowed so it can never break a session.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

/** Cap a single tool output embedded in the transcript so a giant log cannot blow up token cost. */
const MAX_TOOL_OUTPUT = 8000
/** How long (ms) to reuse a computed hot-index before recomputing (avoids opening redb every turn). */
const HOTINDEX_TTL_MS = 60_000
/**
 * Default transcript-line increment that triggers a review. LOWER than the Claude/Codex adapters'
 * 40 on purpose: those transcripts are one-EVENT-per-line (each tool call/result is its own line),
 * whereas we normalize one-MESSAGE-per-line, so the same conversation yields far fewer lines.
 * ~10 lines ≈ a few substantive turns. Override with ENGRAM_REVIEW_MIN_LINES.
 */
const DEFAULT_REVIEW_MIN_LINES = 10
/** Pre-permissioned agent the reviewer session runs as (injected into config by the `config` hook). */
const REVIEWER_AGENT = "engram-reviewer"
/** Pre-permissioned agent the `/engram-*` query commands run as (injected by the `config` hook). */
const QUERY_AGENT = "engram"

/** Permission profile shared by both injected agents: read outside cwd + run engram via bash; no edits/net. */
const ENGRAM_AGENT_PERMISSION = {
  external_directory: "allow",
  bash: "allow",
  edit: "deny",
  webfetch: "deny",
} as const
/** Tool profile: the agents only need read + bash; explicitly disable mutating/networking tools. */
const ENGRAM_AGENT_TOOLS = { write: false, edit: false, patch: false, webfetch: false } as const

/** System prompt for the reviewer agent (the per-run task prompt is sent separately via promptAsync). */
const REVIEWER_AGENT_PROMPT = `你是 engram 的会话末**复盘者**——一个独立视角，**不是**刚才那个干活的 agent，由 engram 插件在会话空闲时自动唤起。
你会在用户消息里收到一段「自上次复盘以来的增量转录切片」的路径，以及一组要执行的 engram 命令模板。严格照收到的指令执行：
- 只通过 **bash** 调用指令里给出的（绝对路径的）engram 二进制来读写记忆库：confirm-use / write / supersede / merge / consolidate / consolidate-done。
- 允许读取工作目录之外的文件（转录切片、SKILL.md）——这是你的输入，已为你放行。
- **绝不**修改任何用户代码或文件（edit/write/patch 已禁用），**不要**联网。
- 全部巩固完成后**务必**执行收尾的 consolidate-done，否则这次巩固不算落定、下次会重跑。
- 收尾用三五句话简述：加固了几条、新写了什么、有无 supersede/merge。`

/** System prompt for the query agent backing the /engram-* slash commands. */
const QUERY_AGENT_PROMPT = `你是 engram 记忆查询助手，被 /engram-* 斜杠命令唤起。严格执行收到的指令：
- 用 **bash** 跑指令里给出的 engram 命令（绝对路径已给）。
- 需要库路径时：先跑 \`<engram> resolve --project-dir . --format json\` 得到 {general_db, project_db, project_name}，再据此加 \`--general-db <general_db> --project-db <project_name>=<project_db>\`。
- status / hot-index 子命令直接用 \`--workspace-root .\` 即可，无需 resolve。
- 把 engram 的输出**原样、完整**展示给用户，不要编造、不要过度解读。`

/** Appended to the reviewer prompt so the reviewer reads OUR normalized transcript correctly. */
const OPENCODE_TRANSCRIPT_NOTE = `

## About this transcript (opencode session, engram-normalized JSONL)
Each line is one message, in chronological order:
\`{"role":"user"|"assistant","text":"...","tools":[{"tool","status","input","output"}]}\`
- \`text\`: the concatenated text parts of that message.
- \`tools[]\`: tool calls the assistant made and their results. Use these to rebuild the
  "which memory was recalled -> what the model then DID" causal chain — e.g. an \`engram recall\`
  / \`engram list\` tool call whose output then visibly shaped the next assistant action counts as
  real (3rd-tier) use; a recall that was loaded but never acted on does not.
- The injected memory hot-index lives in the assistant's system prompt (NOT in this transcript).
  Judge real use by whether a recalled item demonstrably influenced an action or answer here.
- Long tool outputs may be truncated with a [...truncated] marker; that is expected.`

export const EngramPlugin: Plugin = async (input) => {
  // Inside a headless reviewer subprocess (env flag) stay completely inert: no injection, no review,
  // no config injection. The in-process reviewer relies on the reviewerSessions set instead; this
  // guard is for `opencode run`-style subprocess / debug use where we must not recurse.
  if (process.env.ENGRAM_REVIEWER === "1") return {}

  const { client, directory } = input

  // ---- per-CLI ledger paths (isolated from claude/codex), shared store resolved by the engine.
  const home = os.homedir()
  const base = path.join(home, ".engram", "opencode")
  const work = path.join(base, "pending")
  const wm = path.join(base, "watermark.json")
  const txDir = path.join(base, "transcripts")
  const statusFile = path.join(base, "status.txt")
  const logFile = path.join(base, "hook.log")
  for (const d of [base, work, txDir]) {
    try { fs.mkdirSync(d, { recursive: true }) } catch { /* best-effort */ }
  }

  // ---- bundled assets. Covers: npm-package layout (entry in plugin/, assets at the package root =
  // here/..), entry-at-package-root (assets at here), and the legacy install layout (<config>/engram-data).
  const here = pluginDir()
  // 内置进 opencode core 后，here = core 的 plugin 目录，找不到随 app 打包的 engram-data。
  // 故优先用主进程注入的 ENGRAM_DATA_DIR（桌面端 = resources/engram-data 或 dev 仓库内绝对路径），
  // 其余保留 npm 包布局(here/..)与 legacy(here/../engram-data)回退，兼容 CLI npm 安装。
  const dataDir = process.env.ENGRAM_DATA_DIR
  const assetRoots = [
    ...(dataDir ? [dataDir] : []),
    here,
    path.join(here, ".."),
    path.join(here, "..", "engram-data"),
  ]
  const engram = resolveEngramBin(assetRoots)
  const reviewerPromptPath = firstExisting(assetRoots.map((r) => path.join(r, "scripts", "reviewer-prompt.md")))
  const skillPath = firstExisting(assetRoots.map((r) => path.join(r, "skills", "engram", "SKILL.md")))

  // in-process state
  const reviewerSessions = new Set<string>()
  let cachedHot: { text: string; at: number; dir: string } | null = null
  let caughtUp = false
  let reviewing = false

  return {
    /**
     * 0) Self-provision: inject the two pre-permissioned agents (reviewer + query) and the
     *    /engram-* slash commands into the resolved config. This is what makes the npm package a
     *    true one-command install — no agent/command files to drop by hand. Uses `??=` so it never
     *    clobbers anything the user defined themselves.
     */
    config: async (cfg) => {
      try {
        const c = cfg as { agent?: Record<string, unknown>; command?: Record<string, unknown> }
        c.agent ??= {}
        c.agent[REVIEWER_AGENT] ??= {
          mode: "all",
          description: "Engram 会话复盘 subagent——读增量转录、按 engram rubric 巩固记忆（由 engram 插件后台自动调用）。",
          temperature: 0.2,
          permission: { ...ENGRAM_AGENT_PERMISSION },
          tools: { ...ENGRAM_AGENT_TOOLS },
          prompt: REVIEWER_AGENT_PROMPT,
        }
        c.agent[QUERY_AGENT] ??= {
          mode: "all",
          description: "Engram 记忆查询助手——/engram-* 斜杠命令背后的 agent，跑 engram 二进制并原样展示记忆。",
          temperature: 0,
          permission: { ...ENGRAM_AGENT_PERMISSION },
          tools: { ...ENGRAM_AGENT_TOOLS },
          prompt: QUERY_AGENT_PROMPT,
        }
        if (engram) {
          c.command ??= {}
          for (const [name, def] of Object.entries(buildCommands(fwd(engram)))) {
            c.command[name] ??= def
          }
        }
      } catch { /* never break config load */ }
    },

    /** 1) Injection: add the hot-index to the system prompt (every turn; cached). */
    "experimental.chat.system.transform": async (input, output) => {
      try {
        // first time we are live: replay any leftover review a previous run did not finish.
        if (!caughtUp) {
          caughtUp = true
          void catchup()
        }
        // don't inject into the reviewer's own session (it would only muddy the review prompt).
        const sid = (input as { sessionID?: string })?.sessionID
        if (sid && reviewerSessions.has(sid)) return
        if (!output || !Array.isArray(output.system)) return // defend: experimental shape may drift
        const text = hotIndex(directory)
        if (text) output.system.push(text)
      } catch { /* never break prompt assembly */ }
    },

    /** 2) Consolidation trigger: review the increment when a (non-reviewer) session goes idle. */
    event: async ({ event }) => {
      try {
        if (!event || (event as { type?: string }).type !== "session.idle") return
        const sid = (event as { properties?: { sessionID?: string } }).properties?.sessionID
        if (!sid || reviewerSessions.has(sid)) return // don't review the reviewer
        await maybeReview(sid)
      } catch { /* never break the event loop */ }
    },
  }

  // ---------------------------------------------------------------------------- helpers

  /** Compute (and cache per directory) the hot-index text the engine renders for this scope. */
  function hotIndex(dir: string): string {
    const now = Date.now()
    if (cachedHot && cachedHot.dir === dir && now - cachedHot.at < HOTINDEX_TTL_MS) return cachedHot.text
    let text = ""
    if (engram) {
      const r = run(engram, [
        "hot-index", "--emit", "text", "--workspace-root", dir,
        "--status-file", statusFile, "--log", logFile,
      ])
      if (r.status === 0 && r.stdout) text = r.stdout.replace(/\s+$/, "")
    }
    cachedHot = { text, at: now, dir }
    return text
  }

  /** Rebuild the incremental slice for `sid` and launch a reviewer once it is large enough. */
  async function maybeReview(sid: string): Promise<void> {
    if (!engram || reviewing) return
    reviewing = true
    try {
      const file = await writeTranscript(sid)
      if (!file) return

      const rp = run(engram, ["resolve", "--project-dir", directory, "--format", "json"])
      if (rp.status !== 0 || !rp.stdout) return
      const paths = safeJson(rp.stdout) as { general_db?: string; project_db?: string; project_name?: string } | null
      if (!paths?.general_db || !paths.project_db || !paths.project_name) return

      const pr = run(engram, [
        "review-prepare", "--transcript", file, "--session-id", sid,
        "--watermark", wm, "--work-dir", work,
        "--general-db", paths.general_db, "--project-db", paths.project_db, "--project-name", paths.project_name,
      ])
      if (pr.status !== 0 || !pr.stdout) return
      const plan = safeJson(pr.stdout) as ReviewPlan | null
      if (!plan || plan.action !== "review") return

      const minLines = intEnv("ENGRAM_REVIEW_MIN_LINES", DEFAULT_REVIEW_MIN_LINES)
      const newLines = (plan.end_line ?? 0) - (plan.start_line ?? 0)
      if (newLines < minLines) return // leave the pending; next startup catch-up handles it once it grows
      await launchReviewer(plan)
    } finally {
      reviewing = false
    }
  }

  /** Replay a leftover pending review (a previous run launched a reviewer but never saw it finish). */
  async function catchup(): Promise<void> {
    if (!engram) return
    const r = run(engram, ["catchup-scan", "--work-dir", work])
    if (r.status !== 0 || !r.stdout) return
    const plan = safeJson(r.stdout) as ReviewPlan | null
    if (plan?.action === "review") await launchReviewer(plan)
  }

  /**
   * Fetch every message of `sid` via the SDK and write a STABLE append-only JSONL transcript.
   * Because we are called at idle, all messages are complete, so leading lines never change and
   * the engine's line-based watermark stays valid across idles.
   */
  async function writeTranscript(sid: string): Promise<string | null> {
    let msgs: Array<{ info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }> = []
    try {
      const res = await client.session.messages({ path: { id: sid }, query: { directory } })
      msgs = (res?.data ?? []) as typeof msgs
    } catch {
      return null
    }
    const lines: string[] = []
    for (const m of msgs) {
      const role = (m.info?.role as string) ?? "?"
      const text: string[] = []
      const tools: Array<Record<string, unknown>> = []
      for (const p of m.parts ?? []) {
        const type = p.type as string
        if (type === "text" && typeof p.text === "string" && p.text) {
          text.push(p.text)
        } else if (type === "tool") {
          const st = (p.state ?? {}) as Record<string, unknown>
          const status = st.status as string
          let out = status === "completed" ? (st.output as string) : (st.error as string)
          if (typeof out === "string" && out.length > MAX_TOOL_OUTPUT) {
            out = out.slice(0, MAX_TOOL_OUTPUT) + " [...truncated]"
          }
          tools.push({ tool: p.tool, status, input: st.input, output: out })
        }
      }
      const line: Record<string, unknown> = { role, text: text.join("\n") }
      if (tools.length) line.tools = tools
      lines.push(JSON.stringify(line))
    }
    const file = path.join(txDir, sanitize(sid) + ".jsonl")
    try {
      fs.writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "", "utf8")
    } catch {
      return null
    }
    return file
  }

  /**
   * Spawn an independent reviewer as an isolated opencode session. Fills the kernel
   * reviewer-prompt template, appends the opencode transcript note, creates a fresh session
   * (so the reviewer's context is independent and the user's session is untouched), and fires
   * the prompt asynchronously. The reviewer ends by running `engram consolidate-done`, which
   * advances the watermark and clears the pending.
   */
  async function launchReviewer(plan: ReviewPlan): Promise<void> {
    if (!reviewerPromptPath || !engram) return
    let tpl: string
    try {
      tpl = fs.readFileSync(reviewerPromptPath, "utf8")
    } catch {
      return
    }
    const prompt = tpl
      .split("{{TRANSCRIPT}}").join(fwd(plan.slice))
      .split("{{ENGRAM}}").join(fwd(engram))
      .split("{{GENERAL_DB}}").join(fwd(plan.general_db))
      .split("{{PROJECT_DB}}").join(fwd(plan.project_db))
      .split("{{PROJECT_NAME}}").join(plan.project_name)
      .split("{{PENDING}}").join(fwd(plan.pending))
      .split("{{WATERMARK}}").join(fwd(wm))
      .split("{{SKILL}}").join(fwd(skillPath ?? "")) + OPENCODE_TRANSCRIPT_NOTE

    try {
      const created = await client.session.create({ body: { title: "engram-review" }, query: { directory } })
      const rsid = created?.data?.id as string | undefined
      if (!rsid) return
      reviewerSessions.add(rsid)
      // Drive the reviewer with the bundled `engram-reviewer` agent, which is pre-permissioned to
      // read outside the cwd (the transcript slice + SKILL.md live under ~/.engram and ~/.config)
      // and to run the engram binary via bash — so the background session never stalls on an
      // unanswered permission prompt. Falls back to the default agent if it is not installed.
      const body: Record<string, unknown> = { agent: REVIEWER_AGENT, parts: [{ type: "text", text: prompt }] }
      const model = reviewerModel()
      if (model) body.model = model
      await client.session.promptAsync({ path: { id: rsid }, query: { directory }, body: body as never })
    } catch { /* best-effort: pending remains, next startup catch-up retries */ }
  }

  // ----- small utilities

  /** Resolve the directory this plugin file lives in (Bun's import.meta.dir, with fallbacks). */
  function pluginDir(): string {
    try {
      const d = (import.meta as { dir?: string }).dir
      if (d) return d
    } catch { /* not Bun */ }
    try {
      if (typeof __dirname === "string") return __dirname
    } catch { /* not CJS */ }
    try {
      return path.dirname(new URL(import.meta.url).pathname)
    } catch {
      return process.cwd()
    }
  }

  function resolveEngramBin(roots: string[]): string | null {
    const env = process.env.ENGRAM_BIN
    if (env && fs.existsSync(env)) return env
    let name = "engram-linux-x86_64"
    if (process.platform === "win32") name = "engram-windows-x86_64.exe"
    else if (process.platform === "darwin") name = process.arch === "arm64" ? "engram-macos-aarch64" : "engram-macos-x86_64"
    return firstExisting(roots.map((r) => path.join(r, "bin", name)))
  }

  function run(bin: string, args: string[]) {
    return spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  }

  function reviewerModel(): { providerID: string; modelID: string } | null {
    // ENGRAM_REVIEWER_MODEL = "providerID/modelID" (optional). Default: let opencode pick.
    const raw = process.env.ENGRAM_REVIEWER_MODEL
    if (!raw) return null
    const i = raw.indexOf("/")
    if (i <= 0) return null
    return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) }
  }
}

interface ReviewPlan {
  action: string
  slice: string
  general_db: string
  project_db: string
  project_name: string
  pending: string
  start_line?: number
  end_line?: number
}

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  return null
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Forward-slash a path so it survives being embedded in the reviewer's shell commands. */
function fwd(p: string): string {
  return p ? p.split("\\").join("/") : p
}

/** Make a session id safe to use as a filename. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_")
}

/**
 * The /engram-* slash commands, with the resolved engram binary path baked in. Each command's
 * `template` is the prompt handed to the QUERY_AGENT, which runs the engram binary via bash and
 * shows the output verbatim. `recall`/`list` need the db paths (the agent resolves them first);
 * `status`/`render` self-resolve from the cwd via --workspace-root.
 */
function buildCommands(eng: string): Record<string, { template: string; description: string; agent: string }> {
  return {
    "engram-recall": {
      agent: QUERY_AGENT,
      description: "在 engram 记忆库里检索（冷库、热库都搜）",
      template:
        `在 engram 记忆库检索关键词：$ARGUMENTS\n` +
        `先跑 \`${eng} resolve --project-dir . --format json\` 拿库路径，` +
        `再跑 \`${eng} recall --query "$ARGUMENTS" --general-db <general_db> --project-db <project_name>=<project_db> --limit 10\`，` +
        `把命中的记忆条目完整列出，不要额外解读。`,
    },
    "engram-status": {
      agent: QUERY_AGENT,
      description: "查看 engram 记忆系统概况（各层条数 / 项目 / 冷库 / 墓碑）",
      template: `跑 \`${eng} status --workspace-root .\`，把记忆库概况原样展示给我。`,
    },
    "engram-list": {
      agent: QUERY_AGENT,
      description: "列出 engram 记忆（可选过滤：--level L4.2 --status active 等放进 $ARGUMENTS）",
      template:
        `列出 engram 记忆。先跑 \`${eng} resolve --project-dir . --format json\` 拿库路径，` +
        `再跑 \`${eng} list --general-db <general_db> --project-db <project_name>=<project_db> $ARGUMENTS\`，原样展示。`,
    },
    "engram-render": {
      agent: QUERY_AGENT,
      description: "预览本会话将注入的 engram「热索引」",
      template:
        `跑 \`${eng} hot-index --emit text --workspace-root .\`，把输出原样展示给我` +
        `（这就是 engram 会注入本会话上下文的记忆热索引）。`,
    },
  }
}
