/*
 * M5 合并与冲突处理（v2，纯逻辑，可单测）。
 *
 * 三方合并：base = lastSynced[key]（上次同步快照）+ 本机扫描 hash + 远端 manifest hash。
 * - 决策表见 docs/DESIGN-v2.md §3；所有 decision 必带中文 reason（直接进 UI / 日志）。
 * - 分叉时按 conflictPolicy / syncOptions.autoResolve 自动裁决赢家，输家由 sync 备份，
 *   默认不再产生需要人工决策的冲突（D11 修复）。
 * - 纯函数：decideV2 / pickWinner / applyDirection 均无副作用，时间只从入参读取。
 */
import type {
  ConflictPolicy,
  ItemAction,
  LocalEntry,
  MergeDecision,
  MergeDecisionV2,
  MergeInput,
  MergeInputV2,
  Merger,
  RemoteEntry,
  RemoteManifest,
  SyncDirection,
  SyncSnapshot,
} from '../types.js'
import { entryKey } from './manifest.js'

/** 修改时间差的裁决阈值：≤ 2s 视为"时间不可分" */
export const MTIME_TOLERANCE_MS = 2000

// ---------- 版本比较（semver 宽松） ----------

interface ParsedVersion {
  core: number[]
  pre: string[]
}

/** 解析 `1.2.3` / `v1.2.3-beta.1` / `1.2`；失败返回 null */
function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (!raw) return null
  const text = String(raw).trim().replace(/^v/i, '')
  const m = text.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!m) return null
  return { core: m[1].split('.').map((n) => Number(n)), pre: m[2] ? m[2].split('.') : [] }
}

