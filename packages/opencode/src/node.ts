export { Config } from "@/config/config"
export { Server } from "./server/server"
export { bootstrap } from "./cli/bootstrap"
export * as Log from "@opencode-ai/core/util/log"
export { Database } from "@/storage/db"
export { JsonMigration } from "@/storage/json-migration"
// M6: 桌面端 sidecar 需要在 PunkcodeAI 凭据更新时让 provider 状态重新初始化。
// 由 utilityProcess 接到 renderer → main → sidecar 的 set-credentials 消息时调用。
export { InstanceRuntime } from "./project/instance-runtime"
