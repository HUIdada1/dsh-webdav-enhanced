/*
 * M5 合并与冲突处理（纯逻辑，可单测）。
 * 输入：本地扫描条目 + 远端 manifest + 本机上次同步 hash 快照 + 策略。
 * 输出：每个条目的动作（上传 / 下载 / 跳过 / 冲突）。
 * 冲突判定依据"是否同源于上次同步的 hash"，不依赖时钟，跨机可重现。
 */
import type { LocalEntry, MergeDecision, MergeInput, Merger, RemoteEntry } from '../types.js'
import { entryKey } from './manifest.js'

class MergerImpl implements Merger {
  decide(input: MergeInput): MergeDecision[] {
    const decisions: MergeDecision[] = []
    const remoteByKey = new Map(input.remote.entries.filter((e) => !e.deleted).map((e) => [entryKey(e), e]))
    const localByKey = new Map(input.local.map((e) => [entryKey(e), e]))

    // 远端条目：下载或冲突
    for (const [key, remote] of remoteByKey) {
      const local = localByKey.get(key)
      if (!local) {
        decisions.push({ entry: remote, action: 'download' })
        continue
      }
      if (local.hash === remote.hash) {
        decisions.push({ entry: remote, action: 'skip' })
        continue
      }
      // 两端 hash 不同：判断是否分叉
      const lastHash = input.lastSyncedHashes[key] ?? null
      const localChanged = lastHash === null || local.hash !== lastHash
      const remoteChanged = lastHash === null || remote.hash !== lastHash
      if (localChanged && remoteChanged) {
        // 分叉 → 冲突
        decisions.push({
          entry: remote,
          action: 'conflict',
          conflictNote: `diverged: local ${local.hash.slice(0, 8)} vs remote ${remote.hash.slice(0, 8)} from ${remote.source.machineId}`,
        })
      } else if (remoteChanged) {
        decisions.push({ entry: remote, action: 'download' })
      } else {
        decisions.push({ entry: local, action: 'upload' })
      }
    }

    // 本地有而远端没有：上传
    for (const [key, local] of localByKey) {
      if (!remoteByKey.has(key)) {
        decisions.push({ entry: local, action: 'upload' })
      }
    }

    return this.applyPolicy(decisions, input.policy, input.machineId)
  }

  private applyPolicy(decisions: MergeDecision[], policy: MergeInput['policy'], machineId: string): MergeDecision[] {
    if (policy === 'merge-backup') {
      // 默认：冲突时远端为正式，本地保留副本（由 sync 落盘备份）
      return decisions
    }
    if (policy === 'local-wins') {
      return decisions.map((d) =>
        d.action === 'conflict' || d.action === 'download' ? { ...d, action: 'upload' as const } : d,
      )
    }
    if (policy === 'remote-wins') {
      return decisions.map((d) =>
        d.action === 'conflict' || d.action === 'upload' ? { ...d, action: 'download' as const } : d,
      )
    }
    // ask：保持 conflict 标记，由 UI 询问；sync 引擎按 merge-backup 兜底执行
    return decisions
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
