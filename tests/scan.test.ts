import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HASH_CACHE_FILENAME,
  HASH_CACHE_SCHEMA,
  HashCache,
  listConfigTopKeys,
  scanLocal,
  selectConfigKeys,
  splitConfigBlocks,
} from '../src/core/scan.js'
import type { ResolvedEnv, SyncScope } from '../src/types.js'

let root: string
let env: ResolvedEnv

function scopeOf(over: Partial<SyncScope> = {}): SyncScope {
  return {
    bundles: { mode: 'none', exclude: [] },
    skills: { mode: 'none', exclude: [] },
    configs: { mode: 'none', includeKeys: [] },
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-scan-'))
  const skillsDir = path.join(root, 'skills')
  mkdirSync(path.join(skillsDir, 'skill-a'), { recursive: true })
  writeFileSync(path.join(skillsDir, 'skill-a', 'SKILL.md'), '---\nname: skill-a\nversion: 1.2.3\n---\n')
  writeFileSync(path.join(skillsDir, 'skill-a', 'helper.md'), '# helper')
  env = {
    dshHome: root,
    profileDir: path.join(root, 'profiles', 'web'),
    skillsDir,
    settingsFile: path.join(root, 'settings.yaml'),
    credentialsFile: null,
    profile: 'web',
    dshVersion: null,
    nodeVersion: process.version,
    platform: process.platform,
    generation: 'cordis',
    extras: [],
  }
  mkdirSync(env.profileDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function cacheFile(): string {
  return path.join(root, '.webdav-enhanced', HASH_CACHE_FILENAME)
}

const skillScope = scopeOf({ skills: { mode: 'all', exclude: [] } })

describe('scanLocal 内容 hash（D1/D2）', () => {
  it('扫描阶段就算出真实 hash 与 sizeBytes，并写入 hash 缓存', async () => {
    const entries = await scanLocal(env, skillScope)
    expect(entries).toHaveLength(1)
    const skill = entries[0]
    expect(skill.kind).toBe('skill')
    expect(skill.name).toBe('skill-a')
    expect(skill.version).toBe('1.2.3')
    expect(skill.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(skill.sizeBytes).toBeGreaterThan(0)
    expect(existsSync(cacheFile())).toBe(true)
    const cache = JSON.parse(readFileSync(cacheFile(), 'utf8')) as Record<string, { hash: string; mtimeMs: number; fileCount: number }>
    expect(cache['skill:skill-a'].hash).toBe(skill.hash)
    expect(cache['skill:skill-a'].fileCount).toBe(2)
  })

  it('目录指纹未变 → 命中缓存（不重算、不重写缓存文件）', async () => {
    const first = await scanLocal(env, skillScope)
    const before = readFileSync(cacheFile(), 'utf8')
    const beforeMtime = statSync(cacheFile()).mtimeMs

    const second = await scanLocal(env, skillScope)
    expect(second[0].hash).toBe(first[0].hash)
    expect(second[0].sizeBytes).toBe(first[0].sizeBytes)
    expect(readFileSync(cacheFile(), 'utf8')).toBe(before)
    expect(statSync(cacheFile()).mtimeMs).toBe(beforeMtime)
  })

  it('文件内容变了（目录 mtime 不变）→ 缓存失效、hash 变化', async () => {
    const first = await scanLocal(env, skillScope)
    const file = path.join(env.skillsDir, 'skill-a', 'helper.md')
    writeFileSync(file, '# helper changed')
    // 保险：显式把文件 mtime 拨到未来，避免 Windows 时间分辨率导致指纹相同
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)

    const second = await scanLocal(env, skillScope)
    expect(second[0].hash).not.toBe(first[0].hash)
  })

  it('传 cache:null 时不写 hash 缓存（/plan 干跑）', async () => {
    await scanLocal(env, skillScope, [], { cache: null })
    expect(existsSync(cacheFile())).toBe(false)
  })

  it('HashCache 独立读写', () => {
    const cache = new HashCache(root)
    expect(cache.get('skill:x')).toBeNull()
    cache.set('skill:x', { mtimeMs: 1, fileCount: 2, hash: 'h', sizeBytes: 3 })
    cache.save()
    const again = new HashCache(root)
    expect(again.get('skill:x')).toMatchObject({ hash: 'h', fileCount: 2, schema: HASH_CACHE_SCHEMA })
  })

  it('旧 schema 的缓存被丢弃重算并升级（排除表变更后必须失效）', async () => {
    const cache = new HashCache(root)
    cache.set('skill:skill-a', { mtimeMs: 1, fileCount: 99, hash: 'old-hash', sizeBytes: 1 })
    cache.save()
    // 模拟旧版本缓存：删掉 schema
    const file = cacheFile()
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { schema?: number; hash: string }>
    delete data['skill:skill-a'].schema
    writeFileSync(file, JSON.stringify(data), 'utf8')

    const entries = await scanLocal(env, skillScope)
    expect(entries[0].hash).not.toBe('old-hash')
    const after = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { schema: number; hash: string }>
    expect(after['skill:skill-a'].schema).toBe(HASH_CACHE_SCHEMA)
    expect(after['skill:skill-a'].hash).toBe(entries[0].hash)
  })
})

describe('configs 扫描（D7）', () => {
  const settings = [
    'llm-deepseek:',
    '  model: deepseek-chat',
    '',
    'theme: dark',
    '',
    'apiKeyEnv: MY_KEY',
    '',
    'credentials:',
    '  token: abc',
    '',
    'token: x',
    'secret: y',
    'password: z',
    '',
    'providers:',
    '  - openai',
    '',
  ].join('\n')

  beforeEach(() => {
    writeFileSync(env.settingsFile!, settings)
  })

  it('敏感顶层 key 被识别并排除', () => {
    const keys = listConfigTopKeys(settings)
    expect(keys).toEqual(['llm-deepseek', 'theme', 'providers'])
    expect(keys).not.toContain('apiKeyEnv')
    expect(keys).not.toContain('credentials')
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('secret')
    expect(keys).not.toContain('password')
  })

  it('mode=all 且 includeKeys 为空时同步全部非敏感顶层 key（D7 修复）', async () => {
    const entries = await scanLocal(env, scopeOf({ configs: { mode: 'all', includeKeys: [] } }))
    const config = entries.find((e) => e.kind === 'config')
    expect(config).toBeTruthy()
    expect(config!.hash).toMatch(/^[0-9a-f]{64}$/)
    const stub = readFileSync(path.join(root, '.webdav-enhanced', 'config-stub', 'settings.yaml'), 'utf8')
    expect(stub).toContain('llm-deepseek:')
    expect(stub).toContain('theme: dark')
    expect(stub).toContain('providers:')
    expect(stub).not.toContain('apiKeyEnv')
    expect(stub).not.toContain('credentials')
    expect(stub).not.toContain('secret')
  })

  it('mode=selected 只保留 includeKeys（敏感 key 即使勾了也排除）', async () => {
    expect(selectConfigKeys('selected', ['theme'], settings)).toEqual(['theme'])
    expect(selectConfigKeys('selected', ['theme', 'token'], settings)).toEqual(['theme'])
    const entries = await scanLocal(
      env,
      scopeOf({ configs: { mode: 'selected', includeKeys: ['theme'] } }),
    )
    const stub = readFileSync(path.join(root, '.webdav-enhanced', 'config-stub', 'settings.yaml'), 'utf8')
    expect(stub.trim()).toBe('theme: dark')
    expect(entries.some((e) => e.kind === 'config')).toBe(true)
  })

  it('mode=none → 不同步 config', async () => {
    const entries = await scanLocal(env, scopeOf({ configs: { mode: 'none', includeKeys: [] } }))
    expect(entries.some((e) => e.kind === 'config')).toBe(false)
  })

  it('writeConfigStub=false 时不落盘，但 hash 与落盘时一致', async () => {
    const scope = scopeOf({ configs: { mode: 'all', includeKeys: [] } })
    const withStub = await scanLocal(env, scope, [], { cache: null })
    const stubPath = path.join(root, '.webdav-enhanced', 'config-stub', 'settings.yaml')
    expect(existsSync(stubPath)).toBe(true)
    rmSync(path.join(root, '.webdav-enhanced', 'config-stub'), { recursive: true, force: true })
    const dry = await scanLocal(env, scope, [], { cache: null, writeConfigStub: false })
    expect(existsSync(stubPath)).toBe(false)
    expect(dry.find((e) => e.kind === 'config')!.hash).toBe(withStub.find((e) => e.kind === 'config')!.hash)
  })

  it('splitConfigBlocks 保留顶层块内容', () => {
    const blocks = splitConfigBlocks(settings)
    expect(blocks.map((b) => b.key)).toEqual([
      'llm-deepseek', 'theme', 'apiKeyEnv', 'credentials', 'token', 'secret', 'password', 'providers',
    ])
    expect(blocks[0].lines.join('\n')).toContain('model: deepseek-chat')
  })
})
