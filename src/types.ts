/*
 * dsh-webdav-enhanced — core type contracts (v2).
 * All core modules (env / webdav / pack / manifest / merge / sync / install)
 * program against these interfaces only. The Cordis host layer (host.ts)
 * is the only module allowed to depend on the dsh runtime.
 *
 * v2 新增：SyncOptions / SyncSnapshot / RunProgress / RunItem / LogEntry /
 * PlanResult / MergeDecisionV2。旧导出（MergeDecision、MergeInput、Merger、
 * SyncRunReport 旧字段…）保留以兼容老测试与老配置读取。
 */

// ---------- shared primitives ----------

export type Platform = 'win32' | 'darwin' | 'linux' | string

/** 宿主 dsh 的代际：cordis（@deepseek-ai/dsh，当前主线）/ legacy（0.1.x manifest 制式）/ unknown */
export type HostGeneration = 'cordis' | 'legacy' | 'unknown'

export type EntryKind = 'bundle' | 'skill' | 'config'

export type SyncDirection = 'both' | 'upload' | 'download'

/**
 * 冲突策略。
 * v2 新增默认值 'auto'：分叉自动裁决（见 syncOptions.autoResolve）+ 输家备份，
 * 不产生需要人工决策的冲突。四个旧值保留语义兼容。
 */
export type ConflictPolicy = 'auto' | 'merge-backup' | 'ask' | 'local-wins' | 'remote-wins'

export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = 'auto'

// ---------- v2 同步智能选项 ----------

/** 同步智能选项（设置页可改，也可写 cordis 配置） */
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

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  propagateDeletions: true,
  autoResolve: 'auto',
  dedupeRemote: true,
  autoInstall: true,
  contentMerge: true,
  maxBackups: 10,
  pruneTombstones: true,
  hardDelete: false,
}

/** 上次同步快照：三方合并的 base（决定"谁更新"与删除传播的可信度） */
export interface SyncSnapshot {
  hash: string
  version: string | null
  syncedAt: string
  /** 该 hash 来自哪台机器（决定删除传播的可信度） */
  machineId: string
}

// ---------- M1 env ----------

export interface ResolvedEnv {
  /** dsh 数据主目录（$DSH_HOME 或探测到的目录） */
  dshHome: string
  /** profiles 所在目录（cordis 代）；legacy 代等同 dshHome */
  profileDir: string
  /** skills 扫描目录 */
  skillsDir: string
  /** settings.yaml 路径（cordis 代）；不存在则为 null */
  settingsFile: string | null
  /** .credentials.yaml 路径；不存在则为 null。永不参与默认同步 */
  credentialsFile: string | null
  /** 当前激活的 profile 名（默认 'web'） */
  profile: string
  /** 宿主 dsh 版本号；探测不到为 null */
  dshVersion: string | null
  nodeVersion: string
  platform: Platform
  generation: HostGeneration
  /** 其他探测到的候选目录（旁路目录），仅展示不自动操作 */
  extras: string[]
}

// ---------- local entries (M1/M6 扫描产物) ----------

/** 本地一个可同步条目（插件 / 技能 / 配置键组） */
export interface LocalEntry {
  kind: EntryKind
  /** 条目逻辑名，如 bundle 的 npm 名、skill 的 slug */
  name: string
  /** 条目版本；config 类为 null */
  version: string | null
  /** 条目根目录（打包源）；config 类为虚拟源 */
  sourceDir: string
  /** 内容指纹 sha256；扫描阶段即回填（D1/D2 修复） */
  hash: string
  sizeBytes: number
  modifiedAt: string // ISO 8601
  /** 打包时的来源机器信息；非必填，由 sync 填充 */
  machine?: MachineInfo
}

// ---------- remote manifest (M4) ----------

export interface MachineInfo {
  machineId: string
  platform: Platform
  dshVersion: string | null
}

export interface RemoteEntry {
  kind: EntryKind
  name: string
  version: string | null
  hash: string
  /** 远端 zip 相对 /dsh-sync/ 的路径 */
  file: string
  size: number
  source: MachineInfo
  firstSeenAt: string
  updatedAt: string
  /** 软删除：真删除文件仍在 trash/，条目保留墓碑 */
  deleted: boolean
}

