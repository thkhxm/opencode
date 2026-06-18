const disposers = new Set<(directory: string) => Promise<void>>()
const fullInvalidators = new Set<() => Promise<void>>()

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

/**
 * 注册一个"全量失效"回调：不依赖具体 directory，作废该 InstanceState 的所有 per-directory ScopedCache 条目。
 *
 * 背景：disposeInstance(directory) 只能清掉「InstanceStore 里真有 instance 的那个 directory」。而桌面端
 * sidecar 的 provider.list 等会在不经 InstanceStore.load 的情况下直接 InstanceState.use 填充 ScopedCache，
 * 此时 InstanceStore 的 Map 始终为空——disposeAll 遍历它根本碰不到这些缓存，导致 push 新凭据后 provider 缓存
 * 永不失效、模型下拉一直为空。invalidateAllInstances() 借助本回调把所有 InstanceState 的 ScopedCache 全清，
 * 保证 disposeAll 之后下一次 use 必定重建、读到最新 env。
 */
export function registerFullInvalidator(invalidator: () => Promise<void>) {
  fullInvalidators.add(invalidator)
  return () => {
    fullInvalidators.delete(invalidator)
  }
}

export async function disposeInstance(directory: string) {
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
}

export async function invalidateAllInstances() {
  await Promise.allSettled([...fullInvalidators].map((invalidator) => invalidator()))
}
