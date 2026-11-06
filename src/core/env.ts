/*
 * M1 环境探测与路径归一化。
 * dsh 的宿主数据目录在不同版本 / 不同安装方式 / 不同平台下并不统一。
 * 探测顺序：手动指定 > 环境变量 DSH_HOME > 按平台枚举候选目录。
 * 任何单点失败不抛出，汇总进 extras / 返回 unknown 代际，由上层决定降级。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { HostGeneration, Platform, ResolvedEnv } from '../types.js'

const SETTINGS = 'settings.yaml'
const CREDENTIALS = '.credentials.yaml'

/** 本包名：用于反查「自己被装在哪个 profile 里」 */
export const PACKAGE_NAME = 'dsh-webdav-enhanced'

const nodeRequire = createRequire(import.meta.url)

/**
 * 按平台枚举候选 dsh 数据目录（来自真实环境核查）。
 * 顺序无意义，后续按“含 settings.yaml 优先 > 修改时间新优先”排序。
 */
export function candidateDirs(platform: Platform = process.platform): string[] {
  const home = homedir()
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  const dirs: string[] = [
    // Cordis 代 CLI 默认值
    path.join(home, '.dsh'),
    // Windows 桌面端两种落点
    path.join(appData, 'DeepSeek Harness'),
    path.join(home, '.deepseek-harness'),
  ]
  if (platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'DeepSeek Harness'))
  }
  if (platform === 'linux') {
    dirs.push(path.join(home, '.config', 'deepseek-harness'))
  }
  return [...new Set(dirs)]
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

function safeStat(p: string) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

function isDir(p: string): boolean {
  const s = safeStat(p)
  return !!s?.isDirectory()
}

/** 判定宿主代际：cordis（当前主线） / legacy（0.1.x manifest 制式） / unknown */
export function classifyGeneration(dir: string): HostGeneration {
  if (existsSync(path.join(dir, SETTINGS)) || existsSync(path.join(dir, 'settings.yml'))) return 'cordis'
  if (existsSync(path.join(dir, 'profiles'))) return 'cordis'
  const pluginsDir = path.join(dir, 'plugins')
  for (const child of safeReaddir(pluginsDir)) {
    if (existsSync(path.join(pluginsDir, child, 'manifest.json'))) return 'legacy'
  }
  // 有 skills/ 但无 plugins 清单，也基本可按 cordis 对待（技能制式一致）
  if (isDir(path.join(dir, 'skills'))) return 'cordis'
  return 'unknown'
}

export interface EnvProbeOptions {
  /** 用户在设置页手动指定的目录（最高优先级） */
  overrideDir?: string | null
  /** profile 名；留空表示自动探测 */
  profile?: string
  /** 本包根目录，用于精确判定 profile；省略时退化为「第一个装了本包的 profile」 */
  selfRoot?: string | null
}

/**
 * 反查当前插件被安装在哪个 profile 下。
 * dsh 桌面版与 Web 版、多 profile 并存时，写死 'desktop' 会指错目录；
 * 这里按「哪个 profile 的 node_modules 里链接着本包」判定，最稳。
 * @param dshHome dsh 数据主目录
 * @param selfRoot 本包根目录（默认由调用方传入 import.meta 推出的路径）
 */
export function detectActiveProfile(dshHome: string, selfRoot?: string | null): string | null {
  const profilesDir = path.join(dshHome, 'profiles')
  const names = safeReaddir(profilesDir).filter((name) => isDir(path.join(profilesDir, name)))
  if (!names.length) return null

  const real = (target: string): string => {
    try {
      return realpathSync(target)
    } catch {
      return target
    }
  }
  const wanted = selfRoot ? real(selfRoot) : null
  let fallback: string | null = null

  for (const name of names) {
    const link = path.join(profilesDir, name, 'node_modules', PACKAGE_NAME)
    if (!existsSync(link)) continue
    if (wanted && real(link) === wanted) return name
    if (!fallback) fallback = name
  }
  // 没找到链接（例如源码里直接跑）时，只有一个 profile 就认定它
  if (fallback) return fallback
  if (names.length === 1) return names[0]
  return null
}

function buildEmpty(profile: string): ResolvedEnv {
  return {
    dshHome: '',
    profileDir: '',
    skillsDir: '',
    settingsFile: null,
    credentialsFile: null,
    profile,
    dshVersion: null,
    nodeVersion: process.version,
    platform: process.platform,
    generation: 'unknown',
    extras: [],
  }
}

/**
 * 探测并归一化 dsh 环境。
 */
export async function resolveEnv(opts: EnvProbeOptions = {}): Promise<ResolvedEnv> {
  const platform = process.platform
  const candidates: string[] = []

  if (opts.overrideDir) candidates.push(opts.overrideDir)
  const dshHome = process.env.DSH_HOME?.trim()
  if (dshHome) candidates.push(dshHome)
  candidates.push(...candidateDirs(platform))

  const existing = [...new Set(candidates)].filter(isDir)
  const scored = existing
    .map((dir) => ({
      dir,
      // cordis 代（含 profiles/）优先于只有 settings 的旁路目录，其次看修改时间
      rank: existsSync(path.join(dir, 'profiles')) ? 2 : existsSync(path.join(dir, SETTINGS)) || existsSync(path.join(dir, 'settings.yml')) ? 1 : 0,
      mtime: safeStat(dir)?.mtimeMs ?? 0,
    }))
    .sort((a, b) => b.rank - a.rank || b.mtime - a.mtime)

  const primary = scored[0]?.dir ?? ''
  const profile = (opts.profile && opts.profile.trim()) || detectActiveProfile(primary, opts.selfRoot) || 'desktop'
  if (!primary) return buildEmpty(profile)

  const generation = classifyGeneration(primary)
  const settingsFile =
    [SETTINGS, 'settings.yml'].map((f) => path.join(primary, f)).find((f) => existsSync(f)) ?? null
  const credentialsFile = existsSync(path.join(primary, CREDENTIALS))
    ? path.join(primary, CREDENTIALS)
    : null

  // cordis 代：profile 目录优先 <dshHome>/profiles/<profile>，不存在则退回 dshHome
  const profileCandidate = path.join(primary, 'profiles', profile)
  const profileDir = generation === 'cordis' && isDir(profileCandidate) ? profileCandidate : primary
  const skillsDir = path.join(primary, 'skills')

  return {
    dshHome: primary,
    profileDir,
    skillsDir,
    settingsFile,
    credentialsFile,
    profile,
    dshVersion: detectDshVersion(),
    nodeVersion: process.version,
    platform,
    generation,
    extras: scored.slice(1).map((x) => x.dir),
  }
}

/** 尽力探测 dsh 版本；任何失败返回 null */
export function detectDshVersion(): string | null {
  // 1) 同进程可解析到的包（本地开发 / link 安装）
  try {
    const pkgPath = nodeRequire.resolve('@deepseek-ai/dsh/package.json')
    const pkg = nodeRequire(pkgPath) as { version?: string }
    if (pkg.version) return pkg.version
  } catch {
    /* 继续兜底 */
  }
  // 2) 全局可执行文件
  try {
    const out = execFileSync('dsh', ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      shell: process.platform === 'win32',
    })
      .toString()
      .trim()
    const m = out.match(/(\d+\.\d+\.\d+(?:[-.\w]*)?)/)
    return m?.[1] ?? null
  } catch {
    return null
  }
}
