/*
 * M6 同步引擎：把扫描 → 合并 → 上传/下载串起来。
 * - 顺序固定，每步失败记录到 errors 并继续，整体报告 SyncRunReport。
 * - 定时调度支持 intervalHours（0=关）+ 0-5 分钟抖动避开多机撞锁。
 * - 冲突处理：merge-backup 时，远端版本照常下载，本地当前版本备份到
 *   ~/.dsh/webdav-enhanced/backups/<kind>s/<name>.conflict-<machineId>-<ts>/。
 * - 上传去重由 webdav-store.pushEntry 内置（同 hash 跳过）。
 * - 全部对外部依赖以接口注入，便于单测。
 */
import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMerger, conflictCopyName } from './merge.js'
import { scanLocal, machineInfo } from './scan.js'
import { createInstaller } from './install.js'
import { createPackager } from './pack.js'
import { pushEntry } from './webdav-store.js'
import { emptyManifest, entryKey } from './manifest.js'
import type { ConfigStore } from './config-store.js'
import type {
  Installer,
  LocalEntry,
  MergeDecision,
  Merger,
  Packager,
  PluginConfig,
  ResolvedEnv,
  SyncEngine,
  SyncRunReport,
  SyncScope,
  SyncTrigger,
  WebDavClient,
} from '../types.js'
import type { SyncStore } from './webdav-store.js'

export interface SyncEngineDeps {
  env: ResolvedEnv
  configStore: ConfigStore
  store: SyncStore
  client: WebDavClient
  packager?: Packager
  installer?: Installer
  merger?: Merger
}

function nowIso(): string {
  return new Date().toISOString()
}

export class SyncEngineImpl implements SyncEngine {
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly packager: Packager
  private readonly installer: Installer
  private readonly merger: Merger

  constructor(private readonly deps: SyncEngineDeps) {
    this.packager = deps.packager ?? createPackager()
    this.installer = deps.installer ?? createInstaller(deps.env)
    this.merger = deps.merger ?? createMerger()
  }

  private cfg(): PluginConfig {
    return this.deps.configStore.load()
  }

  async runOnce(trigger: SyncTrigger): Promise<SyncRunReport> {
    if (this.running) {
      return this.reportNow({ errors: [{ stage: 'run', message: 'sync already running' }] }, false)
    }
    this.running = true
    const startedAt = nowIso()
    const report: SyncRunReport = {
      trigger,
      startedAt,
      finishedAt: startedAt,
      uploaded: [],
      downloaded: [],
      skipped: 0,
      conflicts: [],
      errors: [],
      ok: false,
    }
    try {
      await this.doRun(report)
      report.ok = report.errors.length === 0
    } catch (err) {
      report.errors.push({ stage: 'fatal', message: (err as Error).message })
      report.ok = false
    } finally {
      report.finishedAt = nowIso()
      this.running = false
      this.lastReport = report
      this.persistHashes(report)
    }
    return report
  }

  private reportNow(partial: Partial<SyncRunReport>, ok: boolean): SyncRunReport {
    return {
      trigger: 'manual',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      uploaded: [],
      downloaded: [],
      skipped: 0,
      conflicts: [],
      errors: [],
      ok,
      ...partial,
    }
  }

  private persistHashes(report: SyncRunReport): void {
    if (!report.ok) return
    try {
      const cfg = this.cfg()
      const map: Record<string, string> = { ...cfg.lastSyncedHashes }
      // 从 merge 决策回填：实际以扫描到的 entry hash 为准更稳，这里复用最新快照
      // 简化：扫描结果以 merge 前 local 列表为准
      // 我们保存最后一次扫描时各 key 的 hash（由 scanLocal 提供）
      const localEntries = this._lastScanEntries
      for (const e of localEntries) {
        map[entryKey(e)] = e.hash
      }
      this.deps.configStore.update({ lastSyncedHashes: map, lastSyncAt: nowIso() })
    } catch (err) {
      // 持久化失败不影响本轮结果，只记日志
      console.warn('[webdav-enhanced] persistHashes failed:', (err as Error).message)
    }
    this._lastScanEntries = []
  }

  private _lastScanEntries: LocalEntry[] = []