export interface RemoteManifest {
  version: number
  updatedAt: string
  entries: RemoteEntry[]
}

export const MANIFEST_VERSION = 1

// ---------- M2 webdav ----------

export interface WebDavConnectionConfig {
  url: string
  username: string
  /** 明文密码仅存在于内存与本地凭据存储，严禁进日志与远端 */
  password: string
  timeoutMs?: number
  /** 内网自签证书场景手动开启；默认 false */
  ignoreTlsErrors?: boolean
  /** 远端同步根目录，默认 /dsh-sync/ */
  remoteRoot?: string
}

export interface TestConnectionStep {
  step: 'propfind' | 'mkcol' | 'put' | 'readback'
  ok: boolean
  detail: string
}

export interface ServerCapabilities {
  supportsLock: boolean
  supportsIfHeader: boolean
  server: string | null
}

export interface TestConnectionResult {
  ok: boolean
  steps: TestConnectionStep[]
  /** 服务端能力探测结果，决定锁与条件写的降级链 */
  capabilities: ServerCapabilities
}

/** 远端目录项（prune / 清理回收站用） */
export interface RemoteDirItem {
  name: string
  type: 'file' | 'directory'
  size: number
  mtime: string | null
}

export interface WebDavClient {
  testConnection(): Promise<TestConnectionResult>
  exists(remotePath: string): Promise<boolean>
  ensureDir(remotePath: string): Promise<void>
  putFile(remotePath: string, localPath: string, opts?: { resume?: boolean }): Promise<void>
  getFile(remotePath: string, localPath: string, opts?: { resume?: boolean }): Promise<void>
  getJson<T>(remotePath: string): Promise<T | null>
  putJsonIfMatch(remotePath: string, data: unknown, etag: string | null): Promise<string | null>
  deleteFile(remotePath: string): Promise<void>
  move(remotePath: string, destPath: string): Promise<void>
  stat(remotePath: string): Promise<{ etag: string | null; size: number; mtime: string | null } | null>
  /** 列出目录内容（prune 用；不存在返回空数组） */
  listDir(remotePath: string): Promise<RemoteDirItem[]>
  /** 尽力而为的软锁；服务端不支持时返回 null 并降级 */
  acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null>
  currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null>
}

// ---------- M3 pack ----------

export interface PackedEntry {
  entry: LocalEntry
  /** 本地 zip 绝对路径（staging 目录内） */
  zipPath: string
  sha256: string
  size: number
}

export interface PackMeta {
  kind: EntryKind
  name: string
  version: string | null
  source: MachineInfo
  originalPath: string
  packedAt: string
  dshVersion: string | null
}

/** 解压安全护栏：路径穿越 / zip 炸弹 */
export interface SafetyGuard {
  /** 总解压体积上限，默认 512MB */
  maxTotalBytes: number
  /** 单文件上限，默认 128MB */
  maxFileBytes: number
}

export const DEFAULT_SAFETY_GUARD: SafetyGuard = {
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
}

export interface Packager {
  pack(entry: LocalEntry, outDir: string): Promise<PackedEntry>
  unpack(zipPath: string, destDir: string, guard: SafetyGuard): Promise<PackMeta>
  hashFile(filePath: string): Promise<string>
}

// ---------- M4 manifest store ----------

export interface LockHandle {
  machineId: string
  acquiredAt: string
  release(): Promise<void>
}

export interface ManifestStore {
  /** 读取远端 manifest；不存在时返回空 manifest（version 固定） */
  read(): Promise<{ manifest: RemoteManifest; etag: string | null }>
  /** 条件写提交；冲突时抛 ManifestConflictError，调用方负责重读重合并 */
  commit(next: RemoteManifest, etag: string | null, lock: LockHandle | null): Promise<string | null>
  /** 尽力而为的软锁；服务端不支持时返回 null 并降级 */
  acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null>
  currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null>
}

export class ManifestConflictError extends Error {
  constructor(public readonly currentEtag: string | null) {
    super('remote manifest changed during merge')
    this.name = 'ManifestConflictError'
  }
}

// ---------- M5 merge (v2) ----------

