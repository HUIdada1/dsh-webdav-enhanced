# dsh-webdav-enhanced v0.4.0 —— 设计契约（唯一事实源）

> 本文件是 v2 改造的**唯一契约**。后端（src/types.ts、src/core/**、src/http.ts、src/host.ts）与
> 前端（src/client.js）必须严格按这里的类型、字段名、端点、语义实现，禁止自行改名或改形状。
> 文档/元信息（README、docs/plugin-detail.*、locale/*.json）以本文件描述的行为为准。

---

## 0. 用户诉求 → 落地映射

| 用户原话 | 落地 |
| --- | --- |
| 插件页面里的说明也放到一个 tab 页，布局要设计、合理、适合正常使用 | `src/client.js` 新增 **说明（Guide）** tab，内容卡片化重排（快速开始 / 能力地图 / 同步规则 / 兼容性 / 安全 / FAQ / 关于），中英双语，全部主题令牌配色 |
| 设置弹窗里加一个 WebDAV 同步 tab，里面展示各种设置 | 在客户端插槽 **`settings.section`** 注册一页（id=`webdav-sync`，order=16），复用同一个面板组件，`variant='settings'` |
| 同步时要有进度 | 后端 `RunProgress` 快照 + `GET /progress` 轮询；前端进度卡（阶段、百分比、计数、当前条目、耗时、可取消） |
| 日志要显示哪些成功 / 失败 / 合并 | 结构化 `LogEntry{level,category,name,message}` 落盘；前端日志 tab 带筛选（全部/成功/失败/合并/跳过/删除）+ 搜索 + 导出 |
| 同步去重、智能判断、全自动、不要冲突、自动分析、全面 | ①内容哈希内容寻址去重（含跨条目远端文件复用）②三路合并（base=上次同步哈希）+ 内建 `auto` 策略：赢家自动选、输家自动备份，**不产生需要人工决策的冲突**③删除传播 ④默认全自动（下载即安装、保存即启停调度、可选定时）⑤`GET /plan` 干跑分析给差异清单 |

---

## 1. 现状缺陷清单（必须修掉，别改回去）

| # | 位置 | 缺陷 | 后果 |
| --- | --- | --- | --- |
| D1 | `core/sync.ts` `_lastScanEntries` | 扫描时 `hash:''`，打包算出的 hash 没回填到扫描条目，`persistHashes` 存的永远是空串 | `lastSyncedHashes` 全空 → 三路合并 base 失效 → **只要两端 hash 不同就判冲突**（用户说的"冲突"根因） |
| D2 | `core/scan.ts` | 扫描阶段完全不算 hash | 无法在扫描期做差异分析，只能打包时才知道 |
| D3 | `core/sync.ts` | `report.skipped` 只有计数，`uploaded/downloaded` 只有 key 字符串 | UI 无法展示"哪些成功/失败/合并" |
| D4 | `host.ts` | 调度器只在启动时按 cordis 配置启动；设置页保存的 `schedule` 不生效 | 用户开了定时同步要重启 dsh 才生效 |
| D5 | `host.ts` | 每次 `runSync()` 都 `buildEngine()` 新建实例，`running` 互斥失效 | 手动同步与定时同步可并发跑，互相踩 manifest |
| D6 | `core/install.ts` `applyConfig` | 整文件覆盖 `settings.yaml` | 丢掉本地其它顶层 key，属于数据损坏级 |
| D7 | `core/scan.ts` `scanConfigs` | `mode:'all'` 但 `includeKeys` 为空 → 返回空数组 | 选"全部同步配置"实际什么都不同步 |
| D8 | `core/sync.ts` | 本地删除不会传播；远端 tombstone 与 trash 无清理 | 删掉的插件会被远端"复活"；trash 无限膨胀 |
| D9 | `core/webdav-store.ts` `pushEntry` | 上传前只按 manifest 同 key 同 hash 去重；不检查远端是否已有同 hash 文件 | 跨条目重复上传（如多个技能内容相同） |
| D10 | `http.ts` | 没有进度、没有结构化日志端点，同步是阻塞式单次 POST | UI 只能转圈等，无进度无明细 |
| D11 | `core/merge.ts` | `ask` 策略只是留标记，没人消费 | 空策略 |
| D12 | `core/config-store.ts` | `lastSyncedHashes: Record<string,string>` 无时间戳，无法判断"谁更新" | 三方合并只能靠 hash 相等性，分叉时无从裁决 |

---

## 2. 配置模型（`src/types.ts` 为准）

```ts
/** 新增：同步智能选项（设置页可改，也可写 cordis 配置） */
export interface SyncOptions {
  /** 删除传播：一端删除，另一端同样删除（远端进 trash，本地先备份）。默认 true */
  propagateDeletions: boolean
  /** 分叉自动裁决：'auto' 按修改时间+版本自动选赢家并备份输家；'local'/'remote' 固定；'manual' 保留冲突标记 */
  autoResolve: 'auto' | 'local' | 'remote' | 'manual'
  /** 跨条目远端去重：远端已有同 hash 文件时只更新 manifest，不重复上传。默认 true */
  dedupeRemote: boolean
  /** 下载后自动安装（bundle 走 dsh plugin add / skill 解压 / config 按键合并）。默认 true */
  autoInstall: boolean
  /** config 类型按顶层 key 合并，而不是整文件覆盖。默认 true */
  contentMerge: boolean
  /** 每类条目保留的本地备份份数，超出删除最旧。默认 10 */
  maxBackups: number
  /** 同步结束后清理远端 tombstone 与超期 trash。默认 true */
  pruneTombstones: boolean
  /** 是否在同步结束后把远端 tombstone 一并物理删除（默认 false，只清 trash） */
  hardDelete: boolean
}
```

`PluginConfig` 增加字段：
```ts
{
  syncOptions: SyncOptions      // 新增
  lastSynced: Record<string, SyncSnapshot>   // 新增，替代 lastSyncedHashes（保留旧字段读取兼容）
}
export interface SyncSnapshot {
  hash: string
  version: string | null
  syncedAt: string
  /** 该 hash 来自哪台机器（决定删除传播的可信度） */
  machineId: string
}
```
兼容：`ConfigStore.load()` 若读到旧 `lastSyncedHashes`（Record<string,string>），迁移成 `lastSynced`（syncedAt=now，machineId=本机），然后删掉旧字段落盘。
`conflictPolicy` 保留四个旧值以兼容老配置，但**默认值改为 `'auto'`**（新增第 5 个值），旧值语义映射：

| conflictPolicy | 行为 |
| --- | --- |
| `auto`（新默认） | 等同 `syncOptions.autoResolve='auto'`，分叉自动裁决 + 备份，不打人工冲突 |
| `merge-backup` | 保留兼容：分叉时远端赢 + 本地备份（=autoResolve remote + backup） |
| `ask` | 保留兼容：不裁决，落 `conflicts[]` 并在 UI 标红（仅显式选择时才有此行为） |
| `local-wins` / `remote-wins` | 固定一侧赢 |

---

## 3. 智能合并算法（`src/core/merge.ts` 重写，纯函数可单测）

**输入**
```ts
interface MergeInputV2 {
  local: LocalEntry[]          // 扫描产物，hash 已算好
  remote: RemoteManifest       // 含 deleted 墓碑
  lastSynced: Record<string, SyncSnapshot>
  policy: ConflictPolicy
  options: Pick<SyncOptions, 'autoResolve' | 'propagateDeletions'>
  direction: SyncDirection
  machineId: string
}
```

**输出**
```ts
type ItemAction = 'upload' | 'download' | 'skip' | 'merge' | 'delete-local' | 'delete-remote' | 'conflict'
interface MergeDecisionV2 {
  key: string                 // `${kind}:${name}`
  kind: EntryKind
  name: string
  action: ItemAction
  /** 必填：人类可读中文原因，直接进 UI 与日志 */
  reason: string
  /** 动作的赢家/来源侧，upload/download/merge 必填 */
  winner?: 'local' | 'remote'
  local?: LocalEntry
  remote?: RemoteEntry
  /** 冲突/合并时建议的备份名 */
  backupHint?: string
}
```

**决策表**（`direction='both'`；`local` 指本机扫描到的条目，`remote` 指 manifest 中 `!deleted` 的条目，`base` 指 `lastSynced[key]`）：

| 条件 | 动作 | reason（中文，直接展示） |
| --- | --- | --- |
| local && remote && hash 相同 | `skip` | 两端内容一致 |
| local && remote && base && local.hash==base.hash && remote.hash!=base.hash | `download` | 远端更新（本机未改） |
| local && remote && base && remote.hash==base.hash && local.hash!=base.hash | `upload` | 本机更新（远端未改） |
| local && remote && !base | `merge`（auto 裁决；无 mtime 优势时 remote 赢） | 首次同步发现两端不一致，自动合并 |
| local && remote && 两端都改了（分叉） | policy=`auto`→`merge`；`local-wins`→`upload`；`remote-wins`→`download`；`ask`→`conflict`；`merge-backup`→`download` | `两端均已修改，自动采用{本机/远端}，另一侧已备份` |
| local && !remote && base && local.hash==base.hash | `delete-local`（propagateDeletions 时；否则 `skip`） | 远端已删除，本机同步删除（已备份） |
| local && !remote && base && local.hash!=base.hash | `upload` | 远端已删除但本机有改动，保留本机 |
| local && !remote && !base | `upload` | 本机新增 |
| !local && remote && base && remote.hash==base.hash | `delete-remote`（propagateDeletions 时；否则 `skip`） | 本机已删除，远端同步删除（进回收站） |
| !local && remote && base && remote.hash!=base.hash | `download` | 远端更新，本机缺失，恢复远端版本 |
| !local && remote && !base | `download` | 远端新增 |
| 两端都无（含墓碑） | 不产出 decision | — |

**auto 裁决 `pickWinner(local, remote)`**（纯函数，导出便于单测）：
1. `local.modifiedAt`（ISO）与 `remote.updatedAt` 比较，差 > 2s → 新的赢（远端较新则 `winner='remote'`）。
2. 差距 ≤ 2s（时间不可分）→ 比较 `version`（semver 宽松比较：数字段逐个比，预发布标识按字典序；解析失败返回 0）→ 高者赢。
3. 仍相同 → **remote 赢**（确定性，避免两机互踢），reason 写明「时间与版本均相同，按远端优先收敛」。

**方向过滤 `applyDirection(decisions, direction)`**：
- `upload`：`download`/`merge(winner=remote)`/`delete-local` → `skip`（reason=「仅上传模式，跳过下载」）；`upload`/`delete-remote`/`merge(winner=local)` 保留。
- `download`：`upload`/`delete-remote`/`merge(winner=local)` → `skip`（reason=「仅下载模式，跳过上传」）；其余保留。
- `both`：原样。

**去重点（D9）**：`upload` 判定后，若 `dedupeRemote` 且远端任一条目（任意 name）`hash` 相同 → 不传文件，只把本条目写进 manifest（`reason` 追加「远端已有同内容文件，复用」），计入 `deduped`。

---

## 4. 进度与日志模型

### 4.1 RunProgress

```ts
export type RunPhase =
  | 'idle' | 'scan' | 'manifest' | 'plan' | 'download' | 'upload' | 'prune' | 'finalize' | 'done' | 'error' | 'cancelled'

