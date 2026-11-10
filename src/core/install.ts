/*
 * M8 落盘与自动安装（v2）。
 * - skill：解压到 $DSH_HOME/skills/<slug>/（含路径穿越防护、备份轮转）。
 * - bundle：解压到暂存目录 → 调用 dsh plugin add → 更新 profile；成功返回 needs-restart。
 * - config：**按顶层 key 合并** settings.yaml（D6 修复），写前备份、备份按 maxBackups 轮转。
 * 所有操作幂等：重复执行不产生副作用。
 */
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createPackager } from './pack.js'
import type {
  ApplyResult,
  Installer,
  PackMeta,
  PackedEntry,
  ResolvedEnv,
  SyncOptions,
} from '../types.js'
import { DEFAULT_SAFETY_GUARD } from '../types.js'

export interface InstallerOptions {
  /** 每类条目保留的本地备份份数（默认 10） */
  maxBackups?: number
  /** config 是否按顶层 key 合并（默认 true；false 时整文件覆盖，仍然先备份） */
  contentMerge?: boolean
}

// ---------- settings.yaml 顶层 key 合并（纯函数，可单测） ----------

const TOP_KEY = /^([A-Za-z_][\w.-]*)\s*:/

interface RawBlock {
  key: string
  lines: string[]
}

/** 把文本拆成 [头部行, blocks]（头部 = 第一个顶层 key 之前的注释/空行） */
function splitWithHeader(raw: string): { header: string[]; blocks: RawBlock[] } {
  const lines = raw.split(/\r?\n/)
  const header: string[] = []
  const blocks: RawBlock[] = []
  let cur: RawBlock | null = null
  for (const line of lines) {
    const m = line.match(TOP_KEY)
    if (m && !/^\s/.test(line)) {
      if (cur) blocks.push(cur)
      cur = { key: m[1], lines: [line] }
    } else if (cur) {
      cur.lines.push(line)
    } else {
      header.push(line)
    }
  }
  if (cur) blocks.push(cur)
  return { header, blocks }
}

/**
 * 顶层 key 合并：远端有的 key 覆盖同名本地 key，远端没有的本地 key 原样保留；
 * 本地没有而远端有的 key 追加到末尾。顺序稳定（本地顺序优先）。
 * 这是 D6 的核心：绝不整文件覆盖，避免丢掉本机其它顶层配置。
 */
