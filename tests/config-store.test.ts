import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FILENAME, ConfigStore, DATA_DIRNAME, defaultConfig } from '../src/core/config-store.js'
import { DEFAULT_SYNC_OPTIONS } from '../src/types.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'dsh-config-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function configFile(): string {
  return path.join(home, DATA_DIRNAME, CONFIG_FILENAME)
}

function writeConfig(data: unknown): void {
  mkdirSync(path.dirname(configFile()), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(data, null, 2), 'utf8')
}

describe('ConfigStore v2 默认值', () => {
  it('新配置：conflictPolicy=auto、syncOptions 全默认、lastSynced 为空', () => {
    const cfg = new ConfigStore(home).load()
    expect(cfg.conflictPolicy).toBe('auto')
    expect(cfg.syncOptions).toEqual(DEFAULT_SYNC_OPTIONS)
    expect(cfg.lastSynced).toEqual({})
    expect(cfg.lastSyncAt).toBeNull()
    expect(existsSync(configFile())).toBe(true)
  })

  it('旧配置缺 syncOptions 时用默认值补齐（深合并已知子结构）', () => {
    writeConfig({
      machineId: 'm-1',
      connection: { url: 'https://dav.example.com/', username: 'alice', passwordRef: 'credentials' },
      options: { timeoutMs: 45000 },
      schedule: { enabled: true },
      syncOptions: { dedupeRemote: false },
    })
    const cfg = new ConfigStore(home).load()
    expect(cfg.connection.url).toBe('https://dav.example.com/')
    expect(cfg.options.timeoutMs).toBe(45000)
    expect(cfg.options.remoteRoot).toBe('/dsh-sync/') // 缺的字段补默认
    expect(cfg.schedule.enabled).toBe(true)
    expect(cfg.schedule.intervalHours).toBe(1)
    expect(cfg.syncOptions.dedupeRemote).toBe(false) // 显式覆盖
    expect(cfg.syncOptions.propagateDeletions).toBe(true) // 其余默认
    expect(cfg.machineId).toBe('m-1')
  })

  it('未知字段原样保留（update 是浅合并）', () => {
    writeConfig({ machineId: 'm-2', futureFlag: 42 })
    const store = new ConfigStore(home)
    const cfg = store.load() as unknown as Record<string, unknown>
    expect(cfg.futureFlag).toBe(42)
    const next = store.update({ lastSyncAt: '2026-06-01T00:00:00Z' })
    expect(next.lastSyncAt).toBe('2026-06-01T00:00:00Z')
  })
})

describe('lastSyncedHashes → lastSynced 迁移', () => {
  it('迁移成快照（syncedAt=now、machineId=本机），并删除旧字段落盘', () => {
    writeConfig({
      machineId: 'm-3',
      lastSyncedHashes: { 'skill:a': 'a'.repeat(64), 'skill:b': 'b'.repeat(64) },
    })
    const cfg = new ConfigStore(home).load()
    expect(cfg.lastSynced['skill:a']).toMatchObject({
      hash: 'a'.repeat(64),
      version: null,
      machineId: 'm-3',
    })
    expect(typeof cfg.lastSynced['skill:b'].syncedAt).toBe('string')
    expect(Number.isNaN(Date.parse(cfg.lastSynced['skill:b'].syncedAt))).toBe(false)
    // 内存里旧字段已删除
    expect('lastSyncedHashes' in cfg).toBe(false)
    // 磁盘上旧字段也已删除
    const disk = JSON.parse(readFileSync(configFile(), 'utf8')) as Record<string, unknown>
    expect(disk.lastSyncedHashes).toBeUndefined()
    expect((disk.lastSynced as Record<string, { hash: string }>)['skill:a'].hash).toBe('a'.repeat(64))
  })

  it('空 lastSyncedHashes 不触发迁移但会清掉旧字段', () => {
    writeConfig({ machineId: 'm-4', lastSyncedHashes: {} })
    const cfg = new ConfigStore(home).load()
    expect(cfg.lastSynced).toEqual({})
    expect('lastSyncedHashes' in cfg).toBe(false)
  })
})

describe('同步快照写入', () => {
  it('markSynced 写 lastSynced + lastSyncAt', () => {
    const store = new ConfigStore(home)
    store.load()
    const when = '2026-06-01T12:00:00.000Z'
    const cfg = store.markSynced(
      { 'skill:a': { hash: 'h1', version: '1.0.0', syncedAt: when, machineId: 'm-1' } },
      when,
    )
    expect(cfg.lastSyncAt).toBe(when)
    expect(cfg.lastSynced['skill:a'].hash).toBe('h1')
    const reloaded = new ConfigStore(home).load()
    expect(reloaded.lastSynced['skill:a'].version).toBe('1.0.0')
    expect(reloaded.lastSyncAt).toBe(when)
  })

  it('markSyncedHashes 兼容旧 hash 映射', () => {
    const store = new ConfigStore(home)
    const cfg = store.markSyncedHashes({ 'bundle:x': 'h2' })
    expect(cfg.lastSynced['bundle:x'].hash).toBe('h2')
    expect(cfg.lastSynced['bundle:x'].machineId).toBe(cfg.machineId)
  })
})

describe('损坏配置自愈', () => {
  it('JSON 损坏时备份后重置默认配置', () => {
    writeConfig('not-an-object')
    // 覆盖成非法 JSON
    writeFileSync(configFile(), '{broken json', 'utf8')
    const store = new ConfigStore(home)
    const cfg = store.load()
    expect(cfg.conflictPolicy).toBe('auto')
    expect(cfg.machineId).toBeTruthy()
    const backups = readdirSync(path.dirname(configFile())).filter((n) => n.includes('.corrupt-'))
    expect(backups.length).toBe(1)
  })
})

// 保持 defaultConfig 导出可用性（host / http 都依赖）
describe('defaultConfig', () => {
  it('保留传入的 machineId', () => {
    expect(defaultConfig('fixed-machine').machineId).toBe('fixed-machine')
  })
})
