# dsh-webdav-enhanced 完整设计方案

> 项目：DeepSeek Harness WebDAV 同步插件（开源）
> 仓库：https://github.com/HUIdada1/dsh-webdav-enhanced.git
> 版本：方案 v1.0（2026-11-05）
> 状态：仅出方案，不含代码提交

---

## 0. 事实核查结论（方案的现实基础）

动手前必须钉死的真实事实，全部来自对 dsh 生态的检索核实，不是想象：

### 0.1 dsh 的真实形态
- dsh 是 npm 包 `@deepseek-ai/dsh`，基于 **Cordis 插件架构**（Koishi 同款），自带 Web UI，默认 `http://127.0.0.1:3080`。
- 启动方式：`npx @deepseek-ai/dsh web`（或 `pnpm dsh web`）。
- 插件三件套：**`package.json`（含 `dsh: { bundle: true }`）+ `cordis.patch.yml` + `src/index.ts`（导出 `name` / `Config`(Schemastery) / `apply(ctx, config)`）**。
- 安装方式：`dsh plugin --profile web add <npm包名或本地路径>`；现有成熟插件（deepseek-plugin、skillhub）都提供 **"设置弹窗里的独立设置页"**，说明"设置弹窗独立 tab 页"是平台原生支持的能力，本方案直接沿用该模式。

### 0.2 数据目录的真实分布（多版本、多安装方式并存，必须探测）
| 场景 | 路径 |
|---|---|
| CLI（Cordis 代） | `$DSH_HOME` 环境变量优先，否则 `~/.dsh/`（settings.yaml、.credentials.yaml） |
| Windows 桌面端 | `%APPDATA%\DeepSeek Harness\` 或 `%USERPROFILE%\.deepseek-harness\` |
| Windows 另一部分版本 | `%USERPROFILE%\.dsh\` |
| macOS | `~/Library/Application Support/DeepSeek Harness/` |
| Linux | `~/.config/deepseek-harness/` 或 `~/.deepseek-harness/` 或 `~/.dsh/` |
| 旧代（0.1.x harness） | `~/.deepseek-harness/plugins/`（manifest.json 制式，与本代 Cordis bundle 制式**不兼容**） |

**结论**：不存在唯一路径，本插件第一优先级就是"环境探测 + 路径归一化"，绝不允许硬编码。

### 0.3 需要同步的真实内容对象
1. **插件（bundles）**：当前 web profile 的 `package.json` 依赖列表 + profile 的 cordis.patch / dsh.profile.yml。
2. **技能（skills）**：`$DSH_HOME/skills/` 下的技能包目录（SKILL.md 制式）。
3. **模型/Provider 配置**：settings.yaml 中 `llm-deepseek` 段及各 provider 段（注意 `.credentials.yaml` 存密钥，**默认不同步密钥**，见 §7 安全设计）。
4. **Agent 预设 / workflow 定义**（若用户目录存在 agents/、flows/ 则纳入可选同步项）。

---

## 1. 总体架构

```
┌─────────────────────────── 单台电脑 ───────────────────────────┐
│  dsh Web UI                                                    │
│    └── 设置弹窗 → "WebDAV 同步" tab（本插件注入的设置页）        │
│           │ 读写                                                │
│    ┌──────▼─────────────────────────────────────────────┐      │
│    │  webdav-sync 插件（Cordis bundle）                   │      │
│    │  ├─ host.ts        入口/工具注册/设置页注册           │      │
│    │  ├─ core/          纯逻辑层（无 dsh 依赖，可单测）    │      │
│    │  │   ├─ env.ts        环境探测与路径归一化            │      │
│    │  │   ├─ webdav.ts     WebDAV 客户端（含容错重试）     │      │
│    │  │   ├─ pack.ts       打包/压缩（zip）/解压/校验      │      │
│    │  │   ├─ manifest.ts   同步清单/指纹/去重               │      │
│    │  │   ├─ merge.ts      三方合并与冲突处理              │      │
│    │  │   ├─ sync.ts       同步引擎（上传/下载/定时调度）  │      │
│    │  │   └─ install.ts    落盘与"自动扫描安装新插件"      │      │
│    │  ├─ client.js     设置页前端（跟随 dsh 中英双语）      │      │
│    │  └─ config-store  本地配置（webdav-sync.json）        │      │
│    └──────▲─────────────────────────────────────────────┘      │
│           │ 读                                                  │
│  本地真实数据：~/.dsh（profile/skills/settings）                 │
└────────────────────────────────────────────────────────────────┘
              │ 上传：zip 包 + 增量清单            │ 下载：清单比对 → zip 拉取 → 本地解压