export type ItemStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped' | 'merged' | 'deleted' | 'conflict'

export interface RunItem {
  key: string
  kind: EntryKind
  name: string
  action: ItemAction
  status: ItemStatus
  /** 人类可读一句话，直接展示在 UI 列表 */
  reason: string
  /** 补充信息：错误原文 / 手工命令 / 复用提示 */
  detail?: string
  bytes?: number
  durationMs?: number
}

export interface RunProgress {
  runId: string
  active: boolean
  phase: RunPhase
  /** 阶段中文文案，后端直接给，前端不必翻译 */
  phaseLabel: string
  trigger: SyncTrigger
  startedAt: string
  finishedAt: string | null
  total: number
  done: number
  percent: number        // 0..100 整数
  current: string | null // 当前条目 key
  message: string        // 一句话状态
  items: RunItem[]
  counts: {
    upload: number; download: number; merge: number; skip: number
    remove: number; conflict: number; failed: number; deduped: number
  }
  report: SyncRunReport | null
}
```

### 4.2 SyncRunReport（扩展，向后兼容旧字段）

```ts
export interface SyncRunReport {
  runId: string
  trigger: SyncTrigger
  startedAt: string
  finishedAt: string
  uploaded: string[]      // key，成功上传
  downloaded: string[]    // key，成功下载并落盘
  merged: string[]        // key，自动合并（含 config 键合并）
  deleted: string[]       // key，传播删除
  skipped: number
  deduped: string[]       // key，远端已有同内容，仅登记
  conflicts: { name: string; note: string }[]
  errors: { stage: string; message: string; name?: string }[]
  items: RunItem[]
  ok: boolean
  cancelled: boolean
  durationMs: number
}
```

### 4.3 LogEntry（落盘 JSONL）

```ts
export interface LogEntry {
  id: number
  at: string
  level: 'info' | 'success' | 'warn' | 'error'
  category: 'sync' | 'upload' | 'download' | 'merge' | 'conflict' | 'skip' | 'delete'
          | 'dedupe' | 'connection' | 'schedule' | 'env' | 'system' | 'prune'
  message: string
  name?: string
  runId?: string
  detail?: string
}
```

落盘：`$DSH_HOME/.webdav-enhanced/logs/sync.jsonl`，单文件 > 1MB 轮转为 `sync.1.jsonl`（只保留 1 份旧文件）。
内存 ring 保留最近 500 条供接口快速返回；启动时读回末尾 200 条。
`GET /logs?limit=&level=&category=` 返回 `{ entries: LogEntry[], total: number }`（新→旧）。

---

## 5. HTTP API 契约（`/api/webdav-enhanced`）

所有响应 JSON，失败 `{ error: string }`（400/500）。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/config` | — | `PublicConfig`（见下，**永不含密码**） |
| POST | `/config` | `{ connection?, options?, scope?, schedule?, conflictPolicy?, syncOptions?, profile? }` | `PublicConfig`；副作用：若 `schedule` 变化→重启/停止调度器；若连接变化→下次同步重建引擎 |
| POST | `/test` | `{ url, username, password?, timeoutMs?, remoteRoot?, ignoreTlsErrors? }` | `TestConnectionResult`（原有结构不变） |
| GET | `/items?kind=bundles\|skills\|configs` | — | `{ name, version, kind, hash, sizeBytes, modifiedAt }[]` |
| GET | `/status` | — | `{ lastSyncAt, machineId, env, schedule, conflictPolicy, syncOptions, direction, lock, counts, lastReport, capabilities }` |
| GET | `/progress` | — | `RunProgress`（空闲时 phase='idle'，report=上次报告） |
| GET | `/plan` | — | `PlanResult`：**干跑，不写任何东西** |
| POST | `/sync` | `{ trigger?: 'manual' }` | `{ started: boolean, runId: string, alreadyRunning: boolean }`（立即返回，不等待） |
| POST | `/cancel` | — | `{ cancelled: boolean }` |
| GET | `/logs?limit=200&level=&category=` | — | `{ entries: LogEntry[], total: number }` |
| POST | `/reprobe` | — | `ResolvedEnv` |
| POST | `/reset` | — | `{ ok: true }`（清本机状态，保留 machineId） |
| POST | `/clear-remote` | — | `{ ok: true, removed: number }` |

