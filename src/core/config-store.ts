/*
 * 本地配置存储：~/.dsh/webdav-sync.json（或探测到的 dshHome 下）。
 * 密码不落明文：仅存引用（keychain / credentials），实际密码由 host 层
 * 写入 .credentials.yaml 的专属字段或系统钥匙串。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PluginConfig, ResolvedEnv, SyncScope } from '../types.js'

export const CONFIG_FILENAME = 'webdav-sync.json'

export function defaultScope(): SyncScope {
  return {
    bundles: { mode: 'all', exclude: [] },
    skills: { mode: 'all', exclude: [] },
    // 配置默认 none：模型/provider 配置含密钥，默认不同步
    configs: { mode: 'none', includeKeys: [] },
  }
}

export function defaultConfig(machineId?: string): PluginConfig {
  return {
    connection: { url: '', username: '', passwordRef: 'credentials' },
    scope: defaultScope(),
    schedule: { enabled: false, intervalHours: 1, direction: 'both' },
    conflictPolicy: 'merge-backup',
    machineId: machineId ?? generateMachineId(),
    env: null,
    lastSyncAt: null,
    lastSyncedHashes: {},
  }
}

export function generateMachineId(): string {
  // hostname 前缀 + 短随机，兼顾可读性与多用户同机隔离
  const host = safeHostname()
  return `${host}-${randomUUID().slice(0, 6)}`
}

function safeHostname(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { hostname } = require('node:os') as typeof import('node:os')
    return hostname().toLowerCase().replace(/[^\w-]+/g, '_').slice(0, 24) || 'machine'
  } catch {
    return 'machine'
  }
}

export class ConfigStore {
  private readonly filePath: string
  private cache: PluginConfig | null = null

  constructor(dshHome: string) {
    const dir = path.join(dshHome, '.webdav-sync')
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
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PluginConfig>
      this.cache = { ...defaultConfig(), ...raw, machineId: raw.machineId ?? defaultConfig().machineId }
      return this.cache
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

  markSynced(hashes: Record<string, string>): PluginConfig {
    return this.update({ lastSyncedHashes: hashes, lastSyncAt: new Date().toISOString() })
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
