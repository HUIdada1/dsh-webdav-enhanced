/*
 * dsh-webdav-sync — core type contracts.
 * All core modules (env / webdav / pack / manifest / merge / sync / install)
 * program against these interfaces only. The Cordis host layer (host.ts)
 * is the only module allowed to depend on the dsh runtime.
 */

// ---------- shared primitives ----------

export type Platform = 'win32' | 'darwin' | 'linux' | string

/** 宿主 dsh 的代际：cordis（@deepseek-ai/dsh，当前主线）/ legacy（0.1.x manifest 制式）/ unknown */
export type HostGeneration = 'cordis' | 'legacy' | 'unknown'

export type EntryKind = 'bundle' | 'skill' | 'config'

export type SyncDirection = 'both' | 'upload' | 'download'

export type ConflictPolicy = 'merge-backup' | 'ask' | 'local-wins' | 'remote-wins'

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
  /** 内容指纹 sha256；由 pack 阶段计算后回填 */
  hash: string
  sizeBytes: number
  modifiedAt: string // ISO 8601
  /** 打包时的来源机器信息；非必填，由 pack 填充 */
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

// ---------- M5 merge ----------

export type MergeActionType =
  | 'upload'          // 本地有新内容 → 上传
  | 'download'        // 远端有本地没有/更新 → 下载
  | 'skip'            // 一致，不动
  | 'conflict'        // 两端分叉，按策略产出冲突副本

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

export interface SyncRunReport {
  trigger: SyncTrigger
  startedAt: string
  finishedAt: string
  uploaded: string[]
  downloaded: string[]
  skipped: number
  conflicts: { name: string; note: string }[]
  errors: { stage: string; message: string }[]
  ok: boolean
}

export interface SyncEngine {
  runOnce(trigger: SyncTrigger): Promise<SyncRunReport>
  /** 定时调度：intervalHours = 0 表示关闭 */
  startScheduler(intervalHours: number, onReport: (r: SyncRunReport) => void): void
  stopScheduler(): void
  isRunning(): boolean
}

// ---------- config store ----------

export interface PluginConnectionConfig {
  url: string
  username: string
  /** 密码引用方式，不落明文 */
  passwordRef: 'keychain' | 'credentials'
}

export type ScopeMode = 'all' | 'selected' | 'none'

export interface SyncScope {
  bundles: { mode: ScopeMode; exclude: string[] }
  skills: { mode: ScopeMode; exclude: string[] }
  configs: { mode: ScopeMode; includeKeys: string[] }
}

export interface PluginConfig {
  connection: PluginConnectionConfig
  scope: SyncScope
  schedule: { enabled: boolean; intervalHours: number; direction: SyncDirection }
  conflictPolicy: ConflictPolicy
  machineId: string
  env: ResolvedEnv | null
  lastSyncAt: string | null
  lastSyncedHashes: Record<string, string>
}
