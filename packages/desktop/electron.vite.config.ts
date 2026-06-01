import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const channel = (() => {
  // PunkcodeAI 优先读 PUNKCODE_CHANNEL，兼容旧名 OPENCODE_CHANNEL
  const raw = process.env.PUNKCODE_CHANNEL ?? process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (raw === "latest") return "prod"
  return "dev"
})()

// PunkcodeAI 后端 API base URL：dev 默认指向本地 sub2api (38080)，prod 由
// .env.production 注入 punkcodeai.myverse.site。代码引用 branding.ts -> DEFAULT_API_BASE_URL。
const punkcodeApiBaseUrl =
  process.env.PUNKCODE_API_BASE_URL ?? (channel === "dev" ? "http://localhost:38080" : "https://punkcodeai.myverse.site")

const punkcodeUpdateFeedUrl = process.env.PUNKCODE_UPDATE_FEED_URL ?? "https://punkcodeai.myverse.site/updates"

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
      "import.meta.env.PUNKCODE_API_BASE_URL": JSON.stringify(punkcodeApiBaseUrl),
      "import.meta.env.PUNKCODE_UPDATE_FEED_URL": JSON.stringify(punkcodeUpdateFeedUrl),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    define: {
      // renderer 端 branding.ts -> DEFAULT_API_BASE_URL 读这个；dev 指向本地 sub2api。
      "import.meta.env.PUNKCODE_API_BASE_URL": JSON.stringify(punkcodeApiBaseUrl),
      "import.meta.env.PUNKCODE_UPDATE_FEED_URL": JSON.stringify(punkcodeUpdateFeedUrl),
      // renderer 的 app 代码（settings.tsx newLayoutDesignsDefault、titlebar channel 角标）
      // 读 VITE_OPENCODE_CHANNEL。之前没注入恒为 undefined，导致 newLayoutDesignsDefault
      // 恒为 true（跑进 V2 实验布局，左右栏丢失，见 #4）。这里按解析出的 channel 注入对齐。
      "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
