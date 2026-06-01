import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"

import contextMenu from "electron-context-menu"

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  getWslConfig,
  preferAppEnv,
  setDefaultServerUrl,
  setWslConfig,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { migrate } from "./migrate"
import { checkUpdate, checkForUpdates, installUpdate, setupAutoUpdater } from "./updater"
import { Deferred, Effect, Fiber } from "effect"

// M8: 用户可见的桌面 app 名称统一脱敏到 PunkcodeAI。
// 注意：APP_IDS 是 Electron 内部 AppUserModelId（任务栏分组 / 自启动 / Squirrel 升级匹配键），
// 必须与 electron-builder.config.ts 中的 appId 保持完全一致。
const APP_NAMES: Record<string, string> = {
  dev: "PunkcodeAI Dev",
  beta: "PunkcodeAI Beta",
  prod: "PunkcodeAI",
}
const APP_IDS: Record<string, string> = {
  dev: "site.myverse.punkcodeai.dev",
  beta: "site.myverse.punkcodeai.beta",
  prod: "site.myverse.punkcodeai",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

/**
 * M6: 主进程内存中保存当前 PunkcodeAI 凭据。
 *
 * - sk- key 仅在内存（不写 electron-store / 不写磁盘）；进程退出即丢。
 * - 用于：sidecar 重启时（如 update / 异常重连）自动重灌；启动时立刻推一次。
 */
type PunkcodeCredentialsPayload = Parameters<SidecarListener["setCredentials"]>[0]
let pendingPunkcodeCredentials: PunkcodeCredentialsPayload | null = null

/**
 * M9（session 按账号隔离）：当前 sidecar 进程是为哪个 accountID 启动的。
 *
 * db 路径在 sidecar 进程启动时冻结，运行期切不了。所以切账号 = 重启 sidecar：
 * 收到的 setCredentials 里 accountID 与本变量不同时，先 kill 当前 sidecar，
 * 再用新账号的隔离数据目录 respawn，最后把新凭据推给新进程。
 */
let currentSidecarAccountID: string | null = null

/**
 * M9：重启 sidecar 进程的回调，由初始 spawn 时注入（带上 hostname/port/password 等固定参数）。
 *
 * 复用同一 port + password，renderer 的 SDK 端点不变、可无感重连。
 * 入参是该账号的隔离数据目录（XDG_DATA_HOME/XDG_STATE_HOME）。
 */
let respawnSidecar: ((accountDataPath: string | undefined) => Promise<void>) | null = null

/**
 * M9：把 accountID 映射成隔离的数据目录。
 *
 * 形如 `${url}:${email}`，含 `:` `/` 等非法路径字符 → sanitize 成单段目录名。
 * 不同账号 → 不同目录 → 不同 session db，物理隔离。
 * 空 accountID（理论上不该发生）→ 返回 undefined，回退到默认共享目录。
 */
function accountDataPathFor(accountID: string | undefined): string | undefined {
  if (!accountID) return undefined
  const safe = accountID.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120)
  if (!safe) return undefined
  return join(app.getPath("userData"), "accounts", safe)
}

async function setPunkcodeCredentialsToSidecar(credentials: PunkcodeCredentialsPayload) {
  pendingPunkcodeCredentials = credentials
  const nextAccountID = credentials.accountID || null

  // 账号切换：当前 sidecar 是为别的账号（或未知账号）启动的，需要重启切到新账号隔离 db。
  if (server && respawnSidecar && nextAccountID && currentSidecarAccountID !== nextAccountID) {
    writeLog("utility", "switching sidecar account, respawning", {
      from: currentSidecarAccountID,
      to: nextAccountID,
    })
    try {
      // respawn 内部会把 pendingPunkcodeCredentials（已是本次的新凭据）推给新进程，
      // 并把 currentSidecarAccountID 设为新账号——所以这里 respawn 成功后直接返回，不重复 push。
      await respawnSidecar(accountDataPathFor(nextAccountID))
      currentSidecarAccountID = nextAccountID
      return
    } catch (e) {
      writeLog("utility", "respawn sidecar for account switch failed", { error: String(e) }, "error")
      // 重启失败 → 抛给 renderer，让它不进登录态（auth.ts handleAuthSuccess 据此回滚）。
      throw e
    }
  }

  if (!server) return
  await server.setCredentials(credentials)
  if (nextAccountID) currentSidecarAccountID = nextAccountID
}

