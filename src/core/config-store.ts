/*
 * 本地配置存储：~/.dsh/.webdav-enhanced/webdav-enhanced.json（或探测到的 dshHome 下）。
 * 密码不落明文：仅存引用（keychain / credentials），实际密码由 host 层
 * 写入 .credentials.yaml 的专属字段或系统钥匙串。
 *
 * v2：
 * - 新增 syncOptions（默认值见 DEFAULT_SYNC_OPTIONS）与 lastSynced（SyncSnapshot）。
 * - 旧字段 lastSyncedHashes 在 load() 时迁移成 lastSynced（syncedAt=now、machineId=本机），
 *   迁移后立即落盘并删除旧字段。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CONFLICT_POLICY,
  DEFAULT_SYNC_OPTIONS,
  type PluginConfig,
  type ResolvedEnv,
  type SyncOptions,
  type SyncScope,
  type SyncSnapshot,
} from '../types.js'

/** 数据目录名（相对 dshHome） */
export const DATA_DIRNAME = '.webdav-enhanced'

export const CONFIG_FILENAME = 'webdav-enhanced.json'

/** 旧版本用的目录名与文件名，仅用于一次性迁移 */
const LEGACY_DIRNAME = '.webdav-sync'
const LEGACY_CONFIG_FILENAME = 'webdav-sync.json'

/**
 * 把旧版 webdav-sync 的数据目录与配置文件名迁移到新命名。
 * 只在目标不存在时执行，失败静默（新目录照常创建，不影响功能）。
 */
export function migrateLegacyData(dshHome: string): void {
  const legacyDir = path.join(dshHome, LEGACY_DIRNAME)
  const nextDir = path.join(dshHome, DATA_DIRNAME)
  if (existsSync(legacyDir) && !existsSync(nextDir)) {
    try {
      renameSync(legacyDir, nextDir)
    } catch {
      /* 目录被占用等情况：放弃迁移，保留旧数据不动 */
    }
  }
  const legacyFile = path.join(nextDir, LEGACY_CONFIG_FILENAME)
  const nextFile = path.join(nextDir, CONFIG_FILENAME)
  if (existsSync(legacyFile) && !existsSync(nextFile)) {
    try {
      renameSync(legacyFile, nextFile)
    } catch {
      /* 同上 */
    }
  }
}

export function defaultScope(): SyncScope {
  return {
    bundles: { mode: 'all', exclude: [] },
    skills: { mode: 'all', exclude: [] },
    // 配置默认 none：模型/provider 配置含密钥，默认不同步
    configs: { mode: 'none', includeKeys: [] },
  }
}

export function defaultSyncOptions(patch: Partial<SyncOptions> = {}): SyncOptions {
  return { ...DEFAULT_SYNC_OPTIONS, ...patch }
}

export function defaultConfig(machineId?: string): PluginConfig {
  return {
    connection: { url: '', username: '', passwordRef: 'credentials' },
    options: { timeoutMs: 30000, remoteRoot: '/dsh-sync/', ignoreTlsErrors: false },
    scope: defaultScope(),
    schedule: { enabled: false, intervalHours: 1, direction: 'both' },
    conflictPolicy: DEFAULT_CONFLICT_POLICY,
    syncOptions: defaultSyncOptions(),
    machineId: machineId ?? generateMachineId(),
    env: null,
    lastSyncAt: null,
    lastSynced: {},
  }
}

export function generateMachineId(): string {
  // hostname 前缀 + 短随机，兼顾可读性与多用户同机隔离
  const host = safeHostname()
  return `${host}-${randomUUID().slice(0, 6)}`
}

function safeHostname(): string {
  try {
    return hostname().toLowerCase().replace(/[^\w-]+/g, '_').slice(0, 24) || 'machine'
  } catch {
    return 'machine'
  }
}

// ---------- 深度默认值合并（只对已知子结构做一层合并，未知字段原样保留） ----------