┌─────────────▼──────────────────────────────────────────────────┐
│  WebDAV 服务器（用户自定义：坚果云/Nextcloud/群晖/AList/自建…）  │
│  /dsh-sync/                                                    │
│    ├─ manifest.json        ← 全局清单（所有条目+指纹+来源机）   │
│    ├─ locks/sync.lock      ← 分布式锁文件（If 头条件写）        │
│    ├─ bundles/<name>@<ver>-<hash8>.zip                        │
│    ├─ skills/<slug>@<ver>-<hash8>.zip                         │
│    ├─ configs/settings@<hash8>.zip                            │
│    └─ trash/               ← 回收站（删除先进回收站，可回滚）   │
└──────────────────────────────────────────────────────────────────┘
```

设计原则（对应你的每一条要求）：
- **高度容错**：所有外部操作（网络、文件 IO、dsh 命令）一律"探测→尝试→重试→降级→报告"，任何单点失败不阻塞整体，不抛未捕获异常到宿主。
- **简约上手**：默认配置下用户只需填 3 个字段（WebDAV 地址、账号、密码）点"测试连接"→"立即同步"即完成首次同步；高级选项全部折叠。
- **可并行开发**：core/ 为纯 TypeScript 逻辑层，不依赖 dsh 运行时，每个模块有独立接口契约（见 §9），可多人/多分支并行写。

---

## 2. 模块方案（逐项）

### M1. 环境探测与路径归一化（env.ts）★地基模块，最先做

**问题**：每台电脑 dsh 安装方式、版本、目录都不同，甚至同机同时存在 CLI 与桌面端两个数据目录。

**探测顺序（从确定到猜测，逐级兜底）**：
1. 读取环境变量 `DSH_HOME`（Cordis 代官方支持），存在且含 settings.yaml → 直接用。
2. 执行 `dsh --version` / 读 `node_modules/@deepseek-ai/dsh/package.json` 判断宿主版本，记录 `dshVersion`、`nodeVersion`、`platform`、`profile`（默认 `web`）。
3. 按平台枚举候选目录（§0.2 全表），逐个 `fs.existsSync` 探测，收集"实际存在的目录集合"。
4. **目录去重与归一**：多个候选命中时，按"含 settings.yaml 优先 > 最近修改时间新优先"排序，取主目录；其余登记为"旁路目录"仅提示不自动操作。
5. 探测结果持久化到 `webdav-sync.json` 的 `env` 段，并缓存 mtime，下次启动若目录消失自动重探测（容错：电脑换了用户名/重装了系统也能自愈）。

**版本适配矩阵**：
| 宿主版本特征 | 插件行为 |
|---|---|
| Cordis 代（存在 settings.yaml + profiles） | 全功能：bundle 同步、skills 同步、provider 配置同步、设置页注入 |
| 旧 harness 代（仅 ~/.deepseek-harness/plugins/） | 降级：只做 plugins/ 目录的 zip 级文件同步，设置页注入不可用时退化为"工具命令 + 本地 HTML 面板"托底（见 M8） |
| 探测不到任何目录 | 设置页显示引导页："未找到 dsh 数据目录，请手动指定"，提供目录选择器，用户指定后写入配置 |

**产出**：`ResolvedEnv { dshHome, profileDir, skillsDir, settingsFile, credentialsFile, dshVersion, generation: 'cordis'|'legacy'|'unknown', extras: string[] }`

### M2. WebDAV 客户端（webdav.ts）

**依赖选型**：`webdav`（npm，webdav-client，支持 Basic/Digest 认证、自定义 header、流式传输，无原生依赖，Windows/Linux/macOS 通吃）。不自研 HTTP 层。

**功能与容错**：
- 连接配置：URL（自动补全/去除尾部斜杠、自动识别子路径）、用户名、密码、（高级）自定义超时、代理、忽略 TLS 证书错误开关（默认关，仅内网自签证书场景手动开）。
- **"测试连接"按钮**：依次 PROPFIND 根 → MKCOL `/dsh-sync/` → 写一个探针文件 → 读回校验 → 删除，四步全过才算绿，每步失败给出人话错误（401 → 账号密码错；404 → 路径错；405/501 → 服务端不支持 MKCOL 或只读；网络错 → 超时/代理）。
- 重试策略：指数退避（1s/2s/4s/8s，最多 4 次），仅对网络类错误重试；401/403 不重试直接报错。
- **断点续传**：上传/下载用分块（每块 4MB）+ 临时文件名（`.part`），完成后 MOVE 成正式名；中断后下次自动从 `.part` 续传或清理重传。
- 兼容性声明与实测目标：坚果云（有 WebDAV 频率限制，需要限速与错误 503 退让）、Nextcloud、群晖 WebDAV、AList、ownCloud、IIS WebDAV。对"不支持 If 头"的服务端，锁机制自动降级为"last-writer 软锁 + 冲突副本"模式（见 M5）。

### M3. 打包 / 压缩 / 校验（pack.ts）

- **格式：zip**（用户明确要求压缩包上传）。库选型：`archiver`（打包）+ `unzipper`（解包），均为纯 JS，跨平台稳定。不用 tar.gz（Windows 资源管理器不友好）。
- zip 内固定结构：`<条目名>/...原样文件树` + `_meta.json`（条目类型、来源机器 id、原始路径、打包时间、dsh 版本）。解包时先读 `_meta.json` 做校验，**拒绝路径穿越**（解出的每条路径必须解析后仍位于目标目录内，参考 skillhub 的安全实践）。
- 压缩级别 6（大小与 CPU 平衡）；skills 一般 <1MB，bundles 可能含 node_modules 很大——**默认排除 `node_modules`、`.git`、`logs/`、缓存目录**，因为 bundle 靠 `dsh plugin add` 重装重建依赖，不需要同步依赖本体（这是重要的体积决策，也避免跨平台二进制不一致）。
- 校验：每个 zip 计算 SHA-256，作为文件名后缀 `<name>@<ver>-<hash8>.zip`，天然内容寻址 = **天然去重**（同一内容永远只有一个文件，重复上传直接 304 式跳过）。

### M4. 同步清单与自动去重（manifest.ts）

WebDAV 上 `/dsh-sync/manifest.json` 是全量的"账本"：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-11-05T10:00:00Z",
  "entries": [
    {
      "kind": "bundle" | "skill" | "config",
      "name": "skillhub-plugin",
      "version": "0.2.16",
      "hash": "sha256全串",          // 去重与变更判定的唯一依据
      "file": "bundles/skillhub-plugin@0.2.16-a1b2c3d4.zip",
      "size": 123456,
      "source": { "machineId": "home-pc", "platform": "win32", "dshVersion": "0.1.6" },
      "firstSeenAt": "...", "updatedAt": "...",
      "deleted": false               // 软删除标记，配合回收站
    }
  ]
}
```

