# dsh-webdav-sync

WebDAV sync plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (dsh, `@deepseek-ai/dsh`).
Sync your plugins, skills, and model/provider configs across multiple machines via any WebDAV server.

[English](#english) | [中文](#中文)

---

## English

### What it does

- **Sync plugins (bundles)** between machines — one installs, all machines get it.
- **Sync skills** — install once, use everywhere.
- **Sync model/provider config** — opt-in, key-based sync of `settings.yaml` (API keys are **excluded by default**).
- **Two-way or one-way sync** — your choice per machine.
- **Automatic dedup** — content-hash addressing means the same zip is stored once, no matter how many machines upload it.
- **Conflict handling** — soft locks, conflict copies, and local backups. Data is never silently lost.
- **Scheduled sync** — every N hours (with jitter to avoid thundering herd).
- **Auto-install on download** — new plugins/skills from another machine are installed automatically.

### Install

```bash
dsh plugin --profile web add dsh-webdav-sync
# or from local checkout:
dsh plugin --profile web add /path/to/dsh-webdav-enhanced
```

Restart dsh web, then open **Settings → WebDAV Sync**.

### Quick start (3 steps)

1. **Connection tab**: enter your WebDAV URL, username, password → click **Test Connection**.
2. **Content tab**: choose what to sync (Plugins / Skills / Config). Default: Plugins + Skills.
3. **Mode tab**: enable scheduled sync (e.g. every 1 hour). Default: two-way.

Click **Save** on each tab. The first sync runs automatically after a successful test.

### WebDAV server compatibility

| Server | Notes |
|---|---|
| **Nextcloud** | Full support. Use an app-password, not your login password. |
| **坚果云 (Jianguoyun)** | Works. Enable WebDAV in account settings; use the app-specific password. Rate-limited — keep interval ≥1h. |
| **群晖 Synology** | Full support via WebDAV Server package. |
| **AList** | Full support. Any storage driver works. |
| **ownCloud** | Same as Nextcloud. |
| **Self-hosted** | Any RFC 4918 server. Lock/If-Match degrade gracefully if unsupported. |

### Conflict resolution

| Policy | Behaviour |
|---|---|
| **Auto-merge + local backup** (default) | Downloads remote version; your local version is backed up to `~/.dsh/webdav-sync/backups/` as `.conflict-<machineId>-<timestamp>.zip`. |
| **Ask on conflict** | Same as auto-merge, but the UI flags the conflict prominently. |
| **Local wins** | Your version is uploaded, overwriting remote. |
| **Remote wins** | Remote version is downloaded, overwriting local (old local backed up). |

### Security notes

- **API keys are never synced by default.** The `.credentials.yaml` file and `apiKey` fields in `settings.yaml` are excluded. Only enable "Models & Config" sync after reviewing which top-level keys are included.
- WebDAV password is stored locally only (system keychain or `.credentials.yaml`), never uploaded.
- All zip files are content-addressed (SHA-256) — integrity is verified on every download.
- Path traversal and zip bombs are rejected during extraction.

### Directory layout (remote)

```
/dsh-sync/
  manifest.json          # global ledger: all entries + content hashes + source machine
  locks/sync.lock        # soft lock (or server-native lock when supported)
  bundles/*.zip          # content-addressed plugin packages
  skills/*.zip           # content-addressed skill packages
  configs/*.zip          # settings.yaml fragments (opt-in)
  trash/                 # soft-deleted files (recoverable)
```

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "HTTP 401" on test | Wrong username/password | Some servers need an **app password** (Nextcloud, 坚果云). |
| "HTTP 405" on MKCOL | Path already exists | Usually harmless — sync proceeds. |
| "HTTP 412" on sync | Remote changed during merge | Automatic retry (max 3). If persistent, another machine is syncing — wait a moment. |
| Sync slow / stuck | Large `node_modules` | Excluded automatically. If you bundled dist artifacts, add to exclude list. |
| Skills not visible after sync | dsh caches skill index | New chat / restart dsh web. |
| Bundle needs restart | dsh loads plugins at startup | Click "Restart" in the banner, or restart manually. |

### Development

```bash
npm install
npm run check   # typecheck + test + build
```

Tests include a mock WebDAV server (`tests/mock-webdav-server.ts`) for offline integration tests.

---

## 中文

### 功能一览

- **跨电脑同步插件**：一台装好，其他机器自动出现。
- **跨电脑同步技能**：写一次，到处可用。
- **同步模型 / Provider 配置**：可选，默认关闭（避免密钥泄露）。
- **双向 / 单向**：每台机器可独立选择方向。
- **自动去重**：内容 hash 寻址，同一个 zip 只存一份，多机上传不重复。
- **冲突处理**：软锁 + 冲突副本 + 本地备份，**永不丢数据**。
- **定时同步**：每 N 小时一次（带随机抖动，避免多机撞锁）。
- **自动安装**：下载到的新插件 / 技能自动落盘并注册。

### 安装

```bash
dsh plugin --profile web add dsh-webdav-sync
# 或本地路径安装：
dsh plugin --profile web add ./dsh-webdav-enhanced
```

重启 dsh web，打开 **设置 → WebDAV 同步**。

### 快速上手（3 步）

1. **连接页**：填 WebDAV 地址、账号、密码 → 点 **测试连接**。
2. **内容页**：勾选要同步的内容（插件 / 技能 / 配置）。默认：插件 + 技能。
3. **方式页**：开启定时同步（如每 1 小时）。默认：双向。

每个页签都要点 **保存**。测试连接成功后会自动触发首次同步。

### 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 测试连接报 401 | 账号密码错 | 部分服务需用**应用专用密码**（Nextcloud、坚果云） |
| MKCOL 报 405 | 路径已存在 | 一般无害，同步会继续 |
| 同步报 412 | 远端合并冲突 | 自动重试 3 次；若持续，另一台机器正在同步，稍等 |
| 同步慢 / 卡住 | node_modules 太大 | 已自动排除；如打包了 dist，请加入排除列表 |
| 技能同步后不可见 | dsh 缓存了索引 | 新开对话 / 重启 dsh web |
| 插件需重启 | dsh 启动时加载插件 | 点提示条上的"重启"，或手动重启 |

### 安全说明

- **API Key 默认不同步**：`.credentials.yaml` 与 `settings.yaml` 中的 `apiKey` 字段被排除。
- WebDAV 密码仅存本机（系统钥匙串或 `.credentials.yaml`），不上传远端。
- 所有 zip 内容寻址（SHA-256），下载时校验完整性。
- 解压时拒绝路径穿越与 zip 炸弹。

### 开源协议

MIT