`PublicConfig`：
```ts
{
  connection: { url, username, passwordRef, hasPassword: boolean }
  options: PluginOptions
  scope: SyncScope
  schedule: { enabled, intervalHours, direction }
  conflictPolicy: ConflictPolicy
  syncOptions: SyncOptions
  machineId: string
  profile: string
  lastSyncAt: string | null
  version: string           // 包版本，UI 展示用
}
```

`PlanResult`：
```ts
{
  generatedAt: string
  direction: SyncDirection
  items: {
    key: string; kind: EntryKind; name: string
    action: ItemAction; reason: string; winner?: 'local' | 'remote'
    local?: { hash: string; version: string | null; sizeBytes: number; modifiedAt: string }
    remote?: { hash: string; version: string | null; size: number; updatedAt: string; machineId: string }
  }[]
  summary: { upload: number; download: number; merge: number; skip: number; remove: number; conflict: number; total: number }
  errors: { stage: string; message: string }[]
}
```

**并发约束**：同一时刻只允许一个 run。`POST /sync` 在运行中返回 `{started:false,alreadyRunning:true,runId:当前}`（HTTP 200）。

---

## 6. 后端模块职责（core-engine 负责）

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | 增加 SyncOptions / SyncSnapshot / RunProgress / RunItem / ItemAction / ItemStatus / LogEntry / PlanResult；扩 SyncRunReport；MergeDecision 换成 v2；保留旧导出以兼容 tests |
| `src/core/merge.ts` | 重写为 v2 决策表 + `pickWinner` + `applyDirection`；导出 `decideV2(input)`；旧 `createMerger()` 保留签名但内部走 v2（tests 同步更新） |
| `src/core/scan.ts` | 扫描阶段计算并回填 `hash`/`sizeBytes`（用 pack.ts 的 `hashDirectory`）；hash 缓存：`$DSH_HOME/.webdav-enhanced/hash-cache.json`，key=`kind:name`，value=`{mtimeMs, fileCount, hash, sizeBytes}`，目录 mtime 与文件数未变则直接用缓存；修 D7（configs mode='all' 时默认同步全部顶层 key，排除 `apiKey`/`credentials` 等敏感 key 与 `.credentials.yaml` 相关段） |
| `src/core/sync.ts` | 注入 `progress` 与 `logger`；按 decisions 逐条执行并更新 RunItem；支持 cancel；上传去重（D9）、删除传播、prune；持久化 `lastSynced`（D1） |
| `src/core/install.ts` | `applyConfig` 改为顶层 key 合并（D6），写前备份 `settings.yaml.bak-<ts>`；备份轮转（maxBackups）；bundle 安装成功返回 `needs-restart` 并在报告里给出集合 |
| `src/core/progress.ts`（新） | `RunProgressTracker`：start/phase/item/update/finish/cancel/snapshot |
| `src/core/runlog.ts`（新） | `RunLogger`：ring + JSONL 落盘 + 轮转 + query(level,category,limit) |
| `src/core/webdav-store.ts` | `pushEntry` 支持 `dedupeRemote`：上传前 `stat(remoteZipRelPath)` 命中则跳过 PUT；`prune`：删 trash 超过 7 天 / 清理墓碑 |
| `src/core/config-store.ts` | 迁移 `lastSyncedHashes`→`lastSynced`；默认值带 `syncOptions` |
| `src/http.ts` | 全部新端点；`/sync` 改为立即返回；`/config` 保存后回调 `onScheduleChanged` |
| `src/host.ts` | 引擎单例 + 互斥（D5）；调度器随配置保存启停（D4）；`runSync` 复用同一引擎并返回报告；日志器注入；版本号读取 |

