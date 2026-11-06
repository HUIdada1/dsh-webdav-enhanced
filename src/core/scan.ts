/*
 * M1+ 本地扫描：把 ResolvedEnv 转成 LocalEntry 列表。
 * - skills：扫描 skillsDir 下的每个含 SKILL.md 的目录。
 * - bundles（cordis 代）：解析 profileDir/package.json 依赖（dsh.bundle 标记或现有插件），
 *   并把每个 bundle 的本地路径作为 sourceDir（若存在），否则只记录 spec。
 * - config：settings.yaml 顶层 key 分组（由 includeKeys 决定）。
 * 容错：单个条目扫描失败不阻塞整体，记录到 errors 返回。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { LocalEntry, MachineInfo, ResolvedEnv, SyncScope } from '../types.js'

export interface ScanResult {
  entries: LocalEntry[]
  errors: { stage: string; message: string }[]
}

function isSkillDir(dir: string): boolean {
  return existsSync(path.join(dir, 'SKILL.md'))
}

function dirMtime(dir: string): string {
  try {
    return statSync(dir).mtime.toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

function safeReadJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function guessSkillVersion(dir: string): string | null {
  // 读 SKILL.md frontmatter 里的 version 字段（尽力而为）
  const skillMd = path.join(dir, 'SKILL.md')
  try {
    const head = readFileSync(skillMd, 'utf8').slice(0, 4096)
    const m = head.match(/^---\n[\s\S]*?version:\s*([^\n]+)\n[\s\S]*?---/m)
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
  } catch {
    return null
  }
}

interface PkgJson {
  name?: string
  version?: string
  dsh?: { bundle?: boolean }
  dependencies?: Record<string, string>
}

/** 解析 profile 已装的 bundle 列表 + 本地路径 */
function scanBundles(env: ResolvedEnv, scope: SyncScope['bundles'], errors: ScanResult['errors']): LocalEntry[] {
  const out: LocalEntry[] = []
  if (scope.mode === 'none') return out
  const profilePkg = path.join(env.profileDir, 'package.json')
  const pkg = safeReadJson<PkgJson>(profilePkg)
  if (!pkg?.dependencies) return out
  const exclude = new Set(scope.exclude)
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    if (exclude.has(name)) continue
    // link: 形式 → 本地路径；npm/git spec → node_modules 下
    let sourceDir: string | null = null
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      sourceDir = path.resolve(env.profileDir, spec.replace(/^(link|file):/, ''))
    } else {
      const nm = path.join(env.profileDir, 'node_modules', name.replace(/^@/, '@'))
      if (existsSync(nm)) sourceDir = nm
    }
    if (!sourceDir || !existsSync(sourceDir)) {
      errors.push({ stage: 'scan-bundle', message: `bundle ${name} spec ${spec} cannot be resolved locally` })
      continue
    }
    const bundlesPkgJson = safeReadJson<PkgJson>(path.join(sourceDir, 'package.json'))
    out.push({
      kind: 'bundle',
      name,
      version: bundlesPkgJson?.version ?? null,
      sourceDir,
      hash: '',
      sizeBytes: 0,
      modifiedAt: dirMtime(sourceDir),
    })
  }
  return out
}

function scanSkills(env: ResolvedEnv, scope: SyncScope['skills'], errors: ScanResult['errors']): LocalEntry[] {
  const out: LocalEntry[] = []
  if (scope.mode === 'none' || !existsSync(env.skillsDir)) return out
  const exclude = new Set(scope.exclude)
  for (const name of safeReaddir(env.skillsDir)) {
    if (exclude.has(name)) continue
    if (name.startsWith('.')) continue
    const dir = path.join(env.skillsDir, name)
    if (!existsSync(dir)) continue
    if (!isSkillDir(dir)) {
      errors.push({ stage: 'scan-skill', message: `skill dir ${name} missing SKILL.md, skipped` })
      continue
    }
    out.push({
      kind: 'skill',
      name,
      version: guessSkillVersion(dir),
      sourceDir: dir,
      hash: '',
      sizeBytes: 0,
      modifiedAt: dirMtime(dir),
    })
  }
  return out
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

function scanConfigs(env: ResolvedEnv, scope: SyncScope['configs']): LocalEntry[] {
  if (scope.mode === 'none' || !env.settingsFile) return []
  // 顶层 key 粒度：把 settings.yaml 按顶层 key 拆分，只保留 includeKeys 勾选的
  const raw = readFileSync(env.settingsFile, 'utf8')
  const keys = scope.includeKeys
  if (keys.length === 0) return []
  const lines = raw.split('\n')
  const inKey = new RegExp(`^(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):`)
  const topKey = /^([\w-]+):/
  let kept: string[] = []
  let cur: string[] = []
  let keeping = false
  for (const line of lines) {
    const m = line.match(topKey)
    if (m && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (cur.length && keeping) kept = kept.concat(cur)
      cur = [line]
      keeping = inKey.test(line)
    } else {
      cur.push(line)
    }
  }
  if (cur.length && keeping) kept = kept.concat(cur)
  if (kept.length === 0) return []
  const stubFile = path.join(env.dshHome, '.webdav-enhanced', 'config-stub', 'settings.yaml')
  const dir = path.dirname(stubFile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(stubFile, kept.join('\n'), 'utf8')
  return [
    {
      kind: 'config',
      name: 'settings',
      version: null,
      sourceDir: dir,
      hash: '',
      sizeBytes: 0,
      modifiedAt: dirMtime(env.settingsFile),
    },
  ]
}

const MACHINE_CACHE = new Map<string, MachineInfo>()

export function machineInfo(env: ResolvedEnv, machineId: string): MachineInfo {
  const key = `${machineId}:${env.platform}`
  if (MACHINE_CACHE.has(key)) return MACHINE_CACHE.get(key)!
  const info: MachineInfo = { machineId, platform: env.platform, dshVersion: env.dshVersion }
  MACHINE_CACHE.set(key, info)
  return info
}

export function scanLocal(env: ResolvedEnv, scope: SyncScope, errors: ScanResult['errors']): LocalEntry[] {
  const out: LocalEntry[] = []
  out.push(...scanSkills(env, scope.skills, errors))
  out.push(...scanBundles(env, scope.bundles, errors))
  out.push(...scanConfigs(env, scope.configs))
  return out
}
