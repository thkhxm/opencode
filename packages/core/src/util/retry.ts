export interface RetryOptions {
  attempts?: number
  delay?: number
  factor?: number
  maxDelay?: number
  retryIf?: (error: unknown) => boolean
}

const TRANSIENT_MESSAGES = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  // sidecar(opencode core 子进程)重启/未就绪窗口期(如桌面端热更新后首启、切账号 respawn)：
  // renderer 抢跑请求时连接被中断，表现为 HTTP 499(client closed request) + 空响应体。
  // 这属瞬时错误，sidecar 起好即恢复，应重试而非立即弹"无法重新加载"toast。
  "499",
  "empty response body",
]

function isTransientError(error: unknown): boolean {
  if (!error) return false
  // oxlint-disable-next-line no-base-to-string -- error is unknown, intentional coercion for message matching
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  return TRANSIENT_MESSAGES.some((m) => message.includes(m))
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  // attempts 5: 配合上面的 499/瞬时识别，覆盖 sidecar 重启窗口(0.5+1+2+4≈7.5s 内多次重试)，
  // 让热更新/切账号后 renderer 抢跑的请求等 sidecar 起好后自动成功，避免瞬时报错弹窗。
  const { attempts = 5, delay = 500, factor = 2, maxDelay = 10000, retryIf = isTransientError } = options

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1 || !retryIf(error)) throw error
      const wait = Math.min(delay * Math.pow(factor, attempt), maxDelay)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError
}
