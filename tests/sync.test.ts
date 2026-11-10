import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/core/config-store.js'
import { emptyManifest, remoteZipRelPath } from '../src/core/manifest.js'
import { createPackager } from '../src/core/pack.js'
import { RunProgressTracker } from '../src/core/progress.js'
import { RunLogger } from '../src/core/runlog.js'
import { SyncEngineImpl } from '../src/core/sync.js'
import type { SyncStore } from '../src/core/webdav-store.js'
import type {
  LocalEntry,
  RemoteEntry,
  RemoteManifest,
  ResolvedEnv,
  SyncOptions,
  SyncScope,
  WebDavClient,
  LockHandle,
} from '../src/types.js'

let root: string
let env: ResolvedEnv
let client: MemoryClient
let store: MemoryStore
let configStore: ConfigStore
let logger: RunLogger
let progress: RunProgressTracker

const packager = createPackager()

// ---------- mock 远端 ----------

class MemoryClient implements WebDavClient {
  files = new Map<string, Buffer>()

  async testConnection() {
    return {
      ok: true,
      steps: [],
      capabilities: { supportsLock: false, supportsIfHeader: false, server: 'memory' },
    }
  }
  async exists(p: string) {
    return this.files.has(p)
  }
  async ensureDir(): Promise<void> {
    /* noop */
  }
  async putFile(p: string, localPath: string): Promise<void> {
    this.files.set(p, readFileSync(localPath))
  }
  async getFile(p: string, localPath: string): Promise<void> {
    const buf = this.files.get(p)
    if (!buf) throw new Error(`remote file not found: ${p}`)
    mkdirSync(path.dirname(localPath), { recursive: true })
    writeFileSync(localPath, buf)
  }
  async getJson<T>(): Promise<T | null> {
    return null
  }
  async putJsonIfMatch(): Promise<string | null> {
    return null
  }
  async deleteFile(p: string): Promise<void> {
    this.files.delete(p)
  }
  async move(a: string, b: string): Promise<void> {
    const f = this.files.get(a)
    if (f) {
      this.files.set(b, f)
      this.files.delete(a)
    }
  }
  async stat(p: string) {
    const f = this.files.get(p)
    return f ? { etag: null, size: f.length, mtime: null } : null
  }
  async listDir() {
    return []
  }
  async acquireLock(machineId: string, _ttlMs: number): Promise<LockHandle> {
    return { machineId, acquiredAt: new Date().toISOString(), release: async () => undefined }
  }
  async currentLockHolder() {
    return null
  }
}

class MemoryStore implements SyncStore {
  manifest: RemoteManifest = emptyManifest()
  async read() {
    return { manifest: this.manifest, etag: null }
  }
  async commit(next: RemoteManifest): Promise<string | null> {
    this.manifest = next
    return null
  }
  async acquireLock(machineId: string): Promise<LockHandle> {
    return { machineId, acquiredAt: new Date().toISOString(), release: async () => undefined }
  }
  async currentLockHolder() {
    return null
  }
}

// ---------- fixtures ----------

function makeEnv(dshHome: string): ResolvedEnv {
  return {
    dshHome,
    profileDir: path.join(dshHome, 'profiles', 'web'),
    skillsDir: path.join(dshHome, 'skills'),
    settingsFile: null,
    credentialsFile: null,
    profile: 'web',
    dshVersion: null,
    nodeVersion: process.version,
    platform: process.platform,
    generation: 'cordis',
    extras: [],
  }
}

