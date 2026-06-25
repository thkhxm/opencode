import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const isSigningCI = () => process.env.GITHUB_ACTIONS === "true" || process.env.GITLAB_CI === "true"

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (!isSigningCI()) return

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
  // 默认 prod：发布正式版是默认行为，只有显式设 PUNKCODE_CHANNEL=dev 才走开发版
  return "prod"
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

// macOS 签名/公证开关：仅当提供了苹果凭据时启用（签名 + 公证，用户双击即用）；
// 否则产未签名包——内部使用 OK，用户首次打开右键→打开 或 `xattr -dr com.apple.quarantine` 绕过 Gatekeeper。
// 这样无需改代码即可在"有/无苹果开发者账号"间切换：配了 APPLE_TEAM_ID / APPLE_API_KEY / CSC_LINK 就自动走签名+公证。
const macSign = !!(process.env.APPLE_TEAM_ID || process.env.APPLE_API_KEY || process.env.CSC_LINK)

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
      // 已 vendor 进本仓 packages/desktop/skills/imagegen（去掉对 sub2api 的跨仓构建依赖，便于 GitLab/GitHub CI）；
      // 若 sub2api 侧 imagegen 有更新，需手动重新 vendor（复制覆盖 packages/desktop/skills/imagegen）。
      // from 相对本配置文件（packages/desktop）。
      from: "skills/imagegen",
      to: "skills/imagegen",
    },
  ],
  // 未签名 mac 构建（无苹果凭据）补 ad-hoc 签名：Apple Silicon 要求二进制至少 ad-hoc 签名才能启动，
  // 否则用户双击报"已损坏/无法打开"。仅在未签名 + darwin 时执行；失败不阻断打包（可手动补签）。
  afterPack: async (context) => {
    if (macSign || context.electronPlatformName !== "darwin") return
    const { readdirSync } = await import("node:fs")
    const appName = readdirSync(context.appOutDir).find((n) => n.endsWith(".app"))
    if (!appName) return
    const appPath = path.join(context.appOutDir, appName)
    try {
      await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", appPath])
      console.log(`[afterPack] 未签名构建：已对 ${appName} 做 ad-hoc 签名（保证 Apple Silicon 可启动）`)
    } catch (e) {
      console.warn(`[afterPack] ad-hoc 签名失败，arm64 上可能无法直接启动，需手动: codesign --force --deep -s - "${appPath}"`, e)
    }
  },
  mac: {
    category: "public.app-category.developer-tools",
    // TODO M9: replace with PunkcodeAI logo when user provides
    icon: `resources/icons/icon.icns`,
    // hardenedRuntime / notarize 仅在签名时有意义；未签名时关掉，避免 electron-builder 因缺证书而失败。
    hardenedRuntime: macSign,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: macSign,
    // 无苹果凭据时显式关闭代码签名（identity: null），否则会因找不到 Developer ID 证书而报错。
    ...(macSign ? {} : { identity: null }),
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: macSign,
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
    // 让用户手动安装时能选安装目录：
    //   - oneClick:false → 带向导 UI 的安装器(不再是无界面一键装)，才会出现目录选择页
    //   - allowToChangeInstallationDirectory:true → 显示"选择安装位置"页
    //   - perMachine:false → 默认按当前用户安装(无需管理员)；用户在目录页选到受保护目录(如 Program Files)时
    //     NSIS 会自动请求提权(allowElevation 默认开)。
    // 对自动更新无影响：electron-updater 升级时以 /S 静默运行安装器、沿用已有安装目录，用户感知不到目录页。
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    // TODO M9: replace with PunkcodeAI logo when user provides
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
    shortcutName: "PunkcodeAI",
  },
  portable: {
    // nsis 安装器沿用 base 的 artifactName(PunkcodeAI-${os}-${arch}.${ext})并据此生成 latest.yml。
    // portable 必须用不同文件名，否则与 nsis 同名互相覆盖：后构建的 portable 会盖掉 nsis，
    // 导致 latest.yml 记录的 sha512/size（nsis 的）与磁盘上的实际文件（portable 的）失配，
    // electron-updater 下载后 sha512 校验失败、自动更新坏掉。
    artifactName: "PunkcodeAI-${os}-${arch}-portable.${ext}",
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
