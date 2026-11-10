/*
 * M6 同步引擎（v2）。
 * - 一次同步：扫描（含 hash）→ 读远端 manifest → 三方合并决策 → 逐条执行 → prune → 持久化 lastSynced。
 * - 注入 RunProgressTracker / RunLogger：每个条目的阶段、耗时、原因、字节数都进快照与日志。
 * - 协作式取消：只在条目边界检查标志，绝不在传输中途硬中断。
 * - **任何单条失败只记录、不中断整体**；报告里必有失败明细。
 * - 上传走 dedupeRemote（D9）；删除传播（D8）；D1：只有本轮真正成功的条目才写 lastSynced。
 * - 定时调度 intervalHours（0=关），setInterval 已 unref，不影响宿主进程退出。
 */
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { conflictCopyName, filterByScope, planDecisions } from './merge.js'
import { scanLocal, machineInfo, HashCache } from './scan.js'
import { createInstallerFromOptions, pruneBackupDir } from './install.js'
import { createPackager } from './pack.js'
import { deleteEntry, pushEntry, pruneRemote, type SyncStore } from './webdav-store.js'
import { emptyManifest } from './manifest.js'
import { RunLogger } from './runlog.js'
import { generateRunId, phaseForAction, RunProgressTracker } from './progress.js'
import { DATA_DIRNAME, type ConfigStore } from './config-store.js'
import {
  DEFAULT_SAFETY_GUARD,
  type EntryKind,
  type Installer,
  type LocalEntry,
  type LogCategory,
  type MachineInfo,
  type MergeDecisionV2,
  type PackMeta,
  type PackedEntry,
  type Packager,
  type PluginConfig,
  type RemoteEntry,
  type RemoteManifest,
  type ResolvedEnv,
  type RunItem,
  type RunProgress,
  type SyncEngine,
  type SyncOptions,
  type SyncRunReport,
  type SyncSnapshot,
  type SyncTrigger,
  type WebDavClient,
} from '../types.js'

export interface SyncEngineDeps {
  env: ResolvedEnv
  configStore: ConfigStore
  store: SyncStore
  client: WebDavClient
  packager?: Packager
  /** 注入自定义 installer（测试用）；不传则按 syncOptions 每次运行构造 */
  installer?: Installer
  progress?: RunProgressTracker
  logger?: RunLogger
  /** 测试用：临时目录根 */
  tempRoot?: string
}

const TRIGGER_LABELS: Record<SyncTrigger, string> = {
  manual: '手动',
  scheduled: '定时',
  'auto-scan': '自动扫描',
}

export function triggerLabel(trigger: SyncTrigger): string {
  return TRIGGER_LABELS[trigger] ?? trigger
}

