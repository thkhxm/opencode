import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = "opencode.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"
// 治本(消除冷启动 sidecar respawn)：持久化"上次成功注入凭据的账号 accountID"(=`${url}:email`, 非密钥)，
// 主进程下次冷启动时据此直接用对账号的隔离 db 首发 sidecar, 不再先 from:null 起、注入账号后再 respawn。
export const LAST_ACCOUNT_ID_KEY = "lastAccountID"
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
