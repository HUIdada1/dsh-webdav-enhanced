/*
 * 同步进度追踪器（v2）。
 * - 纯内存状态机：sync 引擎在每个阶段 / 每个条目上更新，http 层随时 snapshot()。
 * - snapshot() 是深拷贝：调用方随便序列化，不会污染运行中的状态。
 * - 取消采用协作式：cancel() 只置标志，sync 在条目边界检查 isCancelRequested()。
 */
import type { ItemAction, ItemStatus, RunCounts, RunItem, RunPhase, RunProgress, SyncRunReport, SyncTrigger } from '../types.js'

/** 阶段中文文案：后端直接给，前端不必翻译（DESIGN-v2 §4.1） */
export const PHASE_LABELS: Record<RunPhase, string> = {
  idle: '空闲',
  scan: '扫描本地',
  manifest: '读取远端清单',
  plan: '生成同步计划',
  download: '下载中',
  upload: '上传中',
  prune: '清理远端回收站',
  finalize: '保存同步状态',
  done: '已完成',
  error: '同步出错',
  cancelled: '已取消',
}

const EMPTY_COUNTS: RunCounts = {
  upload: 0,
  download: 0,
  merge: 0,
  skip: 0,
  remove: 0,
  conflict: 0,
  failed: 0,
  deduped: 0,
}

/** runId：时间可读 + 随机后缀，避免同进程内并发冲突 */
export function generateRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface StartRunInput {
  runId: string
  trigger?: SyncTrigger
}

function cloneItem(item: RunItem): RunItem {
  return { ...item }
}

export class RunProgressTracker {
  private items: RunItem[] = []
  private dedupedCount = 0
  private cancelRequested = false
  private lastReportValue: SyncRunReport | null = null
  private state: RunProgress

  constructor() {
    this.state = this.idleState()
  }

  private idleState(): RunProgress {
    return {
      runId: '',
      active: false,
      phase: 'idle',
      phaseLabel: PHASE_LABELS.idle,
      trigger: 'manual',
      startedAt: '',
      finishedAt: null,
      total: 0,
      done: 0,
      percent: 0,
      current: null,
      message: '空闲',
      items: [],
      counts: { ...EMPTY_COUNTS },
      report: null,
    }
  }

  /** 开始一轮：重置条目、计数、取消标志 */
  start(input: StartRunInput): RunProgress {
    this.items = []
    this.dedupedCount = 0
    this.cancelRequested = false
    this.state = {
      runId: input.runId,
      active: true,
      phase: 'scan',
      phaseLabel: PHASE_LABELS.scan,
      trigger: input.trigger ?? 'manual',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      total: 0,
      done: 0,
      percent: 0,
      current: null,
      message: '正在扫描本地条目',
      items: [],
      counts: { ...EMPTY_COUNTS },
      report: this.lastReportValue,
    }
    return this.snapshot()
  }

  /** 切换阶段（message 省略时用阶段默认文案） */
  phase(phase: RunPhase, message?: string): void {
    if (!this.state.active) return
    this.state.phase = phase
    this.state.phaseLabel = PHASE_LABELS[phase] ?? phase
    if (message) this.state.message = message
  }

  message(text: string): void {
    this.state.message = text
  }

  /** 批量写入本轮待执行条目（全部 pending） */
  setItems(items: RunItem[]): void {
    this.items = items.map(cloneItem)
    this.recalc()
  }

  /** 追加一个条目 */
  item(item: RunItem): void {
    this.items.push(cloneItem(item))
    this.recalc()
  }

  /** 按 key 更新条目；找不到则忽略 */
  updateItem(key: string, patch: Partial<RunItem>): void {
    const idx = this.items.findIndex((i) => i.key === key)
    if (idx === -1) return
    this.items[idx] = { ...this.items[idx], ...patch }
    const item = this.items[idx]
    if (item.status === 'running') {
      this.state.current = item.key
      this.state.message = item.reason || this.state.message
    }
    this.recalc()
  }

  /** 上传被远端去重复用：单独计数（条目本身仍是 ok） */
  markDeduped(_key?: string): void {
    this.dedupedCount += 1
    this.recalc()
  }

  /** 协作式取消：返回是否真的发出了取消请求 */
  cancel(): boolean {
    if (!this.state.active) {
      this.cancelRequested = false
      return false
    }
    this.cancelRequested = true
    this.state.message = '已请求取消，等待当前条目结束'
    return true
  }

  isCancelRequested(): boolean {
    return this.cancelRequested
  }