- **去重规则**：hash 相同 = 同一内容，无论来自哪台电脑都不重复上传；本地与远端 manifest 比对后，只有"本地有新 hash"的条目才进入上传队列。
- **manifest 并发写保护**：读取→合并→写回前必须持锁（M5）；写回用 ETag/If-Match 条件写（服务端支持时），失败则重新读取重新合并重试，最多 3 次。
- manifest 单文件可能膨胀：条目数 >2000 时自动分片（manifest.0.json…），v1 先不分片但留 `version` 字段。

### M5. 多机冲突处理（merge.ts）★核心难点

**冲突场景**：A、B 两台电脑同时改了同一个 skill → 都上传。策略按条目类型分级：

1. **默认策略「远端优先合并 + 本地副本保留」（推荐，开箱即用）**
   - 同步周期内以"最后更新者赢"（manifest.updatedAt 最新者为准）。
   - 本地被覆盖的旧版本**自动备份**到 `~/.dsh/webdav-sync/backups/<时间戳>/`，可随时回滚——先保证永不丢数据，再谈合并。
2. **软锁（协作互斥）**：同步开始时向 `/dsh-sync/locks/sync.lock` 写 `{machineId, startedAt, ttl: 10min}`；其他机器看到未过期锁则**跳过本轮自动同步**（手动同步弹确认框"另一台机器正在同步，仍要执行？"）。锁带 TTL 防止崩溃死锁。服务端不支持条件写时降级为"锁文件尽力而为 + 冲突副本"模式。
3. **真冲突副本（conflict copies）**：当两端对同一 name 都有"非祖先关系"的新 hash（判定依据：本地记录里保存的"上次同步时该条目的 hash"），不静默覆盖，而是：远端版本落为正式条目，本地版本落为 `<name>.conflict-<machineId>-<日期>.zip` 并存入回收站目录，设置页"同步记录"里给出醒目冲突提示，由用户二选一或手动合并。这是 Git/Syncthing 的实践，用户能理解。
4. **settings.yaml 这类纯文本配置的合并**：不做三方 diff 合并（复杂且易错），采用"按 key 合并"——顶层 key 粒度以 updatedAt 较新者覆盖，被覆盖的旧值写入冲突报告。模型列表天然是"并集优先"：本地有而远端没有的 provider 追加进去，同名 provider 以新版本为准。