**硬性要求**：
- `npm run typecheck` 与 `npm test` 必须全绿（tests/ 里与旧行为冲突的用例，可更新断言，但**不得删除用例覆盖**）。
- 所有对外中文文案走 `RunItem.reason` / `LogEntry.message`，前端直接展示，不再二次翻译。
- 任何单条失败不阻断整体；报告里必有失败明细。

---

## 7. 前端规范（`src/client.js`，Lead 负责）

### 7.1 挂载点

```js
// 页面级（插件详情页）——保留现有两个
{ name: 'plugins.bundle.config', key: PKG }        // 组件 variant='page'
{ name: 'plugins.row.config',    key: PKG+'#'+ROW_ID }
// 设置弹窗——新增
{ name: 'settings.section', id: 'webdav-sync', order: 16, label: () => 'WebDAV 同步' / 'WebDAV sync' }
```

注册形态：`slots.inject(SLOT, () => slots.register({name: SLOT, ...opts}, () => React.createElement(Panel, { variant })))`。
`settings.section` 的 `label` 必须是**函数**（切换语言会重读）。

### 7.2 页签（7 个，顺序固定）

| key | 中文 | 英文 | 内容 |
| --- | --- | --- | --- |
| overview | 概览 | Overview | 状态头（连接/机器/上次同步/方向）、**立即同步 + 进度卡**、最近一次运行分类统计、一键「分析差异」结果表 |
| guide | 说明 | Guide | 卡片化文档：快速开始 4 步、能力地图 4 卡、同步规则表、服务器兼容表、安全 3 条、FAQ 手风琴、关于（版本/机器 ID/数据目录） |
| connect | 连接 | Connection | 地址/账号/密码、测试连接（分步结果）、高级（超时/远端根/忽略 TLS）、服务端能力 |
| scope | 内容 | Content | 插件/技能/配置三组，模式选择 + 条目勾选列表 + 排除项 chip 输入 |
| mode | 方式 | Mode | 方向、定时（开关+间隔）、冲突策略（5 选项，默认自动）、智能选项开关组 |
| logs | 日志 | Logs | 筛选 chips + 搜索 + 列表（时间/级别/分类/条目/信息）+ 导出 + 运行中自动刷新 |
| diag | 诊断 | Diagnostics | 环境 KV、锁持有者、能力、重新探测、**危险区卡片**（重置本机 / 清空远端） |