function nowIso(): string {
  return new Date().toISOString()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sanitize(name: string): string {
  return name.replace(/[^\w.@+-]+/g, '_').slice(0, 80) || 'entry'
}

function plural(kind: EntryKind): string {
  return `${kind}s`
}

/** 同步选项补默认值（老配置没有 syncOptions 时兜底） */
export function normalizeSyncOptions(raw: Partial<SyncOptions> | undefined): SyncOptions {
  const base: SyncOptions = {
    propagateDeletions: true,
    autoResolve: 'auto',
    dedupeRemote: true,
    autoInstall: true,
    contentMerge: true,
    maxBackups: 10,
    pruneTombstones: true,
    hardDelete: false,
  }
  const merged = { ...base, ...(raw ?? {}) }
  if (typeof merged.maxBackups !== 'number' || !Number.isFinite(merged.maxBackups) || merged.maxBackups < 0) {
    merged.maxBackups = base.maxBackups
  }
  return merged
}

/** 并发冲突时返回的报告（POST /sync 在运行中会直接拦掉，不会走到这里） */
export function createBusyReport(runId: string, trigger: SyncTrigger): SyncRunReport {
  const at = nowIso()
  return {
    runId,
    trigger,
    startedAt: at,
    finishedAt: at,
    uploaded: [],
    downloaded: [],
    merged: [],
    deleted: [],
    skipped: 0,
    deduped: [],
    conflicts: [],
    errors: [{ stage: 'run', message: '同步任务已在运行中' }],
    items: [],
    ok: false,
    cancelled: false,
    durationMs: 0,
    needsRestart: [],
  }
}

function emptyReport(runId: string, trigger: SyncTrigger, startedAt: string): SyncRunReport {
  return {
    runId,
    trigger,
    startedAt,
    finishedAt: startedAt,
    uploaded: [],
    downloaded: [],
    merged: [],
    deleted: [],
    skipped: 0,
    deduped: [],
    conflicts: [],
    errors: [],
    items: [],
    ok: false,
    cancelled: false,
    durationMs: 0,
    needsRestart: [],
  }
}

type Bucket = 'uploaded' | 'downloaded' | 'merged' | 'deleted' | 'deduped' | 'skipped' | 'conflict'

interface Outcome {
  status: RunItem['status']
  category: LogCategory
  bucket?: Bucket
  reason?: string
  detail?: string
  bytes?: number
  /** 本轮真正写成功的内容 hash → 记入 lastSynced（D1） */
  synced?: { hash: string; version: string | null }
  /** 该 key 从 lastSynced 移除（删除传播完成） */
  remove?: boolean
  /** bundle 安装成功待重启 */
  needsRestart?: boolean
  /** 需要进报告 errors 的错误原文 */
  error?: string
  /** 进度卡一句话状态 */
  summary?: string
}

interface RunContext {
  cfg: PluginConfig
  options: SyncOptions
  installer: Installer
  tmpRoot: string
  report: SyncRunReport
}

export class SyncEngineImpl implements SyncEngine {
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private currentRun: string | null = null
  private lastReportValue: SyncRunReport | null = null
  private syncedThisRun: Record<string, SyncSnapshot> = {}
  private removedThisRun: string[] = []
  private readonly packager: Packager
  private readonly tracker: RunProgressTracker
  private readonly logger: RunLogger

  constructor(private readonly deps: SyncEngineDeps) {
    this.packager = deps.packager ?? createPackager()
    this.tracker = deps.progress ?? new RunProgressTracker()
    this.logger = deps.logger ?? new RunLogger(deps.env.dshHome || tmpdir())
  }

  private cfg(): PluginConfig {
    return this.deps.configStore.load()
  }

  private dataDir(): string {
    return path.join(this.deps.env.dshHome || '.', DATA_DIRNAME)
  }

  // ---------- run ----------

  async runOnce(trigger: SyncTrigger, opts: { runId?: string } = {}): Promise<SyncRunReport> {
    const startedAt = nowIso()
    if (this.running) {
      return createBusyReport(opts.runId ?? this.currentRun ?? generateRunId(), trigger)
    }
    const runId = opts.runId ?? generateRunId()
    this.running = true
    this.currentRun = runId
    this.syncedThisRun = {}
    this.removedThisRun = []
    this.tracker.start({ runId, trigger })
    const report = emptyReport(runId, trigger, startedAt)
    this.logger.info('sync', `开始同步（${triggerLabel(trigger)}）`, { runId })

    try {
      await this.doRun(report)
      report.ok = report.errors.length === 0 && !report.cancelled
    } catch (err) {
      report.errors.push({ stage: 'fatal', message: errMsg(err) })
      report.ok = false
      this.logger.error('sync', `同步异常终止：${errMsg(err)}`, { runId })
    } finally {
      report.finishedAt = nowIso()
      report.durationMs = Math.max(0, Date.parse(report.finishedAt) - Date.parse(startedAt))
      this.running = false
      this.currentRun = null
      // D1：只把本轮真正同步成功的条目写进 lastSynced（含 version/syncedAt/machineId）
      try {
        this.persistSynced(report)
      } catch (err) {
        report.errors.push({ stage: 'persist', message: `保存同步状态失败：${errMsg(err)}` })
        report.ok = false
      }
      report.items = this.tracker.snapshot().items
      this.lastReportValue = report
      const message = summarize(report)
      this.tracker.finish({ ok: report.ok, cancelled: report.cancelled, report, message })
      if (report.ok) this.logger.success('sync', message, { runId })
      else if (report.cancelled) this.logger.warn('sync', message, { runId })
      else this.logger.warn('sync', message, { runId })
    }
    return report
  }

  private async doRun(report: SyncRunReport): Promise<void> {
    const cfg = this.cfg()
    const options = normalizeSyncOptions(cfg.syncOptions)
    const direction = cfg.schedule.direction
    const installer = this.deps.installer ?? createInstallerFromOptions(this.deps.env, options)

    // 1) 尽力持锁：拿不到也继续（manifest 条件写兜底），并发由 host 层互斥保证
    try {
      const lock = await this.deps.store.acquireLock(cfg.machineId, 10 * 60 * 1000)
      if (lock) await lock.release().catch(() => undefined)
      if (!lock) this.logger.info('sync', '未获得远端锁，按无锁模式继续（manifest 条件写兜底）', { runId: report.runId })
    } catch (err) {
      this.logger.warn('sync', `获取远端锁失败（继续执行）：${errMsg(err)}`, { runId: report.runId })
    }

    const tmpRoot = await mkdtemp(path.join(this.deps.tempRoot ?? tmpdir(), 'dsh-sync-'))
    try {
      // 2) 扫描（v2：扫描期就算真实 hash，D1/D2）
      this.tracker.phase('scan', '正在扫描本地条目')
      const scanErrors: { stage: string; message: string }[] = []
      const localEntries = await scanLocal(this.deps.env, cfg.scope, scanErrors, {
        cache: new HashCache(this.deps.env.dshHome || tmpdir()),
      })
      for (const e of scanErrors) {
        report.errors.push(e)
        this.logger.warn('sync', `扫描告警：${e.message}`, { runId: report.runId })
      }
      const self = machineInfo(this.deps.env, cfg.machineId)
      for (const e of localEntries) e.machine = self
      this.logger.info('sync', `本地扫描完成：${localEntries.length} 个条目`, { runId: report.runId })
      if (this.checkCancel(report)) return

      // 3) 读远端清单
      this.tracker.phase('manifest', '正在读取远端清单')
      const { manifest } = await this.deps.store.read()
      const remote: RemoteManifest = manifest ?? emptyManifest()
      const alive = remote.entries.filter((e) => !e.deleted).length
      this.logger.info('sync', `远端清单：${alive} 个条目（墓碑 ${remote.entries.length - alive} 个）`, {
        runId: report.runId,
      })
      if (this.checkCancel(report)) return

      // 4) 三方合并 + 方向过滤 + 同步范围过滤
      this.tracker.phase('plan', '正在生成同步计划')
      const decisions = filterByScope(
        planDecisions({
          local: localEntries,
          remote,
          lastSynced: cfg.lastSynced ?? {},
          policy: cfg.conflictPolicy,
          options: { autoResolve: options.autoResolve, propagateDeletions: options.propagateDeletions },
          direction,
          machineId: cfg.machineId,
        }),
        cfg.scope,
      )
      this.tracker.setItems(
        decisions.map((d) => ({
          key: d.key,
          kind: d.kind,
          name: d.name,
          action: d.action,
          status: 'pending' as const,
          reason: d.reason,
        })),
      )
      this.logger.info('sync', `同步计划：共 ${decisions.length} 项`, { runId: report.runId })

      const ctx: RunContext = { cfg, options, installer, tmpRoot, report }
      for (const d of decisions) {
        if (this.tracker.isCancelRequested()) {
          report.cancelled = true
          break
        }
        await this.executeOne(d, ctx)
      }
      if (this.tracker.isCancelRequested()) report.cancelled = true

      // 5) prune：清理超期 trash（hardDelete 时连墓碑一起物理删）
      if (!report.cancelled && options.pruneTombstones) {
        this.tracker.phase('prune', '正在清理远端回收站')
        try {
          const pruned = await pruneRemote(this.deps.store, this.deps.client, {
            hardDelete: options.hardDelete,
          })
          if (pruned.trashRemoved || pruned.tombstonesRemoved) {
            this.logger.info(
              'prune',
              `远端清理完成：回收站 ${pruned.trashRemoved} 项，墓碑 ${pruned.tombstonesRemoved} 项`,
              { runId: report.runId },
            )
          }
        } catch (err) {
          // prune 失败只记警告，不影响本轮结果
          this.logger.warn('prune', `远端清理失败（不影响本轮结果）：${errMsg(err)}`, { runId: report.runId })
        }
      }

      // 6) finalize
      this.tracker.phase('finalize', '正在保存同步状态')
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private checkCancel(report: SyncRunReport): boolean {
    if (!this.tracker.isCancelRequested()) return false
    report.cancelled = true
    this.tracker.phase('cancelled', '同步已取消')
    this.logger.warn('sync', '同步已取消（在条目边界停止）', { runId: report.runId })
    return true
  }

  // ---------- 单条目执行 ----------

  private async executeOne(d: MergeDecisionV2, ctx: RunContext): Promise<void> {
    const started = Date.now()
    this.tracker.updateItem(d.key, { status: 'running', reason: d.reason })
    this.tracker.phase(phaseForAction(d.action, d.winner), this.actionMessage(d))
    try {
      const outcome = await this.applyDecision(d, ctx)
      const durationMs = Date.now() - started
      this.tracker.updateItem(d.key, {
        status: outcome.status,
        reason: outcome.reason ?? d.reason,
        detail: outcome.detail,
        bytes: outcome.bytes,
        durationMs,
      })
      this.recordOutcome(d, outcome, ctx)
      this.logOutcome(d, outcome, ctx)
    } catch (err) {
      const message = errMsg(err)
      this.tracker.updateItem(d.key, { status: 'failed', detail: message, durationMs: Date.now() - started })
      ctx.report.errors.push({ stage: d.action, message: `${d.key}: ${message}`, name: d.name })
      this.logger.error(this.categoryOf(d.action), `${d.name} 处理失败：${message}`, {
        name: d.name,
        runId: ctx.report.runId,
        detail: d.reason,
      })
    }
  }

  private recordOutcome(d: MergeDecisionV2, outcome: Outcome, ctx: RunContext): void {
    const report = ctx.report
    switch (outcome.bucket) {
      case 'uploaded':
        report.uploaded.push(d.key)
        break
      case 'downloaded':
        report.downloaded.push(d.key)
        break
      case 'merged':
        report.merged.push(d.key)
        break
      case 'deleted':
        report.deleted.push(d.key)
        break
      case 'deduped':
        report.deduped.push(d.key)
        this.tracker.markDeduped(d.key)
        break
      case 'skipped':
        report.skipped += 1
        break
      case 'conflict':
        report.conflicts.push({ name: d.name, note: outcome.reason ?? d.reason })
        break
      default:
        break
    }
    if (outcome.needsRestart) {
      if (!report.needsRestart) report.needsRestart = []
      report.needsRestart.push(d.key)
    }
    if (outcome.synced) {
      this.syncedThisRun[d.key] = {
        hash: outcome.synced.hash,
        version: outcome.synced.version,
        syncedAt: new Date().toISOString(),
        machineId: ctx.cfg.machineId,
      }
    }
    if (outcome.remove) this.removedThisRun.push(d.key)
    if (outcome.error) {
      ctx.report.errors.push({ stage: d.action, message: `${d.key}: ${outcome.error}`, name: d.name })
      this.logger.error(this.categoryOf(d.action), `${d.name} 处理失败：${outcome.error}`, {
        name: d.name,
        runId: report.runId,
      })
    }
    if (outcome.summary) this.tracker.message(outcome.summary)
  }

  private logOutcome(d: MergeDecisionV2, outcome: Outcome, ctx: RunContext): void {
    const runId = ctx.report.runId
    switch (outcome.bucket) {
      case 'uploaded':
        this.logger.success('upload', `已上传：${d.name}`, { name: d.name, runId, detail: outcome.detail })
        break
      case 'downloaded':
        this.logger.success('download', `已下载：${d.name}`, { name: d.name, runId, detail: outcome.detail })
        break
      case 'merged':
        this.logger.success('merge', `已自动合并：${d.name}`, {
          name: d.name,
          runId,
          detail: outcome.reason,
        })
        break
      case 'deduped':
        this.logger.success('dedupe', `远端已有同内容，复用文件：${d.name}`, { name: d.name, runId, detail: outcome.detail })
        break
      case 'deleted':
        this.logger.success('delete', `已传播删除：${d.name}`, { name: d.name, runId, detail: outcome.detail })
        break
      case 'conflict':
        this.logger.warn('conflict', `保留冲突待人工处理：${d.name}`, { name: d.name, runId, detail: outcome.reason })
        break
      case 'skipped':
        if (outcome.status === 'skipped') {
          this.logger.info('skip', `跳过：${d.name}（${outcome.reason ?? d.reason}）`, { name: d.name, runId })
        }
        break
      default:
        break
    }
  }

  private actionMessage(d: MergeDecisionV2): string {
    switch (d.action) {
      case 'upload':
        return `正在上传：${d.name}`
      case 'download':
        return `正在下载：${d.name}`
      case 'merge':
        return d.winner === 'local' ? `正在自动合并（采用本机）：${d.name}` : `正在自动合并（采用远端）：${d.name}`
      case 'delete-local':
        return `正在删除本机条目：${d.name}`
      case 'delete-remote':
        return `正在删除远端条目：${d.name}`
      case 'conflict':
        return `记录冲突：${d.name}`
      default:
        return d.reason
    }
  }

  private categoryOf(action: MergeDecisionV2['action']): LogCategory {
    switch (action) {
      case 'upload':
        return 'upload'
      case 'download':
        return 'download'
      case 'merge':
        return 'merge'
      case 'delete-local':
      case 'delete-remote':
        return 'delete'
      case 'conflict':
        return 'conflict'
      default:
        return 'skip'
    }
  }

  private async applyDecision(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    switch (d.action) {
      case 'skip':
        return this.applySkip(d)
      case 'upload':
        return this.applyUpload(d, ctx)
      case 'download':
        return this.applyDownload(d, ctx)
      case 'merge':
        return d.winner === 'local' ? this.applyMergeLocalWins(d, ctx) : this.applyMergeRemoteWins(d, ctx)
      case 'delete-local':
        return this.applyDeleteLocal(d, ctx)
      case 'delete-remote':
        return this.applyDeleteRemote(d, ctx)
      case 'conflict':
      default:
        return this.applyConflict(d, ctx)
    }
  }

  private applySkip(d: MergeDecisionV2): Outcome {
    // 只有"两端确实一致"的 skip 才刷新 base；方向过滤 / 未开启删除传播的 skip 不刷新
    const consistent = !!(d.local && d.remote && d.local.hash === d.remote.hash)
    return {
      status: 'skipped',
      bucket: 'skipped',
      category: 'skip',
      reason: d.reason,
      synced: consistent ? { hash: d.local!.hash, version: d.local!.version } : undefined,
    }
  }

  private async applyUpload(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const entry = d.local!
    const staging = await mkdtemp(path.join(ctx.tmpRoot, 'pack-'))
    const packed = await this.packager.pack(entry, staging)
    const res = await pushEntry(this.deps.store, this.deps.client, {
      entry: {
        kind: entry.kind,
        name: entry.name,
        version: entry.version,
        hash: packed.sha256,
        size: packed.size,
        source: machineInfo(this.deps.env, ctx.cfg.machineId) as MachineInfo,
      },
      zipPath: packed.zipPath,
      machineId: ctx.cfg.machineId,
      dedupeRemote: ctx.options.dedupeRemote,
    })
    if (res.deduped) {
      return {
        status: 'ok',
        bucket: 'deduped',
        category: 'dedupe',
        bytes: packed.size,
        reason: `${d.reason}；远端已有同内容文件，复用`,
        detail: `复用远端文件：${res.file}`,
        synced: { hash: packed.sha256, version: entry.version },
        summary: `已复用远端同内容：${entry.name}`,
      }
    }
    if (!res.uploaded) {
      return {
        status: 'skipped',
        bucket: 'skipped',
        category: 'skip',
        bytes: packed.size,
        reason: `${d.reason}；远端清单已有相同内容`,
        detail: `远端文件：${res.file}`,
        synced: { hash: packed.sha256, version: entry.version },
      }
    }
    return {
      status: 'ok',
      bucket: 'uploaded',
      category: 'upload',
      bytes: packed.size,
      synced: { hash: packed.sha256, version: entry.version },
      detail: `远端文件：${res.file}`,
      summary: `已上传：${entry.name}`,
    }
  }

  private async applyDownload(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const remote = d.remote!
    const zipPath = path.join(ctx.tmpRoot, `dl-${sanitize(remote.name)}-${remote.hash.slice(0, 8)}.zip`)
    await this.deps.client.getFile(remote.file, zipPath)
    const unpackDir = path.join(ctx.tmpRoot, `unpack-${sanitize(remote.kind)}-${sanitize(remote.name)}`)
    const meta = await this.packager.unpack(zipPath, unpackDir, DEFAULT_SAFETY_GUARD)
    const packed: PackedEntry = {
      entry: {
        kind: remote.kind,
        name: remote.name,
        version: remote.version,
        sourceDir: '',
        hash: remote.hash,
        sizeBytes: remote.size,
        modifiedAt: new Date().toISOString(),
      },
      zipPath,
      sha256: remote.hash,
      size: remote.size,
    }
    if (!ctx.options.autoInstall) {
      return {
        status: 'skipped',
        category: 'download',
        bytes: remote.size,
        reason: `${d.reason}；已下载但 autoInstall 关闭，未安装`,
        detail: `临时包：${zipPath}`,
      }
    }
    const result = await this.applyByKind(meta, packed, ctx.installer)
    const synced = { hash: remote.hash, version: remote.version }
    switch (result.status) {
      case 'applied':
        return {
          status: 'ok',
          bucket: 'downloaded',
          category: 'download',
          bytes: remote.size,
          synced,
          detail: result.message,
          summary: `已下载安装：${remote.name}`,
        }
      case 'needs-restart':
        return {
          status: 'ok',
          bucket: 'downloaded',
          category: 'download',
          bytes: remote.size,
          synced,
          needsRestart: true,
          detail: `${result.message}（重启 dsh 后生效）`,
          summary: `已下载安装：${remote.name}（待重启生效）`,
        }
      case 'skipped':
        return {
          status: 'ok',
          category: 'download',
          bytes: remote.size,
          synced,
          reason: `${d.reason}；${result.message}`,
          detail: result.message,
        }
      case 'manual-needed':
        return {
          status: 'failed',
          category: 'download',
          bytes: remote.size,
          reason: `${d.reason}；需要手动安装`,
          detail: result.manualCommand ?? result.message,
          error: result.message,
        }
      case 'failed':
      default:
        return {
          status: 'failed',
          category: 'download',
          bytes: remote.size,
          reason: `${d.reason}；安装失败`,
          detail: result.message,
          error: result.message,
        }
    }
  }

  private async applyMergeRemoteWins(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const local = d.local!
    let detail: string | undefined
    try {
      const backupPath = await this.backupLocalEntry(local, ctx)
      detail = `本机旧版本已备份：${backupPath}`
      this.logger.info('merge', `已备份本机旧版本：${local.name}`, { name: local.name, runId: ctx.report.runId, detail: backupPath })
    } catch (err) {
      detail = `本机备份失败（继续按远端版本合并）：${errMsg(err)}`
      this.logger.warn('merge', `备份本机旧版本失败：${local.name}`, { name: local.name, runId: ctx.report.runId })
    }
    const outcome = await this.applyDownload({ ...d, action: 'download' }, ctx)
    return {
      ...outcome,
      status: outcome.status === 'ok' ? 'merged' : outcome.status,
      bucket: outcome.bucket === 'downloaded' ? 'merged' : outcome.bucket,
      category: 'merge',
      reason: d.reason,
      detail: [outcome.detail, detail].filter(Boolean).join('；'),
    }
  }

  private async applyMergeLocalWins(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const remote = d.remote!
    let detail = ''
    try {
      const backupPath = await this.backupRemoteEntry(remote, ctx)
      detail = `远端旧版本已备份：${backupPath}`
      this.logger.info('merge', `已备份远端旧版本：${remote.name}`, { name: remote.name, runId: ctx.report.runId, detail: backupPath })
    } catch (err) {
      detail = `远端备份失败（继续按本机版本合并）：${errMsg(err)}`
      this.logger.warn('merge', `备份远端旧版本失败：${remote.name}`, { name: remote.name, runId: ctx.report.runId })
    }
    const outcome = await this.applyUpload({ ...d, action: 'upload' }, ctx)
    return {
      ...outcome,
      status: outcome.status === 'ok' ? 'merged' : outcome.status,
      bucket: outcome.bucket === 'uploaded' || outcome.bucket === 'deduped' ? 'merged' : outcome.bucket,
      category: 'merge',
      reason: d.reason,
      detail: [outcome.detail, detail].filter(Boolean).join('；'),
    }
  }

  private async applyDeleteLocal(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const entry = d.local!
    if (entry.kind === 'config') {
      // 配置是"多个顶层 key 的合体"，远端墓碑无法确定该删哪些 key → 保守保留本机
      return {
        status: 'skipped',
        bucket: 'skipped',
        category: 'skip',
        reason: '配置类不支持自动删除顶层 key，已保留本机',
        detail: '如需删除请手动编辑 settings.yaml（同步前已备份原值）',
      }
    }
    const bakDir = path.join(this.dataDir(), 'backups', plural(entry.kind), conflictCopyName(entry.name, ctx.cfg.machineId))
    await mkdir(path.dirname(bakDir), { recursive: true })
    let detail: string
    try {
      await rename(entry.sourceDir, bakDir)
      detail = `已移入备份：${bakDir}`
    } catch {
      await cp(entry.sourceDir, bakDir, { recursive: true })
      await rm(entry.sourceDir, { recursive: true, force: true })
      detail = `已复制到备份：${bakDir}`
    }
    this.rotateBackups(entry.kind, ctx.options.maxBackups)
    return {
      status: 'deleted',
      bucket: 'deleted',
      category: 'delete',
      remove: true,
      reason: d.reason,
      detail,
      summary: `已删除本机条目：${entry.name}`,
    }
  }

  private async applyDeleteRemote(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const remote = d.remote!
    await deleteEntry(this.deps.store, this.deps.client, remote.kind, remote.name, ctx.cfg.machineId)
    return {
      status: 'deleted',
      bucket: 'deleted',
      category: 'delete',
      remove: true,
      reason: d.reason,
      detail: `远端文件已移入回收站：${remote.file}`,
      summary: `已删除远端条目：${remote.name}`,
    }
  }

  private async applyConflict(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const local = d.local
    let detail: string | undefined
    if (local) {
      try {
        detail = `本机版本已备份：${await this.backupLocalEntry(local, ctx)}`
      } catch (err) {
        detail = `本机备份失败：${errMsg(err)}`
      }
    }
    return {
      status: 'conflict',
      bucket: 'conflict',
      category: 'conflict',
      reason: d.reason,
      detail,
      summary: `冲突待处理：${d.name}`,
    }
  }

  // ---------- 备份 ----------

  private async backupLocalEntry(entry: LocalEntry, ctx: RunContext): Promise<string> {
    const dir = path.join(this.dataDir(), 'backups', plural(entry.kind), conflictCopyName(entry.name, ctx.cfg.machineId))
    await mkdir(dir, { recursive: true })
    const packed = await this.packager.pack(entry, dir)
    this.rotateBackups(entry.kind, ctx.options.maxBackups)
    return packed.zipPath
  }

  private async backupRemoteEntry(remote: RemoteEntry, ctx: RunContext): Promise<string> {
    const dir = path.join(this.dataDir(), 'backups', plural(remote.kind), conflictCopyName(remote.name, ctx.cfg.machineId))
    await mkdir(dir, { recursive: true })
    const zipPath = path.join(dir, `${sanitize(remote.name)}-${remote.hash.slice(0, 8)}.zip`)
    await this.deps.client.getFile(remote.file, zipPath)
    this.rotateBackups(remote.kind, ctx.options.maxBackups)
    return zipPath
  }

  private rotateBackups(kind: EntryKind, maxBackups: number): void {
    if (!(maxBackups >= 0)) return
    pruneBackupDir(path.join(this.dataDir(), 'backups', plural(kind)), maxBackups)
  }

  private async applyByKind(meta: PackMeta, packed: PackedEntry, installer: Installer) {
    if (meta.kind === 'bundle') return installer.applyBundle(packed, meta)
    if (meta.kind === 'skill') return installer.applySkill(packed, meta)
    if (meta.kind === 'config') return installer.applyConfig(packed, meta)
    return { status: 'failed' as const, message: `unknown kind: ${meta.kind}` }
  }

  // ---------- 持久化 ----------

  /** D1：只持久化"本轮实际同步成功"的条目真实 hash（含 version / syncedAt / machineId） */
  private persistSynced(report: SyncRunReport): void {
    const cfg = this.cfg()
    const next: Record<string, SyncSnapshot> = { ...(cfg.lastSynced ?? {}) }
    for (const key of this.removedThisRun) delete next[key]
    for (const [key, snap] of Object.entries(this.syncedThisRun)) next[key] = snap
    this.deps.configStore.update({ lastSynced: next, lastSyncAt: report.finishedAt })
  }

  // ---------- 调度 ----------

  startScheduler(intervalHours: number, onReport: (r: SyncRunReport) => void): void {
    this.stopScheduler()
    if (!Number.isFinite(intervalHours) || intervalHours <= 0) return
    const ms = Math.max(60_000, intervalHours * 60 * 60 * 1000)
    this.timer = setInterval(() => {
      if (this.running) return
      void this.runOnce('scheduled')
        .then((r) => {
          try {
            onReport(r)
          } catch {
            /* 回调异常不影响调度器 */
          }
        })
        .catch(() => undefined)
    }, ms)
    // unref：不阻止宿主进程退出
    const timer = this.timer as unknown as { unref?: () => void }
    if (typeof timer?.unref === 'function') timer.unref()
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ---------- 状态查询 ----------

  isRunning(): boolean {
    return this.running
  }

  cancel(): boolean {
    return this.tracker.cancel()
  }

  currentRunId(): string | null {
    return this.currentRun
  }

  lastReport(): SyncRunReport | null {
    return this.lastReportValue
  }

  progress(): RunProgress {
    return this.tracker.snapshot()
  }
}

function summarize(report: SyncRunReport): string {
  const parts = [
    `上传 ${report.uploaded.length}`,
    `下载 ${report.downloaded.length}`,
    `合并 ${report.merged.length}`,
    `删除 ${report.deleted.length}`,
    `跳过 ${report.skipped}`,
    `失败 ${report.errors.length}`,
  ]
  if (report.deduped.length > 0) parts.push(`去重 ${report.deduped.length}`)
  const head = report.cancelled ? '同步已取消' : report.ok ? '同步完成' : '同步结束（有失败项）'
  return `${head}：${parts.join('，')}`
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  return new SyncEngineImpl(deps)
}

export type { ConfigStore, ResolvedEnv }