**机器身份**：每台机器首次运行生成 `machineId`（hostname+随机串），用于来源标注与冲突命名。

### M6. 同步引擎与定时调度（sync.ts）

- **一次同步的标准流程**（上传与下载解耦，顺序固定，可断点续跑）：
  1. 环境探测（M1）→ 2. 本地扫描生成"本地清单"（选中条目逐项算 hash）→ 3. 持锁拉取远端 manifest → 4. **下载阶段**：远端有而本地没有/更新的选中条目 → 下载 zip → 校验 → 解压到 staging → 走 install.ts 落盘 → 5. **上传阶段**：本地有而远端没有的条目 → 打包 → 上传 zip → 更新 manifest → 6. 释放锁、写同步记录。
- **定时同步**：设置项 `intervalHours`（0.5~168 小时，默认 0 = 关闭；用户要求"多少小时一次"，默认推荐 1 小时）。用 `setInterval` + 抖动随机延迟（0~5 分钟）避免多机同时撞锁。dsh 重启后按"上次同步时间 + interval"补算是否逾期。
- **上传/下载方向开关**：三个独立选项——自动双向（默认）/仅上传/仅下载，满足"备份型用户"和"接收型用户"。
- **带宽与频率保护**：坚果云类限速服务端遇到 503 自动进入 15 分钟冷静期；单文件上传限速可选（默认不限）。
- **同步记录**：最近 200 条存本地（时间、方向、条目数、成功/失败/冲突明细），设置页可见，失败条目一键重试。

### M7. 设置弹窗「WebDAV 同步」tab（client.js + host 设置页）

沿用现有成熟插件（skillhub/deepseek-plugin）已验证的模式：注入 dsh 设置弹窗独立设置页，前端跟随 dsh 中英双语。