/** v2 单条目动作；decision 的 action 集合 */
export type ItemAction =
  | 'upload'          // 本机内容推到远端
  | 'download'        // 远端内容落到本机
  | 'skip'            // 一致或无操作
  | 'merge'           // 分叉自动裁决（赢家自动选，输家备份）
  | 'delete-local'    // 远端已删除 → 删除本机（先备份）
  | 'delete-remote'   // 本机已删除 → 远端进回收站
  | 'conflict'        // 仅 policy=ask / autoResolve=manual 时保留人工冲突

/** 旧 v1 动作（保留导出，createMerger 兼容用） */
export type MergeActionType = 'upload' | 'download' | 'skip' | 'conflict'

/** v2 合并决策（纯函数产物） */
export interface MergeDecisionV2 {
  /** `${kind}:${name}` */
  key: string
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

export interface MergeInputV2 {
  local: LocalEntry[]
  remote: RemoteManifest
  lastSynced: Record<string, SyncSnapshot>
  policy: ConflictPolicy
  options: Pick<SyncOptions, 'autoResolve' | 'propagateDeletions'>
  direction: SyncDirection
  machineId: string
}

/** 旧 v1 合并决策（保留导出，兼容老测试/调用方） */
export interface MergeDecision {
  entry: LocalEntry | RemoteEntry
  action: MergeActionType
  /** conflict 时必填：副本命名建议与保留位置 */
  conflictNote?: string
}

export interface MergeInput {
  local: LocalEntry[]
  remote: RemoteManifest
  /** 本机上次同步时各条目的 hash 快照：name → hash */
  lastSyncedHashes: Record<string, string>
  policy: ConflictPolicy
  machineId: string
}

export interface Merger {
  decide(input: MergeInput): MergeDecision[]
}

// ---------- M8 install ----------

export type ApplyStatus =
  | 'applied'
  | 'skipped'        // 已是最新
  | 'needs-restart'  // bundle 落盘成功，待重启 dsh 生效
  | 'manual-needed'  // 自动安装失败，附手工命令
  | 'failed'

export interface ApplyResult {
  status: ApplyStatus
  message: string
  /** manual-needed 时给出的人工命令，如 dsh plugin --profile web add ./xxx */
  manualCommand?: string
}

export interface Installer {
  applyBundle(packed: PackedEntry, meta: PackMeta): Promise<ApplyResult>
  applySkill(packed: PackedEntry, meta: PackMeta): Promise<ApplyResult>
  applyConfig(packed: PackedEntry, meta: PackMeta): Promise<ApplyResult>
}

// ---------- M6 sync engine ----------

export type SyncTrigger = 'manual' | 'scheduled' | 'auto-scan'

// ---------- v2 进度模型 ----------

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

export interface RunCounts {
  upload: number
  download: number
  merge: number
  skip: number
  remove: number
  conflict: number
  failed: number
  deduped: number
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
  percent: number
  current: string | null
  message: string
  items: RunItem[]
  counts: RunCounts
  report: SyncRunReport | null
}

// ---------- v2 结构化日志 ----------

export type LogLevel = 'info' | 'success' | 'warn' | 'error'

export type LogCategory =
  | 'sync' | 'upload' | 'download' | 'merge' | 'conflict' | 'skip' | 'delete'
  | 'dedupe' | 'connection' | 'schedule' | 'env' | 'system' | 'prune'

export interface LogEntry {
  id: number
  at: string
  level: LogLevel
  category: LogCategory
  message: string
  name?: string
  runId?: string
  detail?: string
}

export interface LogQuery {
  limit?: number
  level?: LogLevel
  category?: LogCategory
}

// ---------- SyncRunReport（v2，向后兼容旧字段） ----------

export interface SyncRunReport {
  runId: string
  trigger: SyncTrigger
  startedAt: string
  finishedAt: string
  /** key，成功上传 */
  uploaded: string[]
  /** key，成功下载并落盘 */
  downloaded: string[]
  /** key，自动合并（含 config 键合并） */
  merged: string[]
  /** key，传播删除 */
  deleted: string[]
  skipped: number
  /** key，远端已有同内容，仅登记 */
  deduped: string[]
  conflicts: { name: string; note: string }[]
  errors: { stage: string; message: string; name?: string }[]
  items: RunItem[]
  ok: boolean
  cancelled: boolean
  durationMs: number
  /** bundle 安装成功但需重启 dsh 才生效的条目名（附加字段，旧前端可忽略） */
  needsRestart?: string[]
}

export interface SyncEngine {
  runOnce(trigger: SyncTrigger, opts?: { runId?: string }): Promise<SyncRunReport>
  /** 定时调度：intervalHours = 0 表示关闭 */
  startScheduler(intervalHours: number, onReport: (r: SyncRunReport) => void): void
  stopScheduler(): void
  isRunning(): boolean
  /** 请求取消当前 run（在条目边界生效） */
  cancel(): boolean
  currentRunId(): string | null
  /** 最近一次同步报告（无则 null） */
  lastReport(): SyncRunReport | null
  /** 当前进度快照（空闲时 phase='idle'，report=上次报告） */
  progress(): RunProgress
}

// ---------- config store ----------

export interface PluginConnectionConfig {
  url: string
  username: string
  /** 密码引用方式，不落明文 */
  passwordRef: 'keychain' | 'credentials'
}

/** 连接层可选参数：设置页「高级选项」里可改，也可写在 cordis.patch.yml 的 config 里 */
export interface PluginOptions {
  /** 单次 HTTP 请求超时，毫秒 */
  timeoutMs: number
  /** 远端同步根目录 */
  remoteRoot: string
  /** 仅内网自签证书场景开启 */
  ignoreTlsErrors: boolean
}

export type ScopeMode = 'all' | 'selected' | 'none'

export interface SyncScope {
  bundles: { mode: ScopeMode; exclude: string[] }
  skills: { mode: ScopeMode; exclude: string[] }
  configs: { mode: ScopeMode; includeKeys: string[] }
}

export interface ScheduleConfig {
  enabled: boolean
  intervalHours: number
  direction: SyncDirection
}

export interface PluginConfig {
  connection: PluginConnectionConfig
  options: PluginOptions
  scope: SyncScope
  schedule: ScheduleConfig
  conflictPolicy: ConflictPolicy
  /** v2 新增：智能同步选项 */
  syncOptions: SyncOptions
  machineId: string
  env: ResolvedEnv | null
  lastSyncAt: string | null
  /** v2 新增：三方合并的 base（替代 lastSyncedHashes） */
  lastSynced: Record<string, SyncSnapshot>
  /** @deprecated 旧字段，仅用于一次性迁移读取；迁移后从磁盘删除 */
  lastSyncedHashes?: Record<string, string>
}

// ---------- HTTP 视图模型（DESIGN §5） ----------

export interface PublicConfig {
  connection: {
    url: string
    username: string
    passwordRef: 'keychain' | 'credentials'
    hasPassword: boolean
  }
  options: PluginOptions
  scope: SyncScope
  schedule: ScheduleConfig
  conflictPolicy: ConflictPolicy
  syncOptions: SyncOptions
  machineId: string
  profile: string
  lastSyncAt: string | null
  /** 包版本，UI 展示用 */
  version: string
  /** 环境探测结果（诊断页读 dshHome / profileDir / skillsDir / settingsFile / generation） */
  env: ResolvedEnv | null
}

export interface PlanLocalSummary {
  hash: string
  version: string | null
  sizeBytes: number
  modifiedAt: string
}

export interface PlanRemoteSummary {
  hash: string
  version: string | null
  size: number
  updatedAt: string
  machineId: string
}

export interface PlanItem {
  key: string
  kind: EntryKind
  name: string
  action: ItemAction
  reason: string
  winner?: 'local' | 'remote'
  local?: PlanLocalSummary
  remote?: PlanRemoteSummary
}

export interface PlanSummary {
  upload: number
  download: number
  merge: number
  skip: number
  remove: number
  conflict: number
  total: number
}

export interface PlanResult {
  generatedAt: string
  direction: SyncDirection
  items: PlanItem[]
  summary: PlanSummary
  errors: { stage: string; message: string }[]
}

/** GET /status 响应 */
export interface StatusPayload {
  lastSyncAt: string | null
  machineId: string
  env: ResolvedEnv | null
  schedule: ScheduleConfig
  conflictPolicy: ConflictPolicy
  syncOptions: SyncOptions
  direction: SyncDirection
  lock: { machineId: string; startedAt: string; expiresAt: string } | null
  counts: RunCounts
  lastReport: SyncRunReport | null
  capabilities: ServerCapabilities | null
}
