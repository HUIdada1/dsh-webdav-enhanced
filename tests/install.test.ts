import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInstaller, mergeTopLevelConfig, pruneBackupDir } from '../src/core/install.js'
import { createPackager } from '../src/core/pack.js'
import type { LocalEntry, PackedEntry, ResolvedEnv } from '../src/types.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-install-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function mkEnv(maxBackups?: number): { env: ResolvedEnv; installer: ReturnType<typeof createInstaller> } {
  const settingsFile = path.join(root, 'settings.yaml')
  const env: ResolvedEnv = {
    dshHome: root,
    profileDir: path.join(root, 'profiles', 'web'),
    skillsDir: path.join(root, 'skills'),
    settingsFile,
    credentialsFile: null,
    profile: 'web',
    dshVersion: null,
    nodeVersion: process.version,
    platform: process.platform,
    generation: 'cordis',
    extras: [],
  }
  mkdirSync(env.profileDir, { recursive: true })
  return { env, installer: createInstaller(env, { maxBackups }) }
}

/** 把一段 settings.yaml 内容打进 zip（模拟远端下载到的 config 包） */
async function packSettings(remoteContent: string, outName = 'out'): Promise<PackedEntry> {
  const srcDir = path.join(root, `remote-${outName}`)
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(path.join(srcDir, 'settings.yaml'), remoteContent, 'utf8')
  const entry: LocalEntry = {
    kind: 'config',
    name: 'settings',
    version: null,
    sourceDir: srcDir,
    hash: '',
    sizeBytes: 0,
    modifiedAt: new Date().toISOString(),
  }
  return createPackager().pack(entry, path.join(root, `packed-${outName}`))
}

describe('mergeTopLevelConfig', () => {
  it('保留本地独有 key、覆盖同名 key、追加远端独有 key（D6）', () => {
    const local = ['# header comment', 'llm-deepseek:', '  model: local-model', '', 'theme: dark', ''].join('\n')
    const remote = ['llm-deepseek:', '  model: remote-model', '', 'newKey: 2', ''].join('\n')
    const merged = mergeTopLevelConfig(local, remote)
    expect(merged).toContain('# header comment')
    expect(merged).toContain('  model: remote-model')
    expect(merged).not.toContain('  model: local-model')
    expect(merged).toContain('theme: dark') // 本地独有 key 不丢
    expect(merged).toContain('newKey: 2')
    expect(merged.endsWith('\n')).toBe(true)
  })

  it('本地顺序优先，同名块用远端内容替换', () => {
    const local = ['a: 1', 'b: 2', 'c: 3', ''].join('\n')
    const remote = ['c: 30', 'a: 10', ''].join('\n')
    const merged = mergeTopLevelConfig(local, remote)
    const lines = merged
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '')
    expect(lines).toEqual(['a: 10', 'b: 2', 'c: 30'])
  })

  it('远端为空 → 本地内容保持不变', () => {
    const local = ['a: 1', 'b: 2', ''].join('\n')
    expect(mergeTopLevelConfig(local, '')).toBe('a: 1\nb: 2\n')
  })
})

describe('pruneBackupDir', () => {
  it('只保留最新 keep 个，且按 prefix 过滤', () => {
    const dir = path.join(root, 'backups')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 5; i++) writeFileSync(path.join(dir, `settings.yaml.bak-${i}`), String(i))
    writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me')
    pruneBackupDir(dir, 2, 'settings.yaml.bak-')
    const left = readdirSync(dir).sort()
    expect(left.filter((n) => n.startsWith('settings.yaml.bak-')).length).toBe(2)
    expect(left).toContain('unrelated.txt')
  })
})

describe('applyConfig（顶层 key 合并 + 写前备份 + 轮转）', () => {
  it('合并后不丢本地其它顶层 key，写前留下备份', async () => {
    const { env, installer } = mkEnv()
    const local = ['theme: dark', 'keepme: 1', ''].join('\n')
    writeFileSync(env.settingsFile!, local, 'utf8')
    const packed = await packSettings(['theme: light', 'newKey: 2', ''].join('\n'))

    const result = await installer.applyConfig(packed, {
      kind: 'config',
      name: 'settings',
      version: null,
      source: { machineId: 'm1', platform: 'win32', dshVersion: null },
      originalPath: '',
      packedAt: new Date().toISOString(),
      dshVersion: null,
    })
    expect(result.status).toBe('needs-restart')
    const after = readFileSync(env.settingsFile!, 'utf8')
    expect(after).toContain('theme: light') // 远端覆盖同名 key
    expect(after).toContain('keepme: 1') // 本地独有 key 保留（D6）
    expect(after).toContain('newKey: 2') // 远端新增 key 追加
    expect(after).not.toContain('theme: dark')

    const backups = readdirSync(root).filter((n) => n.startsWith('settings.yaml.bak-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(path.join(root, backups[0]), 'utf8')).toBe(local) // 备份是写前内容
  })

  it('重复应用幂等（内容一致 → skipped）', async () => {
    const { env, installer } = mkEnv()
    writeFileSync(env.settingsFile!, 'theme: dark\nkeepme: 1\n', 'utf8')
    const packed = await packSettings(['newKey: 2', ''].join('\n'), 'idem')
    const meta = {
      kind: 'config' as const,
      name: 'settings',
      version: null,
      source: { machineId: 'm1', platform: 'win32', dshVersion: null },
      originalPath: '',
      packedAt: new Date().toISOString(),
      dshVersion: null,
    }
    await installer.applyConfig(packed, meta)
    const again = await installer.applyConfig(packed, meta)
    expect(again.status).toBe('skipped')
  })

  it('备份按 maxBackups 轮转', async () => {
    const { env, installer } = mkEnv(2)
    writeFileSync(env.settingsFile!, 'theme: dark\n', 'utf8')
    const packed = await packSettings(['theme: light', ''].join('\n'), 'rotate')
    const meta = {
      kind: 'config' as const,
      name: 'settings',
      version: null,
      source: { machineId: 'm1', platform: 'win32', dshVersion: null },
      originalPath: '',
      packedAt: new Date().toISOString(),
      dshVersion: null,
    }
    await installer.applyConfig(packed, meta)
    await installer.applyConfig(packed, meta)
    await installer.applyConfig(packed, meta)
    const backups = readdirSync(root).filter((n) => n.startsWith('settings.yaml.bak-'))
    expect(backups.length).toBeLessThanOrEqual(2)
  })

  it('本机没有 settings.yaml 时返回 manual-needed', async () => {
    const { env, installer } = mkEnv()
    const packed = await packSettings(['a: 1', ''].join('\n'), 'nofile')
    const result = await installer.applyConfig(packed, {
      kind: 'config',
      name: 'settings',
      version: null,
      source: { machineId: 'm1', platform: 'win32', dshVersion: null },
      originalPath: '',
      packedAt: new Date().toISOString(),
      dshVersion: null,
    })
    expect(result.status).toBe('manual-needed')
    expect(existsSync(env.settingsFile!)).toBe(false)
  })
})