**Tab 结构（左侧二级导航）**：
1. **连接（地址设置）**：WebDAV 地址、账号、密码（密码用 password 输入框，仅存本机 `.credentials.yaml` 或系统钥匙串，绝不上传 WebDAV——见 §7）、连接测试按钮（结果四步明细）、高级折叠项（超时、代理、TLS 忽略、自定义远端根路径）。
2. **同步内容**：三类开关卡片——插件 / 技能 / 模型与配置，每类内"全选"或逐项勾选（列表来自 M1 本地扫描 + 远端 manifest 并集，标注"仅远端有"的条目并提示"下载后自动安装"）；每项显示版本、大小、来源机器。
3. **同步方式**：方向（双向/仅上传/仅下载）、定时开关 + 小时数、冲突策略选择（自动合并保留副本 / 总是询问 / 总是本地优先 / 总是远端优先）。
4. **记录与诊断**：同步记录列表、当前锁状态（哪台机器持有）、日志查看（复制/导出按钮）、环境探测结果展示（识别到的 dsh 版本与目录，一键重新探测）。
5. **危险区**：清空远端同步数据（二次确认 + 输入 `DELETE`）、重置本机同步状态。

**操作简约性**：首屏只有"连接"必填三项 + 大按钮"测试连接并立即同步"；其余全部有合理默认。

### M8. 落盘与"自动扫描安装新插件"（install.ts）

- **插件（bundle）落盘**：下载的 bundle zip **不直接解到 profile**，而是生成/复用本地目录 → 执行与 skillhub 相同思路的 `dsh plugin --profile <profile> add <本地路径>`（在本机复用当前 dsh CLI，解析 ndjson 进度）→ 成功后更新 profile 的 cordis.patch/依赖；失败（如 pnpm 拦截 prepare）自动按 skillhub 的成熟做法写入 `dangerouslyAllowAllBuilds` 重试一次，再失败则标记"待手动安装"并给出命令。
- **技能（skill）落盘**：解压到 `$DSH_HOME/skills/<slug>/`，拒绝路径穿越、要求含 SKILL.md（skillhub 同款校验）；skills 目录有文件监视，多数情况无需重启 dsh。
- **自动扫描**：两种触发——(a) 每次同步完成后自动执行；(b) 可选"监听模式"：监视 `$DSH_HOME/skills/` 与 profile 变化（chokidar，防抖 30s），变化后延迟进入同步队列。实现上 (a) 为 v1 必做，(b) 为 v1.1。
- **幂等性**：安装前比对 hash，已是最新则跳过；重复执行整个 install 流程不产生副作用。

### M9. 宿主入口与工具（host.ts）

- Cordis 入口：`export const name = 'webdav-sync'`，`Config` 用 Schemastery 定义全部设置（有默认值，改配置热更新）。
- 注册 Agent 工具（可选，v1.1）：`webdav_sync_status`、`webdav_sync_now`，让 Agent 可以回答"同步了吗/帮我同步"。
- 注入设置页（M7）；插件卸载时清理定时器与文件监视，不留后台任务。

---

## 3. 安全与隐私设计

1. **密钥默认不同步**：`.credentials.yaml`（API Key 存放处）与 provider 的 apiKey 字段默认排除，设置页提供"同步密钥（不推荐，需手动确认）"开关。——这是最容易出事故的点，必须默认关。
2. **密码存储**：WebDAV 密码仅存本机：优先系统钥匙串（keytar 可选依赖，装不上则降级明文存 `.credentials.yaml` 并提示），永不上传远端、永不写进日志。
3. **日志脱敏**：所有日志输出前过滤 password/apiKey/token 字段。
4. **解压安全**：路径穿越拒绝、zip 炸弹防护（总解压体积上限 512MB，单文件 128MB）、不解压可执行权限位。
5. **锁 TTL、回收站、本地备份**三重兜底，保证同步永不造成不可恢复的数据丢失——这是"高度容错"的底线承诺。

---

## 4. 配置格式（本地 webdav-sync.json）