function compareCore(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function comparePrerelease(a: string[], b: string[]): number {
  // 无预发布标识 > 有预发布标识（1.0.0 > 1.0.0-beta）
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const nx = Number(x)
      const ny = Number(y)
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (xn !== yn) {
      // 数字标识优先级低于字符串标识
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * semver 宽松比较：数字段逐个比，预发布标识按字典序（数字段按数值）。
 * 解析失败返回 0（视为不分先后）。
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  const core = compareCore(pa.core, pb.core)
  if (core !== 0) return core
  return comparePrerelease(pa.pre, pb.pre)
}

// ---------- 自动裁决 ----------

export interface WinnerChoice {
  winner: 'local' | 'remote'
  /** 中文裁决理由（直接拼进 decision.reason） */
  reason: string
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '未知'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

/**
 * auto 裁决：时间（差 > 2s）→ 版本号 → 平局远端优先。
 * 纯函数，便于单测；时间只来自入参，不读系统时钟。
 */
export function pickWinner(local: LocalEntry, remote: RemoteEntry): WinnerChoice {
  const localTime = Date.parse(local.modifiedAt)
  const remoteTime = Date.parse(remote.updatedAt)
  if (!Number.isNaN(localTime) && !Number.isNaN(remoteTime)) {
    const diff = localTime - remoteTime
    if (Math.abs(diff) > MTIME_TOLERANCE_MS) {
      if (diff > 0) {
        return {
          winner: 'local',
          reason: `本机修改时间较新（本机 ${fmtTime(local.modifiedAt)} / 远端 ${fmtTime(remote.updatedAt)}）`,
        }
      }
      return {
        winner: 'remote',
        reason: `远端修改时间较新（远端 ${fmtTime(remote.updatedAt)} / 本机 ${fmtTime(local.modifiedAt)}）`,
      }
    }
  }
  const cmp = compareVersions(local.version, remote.version)
  if (cmp !== 0) {
    if (cmp > 0) {
      return { winner: 'local', reason: `修改时间接近，按版本号裁决：本机 ${local.version ?? '无版本'} 高于远端 ${remote.version ?? '无版本'}` }
    }
    return { winner: 'remote', reason: `修改时间接近，按版本号裁决：远端 ${remote.version ?? '无版本'} 高于本机 ${local.version ?? '无版本'}` }
  }
  return { winner: 'remote', reason: '时间与版本均相同，按远端优先收敛' }
}

// ---------- 决策表 ----------

function decision(
  base: Omit<MergeDecisionV2, 'key'> & { key?: string },
  local?: LocalEntry,
  remote?: RemoteEntry,
): MergeDecisionV2 {
  return {
    key: base.key ?? entryKey((local ?? remote)!),
    kind: base.kind,
    name: base.name,
    action: base.action,
    reason: base.reason,
    winner: base.winner,
    local,
    remote,
    backupHint: base.backupHint,
  }
}

function backupHintFor(name: string, machineId: string): string {
  // 具体时间戳由 sync 落盘时追加（这里保持纯函数确定性）
  return `${name}.conflict-${machineId}`
}

interface Divergence {
  action: ItemAction
  winner?: 'local' | 'remote'
  reason: string
}

/** 两端都改过的分叉：按 policy + autoResolve 裁决（决策表第 5 行） */
function resolveDivergence(
  policy: ConflictPolicy,
  autoResolve: MergeInputV2['options']['autoResolve'],
  local: LocalEntry,
  remote: RemoteEntry,
): Divergence {
  const adopt = (winner: 'local' | 'remote', extra = ''): Divergence => ({
    action: winner === 'local' ? 'upload' : 'download',
    winner,
    reason: `两端均已修改，自动采用${winner === 'local' ? '本机' : '远端'}，另一侧已备份${extra}`,
  })

  switch (policy) {
    case 'local-wins':
      return { action: 'upload', winner: 'local', reason: '两端均已修改，按 local-wins 策略采用本机' }
    case 'remote-wins':
      return { action: 'download', winner: 'remote', reason: '两端均已修改，按 remote-wins 策略采用远端' }
    case 'merge-backup':
      return adopt('remote')
    case 'ask':
      return { action: 'conflict', reason: '两端均已修改，ask 策略下保留冲突待人工选择' }
    case 'auto':
    default: {
      if (autoResolve === 'local') return { action: 'upload', winner: 'local', reason: '两端均已修改，自动采用本机，另一侧已备份' }
      if (autoResolve === 'remote') return adopt('remote')
      if (autoResolve === 'manual') return { action: 'conflict', reason: '两端均已修改，manual 策略下保留冲突待人工选择' }
      const pick = pickWinner(local, remote)
      return {
        action: 'merge',
        winner: pick.winner,
        reason: `两端均已修改，自动采用${pick.winner === 'local' ? '本机' : '远端'}，另一侧已备份（${pick.reason}）`,
      }
    }
  }
}

/**
 * v2 决策表（DESIGN-v2 §3）。direction 过滤由 applyDirection 单独完成，
 * 这样 /plan 可以同时展示"原始决策"与"方向过滤后"的信息。
 */
export function decideV2(input: MergeInputV2): MergeDecisionV2[] {
  const localByKey = new Map<string, LocalEntry>()
  for (const e of input.local) localByKey.set(entryKey(e), e)
  const remoteByKey = new Map<string, RemoteEntry>()
  for (const e of input.remote.entries) {
    if (!e.deleted) remoteByKey.set(entryKey(e), e)
  }
  const propagate = input.options.propagateDeletions
  const out: MergeDecisionV2[] = []

  // 先按本地扫描顺序，再补远端独有条目：顺序稳定、便于 UI 展示
  const keys: string[] = []
  for (const e of input.local) keys.push(entryKey(e))
  for (const e of input.remote.entries) {
    if (e.deleted) continue
    const key = entryKey(e)
    if (!localByKey.has(key) && !keys.includes(key)) keys.push(key)
  }

  for (const key of keys) {
    const local = localByKey.get(key)
    const remote = remoteByKey.get(key)
    const base: SyncSnapshot | undefined = input.lastSynced[key]

    // 两端都无（含墓碑）→ 不产出 decision
    if (!local && !remote) continue

    if (local && remote) {
      if (local.hash === remote.hash) {
        out.push(decision({ kind: local.kind, name: local.name, action: 'skip', reason: '两端内容一致' }, local, remote))
        continue
      }
      if (!base) {
        // 首次同步发现两端不一致：auto 裁决（无 mtime 优势时 remote 赢）
        const pick = pickWinner(local, remote)
        out.push(
          decision(
            {
              kind: local.kind,
              name: local.name,
              action: 'merge',
              winner: pick.winner,
              reason: `首次同步发现两端不一致，自动合并（${pick.reason}）`,
              backupHint: backupHintFor(local.name, input.machineId),
            },
            local,
            remote,
          ),
        )
        continue
      }
      const localChanged = local.hash !== base.hash
      const remoteChanged = remote.hash !== base.hash
      if (!localChanged && remoteChanged) {
        out.push(
          decision(
            { kind: local.kind, name: local.name, action: 'download', winner: 'remote', reason: '远端更新（本机未改）' },
            local,
            remote,
          ),
        )
        continue
      }
      if (localChanged && !remoteChanged) {
        out.push(
          decision(
            { kind: local.kind, name: local.name, action: 'upload', winner: 'local', reason: '本机更新（远端未改）' },
            local,
            remote,
          ),
        )
        continue
      }
      // 两端都改（分叉）
      const d = resolveDivergence(input.policy, input.options.autoResolve, local, remote)
      out.push(
        decision(
          {
            kind: local.kind,
            name: local.name,
            action: d.action,
            winner: d.winner,
            reason: d.reason,
            backupHint: d.action === 'conflict' || d.action === 'merge' ? backupHintFor(local.name, input.machineId) : undefined,
          },
          local,
          remote,
        ),
      )
      continue
    }

    if (local && !remote) {
      if (base) {
        if (local.hash === base.hash) {
          if (propagate) {
            out.push(
              decision({ kind: local.kind, name: local.name, action: 'delete-local', reason: '远端已删除，本机同步删除（已备份）' }, local),
            )
          } else {
            out.push(
              decision({ kind: local.kind, name: local.name, action: 'skip', reason: '远端已删除，本机保留（未开启删除传播）' }, local),
            )
          }
        } else {
          out.push(
            decision(
              { kind: local.kind, name: local.name, action: 'upload', winner: 'local', reason: '远端已删除但本机有改动，保留本机' },
              local,
            ),
          )
        }
      } else {
        out.push(decision({ kind: local.kind, name: local.name, action: 'upload', winner: 'local', reason: '本机新增' }, local))
      }
      continue
    }

    // !local && remote
    const r = remote!
    if (base) {
      if (r.hash === base.hash) {
        if (propagate) {
          out.push(decision({ kind: r.kind, name: r.name, action: 'delete-remote', reason: '本机已删除，远端同步删除（进回收站）' }, undefined, r))
        } else {
          out.push(decision({ kind: r.kind, name: r.name, action: 'skip', reason: '本机已删除，远端保留（未开启删除传播）' }, undefined, r))
        }
      } else {
        out.push(
          decision({ kind: r.kind, name: r.name, action: 'download', winner: 'remote', reason: '远端更新，本机缺失，恢复远端版本' }, undefined, r),
        )
      }
    } else {
      out.push(decision({ kind: r.kind, name: r.name, action: 'download', winner: 'remote', reason: '远端新增' }, undefined, r))
    }
  }

  return out
}

// ---------- 方向过滤 ----------

/**
 * 方向过滤（DESIGN-v2 §3）：
 * - upload：download / merge(winner=remote) / delete-local → skip（reason=「仅上传模式，跳过下载」）
 * - download：upload / delete-remote / merge(winner=local) → skip（reason=「仅下载模式，跳过上传」）
 * - both：原样。
 * conflict 不在此处过滤，由 sync 在真正执行时按方向跳过并记录。
 */
export function applyDirection(decisions: MergeDecisionV2[], direction: SyncDirection): MergeDecisionV2[] {
  if (direction === 'both') return decisions
  if (direction === 'upload') {
    return decisions.map((d) => {
      const needsDownload =
        d.action === 'download' ||
        d.action === 'delete-local' ||
        (d.action === 'merge' && d.winner === 'remote')
      if (!needsDownload) return d
      return { ...d, action: 'skip' as const, winner: undefined, reason: '仅上传模式，跳过下载' }
    })
  }
  return decisions.map((d) => {
    const needsUpload =
      d.action === 'upload' ||
      d.action === 'delete-remote' ||
      (d.action === 'merge' && d.winner === 'local')
    if (!needsUpload) return d
    return { ...d, action: 'skip' as const, winner: undefined, reason: '仅下载模式，跳过上传' }
  })
}

/** 一步到位：决策 + 方向过滤（sync / plan 共用） */
export function planDecisions(input: MergeInputV2): MergeDecisionV2[] {
  return applyDirection(decideV2(input), input.direction)
}

// ---------- 同步范围过滤 ----------

/**
 * 按 scope 过滤决策（**双向都生效**）。
 *
 * 只靠 scanLocal 里「不扫描」是不够的：scope=none 的类别仍然会出现在远端清单里，
 * 于是会被判成 download —— 用户勾「不同步」却还是把东西拉了下来；更糟的是这些条目
 * 一旦进了 lastSynced，下一轮「本机缺失 + 远端未变」就变成删除传播，把远端数据删掉。
 * 所以范围必须在决策层再过滤一遍。
 */
export function filterByScope<T extends { kind: EntryKindLike; name: string }>(
  decisions: T[],
  scope: SyncScopeLike,
): T[] {
  return decisions.filter((d) => {
    if (d.kind === 'bundle') {
      return scope.bundles.mode !== 'none' && !scope.bundles.exclude.includes(d.name)
    }
    if (d.kind === 'skill') {
      return scope.skills.mode !== 'none' && !scope.skills.exclude.includes(d.name)
    }
    // config 条目名固定为 settings；具体同步哪些顶层 key 由 scanConfigs / applyConfig 决定
    return scope.configs.mode !== 'none'
  })
}

type EntryKindLike = 'bundle' | 'skill' | 'config'

interface SyncScopeLike {
  bundles: { mode: 'all' | 'selected' | 'none'; exclude: string[] }
  skills: { mode: 'all' | 'selected' | 'none'; exclude: string[] }
  configs: { mode: 'all' | 'selected' | 'none'; includeKeys: string[] }
}

// ---------- v1 兼容（保留 createMerger 签名，内部走 v2） ----------

function toLegacy(decisions: MergeDecisionV2[]): MergeDecision[] {
  const out: MergeDecision[] = []
  for (const d of decisions) {
    const entry = (d.local ?? d.remote) as LocalEntry | RemoteEntry
    switch (d.action) {
      case 'upload':
        out.push({ entry, action: 'upload' })
        break
      case 'download':
        out.push({ entry: (d.remote ?? d.local) as RemoteEntry, action: 'download' })
        break
      case 'merge':
        if (d.winner === 'local') out.push({ entry, action: 'upload' })
        else out.push({ entry: (d.remote ?? d.local) as RemoteEntry, action: 'download' })
        break
      case 'conflict':
        out.push({ entry: (d.remote ?? d.local) as RemoteEntry, action: 'conflict', conflictNote: d.reason })
        break
      case 'delete-local':
      case 'delete-remote':
      case 'skip':
      default:
        out.push({ entry, action: 'skip' })
        break
    }
  }
  return out
}

export function legacySnapshots(input: MergeInput): Record<string, SyncSnapshot> {
  const syncedAt = new Date(0).toISOString()
  const out: Record<string, SyncSnapshot> = {}
  for (const [key, hash] of Object.entries(input.lastSyncedHashes ?? {})) {
    out[key] = { hash, version: null, syncedAt, machineId: input.machineId }
  }
  return out
}

class MergerImpl implements Merger {
  decide(input: MergeInput): MergeDecision[] {
    const decisions = decideV2({
      local: input.local,
      remote: input.remote,
      lastSynced: legacySnapshots(input),
      policy: input.policy,
      options: { autoResolve: 'auto', propagateDeletions: true },
      direction: 'both',
      machineId: input.machineId,
    })
    return toLegacy(decisions)
  }
}

export function createMerger(): Merger {
  return new MergerImpl()
}

// ---------- 冲突副本命名 ----------

export function conflictCopyName(name: string, machineId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${name}.conflict-${machineId}-${stamp}`
}

export type { RemoteManifest }