async function clearPunkcodeCredentialsFromSidecar() {
  pendingPunkcodeCredentials = null
  if (!server) return
  await server.clearCredentials()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "site.myverse.punkcodeai.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "PunkcodeAI Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()
  initCrashReporter()

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    void killSidecar()
  })

  app.on("will-quit", () => {
    void killSidecar()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    void killSidecar().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void killSidecar().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData>()
  const loadingComplete = Deferred.makeUnsafe<void>()

  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    awaitInitialization: Effect.fnUntraced(
      function* (sendStep) {
        sendStep(initStep)
        const listener = (step: InitStep) => sendStep(step)
        initEmitter.on("step", listener)
        try {
          logger.log("awaiting server ready")
          const res = yield* Deferred.await(serverReady)
          logger.log("server ready", { url: res.url })
          return res
        } finally {
          initEmitter.off("step", listener)
        }
      },
      (e) => Effect.runPromise(e),
    ),
    getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED }),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getWslConfig: () => Promise.resolve(getWslConfig()),
    setWslConfig: (config: WslConfig) => setWslConfig(config),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    wslPath: async (path, mode) => wslPath(path, mode),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    loadingWindowComplete: () => Deferred.doneUnsafe(loadingComplete, Effect.void),
    runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killSidecar),
    checkUpdate: async () => checkUpdate(),
    installUpdate: async () => installUpdate(killSidecar),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    setPunkcodeCredentials: (credentials) => setPunkcodeCredentialsToSidecar(credentials),
    clearPunkcodeCredentials: () => clearPunkcodeCredentialsFromSidecar(),
  })

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING) migrate()
  app.setAsDefaultProtocolClient("opencode")
  registerRendererProtocol()
  setDockIcon()
  setupAutoUpdater()
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const needsMigration = ((): boolean => {
    if (process.env.OPENCODE_DB === ":memory:") return false

    const xdg = process.env.XDG_DATA_HOME
    const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
    return !existsSync(join(base, "opencode", "opencode.db"))
  })()
  let overlay: BrowserWindow | null = null

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.OPENCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })

    // M9：把 spawn 抽成可复用的函数——初始启动 + 切账号 respawn 共用同一套
    // hostname/port/password/needsMigration（复用 port+password 让 renderer 无感重连）。
    // 入参 accountDataPath 决定 sidecar 进程用哪个账号隔离的 db 目录。
    const doSpawn = async (accountDataPath: string | undefined) => {
      const { listener, health } = await spawnLocalServer(hostname, port, password, {
        needsMigration,
        userDataPath: app.getPath("userData"),
        accountDataPath,
        onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      })
      server = listener
      // 如果 renderer 在 sidecar 启动前已经通过 IPC 推过凭据（dev/race 场景），
      // 此时 sidecar 已 ready，立刻把内存中的最新凭据推过去。
      if (pendingPunkcodeCredentials) {
        const creds = pendingPunkcodeCredentials
        try {
          await listener.setCredentials(creds)
          if (creds.accountID) currentSidecarAccountID = creds.accountID
        } catch (e) {
          writeLog("utility", "set initial punkcode credentials failed", { error: String(e) }, "warn")
        }
      }
      return health
    }

    // M9：注册 respawn 回调供切账号时调用——先停掉当前 sidecar，再用新账号目录起一个。
    // respawn 后不需要重新等 health（renderer 会自己重连），但仍 await 一下健康检查避免立刻打挂。
    respawnSidecar = async (accountDataPath: string | undefined) => {
      const previous = server
      server = null
      if (previous) await previous.stop()
      const health = await doSpawn(accountDataPath)
      await Promise.race([health.wait, new Promise<void>((resolve) => setTimeout(resolve, 30_000))])
    }

    const health = yield* Effect.promise(() => doSpawn(undefined))
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(Effect.forkChild)

  if (needsMigration) {
    const show = yield* loadingTask.pipe(
      Fiber.await,
      Effect.timeout("1 second"),
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    )
    if (show) {
      overlay = createLoadingWindow()
      yield* Effect.sleep("1 second")
    }
  }

  yield* Fiber.await(loadingTask)
  setInitStep({ phase: "done" })

  if (overlay) yield* Deferred.await(loadingComplete)

  mainWindow = createMainWindow()
  if (mainWindow) {
    createMenu({
      trigger: (id) => {
        const win = BrowserWindow.getFocusedWindow() ?? mainWindow
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void checkForUpdates(true, killSidecar)
      },
      relaunch: () => {
        void killSidecar().finally(() => {
          app.relaunch()
          app.exit(0)
        })
      },
    })
  }

  overlay?.close()
})

Effect.runFork(main)