```jsonc
{
  "connection": { "url": "", "username": "", "passwordRef": "keychain|credentials" },
  "scope": {
    "bundles": { "mode": "all", "exclude": [] },   // all | selected
    "skills":  { "mode": "all", "exclude": [] },
    "configs": { "mode": "none", "includeKeys": [] } // none | keys | all(不含密钥)
  },
  "schedule": { "enabled": false, "intervalHours": 1, "direction": "both" },
  "conflictPolicy": "merge-backup",   // merge-backup | ask | local-wins | remote-wins
  "machineId": "home-pc-8f3a2c",
  "env": { /* M1 探测缓存 */ },
  "lastSyncAt": null
}
```

---

## 5. 目录结构（仓库）

```
dsh-webdav-enhanced/
├── package.json            # name: dsh-webdav-sync, dsh.bundle: true
├── cordis.patch.yml
├── README.md               # 中英双语，含各 WebDAV 服务商截图级教程
├── CHANGELOG.md
├── src/
│   ├── host.ts             # M9
│   ├── config-store.ts
│   ├── core/               # 纯逻辑层（不 import dsh/cordis，可 node 直跑单测）
│   │   ├── env.ts          # M1
│   │   ├── webdav.ts       # M2
│   │   ├── pack.ts         # M3
│   │   ├── manifest.ts     # M4
│   │   ├── merge.ts        # M5
│   │   ├── sync.ts         # M6
│   │   └── install.ts      # M8
│   ├── client.js           # M7 设置页前端
│   └── types.ts
├── tests/                  # vitest，core/ 每层单测 + 集成假 WebDAV 服务器
└── docs/PLAN.md            # 本文档
```

---

## 6. 技术选型一览

| 用途 | 选型 | 理由 |
|---|---|---|
| WebDAV 客户端 | `webdav` (webdav-client) | 纯 JS、认证全、流式、跨平台 |
| 打包/解包 | `archiver` + `unzipper` | 纯 JS、zip 含 data descriptor 兼容（skillhub 踩过的坑） |
| 配置校验 | `schemastery`（Cordis 同款） | 热更新、默认值内聚 |
| 文件监视(v1.1) | `chokidar` | 事实标准 |
| 测试 | `vitest` | 快、TS 原生 |
| Node 要求 | >= 20 | 与 dsh 生态对齐 |

---

## 7. 并行开发方案（模块契约先行）

各 core 模块只依赖 `types.ts` 里的接口，不互相 import 实现细节，契约如下（先合入 types.ts 再开分支）：

```ts
// 例：M6 sync.ts 只面向这三个接口编程
interface ManifestStore { read(): Promise<RemoteManifest>; commit(next: RemoteManifest, lock: LockHandle): Promise<void>; }
interface Packager { pack(entry: LocalEntry, out: string): Promise<PackedEntry>; unpack(zip: string, dest: string, guard: SafetyGuard): Promise<void>; }
interface Installer { applyBundle(p: PackedEntry): Promise<ApplyResult>; applySkill(p: PackedEntry): Promise<ApplyResult>; applyConfig(p: PackedEntry): Promise<ApplyResult>; }
```

**并行分工建议（5 条工作流互不冲突）**：

| 工作流 | 模块 | 可独立验收的标准 |
|---|---|---|
| W1 地基 | types.ts + M1 env + M4 manifest | 在 3 种模拟目录结构（Cordis/legacy/空）下单测全绿，输出 ResolvedEnv 正确 |
| W2 传输 | M2 webdav + M3 pack | 对本地起的 WebDAV 服务器（如 `webdav-server` 内存版）完成上传/下载/断点续传/重试测试 |
| W3 智能 | M5 merge + M8 install | 用假数据构造双机并发改同一 skill 场景，产出冲突副本与备份，install 幂等 |
| W4 调度 | M6 sync | 用 W1/W2/W3 的 mock 接口跑通完整同步流程（单向、双向、定时触发） |
| W5 界面 | M7 client.js + M9 host + config-store | 本地 link 安装进 dsh web，设置页 5 个二级 tab 可点通（可先接 mock 数据） |

