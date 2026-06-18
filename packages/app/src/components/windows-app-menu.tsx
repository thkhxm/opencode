import { IconButton } from "@opencode-ai/ui/icon-button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/components/icon-button-v2.jsx"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/components/icon.jsx"

import { useCommand } from "@/context/command"
import { usePlatform } from "@/context/platform"

/**
 * Windows 标题栏左上角的 ☰ 按钮。
 *
 * 极简化（用户要求）：不再展开 File/Edit/View/Go/Window/Help 这套下拉菜单
 * （绝大多数项是 opencode 原生功能，PunkcodeAI 桌面端用不上）。点击直接打开
 * 「设置」界面（command: settings.open）。
 *
 * 标准操作仍走键盘快捷键，不依赖本菜单：复制/粘贴/剪切/全选(Ctrl+C/V/X/A)是浏览器原生；
 * 缩放(Ctrl +/-)、全屏(F11) 由 Electron / command keybind 处理。
 *
 * macOS 顶部原生菜单(主进程 menu.ts createMenu, 仅 darwin)不受影响, 保持原样。
 */
export function WindowsAppMenu(props: {
  command: ReturnType<typeof useCommand>
  platform: ReturnType<typeof usePlatform>
  variant?: "legacy" | "v2"
}) {
  const openSettings = () => props.command.trigger("settings.open")

  return props.variant === "v2" ? (
    <div
      data-component="desktop-icon-button"
      class="flex h-7 w-9 shrink-0 items-center justify-center rounded-[6px] px-1"
    >
      <IconButtonV2
        variant="ghost-muted"
        size="large"
        icon={<IconV2 name="menu" />}
        aria-label="设置"
        onClick={openSettings}
      />
    </div>
  ) : (
    <IconButton
      icon="menu"
      variant="ghost"
      class="titlebar-icon rounded-md shrink-0"
      aria-label="设置"
      onClick={openSettings}
    />
  )
}