export function mergeTopLevelConfig(localRaw: string, remoteRaw: string): string {
  const local = splitWithHeader(localRaw)
  const remote = splitWithHeader(remoteRaw)
  // 远端没有可合并的顶层 key（空文件/只有注释）：本地原样返回，避免无意义的格式漂移
  if (local.blocks.length === 0 && remote.blocks.length === 0) return localRaw
  if (remote.blocks.length === 0) return localRaw
  const pending = new Map(remote.blocks.map((b) => [b.key, b]))
  const out: string[] = [...local.header]
  const pushBlock = (lines: string[]): void => {
    const trimmed = [...lines]
    // 块内尾部的空行只是分隔符，统一由 pushBlock 重新补一个空行
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop()
    out.push(...trimmed, '')
  }
  for (const block of local.blocks) {
    const replace = pending.get(block.key)
    if (replace) {
      pushBlock(replace.lines)
      pending.delete(block.key)
    } else {
      pushBlock(block.lines)
    }
  }
  for (const block of remote.blocks) {
    if (!pending.has(block.key)) continue
    pushBlock(block.lines)
    pending.delete(block.key)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n') + '\n'
}

/**
 * 删除超过 keep 份的最旧备份（按 mtime 从新到旧排序，保留前 keep 个）。
 * @param prefix 只处理这些名字的备份（防止误删同目录其它文件）
 */
export function pruneBackupDir(dir: string, keep: number, prefix = ''): string[] {
  const removed: string[] = []
  try {
    const items = readdirSync(dir)
      .filter((name) => !prefix || name.startsWith(prefix))
      .map((name) => {
        const full = path.join(dir, name)
        let mtime = 0
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          /* 忽略 */
        }
        return { name, full, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const item of items.slice(Math.max(0, keep))) {
      try {
        const st = statSync(item.full)
        if (st.isDirectory()) rmSync(item.full, { recursive: true, force: true })
        else unlinkSync(item.full)
        removed.push(item.name)
      } catch {
        /* 尽力而为 */
      }
    }
  } catch {
    /* 目录不存在等 */
  }
  return removed
}

class InstallerImpl implements Installer {
  private readonly packager = createPackager()
  private readonly maxBackups: number
  private readonly contentMerge: boolean

  constructor(
    private readonly env: ResolvedEnv,
    options: InstallerOptions = {},
  ) {
    const raw = Number(options.maxBackups)
    this.maxBackups = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 10
    this.contentMerge = options.contentMerge !== false
  }

  private dataDir(): string {
    return path.join(this.env.dshHome || '.', '.webdav-enhanced')
  }

  /** 备份目录根：backups/<kind>s */
  private backupRoot(kind: 'bundle' | 'skill'): string {
    return path.join(this.dataDir(), 'backups', `${kind}s`)
  }

  async applyBundle(packed: PackedEntry, meta: PackMeta): Promise<ApplyResult> {
    if (this.env.generation !== 'cordis') {
      return {
        status: 'manual-needed',
        message: 'legacy/unknown 代宿主不支持自动安装 bundle',
        manualCommand: `手动解压 ${packed.zipPath} 到 ${this.env.dshHome}/plugins/`,
      }
    }
    const staging = path.join(this.dataDir(), 'bundle-staging', meta.name)
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await mkdir(staging, { recursive: true })
    await this.packager.unpack(packed.zipPath, staging, DEFAULT_SAFETY_GUARD)

    // 检查是否已安装同 hash（幂等）
    const installedMark = path.join(this.dataDir(), 'installed-bundles', `${meta.name}.json`)
    if (existsSync(installedMark)) {
      try {
        const prev = JSON.parse(readFileSync(installedMark, 'utf8')) as { hash?: string }
        if (prev.hash === packed.sha256) {
          return { status: 'skipped', message: `${meta.name} 已是最新` }
        }
      } catch {
        /* 继续安装 */
      }
    }

    // 调用 dsh plugin add（复用 skillhub 思路）
    const addCmd = `dsh plugin --profile ${this.env.profile} add "${staging}"`
    const ok = await this.runDshPluginAdd(staging)
    if (!ok) {
      return {
        status: 'manual-needed',
        message: `dsh plugin add 失败：${meta.name}`,
        manualCommand: addCmd,
      }
    }

    // 记录已安装 hash
    mkdirSync(path.dirname(installedMark), { recursive: true })
    writeFileSync(installedMark, JSON.stringify({ hash: packed.sha256, installedAt: new Date().toISOString() }), 'utf8')
    return { status: 'needs-restart', message: `${meta.name} 已安装，重启 dsh 后生效` }
  }

  private async runDshPluginAdd(dir: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        'dsh',
        ['plugin', '--profile', this.env.profile, 'add', dir],
        { timeout: 120_000, shell: process.platform === 'win32' },
        (err, _stdout, stderr) => {
          if (err) {
            console.warn('[webdav-enhanced] dsh plugin add failed:', stderr ?? err.message)
            resolve(false)
            return
          }
          resolve(true)
        },
      )
    })
  }

  async applySkill(packed: PackedEntry, meta: PackMeta): Promise<ApplyResult> {
    const dest = path.join(this.env.skillsDir, meta.name)
    // 幂等：同 hash 跳过
    const markDir = path.join(this.dataDir(), 'installed-skills')
    const mark = path.join(markDir, `${meta.name}.json`)
    if (existsSync(mark)) {
      try {
        const prev = JSON.parse(readFileSync(mark, 'utf8')) as { hash?: string }
        if (prev.hash === packed.sha256) {
          return { status: 'skipped', message: `skill ${meta.name} 已是最新` }
        }
      } catch {
        /* 继续安装 */
      }
    }
    // 备份旧版本（冲突回滚需要）；v2 按 maxBackups 轮转，避免无限膨胀
    if (existsSync(dest)) {
      const bakRoot = this.backupRoot('skill')
      await mkdir(bakRoot, { recursive: true })
      const bak = path.join(bakRoot, `${meta.name}-${Date.now()}`)
      await rename(dest, bak).catch(() => undefined)
      pruneBackupDir(bakRoot, this.maxBackups)
    }
    await mkdir(dest, { recursive: true })
    await this.packager.unpack(packed.zipPath, dest, DEFAULT_SAFETY_GUARD)
    // 要求含 SKILL.md（skillhub 同款校验）
    if (!existsSync(path.join(dest, 'SKILL.md'))) {
      return { status: 'failed', message: `skill ${meta.name} 解压后缺少 SKILL.md` }
    }
    mkdirSync(markDir, { recursive: true })
    writeFileSync(mark, JSON.stringify({ hash: packed.sha256, installedAt: new Date().toISOString() }), 'utf8')
    return { status: 'applied', message: `skill ${meta.name} 已安装` }
  }

  async applyConfig(packed: PackedEntry, meta: PackMeta): Promise<ApplyResult> {
    // 解压到暂存，读 settings.yaml，按顶层 key 合并
    const staging = path.join(this.dataDir(), 'config-staging', meta.name)
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await mkdir(staging, { recursive: true })
    await this.packager.unpack(packed.zipPath, staging, DEFAULT_SAFETY_GUARD)

    const src = path.join(staging, 'settings.yaml')
    if (!existsSync(src)) {
      return { status: 'failed', message: `config pack ${meta.name} 缺少 settings.yaml` }
    }
    if (!this.env.settingsFile || !existsSync(this.env.settingsFile)) {
      return { status: 'manual-needed', message: '本机没有 settings.yaml', manualCommand: `手动合并 ${src}` }
    }

    const local = readFileSync(this.env.settingsFile, 'utf8')
    const remote = readFileSync(src, 'utf8')
    if (local === remote) {
      return { status: 'skipped', message: 'settings.yaml 内容一致' }
    }

    // 写前备份（D6：绝不整文件覆盖丢 key）
    const bak = await this.backupSettings()
    const next = this.contentMerge ? mergeTopLevelConfig(local, remote) : remote
    if (next === local) {
      return { status: 'skipped', message: 'settings.yaml 合并后无变化' }
    }
    // 原子写：临时文件 + rename
    const tmp = `${this.env.settingsFile}.tmp-${Date.now()}`
    await writeFile(tmp, next, 'utf8')
    await rename(tmp, this.env.settingsFile)
    return {
      status: 'needs-restart',
      message: this.contentMerge ? `settings.yaml 已按顶层 key 合并（备份：${bak}）` : `settings.yaml 已覆盖（备份：${bak}）`,
    }
  }

  private async backupSettings(): Promise<string> {
    const file = this.env.settingsFile!
    const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await copyFile(file, bak)
    pruneBackupDir(path.dirname(file), this.maxBackups, path.basename(file) + '.bak-')
    return bak
  }
}

export function createInstaller(env: ResolvedEnv, options: InstallerOptions = {}): Installer {
  return new InstallerImpl(env, options)
}

/** installer 直接由 SyncOptions 构造（sync 引擎用） */
export function createInstallerFromOptions(env: ResolvedEnv, options: Partial<SyncOptions>): Installer {
  return createInstaller(env, { maxBackups: options.maxBackups, contentMerge: options.contentMerge })
}