function makeLocalSkill(name: string, content = `# ${name}`): LocalEntry {
  const dir = path.join(env.skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\nversion: 1.0.0\n---\n${content}`)
  return {
    kind: 'skill',
    name,
    version: '1.0.0',
    sourceDir: dir,
    hash: '',
    sizeBytes: 0,
    modifiedAt: new Date().toISOString(),
  }
}

async function makeRemoteSkill(name: string, version = '1.0.0') {
  const srcDir = path.join(root, 'remote-src', name)
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(path.join(srcDir, 'SKILL.md'), `---\nname: ${name}\nversion: ${version}\n---\nremote body`)
  const entry: LocalEntry = {
    kind: 'skill',
    name,
    version,
    sourceDir: srcDir,
    hash: '',
    sizeBytes: 0,
    modifiedAt: new Date().toISOString(),
  }
  const packed = await packager.pack(entry, path.join(root, 'remote-packed', name))
  const remote: RemoteEntry = {
    kind: 'skill',
    name,
    version,
    hash: packed.sha256,
    file: remoteZipRelPath({ kind: 'skill', name, version, hash: packed.sha256 }),
    size: packed.size,
    source: { machineId: 'other-pc', platform: 'linux', dshVersion: null },
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deleted: false,
  }
  client.files.set(remote.file, readFileSync(packed.zipPath))
  store.manifest = { ...store.manifest, entries: [...store.manifest.entries, remote] }
  return { remote, packed }
}

const skillScope: SyncScope = {
  bundles: { mode: 'none', exclude: [] },
  skills: { mode: 'all', exclude: [] },
  configs: { mode: 'none', includeKeys: [] },
}

function makeEngine(over: {
  syncOptions?: Partial<SyncOptions>
  direction?: 'both' | 'upload' | 'download'
  packagerOverride?: { pack: typeof packager.pack } | null
} = {}) {
  const cfg = configStore.load()
  configStore.update({
    scope: skillScope,
    conflictPolicy: 'auto',
    machineId: 'm1',
    schedule: { enabled: false, intervalHours: 1, direction: over.direction ?? 'both' },
    syncOptions: { ...cfg.syncOptions, ...(over.syncOptions ?? {}) },
  })
  return new SyncEngineImpl({
    env,
    configStore,
    store,
    client,
    packager: over.packagerOverride
      ? ({ pack: over.packagerOverride.pack, unpack: packager.unpack.bind(packager), hashFile: packager.hashFile.bind(packager) } as never)
      : packager,
    progress,
    logger,
  })
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-sync-'))
  env = makeEnv(root)
  mkdirSync(env.profileDir, { recursive: true })
  mkdirSync(env.skillsDir, { recursive: true })
  client = new MemoryClient()
  store = new MemoryStore()
  configStore = new ConfigStore(root)
  configStore.load()
  logger = new RunLogger(root)
  progress = new RunProgressTracker()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------- tests ----------

describe('SyncEngine v2', () => {
  it('首轮：上传本机新增 + 下载安装远端新增，lastSynced 写入真实 hash（D1）', async () => {
    const local = makeLocalSkill('local-skill')
    const { remote: remoteEntry, packed: remotePacked } = await makeRemoteSkill('remote-skill')
    const localPacked = await packager.pack(local, path.join(root, 'local-packed'))

    const engine = makeEngine()
    const report = await engine.runOnce('manual')

    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.uploaded).toContain('skill:local-skill')
    expect(report.downloaded).toContain('skill:remote-skill')
    expect(report.items.every((i) => i.status !== 'pending')).toBe(true)

    // 本机新增的远端条目已登记
    const manifest = store.manifest
    expect(manifest.entries.map((e) => e.name).sort()).toEqual(['local-skill', 'remote-skill'])
    expect(manifest.entries.find((e) => e.name === 'local-skill')!.hash).toBe(localPacked.sha256)

    // 远端条目已解压安装到 skills/
    expect(existsSync(path.join(env.skillsDir, 'remote-skill', 'SKILL.md'))).toBe(true)

    // D1：lastSynced 里是真实 hash（不是空串），且带 version/syncedAt/machineId
    const synced = configStore.load().lastSynced
    expect(synced['skill:local-skill'].hash).toBe(localPacked.sha256)
    expect(synced['skill:remote-skill'].hash).toBe(remoteEntry.hash)
    expect(synced['skill:remote-skill'].version).toBe('1.0.0')
    expect(synced['skill:remote-skill'].machineId).toBe('m1')
    expect(Number.isNaN(Date.parse(synced['skill:remote-skill'].syncedAt))).toBe(false)
    expect(remotePacked.sha256).toBe(remoteEntry.hash)

    // 进度快照 & 日志
    const snapshot = engine.progress()
    expect(snapshot.active).toBe(false)
    expect(snapshot.report).toBe(report)
    expect(snapshot.counts.upload).toBe(1)
    expect(snapshot.counts.download).toBe(1)
    expect(snapshot.total).toBe(2)
    expect(logger.query({ limit: 100 }).entries.length).toBeGreaterThan(0)
    expect(logger.query({ category: 'upload' }).entries.length).toBeGreaterThan(0)
    expect(logger.query({ category: 'download' }).entries.length).toBeGreaterThan(0)
  }, 20000)

  it('第二轮：内容未变 → 全部 skip，lastSynced 保持真实 hash', async () => {
    makeLocalSkill('local-skill')
    await makeRemoteSkill('remote-skill')
    const engine = makeEngine()
    await engine.runOnce('manual')

    const second = await engine.runOnce('manual')
    expect(second.ok).toBe(true)
    expect(second.uploaded).toEqual([])
    expect(second.downloaded).toEqual([])
    expect(second.skipped).toBe(2)
    const synced = configStore.load().lastSynced
    expect(synced['skill:local-skill'].hash).toMatch(/^[0-9a-f]{64}$/)
    expect(synced['skill:remote-skill'].hash).toMatch(/^[0-9a-f]{64}$/)
  }, 20000)

  it('autoInstall=false：下载但不落盘，不写 lastSynced', async () => {
    makeLocalSkill('local-skill')
    await makeRemoteSkill('remote-skill')
    const engine = makeEngine({ syncOptions: { autoInstall: false } })
    const report = await engine.runOnce('manual')
    expect(report.downloaded).toEqual([])
    expect(existsSync(path.join(env.skillsDir, 'remote-skill'))).toBe(false)
    const synced = configStore.load().lastSynced
    expect(synced['skill:remote-skill']).toBeUndefined()
    expect(synced['skill:local-skill']).toBeDefined()
  }, 20000)

  it('取消：在当前条目结束后停止，剩余条目保持 pending', async () => {
    makeLocalSkill('cancel-a')
    makeLocalSkill('cancel-b')
    makeLocalSkill('cancel-c')
    let engine: SyncEngineImpl
    let packCalls = 0
    const countingPackager = {
      pack: async (...args: Parameters<typeof packager.pack>) => {
        packCalls += 1
        if (packCalls >= 2) engine.cancel()
        return packager.pack(...args)
      },
    }
    engine = makeEngine({ packagerOverride: countingPackager })
    const report = await engine.runOnce('manual')
    expect(report.cancelled).toBe(true)
    expect(report.ok).toBe(false)
    const items = report.items
    expect(items.filter((i) => i.status === 'pending').length).toBeGreaterThanOrEqual(1)
    expect(items.some((i) => i.status === 'ok')).toBe(true)
    expect(engine.progress().active).toBe(false)
  }, 20000)

  it('只上传方向：不下载远端条目', async () => {
    makeLocalSkill('local-skill')
    await makeRemoteSkill('remote-skill')
    const engine = makeEngine({ direction: 'upload' })
    const report = await engine.runOnce('manual')
    expect(report.uploaded).toContain('skill:local-skill')
    expect(report.downloaded).toEqual([])
    expect(existsSync(path.join(env.skillsDir, 'remote-skill'))).toBe(false)
    expect(report.items.find((i) => i.name === 'remote-skill')!.status).toBe('skipped')
  }, 20000)

  it('并发 runOnce 返回「已在运行中」报告', async () => {
    await makeRemoteSkill('slow-skill')
    const engine = makeEngine()
    const first = engine.runOnce('manual')
    const second = await engine.runOnce('manual')
    expect(second.ok).toBe(false)
    expect(second.errors[0].message).toContain('已在运行中')
    await first
  }, 20000)

  it('日志落盘到 .webdav-enhanced/logs/sync.jsonl', async () => {
    makeLocalSkill('log-skill')
    const engine = makeEngine()
    await engine.runOnce('manual')
    const logPath = path.join(root, '.webdav-enhanced', 'logs', 'sync.jsonl')
    expect(existsSync(logPath)).toBe(true)
    const lines = readFileSync(logPath, 'utf8').trim().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    expect(readdirSync(path.join(root, '.webdav-enhanced')).length).toBeGreaterThan(0)
  }, 20000)
})