依赖关系：W4 依赖 W1–W3 的**接口**（不依赖实现，mock 先行）；W5 依赖 config-store 接口。因此 **W1–W3–W5 可第一天同时开工**，W4 第二天接入。

---

## 8. 进度方案

| 阶段 | 内容 | 里程碑/验收 | 预估 |
|---|---|---|---|
| P0 脚手架 | 仓库初始化、三件套骨架、types.ts 契约、CI（typecheck+test+build） | `dsh plugin --profile web add ./` 后 dsh 能加载，--dump-config 可见 | 0.5 天 |
| P1 地基 | M1 + M4 + config-store | 三平台目录探测单测全绿 | 1.5 天 |
| P2 传输 | M2 + M3 | 真实 WebDAV（坚果云测试账号）上传下载/续传/重试通过 | 2 天 |
| P3 智能 | M5 + M8 | 双机冲突剧本演练通过（可用两台真机或两个 profile 模拟） | 2 天 |
| P4 引擎 | M6 | 端到端：改本地 skill → 定时同步 → 另一"机"自动出现并可用 | 1.5 天 |
| P5 界面 | M7 + M9 | 设置页五 tab 可用，中英双语 | 2 天 |
| P6 加固 | 安全审计（§3）、README 教程、多服务端兼容实测（坚果云/Nextcloud/AList）、错误码人话表 | 发布 v1.0，README 含故障排查表 | 1.5 天 |

**验证清单（发布前必过）**：
1. 两台真实电脑（Win+Win 或 Win+Linux）互相同步插件与 skill；
2. 断网中途同步 → 恢复后续传成功，无脏文件；
3. 两端同时改同一 skill → 产生冲突副本 + 本地备份，数据零丢失；
4. 坚果云账号跑 24 小时定时同步不被限流封禁；
5. 卸载插件后无残留定时任务/后台进程。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| dsh 处于 Developer Preview，API/包名可能变 | core/ 与宿主解耦；CI 里加 dsh 最新版兼容性冒烟测试；manifest.version 预留 |
| 各 WebDAV 服务端行为差异（锁、If 头、限流） | 能力探测 → 自动降级链（条件写→软锁→冲突副本）；实测矩阵 |
| 用户目录含中文/空格/符号链接（Windows 高危） | 所有路径操作走 `path.resolve` + 存在性校验；集成测试覆盖中文路径 |
| bundle 同步后 dsh 需重启才生效 | install 完成后设置页提示"重启生效"并提供一键重启入口（skillhub 已有同源实现可借鉴） |
| 密钥误同步导致泄露 | 默认排除 + 显式开关 + 日志脱敏 + README 警示，四重防线 |

---

## 10. 参考来源（真实检索依据）

- dsh Cordis 插件三件套与 profile 机制、设置页模式：npm `deepseek-plugin`、`@cocofhu/skillhub` 文档及 CSDN《DeepSeek Harness 插件完整指南》[ref_web_0bc130275900857fec69c2ee][ref_web_7bf6349a0d737e546798d787]
- `$DSH_HOME`/`~/.dsh`/settings.yaml/.credentials.yaml 机制：腾讯云《DeepSeek Harness 接入 Memory 配置》[ref_web_101ec95ea4f54af6cdca3c61]
- 各平台数据目录分布与桌面端差异：多篇桌面端实测 [ref_web_98c62ffd6870f5ffe99acb6e][ref_web_a682d4c5857f9ef7196f4104][ref_web_90c2b517e718e61f3f61a829][ref_web_05e12f4bde176f8b3086a281]
- 旧代 0.1.x harness 插件制式（manifest.json 代）：[ref_web_d42f4ded2f0dd84bf3767fdb][ref_web_b7a53d633dba20ca5cfd876b]
- 旧版插件市场/目录：npm `deepseek-plugin`、DEV Community [ref_web_804d164631b6c450f0681182][ref_web_0e7632c178410b0d0dfb14d4]
