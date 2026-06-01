/**
 * 会话时间线「改动文件」列表里的图片去重纯函数（无 effect / sdk / DOM 依赖，便于单测）。
 *
 * 背景：codex 生成图片时常同时在文件系统产出同名的多种格式（最典型 x.png + x.jpg，
 * 同一张图），git snapshot diff 会各列一条，时间线于是把同一张图渲染成两张相同的缩略图。
 * 这里把"同目录同名（同 stem）的图片文件"折叠成一张，优先保留 png（无损、用户偏好），
 * 没有 png 时按 webp > 其他次之。非图片 diff 原样保留、顺序不变。
 *
 * 说明：这是【展示层】折叠——实际文件改动不受影响，被折叠的格式仍可通过其他入口打开。
 */

/** 视作"同一张图不同格式"的图片扩展名（小写，不含点）。 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic", "heif", "svg"])

/** 取文件的图片扩展名（小写）；非图片返回 null。 */
export function imageExt(file: string): string | null {
  const dot = file.lastIndexOf(".")
  if (dot < 0) return null
  const ext = file.slice(dot + 1).toLowerCase()
  return IMAGE_EXTS.has(ext) ? ext : null
}

/** 取去掉扩展名后的路径（含目录），用于判定"同名不同格式"。 */
export function stemOf(file: string): string {
  const dot = file.lastIndexOf(".")
  return dot < 0 ? file : file.slice(0, dot)
}

/** 格式优先级：png 最优（无损 / 用户偏好），webp 次之，其余并列最后。值越小越优先。 */
function formatRank(ext: string): number {
  if (ext === "png") return 0
  if (ext === "webp") return 1
  return 2
}

/**
 * 把"同 stem 的图片文件"折叠成一张（优先 png）。非图片或唯一格式的图片原样保留，顺序不变。
 */
export function dedupeImageVariants<T extends { file: string }>(diffs: T[]): T[] {
  // 第一遍：为每个图片 stem 选出要保留的那一条（优先级最高；并列时取先出现的）。
  const keep = new Map<string, T>()
  for (const d of diffs) {
    const ext = imageExt(d.file)
    if (!ext) continue
    const stem = stemOf(d.file)
    const cur = keep.get(stem)
    if (!cur || formatRank(ext) < formatRank(imageExt(cur.file)!)) keep.set(stem, d)
  }
  // 第二遍：按原顺序输出——非图片全留；图片只在它正是该 stem 被保留的那一条时留下。
  return diffs.filter((d) => {
    const ext = imageExt(d.file)
    if (!ext) return true
    return keep.get(stemOf(d.file)) === d
  })
}
