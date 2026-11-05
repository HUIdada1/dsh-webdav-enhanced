import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyGeneration, resolveEnv } from '../src/core/env.js'

let root: string
const savedDshHome = process.env.DSH_HOME
const savedAppData = process.env.APPDATA

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-env-'))
  // 隔离真实用户目录，保证测试只看临时世界
  process.env.DSH_HOME = ''
  process.env.APPDATA = path.join(root, 'no-appdata')
  mkdirSync(process.env.APPDATA, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  process.env.DSH_HOME = savedDshHome ?? ''
  process.env.APPDATA = savedAppData ?? ''
})

function makeCordisHome(): string {
  const d = path.join(root, 'cordis-home')
  mkdirSync(path.join(d, 'profiles', 'web'), { recursive: true })
  writeFileSync(path.join(d, 'settings.yaml'), 'llm-deepseek: {}\n')
  writeFileSync(path.join(d, '.credentials.yaml'), 'PROXY_USER_KEY: x\n')
  mkdirSync(path.join(d, 'skills', 'my-skill'), { recursive: true })
  writeFileSync(path.join(d, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n')
  return d
}

function makeLegacyHome(): string {
  const d = path.join(root, 'legacy-home')
  mkdirSync(path.join(d, 'plugins', 'p1'), { recursive: true })
  writeFileSync(path.join(d, 'plugins', 'p1', 'manifest.json'), '{"name":"p1"}')
  return d
}

describe('classifyGeneration', () => {
  it('identifies cordis via settings.yaml', () => {
    expect(classifyGeneration(makeCordisHome())).toBe('cordis')
  })
  it('identifies legacy via plugins/*/manifest.json', () => {
    expect(classifyGeneration(makeLegacyHome())).toBe('legacy')
  })
  it('returns unknown for empty dir', () => {
    const d = path.join(root, 'empty')
    mkdirSync(d, { recursive: true })
    expect(classifyGeneration(d)).toBe('unknown')
  })
})

describe('resolveEnv', () => {
  it('respects overrideDir as top priority', async () => {
    const cordis = makeCordisHome()
    const env = await resolveEnv({ overrideDir: cordis })
    expect(env.dshHome).toBe(cordis)
    expect(env.generation).toBe('cordis')
    expect(env.profileDir).toBe(path.join(cordis, 'profiles', 'web')) // 存在则取 profile 目录
    expect(env.settingsFile).toBe(path.join(cordis, 'settings.yaml'))
    expect(env.credentialsFile).toBe(path.join(cordis, '.credentials.yaml'))
    expect(env.skillsDir).toBe(path.join(cordis, 'skills'))
  })

  it('falls back profileDir to dshHome when profiles/<profile> missing', async () => {
    const cordis = makeCordisHome()
    const env = await resolveEnv({ overrideDir: cordis, profile: 'not-exist' })
    expect(env.profileDir).toBe(cordis)
  })

  it('does not pick a non-existent overrideDir', async () => {
    const missing = path.join(root, 'nowhere')
    const env = await resolveEnv({ overrideDir: missing })
    // 不应把不存在的目录当成主目录（即便真实 HOME 下存在 dsh 目录）
    expect(env.dshHome).not.toBe(missing)
  })
})
