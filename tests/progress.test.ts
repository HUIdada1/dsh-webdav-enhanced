import { describe, expect, it } from 'vitest'
import {
  countsFromItems,
  countsFromReport,
  generateRunId,
  PHASE_LABELS,
  phaseForAction,
  RunProgressTracker,
} from '../src/core/progress.js'
import type { RunItem, SyncRunReport } from '../src/types.js'

function mkReport(over: Partial<SyncRunReport> = {}): SyncRunReport {
  return {
    runId: 'run-9',
    trigger: 'manual',
    startedAt: '2026-06-01T00:00:00Z',
    finishedAt: '2026-06-01T00:00:01Z',
    uploaded: ['skill:a'],
    downloaded: [],
    merged: [],
    deleted: [],
    skipped: 2,
    deduped: ['skill:d'],
    conflicts: [],
    errors: [],
    items: [],
    ok: true,
    cancelled: false,
    durationMs: 1000,
    needsRestart: [],
    ...over,
  }
}

function item(over: Partial<RunItem>): RunItem {
  return {
    key: 'skill:a',
    kind: 'skill',
    name: 'a',
    action: 'upload',
    status: 'pending',
    reason: 'r',
    ...over,
  }
}

describe('RunProgressTracker', () => {
  it('start 后快照字段齐全、active 且 phase=scan', () => {
    const tracker = new RunProgressTracker()
    tracker.start({ runId: 'run-1', trigger: 'manual' })
    const s = tracker.snapshot()
    expect(s.runId).toBe('run-1')
    expect(s.active).toBe(true)
    expect(s.phase).toBe('scan')
    expect(s.phaseLabel).toBe(PHASE_LABELS.scan)
    expect(s.phaseLabel.length).toBeGreaterThan(0)
    expect(s.trigger).toBe('manual')
    expect(typeof s.startedAt).toBe('string')
    expect(s.finishedAt).toBeNull()
    expect(s.total).toBe(0)
    expect(s.done).toBe(0)
    expect(s.percent).toBe(0)
    expect(s.current).toBeNull()
    expect(s.items).toEqual([])
    expect(s.counts).toMatchObject({
      upload: 0,
      download: 0,
      merge: 0,
      skip: 0,
      remove: 0,
      conflict: 0,
      failed: 0,
      deduped: 0,
    })
    expect(s.report).toBeNull()
  })

  it('setItems/updateItem 推进 total/done/percent/current/counts', () => {
    const tracker = new RunProgressTracker()
    tracker.start({ runId: 'run-2', trigger: 'scheduled' })
    tracker.setItems([
      item({ key: 'skill:a', action: 'upload' }),
      item({ key: 'skill:b', action: 'download', name: 'b' }),
      item({ key: 'skill:c', action: 'delete-remote', name: 'c' }),
    ])
    let s = tracker.snapshot()
    expect(s.total).toBe(3)
    expect(s.percent).toBe(0)

    tracker.updateItem('skill:a', { status: 'running', reason: '正在上传：a' })
    s = tracker.snapshot()
    expect(s.current).toBe('skill:a')
    expect(s.phase).toBe('scan') // phase 由 sync 引擎显式切换
    expect(s.percent).toBe(0)

    tracker.phase('upload', '正在上传：a')
    tracker.updateItem('skill:a', { status: 'ok', bytes: 9, durationMs: 3 })
    tracker.updateItem('skill:b', { status: 'ok' })
    tracker.updateItem('skill:c', { status: 'deleted' })
    s = tracker.snapshot()
    expect(s.phase).toBe('upload')
    expect(s.phaseLabel).toBe(PHASE_LABELS.upload)
    expect(s.done).toBe(3)
    expect(s.percent).toBe(100)
    expect(s.current).toBeNull()
    expect(s.counts.upload).toBe(1)
    expect(s.counts.download).toBe(1)
    expect(s.counts.remove).toBe(1)
    expect(s.items[0].bytes).toBe(9)
    expect(s.items[0].durationMs).toBe(3)
  })

  it('markDeduped 单独计数；失败/跳过/冲突分别归类', () => {
    const tracker = new RunProgressTracker()
    tracker.start({ runId: 'run-3', trigger: 'manual' })
    tracker.setItems([
      item({ key: 'skill:a', action: 'upload', status: 'ok' }),
      item({ key: 'skill:b', action: 'skip', status: 'skipped', name: 'b' }),
      item({ key: 'skill:c', action: 'download', status: 'failed', name: 'c' }),
      item({ key: 'skill:d', action: 'conflict', status: 'conflict', name: 'd' }),
      item({ key: 'skill:e', action: 'merge', status: 'merged', name: 'e' }),
    ])
    tracker.markDeduped('skill:a')
    const counts = tracker.counts()
    expect(counts).toEqual({
      upload: 1,
      download: 0,
      merge: 1,
      skip: 1,
      remove: 0,
      conflict: 1,
      failed: 1,
      deduped: 1,
    })
  })

  it('cancel 在运行中返回 true 并置标志；finish 后快照归一为 idle 且带报告', () => {
    const tracker = new RunProgressTracker()
    tracker.start({ runId: 'run-4', trigger: 'manual' })
    expect(tracker.isCancelRequested()).toBe(false)
    expect(tracker.cancel()).toBe(true)
    expect(tracker.isCancelRequested()).toBe(true)
    const report = mkReport()
    tracker.finish({ ok: false, cancelled: true, report, message: '同步已取消' })
    const s = tracker.snapshot()
    expect(s.active).toBe(false)
    expect(s.phase).toBe('idle')
    expect(s.phaseLabel).toBe(PHASE_LABELS.idle)
    expect(s.report).toBe(report)
    expect(s.finishedAt).not.toBeNull()
    expect(s.message).toBe('同步已取消')
    // 空闲时 cancel 不再生效
    expect(tracker.cancel()).toBe(false)
  })

  it('reset 清空上次报告', () => {
    const tracker = new RunProgressTracker()
    tracker.start({ runId: 'run-5' })
    tracker.finish({ ok: true, cancelled: false, report: mkReport() })
    expect(tracker.snapshot().report).not.toBeNull()
    tracker.reset()
    const s = tracker.snapshot()
    expect(s.report).toBeNull()
    expect(s.runId).toBe('')
    expect(s.phase).toBe('idle')
  })

  it('generateRunId 唯一可读', () => {
    const a = generateRunId()
    const b = generateRunId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^run-/)
  })
})