function mergeConfig(base: PluginConfig, raw: Record<string, unknown>): PluginConfig {
  const connection = { ...base.connection, ...((raw.connection as object) ?? {}) }
  const options = { ...base.options, ...((raw.options as object) ?? {}) }
  const schedule = { ...base.schedule, ...((raw.schedule as object) ?? {}) }
  const rawScope = (raw.scope as Record<string, unknown>) ?? {}
  const scope: SyncScope = {
    bundles: { ...base.scope.bundles, ...((rawScope.bundles as object) ?? {}) },
    skills: { ...base.scope.skills, ...((rawScope.skills as object) ?? {}) },
    configs: { ...base.scope.configs, ...((rawScope.configs as object) ?? {}) },
  }
  const syncOptions = defaultSyncOptions(((raw.syncOptions as Partial<SyncOptions>) ?? {}) as Partial<SyncOptions>)
  const lastSynced: Record<string, SyncSnapshot> = {}
  const rawLastSynced = raw.lastSynced
  if (rawLastSynced && typeof rawLastSynced === 'object') {
    for (const [key, value] of Object.entries(rawLastSynced as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const snap = value as Partial<SyncSnapshot>
      if (typeof snap.hash !== 'string' || !snap.hash) continue
      lastSynced[key] = {
        hash: snap.hash,
        version: typeof snap.version === 'string' ? snap.version : null,
        syncedAt: typeof snap.syncedAt === 'string' ? snap.syncedAt : new Date(0).toISOString(),
        machineId: typeof snap.machineId === 'string' ? snap.machineId : base.machineId,
      }
    }
  }
  return {
    ...base,
    ...raw,
    connection,
    options,
    scope,
    schedule,
    syncOptions,
    lastSynced,
    machineId: typeof raw.machineId === 'string' && raw.machineId ? raw.machineId : base.machineId,
    conflictPolicy: normalizePolicy(raw.conflictPolicy),
    lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null,
    env: (raw.env as ResolvedEnv | null) ?? null,
  }
}

function normalizePolicy(value: unknown): PluginConfig['conflictPolicy'] {
  const allowed = ['auto', 'merge-backup', 'ask', 'local-wins', 'remote-wins']
  return typeof value === 'string' && allowed.includes(value) ? (value as PluginConfig['conflictPolicy']) : DEFAULT_CONFLICT_POLICY
}

/** 旧 lastSyncedHashes（Record<string,string>）→ lastSynced；返回是否有迁移 */
function migrateSnapshots(cfg: PluginConfig, raw: Record<string, unknown>): boolean {
  const legacy = raw.lastSyncedHashes
  delete cfg.lastSyncedHashes
  if (!legacy || typeof legacy !== 'object') return false
  const now = new Date().toISOString()
  let migrated = false
  for (const [key, hash] of Object.entries(legacy as Record<string, unknown>)) {
    if (typeof hash !== 'string' || !hash) continue
    if (cfg.lastSynced[key]) continue
    cfg.lastSynced[key] = { hash, version: null, syncedAt: now, machineId: cfg.machineId }
    migrated = true
  }
  return migrated
}

export class ConfigStore {
  private readonly filePath: string
  private cache: PluginConfig | null = null

  constructor(dshHome: string) {
    const dir = path.join(dshHome, DATA_DIRNAME)
    mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, CONFIG_FILENAME)
  }

  load(): PluginConfig {
    if (this.cache) return this.cache
    if (!existsSync(this.filePath)) {
      this.cache = defaultConfig()
      this.save(this.cache)
      return this.cache
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>
      const cfg = mergeConfig(defaultConfig(), raw)
      const migrated = migrateSnapshots(cfg, raw)
      this.cache = cfg
      if (migrated) {
        // 迁移完成立即落盘（旧字段一并删掉），避免下一轮重复迁移
        this.save(cfg)
      }
      return cfg
    } catch {
      // 配置损坏：备份后重置
      this.backupCorrupt()
      this.cache = defaultConfig()
      this.save(this.cache)
      return this.cache
    }
  }

  save(cfg: PluginConfig): void {
    this.cache = cfg
    // 原子写：先写临时文件再 rename，避免崩溃半截
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  update(patch: Partial<PluginConfig>): PluginConfig {
    const next = { ...this.load(), ...patch }
    this.save(next)
    return next
  }

  updateEnv(env: ResolvedEnv): PluginConfig {
    return this.update({ env })
  }

  /** v2：写入上次同步快照（lastSynced）+ lastSyncAt */
  markSynced(snapshots: Record<string, SyncSnapshot>, when = new Date().toISOString()): PluginConfig {
    return this.update({ lastSynced: snapshots, lastSyncAt: when })
  }

  /** 兼容旧调用：hash 字符串映射 → 快照（syncedAt=now、machineId=当前机器） */
  markSyncedHashes(hashes: Record<string, string>, when = new Date().toISOString()): PluginConfig {
    const cfg = this.load()
    const next: Record<string, SyncSnapshot> = { ...cfg.lastSynced }
    for (const [key, hash] of Object.entries(hashes)) {
      next[key] = { hash, version: null, syncedAt: when, machineId: cfg.machineId }
    }
    return this.update({ lastSynced: next, lastSyncAt: when })
  }

  get path_(): string {
    return this.filePath
  }

  private backupCorrupt(): void {
    try {
      const bak = this.filePath + `.corrupt-${Date.now()}.bak`
      renameSync(this.filePath, bak)
    } catch {
      /* 尽力而为 */
    }
  }
}

export function createConfigStore(dshHome: string): ConfigStore {
  return new ConfigStore(dshHome)
}
