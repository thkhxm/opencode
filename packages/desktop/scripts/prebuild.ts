#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
// 关键(根治"更新后历史会话消失"): 把渠道显式传给核心 dist 构建 build-node.ts。
// 否则其 Script.channel 在 OPENCODE_CHANNEL 未设时回退到 git 分支名(如 feat/punkcode-integration),
// getChannelPath 据此烘出 opencode-<分支>.db; 而别的构建可能烘成 opencode.db, 两者对不上 →
// 更新后读到另一个(空)库, 会话像"凭空消失"。固定按 resolveChannel()(默认 prod)烘焙, 库名永远稳定。
process.env.OPENCODE_CHANNEL = channel

await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