describe('派生计数与阶段映射', () => {
  it('countsFromItems 与 tracker 口径一致', () => {
    const counts = countsFromItems(
      [
        item({ action: 'upload', status: 'ok' }),
        item({ key: 'skill:b', action: 'download', status: 'ok', name: 'b' }),
        item({ key: 'skill:c', action: 'delete-local', status: 'deleted', name: 'c' }),
        item({ key: 'skill:d', action: 'skip', status: 'skipped', name: 'd' }),
      ],
      2,
    )
    expect(counts).toEqual({ upload: 1, download: 1, merge: 0, skip: 1, remove: 1, conflict: 0, failed: 0, deduped: 2 })
  })

  it('countsFromReport 从报告数组还原分类计数', () => {
    const counts = countsFromReport(mkReport({ errors: [{ stage: 'upload', message: 'x' }], conflicts: [{ name: 'c', note: 'n' }] }))
    expect(counts).toEqual({ upload: 1, download: 0, merge: 0, skip: 2, remove: 0, conflict: 1, failed: 1, deduped: 1 })
    expect(countsFromReport(null)).toEqual({ upload: 0, download: 0, merge: 0, skip: 0, remove: 0, conflict: 0, failed: 0, deduped: 0 })
  })

  it('phaseForAction 按动作映射阶段', () => {
    expect(phaseForAction('upload')).toBe('upload')
    expect(phaseForAction('delete-remote')).toBe('upload')
    expect(phaseForAction('download')).toBe('download')
    expect(phaseForAction('delete-local')).toBe('download')
    expect(phaseForAction('merge', 'local')).toBe('upload')
    expect(phaseForAction('merge', 'remote')).toBe('download')
    expect(phaseForAction('skip')).toBe('finalize')
  })
})
