# PunkcodeAI 自建 Update Server 部署指南

## 1. 背景

PunkcodeAI 桌面端不依赖 GitHub Releases / 第三方 CDN，**所有桌面端版本与更新分发由自建 update server 完成**，确保版本节奏、灰度策略与下架机制都由我们直接控制。

桌面端通过 [electron-updater](https://www.electron.build/auto-update) 的 `generic` provider 拉取更新，feed URL 在两处配置：

1. **打包期默认值**：`packages/desktop/electron-builder.config.ts` -> `publish.url`
   - 写入构建产物 `app-update.yml`
   - 默认 `https://punkcodeai.myverse.site/updates`
2. **运行时覆盖**：环境变量 `PUNKCODE_UPDATE_FEED_URL`
   - 由 `packages/desktop/src/main/updater.ts` 在 `autoUpdater.setFeedURL` 时读取
   - 用于不重新打包就切换到 staging / 灰度通道

## 2. Server 应该提供哪些文件

对于一个 feed URL `https://punkcodeai.myverse.site/updates`，桌面端会按以下规则取文件：

| 平台 | 元数据文件 | 安装包文件 |
| --- | --- | --- |
| Windows | `latest.yml` | `PunkcodeAI-win-x64.exe` |
| macOS (Intel) | `latest-mac.yml` | `PunkcodeAI-mac-x64.dmg` / `.zip` |
| macOS (Apple Silicon) | `latest-mac.yml` | `PunkcodeAI-mac-arm64.dmg` / `.zip` |
| Linux | `latest-linux.yml` | `PunkcodeAI-linux-x64.AppImage` |

`latest.yml` 是 electron-builder `package` 命令自动产出的（在 `packages/desktop/dist/` 下），**不要手写**。一个最小示例：

```yaml
version: 1.16.0
files:
  - url: PunkcodeAI-win-x64.exe
    sha512: <base64-sha512>
    size: 102400000
path: PunkcodeAI-win-x64.exe
sha512: <base64-sha512>
releaseDate: '2026-06-01T12:00:00.000Z'
```

桌面端的版本比对靠 `version` 字段，签名校验靠 `sha512`。任何文件被改动后 `sha512` 必须重新生成（electron-builder 已自动算好，直接照搬）。

## 3. 通道（channel）目录结构

`electron-builder.config.ts` 按通道分目录：

```
https://punkcodeai.myverse.site/updates/
├── latest.yml              # prod channel (默认)
├── PunkcodeAI-win-x64.exe
├── PunkcodeAI-mac-arm64.dmg
├── latest-mac.yml
├── latest-linux.yml
├── PunkcodeAI-linux-x64.AppImage
├── dev/
│   ├── latest.yml          # dev channel
│   └── ...
└── beta/
    ├── latest.yml          # beta channel
    └── ...
```

prod 通道用户量最大，放在根目录；dev / beta 在各自子目录。

## 4. 上传流程

### 方案 A：nginx 静态目录（推荐用于 myverse.site）

1. 在站点根目录 (假设 `/var/www/punkcodeai/updates/`) 创建对应通道子目录
2. 把 `packages/desktop/dist/` 下产物（`*.yml` + `*.exe` / `*.dmg` / `*.AppImage`）整体 rsync 上去：

```bash
# 在打包机上执行
rsync -avz packages/desktop/dist/ \
  user@server:/var/www/punkcodeai/updates/
```

3. nginx 配置开启 CORS 与 sha512 元数据缓存友好策略：

```nginx
location /updates/ {
  alias /var/www/punkcodeai/updates/;
  add_header Access-Control-Allow-Origin "*";

  # *.yml 高频更新，不缓存
  location ~ /updates/.*\.ya?ml$ {
    add_header Cache-Control "no-cache, max-age=0";
  }

  # 安装包按 sha512 已校验，可长缓存
  location ~ /updates/.*\.(exe|dmg|zip|AppImage)$ {
    add_header Cache-Control "public, max-age=604800";  # 7 天
  }
}
```

### 方案 B：GitHub Releases 镜像（fallback）

如果短期没有自建服务器，可以临时把同一份产物上传到 GitHub Releases，然后用 `https://github.com/thkhxm/opencode/releases/latest/download` 作为 `PUNKCODE_UPDATE_FEED_URL`。这是 fallback，不是长期方案——一旦自建服务器就绪应立即切回。

## 5. GitLab CI 自动发布

正式包以 tag `desktop-v*` 触发 GitLab CI：

1. `build:mac` 在 macOS runner 产出 `dmg/zip/latest-mac.yml`
2. `build:win` 在 Windows runner 产出 `exe/blockmap/latest.yml`
3. `deploy:updates` 汇总两个 job 的 artifacts，校验 `latest*.yml` 中的 `size/sha512`，通过 SSH 发布到 `/updates`

GitLab CI/CD Variables 需要配置：

| 变量 | 说明 |
| --- | --- |
| `PUNKCODE_UPDATE_HOST` | 更新服务器 host |
| `PUNKCODE_UPDATE_USER` | SSH 用户 |
| `PUNKCODE_UPDATE_REMOTE_DIR` | 服务器上的 updates 根目录；prod 直接写入这里，`beta/dev` 会自动追加子目录 |
| `PUNKCODE_UPDATE_SSH_PRIVATE_KEY` | 部署 SSH 私钥 |
| `PUNKCODE_UPDATE_SSH_HOST_KEY` | 可选，`known_hosts` 行；不填时首次连接使用 OpenSSH `accept-new` |
| `PUNKCODE_UPDATE_PUBLIC_URL` | 可选，默认 `https://punkcodeai.myverse.site/updates` |

tag 发布命令：

```bash
git tag desktop-v1.15.39
git push origin desktop-v1.15.39
git push gitlab desktop-v1.15.39
```

## 6. 手动发布一次新版本的完整步骤

```bash
# 1. 在 packages/desktop/package.json 把 version 加一档（如 1.15.11 -> 1.16.0）
# 2. 打包
cd packages/desktop
bun run prebuild
bun run build
bun run package:win   # 或 :mac / :linux
# 产物在 dist/ 下：latest.yml + PunkcodeAI-win-x64.exe + .exe.blockmap
# 3. 上传（方案 A）
rsync -avz dist/ user@punkcodeai.myverse.site:/var/www/punkcodeai/updates/
# 4. 验证：从一台老版本 PunkcodeAI 上点 "检查更新"，确认能拉到、能下载、能装上
```

## 7. 灰度发布

`autoUpdater.channel` 当前固定 `latest`。如要做灰度：

1. 在 server 端发布两份 `latest.yml`：`latest.yml` (旧版本) + `latest-canary.yml` (新版本)
2. 在桌面端 `setupAutoUpdater()` 里按用户 id 哈希决定 `autoUpdater.channel`：

```ts
autoUpdater.channel = userIdHash % 100 < CANARY_PCT ? "canary" : "latest"
```

3. canary 用户先升级，问题在小范围内暴露后再 promote 到 latest。

## 8. 紧急下架

如发现刚发的版本有严重问题：

1. 把 server 上的 `latest.yml` 改回上一个稳定版本号
2. 删除问题版本的安装包文件
3. 已经升上去的用户会在下一次 `checkForUpdates()` 拉到旧版本 — electron-updater 默认 `allowDowngrade = true`（在 `updater.ts` 已开），会自动回滚