  /** 结束一轮：记录报告，active=false（snapshot 会归一成 idle 相位） */
  finish(result: { ok: boolean; cancelled: boolean; report: SyncRunReport; message?: string }): RunProgress {
    const finishedAt = new Date().toISOString()
    this.state.active = false
    this.state.finishedAt = finishedAt
    this.state.phase = result.cancelled ? 'cancelled' : result.ok ? 'done' : 'error'
    this.state.phaseLabel = PHASE_LABELS[this.state.phase]
    this.state.current = null
    this.state.message = result.message ?? (result.ok ? '同步完成' : result.cancelled ? '同步已取消' : '同步结束（有失败项）')
    this.state.report = result.report
    this.lastReportValue = result.report
    this.recalc()
    return this.snapshot()
  }

  /** 复位为空闲（重置本机状态时用） */
  reset(): void {
    this.items = []
    this.dedupedCount = 0
    this.cancelRequested = false
    this.lastReportValue = null
    this.state = this.idleState()
  }

  /** 当前进度快照（深拷贝；空闲时相位归一为 'idle'） */
  snapshot(): RunProgress {
    const counts = this.counts()
    const total = this.items.length
    const done = this.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length
    const percent = total === 0 ? (this.state.active ? 0 : 100) : Math.min(100, Math.round((done / total) * 100))
    const idle = !this.state.active
    return {
      runId: this.state.runId,
      active: this.state.active,
      phase: idle ? 'idle' : this.state.phase,
      phaseLabel: idle ? PHASE_LABELS.idle : this.state.phaseLabel,
      trigger: this.state.trigger,
      startedAt: this.state.startedAt,
      finishedAt: this.state.finishedAt,
      total,
      done,
      percent,
      current: idle ? null : this.state.current,
      message: this.state.message,
      items: this.items.map(cloneItem),
      counts,
      report: this.state.report,
    }
  }

  counts(): RunCounts {
    const c: RunCounts = { ...EMPTY_COUNTS, deduped: this.dedupedCount }
    for (const item of this.items) {
      switch (item.action) {
        case 'upload':
          if (item.status === 'ok') c.upload += 1
          break
        case 'download':
          if (item.status === 'ok') c.download += 1
          break
        case 'merge':
          if (item.status === 'ok' || item.status === 'merged') c.merge += 1
          break
        case 'delete-local':
        case 'delete-remote':
          if (item.status === 'ok' || item.status === 'deleted') c.remove += 1
          break
        default:
          break
      }
      if (item.status === 'skipped') c.skip += 1
      if (item.status === 'conflict') c.conflict += 1
      if (item.status === 'failed') c.failed += 1
    }
    return c
  }

  private recalc(): void {
    const counts = this.counts()
    const total = this.items.length
    const done = this.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length
    this.state.total = total
    this.state.done = done
    this.state.percent = total === 0 ? (this.state.active ? 0 : 100) : Math.min(100, Math.round((done / total) * 100))
    this.state.counts = counts
    const running = this.items.find((i) => i.status === 'running')
    this.state.current = running ? running.key : null
  }
}

/** 由行动作推断执行阶段（进度条上的阶段文案） */
export function phaseForAction(action: ItemAction, winner?: 'local' | 'remote'): RunPhase {
  switch (action) {
    case 'upload':
    case 'delete-remote':
      return 'upload'
    case 'download':
    case 'delete-local':
      return 'download'
    case 'merge':
      return winner === 'local' ? 'upload' : 'download'
    default:
      return 'finalize'
  }
}

/** 从 RunItem 列表推导分类计数（/status.counts 与测试共用） */
export function countsFromItems(items: RunItem[], deduped = 0): RunCounts {
  const c: RunCounts = { ...EMPTY_COUNTS, deduped }
  for (const item of items) {
    if (item.action === 'upload' && item.status === 'ok') c.upload += 1
    else if (item.action === 'download' && item.status === 'ok') c.download += 1
    else if (item.action === 'merge' && (item.status === 'ok' || item.status === 'merged')) c.merge += 1
    else if ((item.action === 'delete-local' || item.action === 'delete-remote') && (item.status === 'ok' || item.status === 'deleted')) c.remove += 1
    if (item.status === 'skipped') c.skip += 1
    if (item.status === 'conflict') c.conflict += 1
    if (item.status === 'failed') c.failed += 1
  }
  return c
}

/** 由 SyncRunReport 推导分类计数（/status 用：最近一次运行） */
export function countsFromReport(report: SyncRunReport | null): RunCounts {
  if (!report) return { ...EMPTY_COUNTS }
  return {
    upload: report.uploaded.length,
    download: report.downloaded.length,
    merge: report.merged.length,
    skip: report.skipped,
    remove: report.deleted.length,
    conflict: report.conflicts.length,
    failed: report.errors.length,
    deduped: report.deduped.length,
  }
}

export type { ItemStatus }
