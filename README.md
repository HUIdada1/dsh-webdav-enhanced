# dsh-webdav-enhanced

[![npm version](https://img.shields.io/npm/v/dsh-webdav-enhanced?color=4a7dff)](https://www.npmjs.com/package/dsh-webdav-enhanced)
[![npm downloads](https://img.shields.io/npm/dm/dsh-webdav-enhanced)](https://www.npmjs.com/package/dsh-webdav-enhanced)
[![GitHub stars](https://img.shields.io/github/stars/HUIdada1/dsh-webdav-enhanced?style=social)](https://github.com/HUIdada1/dsh-webdav-enhanced)
[![license](https://img.shields.io/npm/l/dsh-webdav-enhanced)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-webdav-enhanced)](./package.json)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4a7dff)](https://www.npmjs.com/package/@deepseek-ai/dsh)

**简体中文** | [English](README.en.md)

用一台 WebDAV 服务器，把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh`）的插件、技能和模型配置同步到你的所有机器。

一台装好，其余机器自动跟上。分叉时自动合并、内容自动去重，不用再重复安装、手工拷贝 `settings.yaml`，也不用为了对齐环境折腾一晚上。

## 功能

| 能力 | 说明 |
| --- | --- |
| **同步插件** | profile 里的 bundle 打包上传，其他机器下载后自动安装 |
| **同步技能** | `$DSH_HOME/skills` 下的技能目录整包同步，装一次到处可用 |
| **同步模型配置** | `settings.yaml` 顶层 key 按 key 合并同步，默认关闭 |
| **双向 / 单向** | 每台机器可独立选择双向、仅上传、仅下载 |
| **内容寻址去重** | 内容 SHA-256 寻址，同内容只传一次；远端已有同内容文件时跨条目复用，不重复上传 |
| **三路智能合并** | base 取上次同步快照，只有两端都改过才算分叉；分叉按修改时间、再按版本号裁决赢家，输家自动备份 |
| **默认全自动** | 分叉自动裁决、下载即安装、删除自动传播、定时开关保存即生效，不需要人工处理冲突 |
| **删除传播** | 一端删除，另一端跟随：远端进 `trash/`，本地先备份 |
| **实时进度** | 阶段 + 百分比 + 上传/下载/合并/跳过/删除计数 + 当前条目，运行中随时取消 |
| **结构化日志** | 按级别与分类（上传/下载/合并/跳过/删除/去重/冲突/连接/调度/环境）落盘 JSONL，界面可筛选、搜索、导出 |
| **干跑分析** | 同步前先看差异清单（每个条目要上传、下载、合并还是跳过），只读不写 |
| **自动清理** | 远端 tombstone 与超期 trash 自动清理，本地备份按份数轮转（默认保留 10 份） |

## 安装

在 dsh 的 **Add plugin** 向导里搜索 `dsh-webdav-enhanced` 并安装，或用 CLI：

```bash
# 桌面版（Electron）：profile 名为 desktop
dsh plugin --profile desktop add dsh-webdav-enhanced

# Web 版：profile 名为 web
dsh plugin --profile web add dsh-webdav-enhanced
```

本地开发版（link 安装，重新构建后重启即可生效）：

```bash
dsh plugin --profile desktop add link:/path/to/dsh-webdav-enhanced
```

装好后重启 dsh。面板有两个入口，内容完全一致：

- **插件详情页**：左侧边栏 **插件** → **已安装插件** → 点开 **WebDAV 同步**（包名 `dsh-webdav-enhanced`），面板占详情页主体，共 7 个页签，第一个是「概览」。
- **设置弹窗**：左侧导航里的 **WebDAV 同步** 独立设置页，和插件页是同一套面板。

> 说明：配置页注册在 `plugins.bundle.config`、`plugins.row.config` 与设置弹窗的 `settings.section`（id `webdav-sync`）三个插槽上。包内 `locale/*.json` 提供列表里的标题、描述与详情文档路径，`icon.svg` 提供图标；缺任意一项时 dsh 会退回包名与默认插画。

## 快速开始

1. **看一遍「说明」**：面板里的「说明」页签是卡片化的上手文档，快速开始、能力地图、同步规则、兼容性、安全与 FAQ 都在里面。
2. **连接**：填 WebDAV 地址、账号、密码，点「测试连接」。测试会依次验证 PROPFIND、MKCOL、PUT 与回读，并探测服务端是否支持 LOCK / If-Match。
3. **内容**：勾选要同步的东西。默认插件 + 技能，模型配置默认关闭。
4. **方式**：选择方向与定时间隔（例如每 1 小时）。默认双向、不定时。
5. **同步**：回「概览」点「分析差异」先看清单，确认后点「立即同步」；进度卡会实时显示阶段、百分比与逐条结果。

每个页签点一次「保存」。测试连接通过后可直接点「立即同步」跑第一次。

## 设置页

插件详情页与设置弹窗共用这 7 个页签，顺序固定：

| 页签 | 内容 |
| --- | --- |
| 概览 | 状态头（连接 / 机器 / 上次同步 / 方向）、立即同步 + 进度卡、最近一次运行分类统计、一键「分析差异」结果表 |
| 说明 | 卡片化文档：快速开始、能力地图、同步规则、服务器兼容、安全、FAQ、关于（版本 / 机器 ID / 数据目录） |
| 连接 | 地址、账号、密码、测试连接、高级（超时 / 远端根目录 / 忽略自签 TLS）、服务端能力 |
| 内容 | 插件 / 技能 / 配置三组，模式选择 + 条目勾选 + 排除项 |
| 方式 | 方向、定时开关与间隔、冲突策略、智能选项开关组 |
| 日志 | 级别与分类筛选 + 搜索 + 列表 + 导出，运行中自动刷新 |
| 诊断 | 环境 KV、锁持有者、服务端能力、重新探测、危险区（重置本机 / 清空远端） |

## 配置项

常用项都能在设置页里改，其余通过 profile 的 `cordis.patch.yml` 配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `profile` | 自动探测 | 要同步的 dsh profile 名。留空时按「哪个 profile 装了本插件」判定，桌面版得 `desktop`、Web 版得 `web` |
| `connection.url` / `connection.username` | 空 | 也可在设置页填写 |
| `connection.password` | 空 | 仅作首次迁移来源；之后以本地凭据文件为准 |
| `options.timeoutMs` | `30000` | 单次 WebDAV 请求超时（毫秒） |
| `options.remoteRoot` | `/dsh-sync/` | 远端同步根目录 |
| `options.ignoreTlsErrors` | `false` | 仅内网自签证书场景开启 |
| `schedule.enabled` / `schedule.intervalHours` | `false` / `1` | 定时同步开关与周期，保存即生效，无需重启 |
| `conflictPolicy` | `auto` | 冲突策略，见下文「冲突策略」 |
| `syncOptions.propagateDeletions` | `true` | 删除传播：一端删除另一端跟随 |
| `syncOptions.autoResolve` | `'auto'` | 分叉裁决方式：`auto` / `local` / `remote` / `manual` |
| `syncOptions.dedupeRemote` | `true` | 跨条目远端去重：远端已有同 hash 文件时只登记不重传 |
| `syncOptions.autoInstall` | `true` | 下载后自动安装：bundle 走插件安装、技能解压、配置按键合并 |
| `syncOptions.contentMerge` | `true` | 配置按顶层 key 合并，不再整体覆盖文件 |
| `syncOptions.maxBackups` | `10` | 每类条目保留的本地备份份数，超出删除最旧 |
| `syncOptions.pruneTombstones` | `true` | 同步结束后清理远端 tombstone 与超期 trash |
| `syncOptions.hardDelete` | `false` | 是否在结束后物理删除远端 tombstone（默认只清 trash） |
| `scope.*` | 插件 + 技能 `all`，配置 `none` | 同步范围 |

## 同步范围

- **插件**：profile `package.json` 依赖里带 `dsh.bundle` 标记的条目，按本地路径打包。
- **技能**：`$DSH_HOME/skills` 下每个含 `SKILL.md` 的目录，连内部文件一起同步。
- **配置**：`settings.yaml` 的顶层 key，可用 `includeKeys` 精确指定。`.credentials.yaml` 永不参与，`apiKey`、`credentials` 等敏感顶层 key 同样永不参与。

配置模式选「全部」时同步所有非敏感顶层 key；选「指定」时只动 `includeKeys` 列出的 key。

> 范围是**双向生效**的：某类选「不同步」或把条目加进排除列表后，既不扫描上传，也不会从远端下载；删除传播同样不会碰它。

## 冲突策略

v0.4.0 起默认策略是 `auto`：两端都改过才算分叉，分叉时自动按「修改时间 → 版本号 → 远端优先」裁决赢家，输家自动备份，**不产生需要人工决策的冲突**。

| 策略 | 行为 |
| --- | --- |
| **`auto`**（默认） | 修改时间差 > 2 秒时新的赢；差距 ≤ 2 秒按版本号裁决；仍相同则远端赢（避免两机互踢）。输家自动备份 |
| **`merge-backup`** | 兼容旧版：分叉时下载远端版本，本机旧版本备份 |
| **`ask`** | 兼容旧版：只在显式选择时生效，不裁决，冲突条目落进报告并在界面标红 |
| **`local-wins`** | 固定本机赢，上传本机版本覆盖远端（远端旧版本进 trash） |
| **`remote-wins`** | 固定远端赢，下载远端版本覆盖本机（本机旧版本先备份） |

想彻底退出自动模式、每次都人工过一遍冲突，把 `conflictPolicy` 设为 `ask`；其余情况保持默认即可。

## 服务器兼容性

| 服务 | 说明 |
| --- | --- |
| **Nextcloud / ownCloud** | 完整支持，请使用应用专用密码 |
| **坚果云** | 可用，需在账号设置里开启 WebDAV 并使用应用密码；有频率限制，建议间隔 ≥ 1 小时 |
| **群晖 Synology** | 安装 WebDAV Server 套件后完整支持 |
| **AList** | 完整支持，任意存储驱动 |
| **自建服务** | 任意 RFC 4918 实现；不支持 LOCK / If-Match 时自动降级为软锁与冲突副本 |

## 安全

- **API Key 默认不同步**：`.credentials.yaml` 永不参与；`settings.yaml` 里的 `apiKey` 等敏感顶层 key 永不参与；配置同步默认关闭。
- **密码不出本机**：WebDAV 密码写在 `$DSH_HOME/.webdav-enhanced/credentials.json`（权限 0600），既不进 cordis 配置，也不上传远端；接口返回的配置里永远不含密码。
- **完整性校验**：所有 zip 按 SHA-256 内容寻址，下载后逐份校验。
- **删除有兜底**：远端删除进 `trash/` 保留 7 天，本地删除前先备份，误删可从两处找回。
- **解压防护**：拒绝路径穿越与 zip 炸弹，单文件 128MB、总量 512MB 上限。

## 远端目录结构

```
/dsh-sync/
├── manifest.json        # 全局账本：条目、hash、版本、来源机器、删除墓碑
├── locks/sync.lock      # 软锁（服务端支持时用原生 LOCK）
├── bundles/*.zip        # 内容寻址的插件包
├── skills/*.zip         # 内容寻址的技能包
├── configs/*.zip        # settings.yaml 片段（可选）
└── trash/               # 删除与冲突的兜底副本，超期自动清理
```

每次同步结束会清理墓碑与超过 7 天的 trash，由 `syncOptions.pruneTombstones` 与 `hardDelete` 控制。

## 本机目录结构

```
$DSH_HOME/.webdav-enhanced/
├── webdav-enhanced.json     # 同步配置与状态（不含密码）
├── credentials.json         # WebDAV 密码（0600，不进 git、不上远端）
├── hash-cache.json          # 扫描哈希缓存，加速差异分析
├── backups/<kind>s/         # 合并 / 覆盖前的本地备份，按 maxBackups 轮转
└── logs/sync.jsonl          # 结构化日志（>1MB 轮转为 sync.1.jsonl）
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
| 插件页里找不到面板 | 面板有两个入口：插件详情页与设置弹窗 | 插件 → 已安装插件 → WebDAV 同步；或设置弹窗左侧的「WebDAV 同步」，两处是同一套面板 |
| 进度卡停在某个阶段不动 | 单条大文件传输慢、服务端限速，或在等软锁 | 看「日志」页签最新一条消息；仍不动就点「取消」，检查网络与远端锁；坚果云这类有限速的服务把定时间隔放到 ≥ 1 小时 |
| 日志在哪里看 | 界面和文件都有 | 面板「日志」页签可筛选、搜索、导出；落盘在 `$DSH_HOME/.webdav-enhanced/logs/sync.jsonl` |
| 备份在哪里找 | 合并或覆盖前的旧版本 | `$DSH_HOME/.webdav-enhanced/backups/<kind>s/`，按 `syncOptions.maxBackups` 轮转（默认 10 份） |
| 自动合并会不会丢数据 | 不会 | 输家版本自动备份，远端删除进 trash；想全部人工确认可把 `conflictPolicy` 设为 `ask` |
| 想先看差异再同步 | 干跑分析 | 概览 → 「分析差异」，只列清单，不写任何东西 |
| 定时同步改了不生效 | 旧版需要重启 | v0.4.0 起保存即生效；仍不跑就看「日志」里调度分类的记录 |
| 列表里只显示包名、没有图标 | `dsh.client` 或 `icon` / `locale` 导出缺失 | 0.3.0 起已内置，确认安装的是 `>=0.3.0` |
| 测试连接 401 | 账号或密码错误 | Nextcloud、坚果云需使用应用专用密码；改了密码请重新在面板里输入并保存 |
| MKCOL / PUT 返回 423 | 远端目录被 LOCK 锁住 | 「测试连接」不再锁目录；若仍报 423，等 10–60 秒或重启 WebDAV 服务端清掉残留锁 |
| readback 返回 404 | 上一步 PUT 没写进去 | 先解决 423 / 403；文件根本没落盘时读回必然 404 |
| MKCOL 返回 405 | 目录已存在 | 无害，同步继续 |
| 同步返回 412 | 远端在合并期间被改动 | 自动重试 3 次；持续失败说明另一台机器正在同步 |
| 同步很慢 | 目录里混入大文件 | `node_modules` 已自动排除，其余请加入排除列表；也可先在概览点「分析差异」确认这次要动多少条目 |
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