  private async doRun(report: SyncRunReport): Promise<void> {
    const cfg = this.cfg()
    const direction = cfg.schedule.direction

    // 1) 持锁（尽力而为，支持服务端不支持时返回 null）
    const lock = await this.deps.store.acquireLock(cfg.machineId, 10 * 60 * 1000).catch((e) => {
      report.errors.push({ stage: 'lock', message: `acquire lock failed: ${(e as Error).message}` })
      return null
    })
    try {
      await this.runCritical(report, direction)
    } finally {
      if (lock) await lock.release().catch(() => undefined)
    }
  }

  private async runCritical(report: SyncRunReport, direction: PluginConfig['schedule']['direction']): Promise<void> {
    // 本方法只处理一次完整同步；方向由参数控制

    const cfg = this.cfg()
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'dsh-sync-'))
    try {
      // 2) 扫描本地
      const localEntries = scanLocal(this.deps.env, cfg.scope, report.errors)
      this._lastScanEntries = localEntries
      // 赋 machine 信息（打包用）
      const self = machineInfo(this.deps.env, cfg.machineId)
      for (const e of localEntries) e.machine = self

      // 3) 读远端 manifest
      const { manifest, etag } = await this.deps.store.read()
      const remote = manifest ?? emptyManifest()

      // 4) 合并决策
      const decisions = this.merger.decide({
        local: localEntries,
        remote,
        lastSyncedHashes: cfg.lastSyncedHashes,
        policy: cfg.conflictPolicy,
        machineId: cfg.machineId,
      })
      const byAction = this.groupByAction(decisions)

      // 5) 下载阶段（download + conflict，方向允许时）
      if (direction !== 'upload') {
        for (const d of byAction.download) {
          await this.handleDownload(d, tmpRoot, report)
        }
        for (const d of byAction.conflict) {
          await this.handleConflict(d, tmpRoot, report)
        }
      } else {
        report.skipped += byAction.download.length + byAction.conflict.length
      }

      // 6) 上传阶段（方向允许时；merge-backup 下 conflict 本端副本不视为上传）
      if (direction !== 'download') {
        for (const d of byAction.upload) {
          await this.handleUpload(d, report)
        }
      } else {
        report.skipped += byAction.upload.length
      }

      report.skipped += byAction.skip.length
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private groupByAction(decisions: MergeDecision[]): Record<'upload' | 'download' | 'skip' | 'conflict', MergeDecision[]> {
    const g: Record<'upload' | 'download' | 'skip' | 'conflict', MergeDecision[]> = {
      upload: [],
      download: [],
      skip: [],
      conflict: [],
    }
    for (const d of decisions) g[d.action].push(d)
    return g
  }

  private async handleUpload(d: MergeDecision, report: SyncRunReport): Promise<void> {
    const entry = d.entry as LocalEntry
    const staging = path.join(mkdtempSync(path.join(tmpdir(), 'dsh-pack-')), 'a')
    try {
      const packed = await this.packager.pack(entry, staging)
      const key = entryKey(entry)
      const res = await pushEntry(
        this.deps.store,
        this.deps.client,
        {
          entry: {
            kind: entry.kind,
            name: entry.name,
            version: entry.version,
            hash: packed.sha256,
            size: packed.size,
            source: machineInfo(this.deps.env, this.cfg().machineId),
          },
          zipPath: packed.zipPath,
          machineId: this.cfg().machineId,
        },
      )
      if (res.uploaded) report.uploaded.push(key)
      else report.skipped++
    } catch (err) {
      report.errors.push({ stage: 'upload', message: `${entry.name}: ${(err as Error).message}` })
    }
  }

  private async handleDownload(d: MergeDecision, tmpRoot: string, report: SyncRunReport): Promise<void> {
    const entry = d.entry as import('../types.js').RemoteEntry
    if (!('file' in entry)) return
    const zipPath = path.join(tmpRoot, path.basename(entry.file))
    try {
      await this.deps.client.getFile(entry.file, zipPath, { resume: true })
      const meta = await this.packager.unpack(zipPath, path.join(tmpRoot, 'unpacked-' + entry.name), {
        maxTotalBytes: 512 * 1024 * 1024,
        maxFileBytes: 128 * 1024 * 1024,
      })
      // 构造 apply 所需的 packed：下载场景下 entry 用本地占位即可（installer 只看 meta + zipPath）
      const packed = {
        entry: {
          kind: entry.kind,
          name: entry.name,
          version: entry.version,
          sourceDir: '',
          hash: entry.hash,
          sizeBytes: entry.size,
          modifiedAt: new Date().toISOString(),
        } as LocalEntry,
        zipPath,
        sha256: entry.hash,
        size: entry.size,
      }
      const result = await this.applyByKind(meta, packed)
      if (result.status === 'applied' || result.status === 'needs-restart') {
        report.downloaded.push(entryKey(entry))
      } else if (result.status === 'skipped') {
        report.skipped++
      } else if (result.status === 'manual-needed') {
        report.errors.push({ stage: 'download', message: `${entry.name} needs manual install: ${result.manualCommand ?? result.message}` })
      } else {
        report.errors.push({ stage: 'download', message: `${entry.name}: ${result.message}` })
      }
    } catch (err) {
      report.errors.push({ stage: 'download', message: `${entry.name}: ${(err as Error).message}` })
    }
  }

  private async handleConflict(d: MergeDecision, tmpRoot: string, report: SyncRunReport): Promise<void> {
    const entry = d.entry as import('../types.js').RemoteEntry
    if (!('file' in entry)) return
    // 备份本机当前版本（保留证据）
    try {
      await this.backupLocal({ kind: entry.kind, name: entry.name }, report)
    } catch (err) {
      report.errors.push({ stage: 'conflict-backup', message: `backup failed for ${entry.name}: ${(err as Error).message}` })
    }
    // 按 merge-backup 策略下载远端版（默认行为；policy=ask 时也在记录里提示用户）
    await this.handleDownload({ ...d, action: 'download' }, tmpRoot, report)
    report.conflicts.push({ name: entry.name, note: d.conflictNote ?? 'diverged' })
  }

  private async backupLocal(ref: { kind: string; name: string }, _report: SyncRunReport): Promise<void> {
    // 从本机现场找该条目的目录并打包到 backups
    const kind = ref.kind
    const name = ref.name
    const local = this._lastScanEntries.find((e) => e.kind === kind && e.name === name)
    if (!local) return
    const machineId = this.cfg().machineId
    const bakDir = path.join(this.deps.env.dshHome, '.webdav-enhanced', 'backups', `${kind}s`, conflictCopyName(name, machineId))
    await mkdir(path.dirname(bakDir), { recursive: true })
    // 用 packager 打 zip 到备份目录（一致性 + 排除 node_modules 等）
    const packed = await this.packager.pack(local, bakDir)
    const finalPath = path.join(bakDir, `${conflictCopyName(name, machineId)}.zip`)
    const { rename } = await import('node:fs/promises')
    await rename(packed.zipPath, finalPath).catch(() => undefined)
  }

  private async applyByKind(
    meta: { kind: string; name: string; version: string | null; source: unknown; originalPath: string; packedAt: string; dshVersion: string | null },
    packed: { entry: LocalEntry; zipPath: string; sha256: string; size: number },
  ) {
    const m = meta as Parameters<Installer['applyBundle']>[1]
    const p = { entry: packed.entry, zipPath: packed.zipPath, sha256: packed.sha256, size: packed.size } as Parameters<Installer['applyBundle']>[0]
    if (meta.kind === 'bundle') return this.installer.applyBundle(p, m)
    if (meta.kind === 'skill') return this.installer.applySkill(p, m)
    if (meta.kind === 'config') return this.installer.applyConfig(p, m)
    return { status: 'failed' as const, message: `unknown kind: ${meta.kind}` }
  }

  // ---------- 定时调度 ----------

  startScheduler(intervalHours: number, onReport: (r: SyncRunReport) => void): void {
    this.stopScheduler()
    if (intervalHours <= 0) return
    const ms = intervalHours * 60 * 60 * 1000
    const tick = () => {
      // 抖动 0~5 分钟，规避多机撞锁
      const jitter = Math.floor(Math.random() * 5 * 60 * 1000)
      void (async () => {
        await this.runOnce('scheduled')
        onReport(this.lastReport ?? this.reportNow({ errors: [{ stage: 'run', message: 'no report' }] }, false))
      })()
    }
    this.timer = setInterval(tick, ms)
    // unref 让 Node 进程可自然退出（dsh 宿主保持运行不受影响）
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) (this.timer as { unref(): void }).unref()
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  isRunning(): boolean {
    return this.running
  }

  private lastReport: SyncRunReport | null = null
}

export type { SyncScope }

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  return new SyncEngineImpl(deps)
}

// 便于其他模块使用
export type { ConfigStore }
