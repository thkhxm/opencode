import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import type { PunkcodeCredentials, SqliteMigrationProgress } from "../preload/types"

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "sqlite"; progress: SqliteMigrationProgress }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "credentials-updated" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = {
  stop: () => Promise<void>
  /**
   * 把 PunkcodeAI sk-key + 模型列表透传给 sidecar 进程。
   * 内部以 utilityProcess.postMessage 实现；sidecar 收到后更新 process.env
   * 并 dispose 所有 instance state，下一次 provider.list 会重读 env 拿到新凭据。
   */
  setCredentials: (credentials: PunkcodeCredentials) => Promise<void>
  /** 清掉 PunkcodeAI 凭据（退出登录） */
  clearCredentials: () => Promise<void>
}

const SIDECAR_SERVICE_NAME = "opencode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  needsMigration: boolean
  userDataPath: string
  /**
   * M9（session 按账号隔离）：按账号隔离的数据根目录。
   *
   * sidecar 进程的 db 路径由 `Global.Path.data`（= `XDG_DATA_HOME/opencode`）在**进程启动时**冻结，
   * 运行期无法再切。因此账号隔离通过"不同账号用不同 XDG_DATA_HOME/XDG_STATE_HOME 启动 sidecar"实现：
   *   - 传入此值时，spawn 出来的 sidecar 进程 env 里 XDG_DATA_HOME / XDG_STATE_HOME 指向该目录，
   *     于是该账号的 session db（opencode-<channel>.db）物理落在专属子目录，互不可见。
   *   - 不传（如登录前、未知账号）时回退到 userDataPath，行为同改造前。
   * 切换账号 = 主进程 kill 当前 sidecar + 用新账号的 accountDataPath 重新 spawn（见 index.ts）。
   */
  accountDataPath?: string
  onSqliteProgress?: (progress: SqliteMigrationProgress) => void
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export function preferAppEnv(userDataPath: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  Object.assign(process.env, {
    ...(shell ? loadShellEnv(shell) : null),
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: createSidecarEnv(options.accountDataPath),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "sqlite") {
        refreshTimeout()
        options.onSqliteProgress?.(message.progress)
        return
      }
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
      needsMigration: options.needsMigration,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
      }
    }

    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined

  // M6: 接收 sidecar 对 set-credentials / clear-credentials 的 ACK。
  // 设计成"取最近一次 pending"，多并发情况下后到的会覆盖前面的 resolver；
  // 实际调用方都是 await 串行，不会有并发，但兜底安全。
  let pendingCredentialsAck: (() => void) | undefined
  child.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return
    if ((raw as { type?: unknown }).type !== "credentials-updated") return
    if (pendingCredentialsAck) {
      const resolver = pendingCredentialsAck
      pendingCredentialsAck = undefined
      resolver()
    }
  })

  const SIDECAR_CREDENTIALS_ACK_TIMEOUT = 5000
  function postCredentialsMessage(message: Record<string, unknown>): Promise<void> {
    if (exited) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        pendingCredentialsAck = undefined
        resolve()
      }
      const timeout = setTimeout(finish, SIDECAR_CREDENTIALS_ACK_TIMEOUT)
      pendingCredentialsAck = finish
      child.postMessage(message)
    })
  }

  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
      setCredentials: (credentials: PunkcodeCredentials) =>
        postCredentialsMessage({ type: "set-credentials", credentials }),
      clearCredentials: () => postCredentialsMessage({ type: "clear-credentials" }),
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

function createSidecarEnv(accountDataPath?: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  // M9（session 按账号隔离）：把 sidecar 的 db / state 目录指向账号专属目录。
  // db 路径 = XDG_DATA_HOME/opencode/opencode-<channel>.db（见 opencode storage/db.ts + core/global.ts），
  // 在 sidecar 进程启动时冻结；故这里在 fork env 上设好，不同账号的 session 物理隔离。
  if (accountDataPath) {
    env.XDG_DATA_HOME = accountDataPath
    env.XDG_STATE_HOME = accountDataPath
  }
  return env
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
