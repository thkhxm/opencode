# PunkcodeAI 桌面端发布流程

> 本文件是桌面端发布的唯一权威流程。改发布相关的东西前先读这里。

## 分支模型

- **`feat/punkcode-integration`** — 日常开发分支。所有功能 / 修复都在这里提交。
- **`release`** — 正式版本分支。**只反映「已正式发布」的状态**。每次确认发布时，把开发分支合并进来，并在合并点打发布 tag。

> 不要直接在 `release` 上开发；它只接受来自开发分支的合并。

## 版本号规则（每次发布 +1，不是每次改动 +1）

- **开发期间的提交不要改 `packages/desktop/package.json` 的 `version`。** 多个改动可以累积在同一个待发布版本里，版本号保持不变。
- **只有在确认要发布时**，才把 `version` 自增**一个补丁号**（如 `1.15.38` → `1.15.39`），每次发布只 +1。
- 原因：electron-updater 按 `version` 比较决定是否推更新——同版本号不会被识别为更新，所以版本号必须随**每次发布**递增，但**不必随每次改动**递增。

## 发布步骤（每次发布执行一遍）

1. 在 `feat/punkcode-integration` 上确认所有要发布的改动已提交（此时 `version` 仍是上次发布的值）。
2. **bump 版本**：把 `packages/desktop/package.json` 的 `version` +1（一个补丁号），单独提交。
3. **合并进正式分支**：
   ```bash
   git checkout release
   git merge --no-ff feat/punkcode-integration -m "release: <version>"
   git push origin release
   ```
4. **打 tag 触发 CI 打包**（在 release 分支的发布提交上）：
   ```bash
   git tag -a desktop-v<version> -m "PunkcodeAI 桌面端 v<version>: <一句话>"
   git push origin desktop-v<version>
   ```
   CI（`.github/workflows/punkcode-desktop.yml`，触发条件 `desktop-v*`）会出 mac(arm64) + win(x64) **签名包**并挂到 GitHub Release。
5. **发布到自建更新源** `/www/wwwroot/punkcodeai-updates/`：用 sub2api 仓库 `deploy/publish-desktop-update*.{sh,ps1}`，或手动：
   - 用**公开 URL** `curl -sL "https://github.com/thkhxm/opencode/releases/download/desktop-v<version>/<file>"` 下载各产物（注意：`gh release download` 在部分环境会下成**损坏的小文件**，务必用 curl）。
   - 按 `latest.yml` / `latest-mac.yml` 里的 **sha512 + size 逐个校验**通过后再上传。
   - 上传到 `/www/wwwroot/punkcodeai-updates/`（主机 / 凭据见思源「/工具/sub2api → 配置与部署 → 部署主机」）。
6. **验证**：`curl -I https://punkcodeai.myverse.site/updates/latest.yml`（win）与 `latest-mac.yml`（mac）返回 200，且 `version` 为本次发布版本。

## 渠道：发布构建必须是 prod（否则会话库名漂移 → 用户更新后会话"消失"）

- 会话存 SQLite，库文件名由烘焙进核心包的 `OPENCODE_CHANNEL` 决定（`getChannelPath`：prod/latest/beta → `opencode.db`，其它 → `opencode-<渠道>.db`）。
- `scripts/prebuild.ts` 已把渠道（`resolveChannel()`，默认 **prod**）显式传给核心 dist 构建 `build-node.ts`；CI 设 `PUNKCODE_CHANNEL=prod`。
- **绝不要用非 prod 渠道打"正式"包**，否则库名漂移、用户会话读不到。dev 渠道（`opencode-dev.db`）是有意隔离的，不受影响。
- 兜底：首启时若 `opencode.db` 为空且同目录存在旧渠道库，会自动接管历史会话并弹通知（见 `sidecar.ts` 的 `seedSessionsFromPreviousChannel`）。