### 7.3 视觉规范（必须遵守，禁止自创色值）

- 只用这些令牌（带回退）：`--dsw-alias-bg-base/bg-layer-1/bg-layer-2/bg-overlay`、`--dsw-alias-border-l1/border-l2`、`--dsw-alias-brand-primary`、`--dsw-alias-label-primary/label-secondary`、`--dsw-alias-state-error-primary/success-primary/warn-primary/idle-primary`。
- 强调色淡底统一 `color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)`。
- 圆角：小控件 8px、卡片 12px、胶囊 999px；间距 4 的倍数（4/8/12/16/20/24）。
- 字号：标题 14/600、正文 13、辅助 12/11。行高 1.55。
- 字体继承；容器不设背景色时用 `bg-layer-1`，嵌套卡用 `bg-layer-2`。
- 布局：根 `max-width: 820px`；`settings` 变体 `max-width: 100%`；窄屏 (<640px) 单列。
- 交互要素：按钮有 `:hover`/`:disabled`/`:focus-visible` 态；开关用 `<input type=checkbox>` 但视觉做成 pill 开关（`role="switch"` + `aria-checked`）；进度条 `role="progressbar"` 带 aria 属性；日志列表虚拟上限 300 条渲染。
- 禁止：`require('@deepseek-ai/*')`、写 `document.body`、iframe、内联 style 覆盖主题色。

