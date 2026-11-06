# dsh-webdav-sync

[![npm version](https://img.shields.io/npm/v/dsh-webdav-sync?color=4a7dff)](https://www.npmjs.com/package/dsh-webdav-sync)
[![npm downloads](https://img.shields.io/npm/dm/dsh-webdav-sync)](https://www.npmjs.com/package/dsh-webdav-sync)
[![GitHub stars](https://img.shields.io/github/stars/HUIdada1/dsh-webdav-enhanced?style=social)](https://github.com/HUIdada1/dsh-webdav-enhanced)
[![license](https://img.shields.io/npm/l/dsh-webdav-sync)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-webdav-sync)](./package.json)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4a7dff)](https://www.npmjs.com/package/@deepseek-ai/dsh)

**简体中文** | [English](README.en.md)

用一台 WebDAV 服务器，把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh`）的插件、技能和模型配置同步到你的所有机器。

一台装好，其余机器自动跟上。不用再重复安装、手工拷贝 `settings.yaml`，也不用为了对齐环境折腾一晚上。

## 功能

| 能力 | 说明 |
| --- | --- |
| **同步插件** | profile 里的 bundle 打包上传，其他机器下载后自动安装 |
| **同步技能** | `$DSH_HOME/skills` 下的技能目录整包同步，装一次到处可用 |
| **同步模型配置** | `settings.yaml` 顶层 key 按需同步，默认关闭 |
| **双向 / 单向** | 每台机器可独立选择双向、仅上传、仅下载 |
| **自动去重** | 内容 SHA-256 寻址，同一份 zip 只存一次，多机上传不重复 |
| **冲突不丢数据** | 软锁 + 冲突副本 + 本地备份，任何策略下都能找回旧版本 |
| **定时同步** | 每 N 小时一次，带 0–5 分钟随机抖动，避免多机撞锁 |
| **自动安装** | 下载到的新插件、新技能自动落盘并注册 |

## 安装

在 dsh 的 **Add plugin** 向导里搜索 `dsh-webdav-sync` 并安装，或用 CLI：

```bash
# 桌面版（Electron）：profile 名为 desktop
dsh plugin --profile desktop add dsh-webdav-sync

# Web 版：profile 名为 web
dsh plugin --profile web add dsh-webdav-sync
```

本地开发版（link 安装，重新构建后重启即可生效）：

```bash
dsh plugin --profile desktop add link:/path/to/dsh-webdav-enhanced
```

装好后重启 dsh，进入 **设置 → 插件 → WebDAV 同步**。

> 设置页挂在 `plugins.bundle.config` 插槽上，和 `dsh-client-auto-continue` 等插件用的是同一套机制。

## 快速开始

1. **连接**：填 WebDAV 地址、账号、密码，点「测试连接」。测试会依次验证 PROPFIND、MKCOL、PUT 与回读，并探测服务端是否支持 LOCK / If-Match。
2. **同步内容**：勾选要同步的东西。默认插件 + 技能，模型配置默认关闭。
3. **同步方式**：选择方向与定时周期（例如每 1 小时）。默认双向。

每个页签点一次「保存」。测试连接通过后会自动触发首次同步。

## 设置页

| 页签 | 内容 |
| --- | --- |
| 连接 | 地址、账号、密码、超时、远端根目录、忽略自签 TLS |
| 同步内容 | 插件 / 技能 / 配置的开关、排除列表、只同步指定 key |
| 同步方式 | 方向、定时周期、冲突策略 |
| 记录与诊断 | 上次同步结果、环境探测、当前锁持有者、最近日志 |
| 危险区 | 重置本机同步状态、清空远端同步数据（需输入 DELETE 确认） |

## 配置项

常用项都能在设置页里改，其余通过 profile 的 `cordis.patch.yml` 配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `profile` | `desktop` | 要同步的 dsh profile 名。桌面版用 `desktop`，Web 版用 `web` |
| `connection.url` / `connection.username` | 空 | 也可在设置页填写 |
| `connection.password` | 空 | 仅作首次迁移来源；之后以本地凭据文件为准 |
| `schedule.enabled` / `schedule.intervalHours` | `false` / `1` | 定时同步开关与周期 |
| `conflictPolicy` | `merge-backup` | 冲突策略 |
| `scope.*` | 插件 + 技能 `all`，配置 `none` | 同步范围 |

## 同步范围

- **插件**：profile `package.json` 依赖里带 `dsh.bundle` 标记的条目，按本地路径打包。
- **技能**：`$DSH_HOME/skills` 下每个含 `SKILL.md` 的目录，连内部文件一起同步。
- **配置**：`settings.yaml` 的顶层 key，可用 `includeKeys` 精确指定。`.credentials.yaml` 永不参与。

## 冲突策略

| 策略 | 行为 |
| --- | --- |
| **自动合并 + 本地备份**（默认） | 下载远端版本，本地旧版本打包到 `~/.dsh/webdav-sync/backups/<kind>s/` |
| **冲突时询问** | 与上者相同，但在界面上显著标记冲突条目 |
| **本机优先** | 上传本机版本，覆盖远端 |
| **远端优先** | 下载远端版本，覆盖本机（旧版本仍会备份） |

## 服务器兼容性

| 服务 | 说明 |
| --- | --- |
| **Nextcloud / ownCloud** | 完整支持，请使用应用专用密码 |
| **坚果云** | 可用，需在账号设置里开启 WebDAV 并使用应用密码；有频率限制，建议间隔 ≥ 1 小时 |
| **群晖 Synology** | 安装 WebDAV Server 套件后完整支持 |
| **AList** | 完整支持，任意存储驱动 |
| **自建服务** | 任意 RFC 4918 实现；不支持 LOCK / If-Match 时自动降级为软锁与冲突副本 |

## 安全

- **API Key 默认不同步**：`.credentials.yaml` 与 `settings.yaml` 中的 `apiKey` 字段被排除；配置同步默认关闭。
- **密码不出本机**：WebDAV 密码写在 `$DSH_HOME/.webdav-sync/credentials.json`（权限 0600），既不进 cordis 配置，也不上传远端；接口返回的配置里永远不含密码。
- **完整性校验**：所有 zip 按 SHA-256 内容寻址，下载后逐份校验。
- **解压防护**：拒绝路径穿越与 zip 炸弹，单文件 128MB、总量 512MB 上限。

## 远端目录结构

```
/dsh-sync/
├── manifest.json        # 全局账本：条目、hash、来源机器
├── locks/sync.lock      # 软锁（服务端支持时用原生 LOCK）
├── bundles/*.zip        # 内容寻址的插件包
├── skills/*.zip         # 内容寻址的技能包
├── configs/*.zip        # settings.yaml 片段（可选）
└── trash/               # 软删除内容，可恢复
```

## 本机目录结构

```
$DSH_HOME/.webdav-sync/
├── webdav-sync.json     # 同步配置与状态（不含密码）
└── credentials.json     # WebDAV 密码（0600，不进 git、不上远端）
```

## Agent 工具

插件向 dsh 注册两个工具，可以直接在对话里调用：

| 工具 | 用途 |
| --- | --- |
| `webdav_sync_status` | 查询上次同步时间、机器 ID、环境探测结果、定时配置 |
| `webdav_sync_now` | 立即执行一次同步并返回报告 |

## 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 测试连接 401 | 账号或密码错误 | Nextcloud、坚果云需使用应用专用密码 |
| MKCOL 返回 405 | 目录已存在 | 无害，同步继续 |
| 同步返回 412 | 远端在合并期间被改动 | 自动重试 3 次；持续失败说明另一台机器正在同步 |
| 同步很慢 | 目录里混入大文件 | `node_modules` 已自动排除，其余请加入排除列表 |
| 技能同步后不可见 | dsh 缓存了技能索引 | 新开对话或重启 dsh web |
| 插件安装后未生效 | dsh 启动时加载插件 | 点提示条上的「重启」，或手动重启 |

## 开发

```bash
npm install
npm run check   # 类型检查 + 测试 + 构建
```

`npm run build` 先跑 `tsc` 产出 `lib/*.js`，再把 `src/client.js` 复制成 `lib/client.js`。前端是纯 JS、无 import，不需要打包器；dsh 通过 `exports["./client"]` 加载它，格式为 `window.__ModuleLoader__.load({ id, factory })`。

测试使用内置的 mock WebDAV 服务（`tests/mock-webdav-server.ts`），无需真实服务器即可跑通完整同步流程。

## License

[MIT](./LICENSE)
