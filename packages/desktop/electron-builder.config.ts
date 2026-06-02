import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  // 同时兼容 OPENCODE_CHANNEL（旧）与 PUNKCODE_CHANNEL（新），优先取新名
  const raw = process.env.PUNKCODE_CHANNEL ?? process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

/**
 * M8: 自建 update server feed URL
 *
 * - 用户原话："opencode 自建 update server，不依赖外部，我们自己控制桌面端的更新和版本"
 * - electron-updater 的 generic provider 只需要 url，会自动从该路径下取：
 *     - latest.yml / latest-mac.yml / latest-linux.yml
 *     - 对应平台的 .exe / .dmg / .AppImage 安装包
 * - 默认指向 https://punkcodeai.myverse.site/updates，可通过 PUNKCODE_UPDATE_FEED_URL 覆盖
 * - 部署说明见 deploy/UPDATE_SERVER.md
 */
const updateFeedUrl = process.env.PUNKCODE_UPDATE_FEED_URL ?? "https://punkcodeai.myverse.site/updates"

const getBase = (): Configuration => ({
  artifactName: "PunkcodeAI-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    {
      // imagegen skill：打包后随 app 拷到 resources/skills/imagegen，
      // 主进程在 app.isPackaged 时用 join(process.resourcesPath, "skills", "imagegen") 找它（见 main/index.ts）。
      // from 相对本配置文件（packages/desktop）：../../.. = D:/project，再进 sub2api/skills/imagegen。
      from: "../../../sub2api/skills/imagegen",
      to: "skills/imagegen",
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    // TODO M9: replace with PunkcodeAI logo when user provides
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  // 内部协议保持 opencode://（CLI / sidecar 已硬编码），用户感知不到 URL 协议
  protocols: {
    name: "PunkcodeAI",
    schemes: ["opencode"],
  },
  win: {
    // TODO M9: replace with PunkcodeAI logo when user provides
    icon: `resources/icons/icon.ico`,
    // M9 TODO: 提供真实签名证书后 publisherName 走 signtoolOptions.publisherName
    signtoolOptions: {
      sign: signWindows,
      publisherName: "thkhxm",
    },
    target: ["nsis", "portable"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    // TODO M9: replace with PunkcodeAI logo when user provides
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
    shortcutName: "PunkcodeAI",
  },
  linux: {
    // TODO M9: replace with PunkcodeAI logo when user provides
    icon: `resources/icons`,
    category: "Development",
    maintainer: "thkhxm",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "site.myverse.punkcodeai.dev",
        productName: "PunkcodeAI Dev",
        rpm: { packageName: "punkcodeai-dev" },
        publish: {
          provider: "generic" as const,
          url: `${updateFeedUrl}/dev`,
        },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "site.myverse.punkcodeai.beta",
        productName: "PunkcodeAI Beta",
        protocols: { name: "PunkcodeAI Beta", schemes: ["opencode"] },
        publish: {
          provider: "generic" as const,
          url: `${updateFeedUrl}/beta`,
        },
        rpm: { packageName: "punkcodeai-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "site.myverse.punkcodeai",
        productName: "PunkcodeAI",
        protocols: { name: "PunkcodeAI", schemes: ["opencode"] },
        publish: {
          provider: "generic" as const,
          url: updateFeedUrl,
        },
        rpm: { packageName: "punkcodeai" },
      }
    }
  }
}

export default getConfig()