### 7.4 轮询与状态

- 面板挂载：`GET /config` + `GET /status` + `GET /progress` + `GET /logs?limit=80`。
- 运行中（`progress.active`）：每 900ms 轮询 `/progress`；结束后刷 `/logs` 与 `/status`。
- 组件卸载必须清掉所有定时器与请求（`dispose` 返回函数里 `clearInterval`）。
- 事件委托：所有按钮 onclick 直接绑定，不用全局事件。

### 7.5 轮询与文案

- 所有 UI 文案在中英两套 `i18n` 字典中，禁止硬编码中文到 DOM。
- 后端返回的 `reason`/`message` 已是中文，直接展示（不做二次翻译）。

---

## 8. 文件所有权（写作用域，严禁越界）

| 所有者 | 可写文件 |
| --- | --- |
| Lead | `src/client.js`、`package.json`、`docs/DESIGN-v2.md`、`scripts/**`、`README*`（终审） |
| core-engine | `src/types.ts`、`src/core/**`、`src/http.ts`、`src/host.ts`、`tests/**` |
| docs-i18n | `README.md`、`README.en.md`、`docs/plugin-detail.zh.md`、`docs/plugin-detail.en.md`、`locale/zh.json`、`locale/en.json` |

构建产物 `lib/**` 由 Lead 在集成阶段统一 `npm run build` 生成，任何人不要手改。

---

## 9. 集成期补丁（真实服务器验证后发现，已修）

以下三条不是设计变更，而是把「只在 mock 服务器上成立」的实现缺陷修到真实环境可用。改完都用真实 WebDAV 复测通过。

### 9.1 打包排除表不能再排除 `lib` / `dist`
`pack.ts` 原排除表含 `lib`、`dist`。但 profile 里的 bundle 是 npm 装到 `node_modules/<pkg>/` 的，运行时代码就在 `lib/`：排除后
①内容 hash 只覆盖 package.json/README，代码改了 hash 都不变 → 永远不触发同步；
②上传的 zip 里没有可执行代码，别的机器装出来是空壳。
现排除表只剩 `node_modules`、`.git`、`logs`、`cache`、`.cache`；`hashDirectory`/`pack`/`unpack` 共用同一张表，`hash-cache.json` 加 `schema=2` 使旧缓存失效。

### 9.2 远端集合必须先 MKCOL，再 PUT / MOVE
真实服务器（muhuix DAV 实测）对「写入/移动到不存在的集合」返回 **403** 而不是 409：
- `pushEntry` 上传前补 `ensureDir(path.posix.dirname(targetFile))`，MOVE 失败时清掉 staging 残留；
- `acquireLock` 在写软锁文件前补 `ensureDir('locks')` —— 否则整个同步在取锁阶段就 403 失败。

### 9.3 同步范围必须双向过滤（`merge.filterByScope`）
只靠「扫描时跳过」是不够的：`scope=none` 的类别仍在远端清单里，会被判成 download 拉下来；更糟的是这些条目一旦写进 `lastSynced`，下一轮「本机缺失 + 远端未变」就变成 `delete-remote`，把远端数据删掉。
现在 `sync.ts` 与 `host.ts` 的 `/plan` 都在 `planDecisions()` 之后过一遍 `filterByScope()`，语义统一为：**范围是双向的**（不同步 = 既不上传也不下载，也不参与删除传播）。
