import { describe, expect, it } from 'vitest'
import {
  applyDirection,
  compareVersions,
  conflictCopyName,
  createMerger,
  decideV2,
  filterByScope,
  pickWinner,
} from '../src/core/merge.js'
import { emptyManifest } from '../src/core/manifest.js'
import type {
  LocalEntry,
  MergeDecisionV2,
  MergeInput,
  MergeInputV2,
  RemoteEntry,
  SyncSnapshot,
} from '../src/types.js'

const machine = { machineId: 'm1', platform: 'win32', dshVersion: null }

function mkLocal(over: Partial<LocalEntry> = {}): LocalEntry {
  return {
    kind: 'skill',
    name: 's1',
    version: '1.0.0',
    sourceDir: '/tmp/s1',
    hash: 'a'.repeat(64),
    sizeBytes: 10,
    modifiedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function mkRemote(over: Partial<RemoteEntry> = {}): RemoteEntry {
  return {
    kind: 'skill',
    name: 's1',
    version: '1.0.0',
    hash: 'a'.repeat(64),
    file: 'skills/s1@1.0.0-aaaaaaaa.zip',
    size: 10,
    source: machine,
    firstSeenAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deleted: false,
    ...over,
  }
}

function remoteManifest(entries: RemoteEntry[], deleted: RemoteEntry[] = []) {
  return {
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    entries: [...entries, ...deleted.map((e) => ({ ...e, deleted: true }))],
  }
}

function snapshot(hash: string): SyncSnapshot {
  return { hash, version: null, syncedAt: '2026-01-01T00:00:00Z', machineId: 'm1' }
}

function mkInputV2(over: Partial<MergeInputV2> = {}): MergeInputV2 {
  return {
    local: [],
    remote: emptyManifest(),
    lastSynced: {},
    policy: 'auto',
    options: { autoResolve: 'auto', propagateDeletions: true },
    direction: 'both',
    machineId: 'm1',
    ...over,
  }
}

function byKey(decisions: MergeDecisionV2[], key = 'skill:s1'): MergeDecisionV2 {
  const hit = decisions.find((d) => d.key === key)
  if (!hit) throw new Error(`no decision for ${key}: ${JSON.stringify(decisions)}`)
  return hit
}

// ---------- pickWinner ----------

describe('pickWinner', () => {
  it('时间差 > 2s 时新的赢：本机较新', () => {
    const local = mkLocal({ modifiedAt: '2026-06-01T12:00:00Z' })
    const remote = mkRemote({ updatedAt: '2026-06-01T11:00:00Z' })
    const pick = pickWinner(local, remote)
    expect(pick.winner).toBe('local')
    expect(pick.reason).toContain('本机修改时间较新')
  })

  it('时间差 > 2s 时新的赢：远端较新', () => {
    const local = mkLocal({ modifiedAt: '2026-06-01T11:00:00Z' })
    const remote = mkRemote({ updatedAt: '2026-06-01T12:00:00Z' })
    const pick = pickWinner(local, remote)
    expect(pick.winner).toBe('remote')
    expect(pick.reason).toContain('远端修改时间较新')
  })

  it('时间不可分（≤2s）时按版本号裁决', () => {
    const local = mkLocal({ modifiedAt: '2026-06-01T12:00:00Z', version: '1.2.0' })
    const remote = mkRemote({ updatedAt: '2026-06-01T12:00:01Z', version: '1.10.0' })
    const pick = pickWinner(local, remote)
    expect(pick.winner).toBe('remote')
    expect(pick.reason).toContain('版本号')
  })

  it('时间与版本均相同 → 远端优先收敛（确定性）', () => {
    const pick = pickWinner(mkLocal(), mkRemote())
    expect(pick.winner).toBe('remote')
    expect(pick.reason).toContain('远端优先收敛')
  })
})

describe('compareVersions', () => {
  it('数字段逐个比较（1.10.0 > 1.9.0）', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
  })
  it('正式版高于预发布版，预发布标识按字典序', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })
  it('解析失败返回 0', () => {
    expect(compareVersions('not-a-version', '1.0.0')).toBe(0)
    expect(compareVersions(null, null)).toBe(0)
  })
})

// ---------- v2 决策表 ----------

describe('decideV2 决策表', () => {
  it('两端 hash 相同 → skip「两端内容一致」', () => {
    const d = decideV2(mkInputV2({ local: [mkLocal()], remote: remoteManifest([mkRemote()]) }))
    expect(d).toHaveLength(1)
    expect(d[0].action).toBe('skip')
    expect(d[0].reason).toBe('两端内容一致')
  })

  it('base 存在、本机未改、远端已改 → download', () => {
    const local = mkLocal({ hash: 'a'.repeat(64) })
    const remote = mkRemote({ hash: 'b'.repeat(64) })
    const d = decideV2(
      mkInputV2({
        local: [local],
        remote: remoteManifest([remote]),
        lastSynced: { 'skill:s1': snapshot('a'.repeat(64)) },
      }),
    )
    expect(d[0].action).toBe('download')
    expect(d[0].winner).toBe('remote')
    expect(d[0].reason).toContain('远端更新（本机未改）')
  })

  it('base 存在、远端未改、本机已改 → upload', () => {
    const local = mkLocal({ hash: 'b'.repeat(64) })
    const remote = mkRemote({ hash: 'a'.repeat(64) })
    const d = decideV2(
      mkInputV2({
        local: [local],
        remote: remoteManifest([remote]),
        lastSynced: { 'skill:s1': snapshot('a'.repeat(64)) },
      }),
    )
    expect(d[0].action).toBe('upload')
    expect(d[0].winner).toBe('local')
    expect(d[0].reason).toContain('本机更新（远端未改）')
  })

  it('首次同步无 base 且两端不同 → merge，auto 裁决（远端较新则远端赢）', () => {
    const local = mkLocal({ hash: 'a'.repeat(64), modifiedAt: '2026-06-01T10:00:00Z' })
    const remote = mkRemote({ hash: 'b'.repeat(64), updatedAt: '2026-06-01T12:00:00Z' })
    const d = decideV2(mkInputV2({ local: [local], remote: remoteManifest([remote]) }))
    expect(d[0].action).toBe('merge')
    expect(d[0].winner).toBe('remote')
    expect(d[0].reason).toContain('首次同步发现两端不一致')
    expect(d[0].backupHint).toBeTruthy()
  })

  it('分叉 policy=auto + autoResolve=auto → merge（自动采用远端并备份）', () => {
    const local = mkLocal({ hash: 'a'.repeat(64), modifiedAt: '2026-06-01T12:00:00Z' })
    const remote = mkRemote({ hash: 'b'.repeat(64), updatedAt: '2026-06-01T12:00:00Z', version: '2.0.0' })
    const d = decideV2(
      mkInputV2({
        local: [local],
        remote: remoteManifest([remote]),
        lastSynced: { 'skill:s1': snapshot('c'.repeat(64)) },
        policy: 'auto',
      }),
    )
    expect(d[0].action).toBe('merge')
    expect(d[0].winner).toBe('remote')
    expect(d[0].reason).toContain('两端均已修改')
    expect(d[0].reason).toContain('另一侧已备份')
  })

  it('分叉 policy=ask → conflict', () => {
    const d = decideV2(
      mkInputV2({
        local: [mkLocal({ hash: 'a'.repeat(64) })],
        remote: remoteManifest([mkRemote({ hash: 'b'.repeat(64) })]),
        lastSynced: { 'skill:s1': snapshot('c'.repeat(64)) },
        policy: 'ask',
      }),
    )
    expect(d[0].action).toBe('conflict')
    expect(d[0].backupHint).toBeTruthy()
  })

  it('分叉 policy=local-wins → upload；remote-wins → download；merge-backup → download', () => {
    const build = (policy: MergeInputV2['policy']) =>
      decideV2(
        mkInputV2({
          local: [mkLocal({ hash: 'a'.repeat(64) })],
          remote: remoteManifest([mkRemote({ hash: 'b'.repeat(64) })]),
          lastSynced: { 'skill:s1': snapshot('c'.repeat(64)) },
          policy,
        }),
      )[0]
    expect(build('local-wins').action).toBe('upload')
    expect(build('local-wins').winner).toBe('local')
    expect(build('remote-wins').action).toBe('download')
    expect(build('remote-wins').winner).toBe('remote')
    expect(build('merge-backup').action).toBe('download')
  })

  it('分叉 policy=auto + autoResolve=manual → conflict', () => {
    const d = decideV2(
      mkInputV2({
        local: [mkLocal({ hash: 'a'.repeat(64) })],
        remote: remoteManifest([mkRemote({ hash: 'b'.repeat(64) })]),
        lastSynced: { 'skill:s1': snapshot('c'.repeat(64)) },
        options: { autoResolve: 'manual', propagateDeletions: true },
      }),
    )
    expect(d[0].action).toBe('conflict')
  })

  it('本机新增（无 base、无远端）→ upload「本机新增」', () => {
    const d = decideV2(mkInputV2({ local: [mkLocal()] }))
    expect(d[0].action).toBe('upload')
    expect(d[0].reason).toBe('本机新增')
  })

  it('远端新增（无 base、无本地）→ download「远端新增」', () => {
    const d = decideV2(mkInputV2({ remote: remoteManifest([mkRemote()]) }))
    expect(d[0].action).toBe('download')
    expect(d[0].reason).toBe('远端新增')
  })

  it('本机删除且远端未改 → delete-remote；关闭删除传播 → skip', () => {
    const remote = remoteManifest([mkRemote()])
    const base = { 'skill:s1': snapshot(mkRemote().hash) }
    const propagated = decideV2(mkInputV2({ remote, lastSynced: base }))
    expect(propagated[0].action).toBe('delete-remote')
    expect(propagated[0].reason).toContain('本机已删除')
    const kept = decideV2(
      mkInputV2({ remote, lastSynced: base, options: { autoResolve: 'auto', propagateDeletions: false } }),
    )
    expect(kept[0].action).toBe('skip')
    expect(kept[0].reason).toContain('未开启删除传播')
  })

  it('本机删除但远端有改动 → download「恢复远端版本」', () => {
    const d = decideV2(
      mkInputV2({
        remote: remoteManifest([mkRemote({ hash: 'b'.repeat(64) })]),
        lastSynced: { 'skill:s1': snapshot('a'.repeat(64)) },
      }),
    )
    expect(d[0].action).toBe('download')
    expect(d[0].reason).toContain('恢复远端版本')
  })

  it('远端删除且本机未改 → delete-local；关闭删除传播 → skip', () => {
    const local = mkLocal({ hash: 'a'.repeat(64) })
    const base = { 'skill:s1': snapshot('a'.repeat(64)) }
    const tomb = [mkRemote({ hash: 'a'.repeat(64) })]
    const propagated = decideV2(mkInputV2({ local: [local], remote: remoteManifest([], tomb), lastSynced: base }))
    expect(propagated[0].action).toBe('delete-local')
    expect(propagated[0].reason).toContain('远端已删除')
    const kept = decideV2(
      mkInputV2({
        local: [local],
        remote: remoteManifest([], tomb),
        lastSynced: base,
        options: { autoResolve: 'auto', propagateDeletions: false },
      }),
    )
    expect(kept[0].action).toBe('skip')
  })

  it('远端删除但本机有改动 → upload「保留本机」', () => {
    const local = mkLocal({ hash: 'b'.repeat(64) })
    const tomb = [mkRemote({ hash: 'a'.repeat(64) })]
    const d = decideV2(
      mkInputV2({ local: [local], remote: remoteManifest([], tomb), lastSynced: { 'skill:s1': snapshot('a'.repeat(64)) } }),
    )
    expect(d[0].action).toBe('upload')
    expect(d[0].reason).toContain('保留本机')
  })

  it('两端都无（含墓碑）→ 不产出 decision', () => {
    const tomb = [mkRemote({ deleted: true })]
    const d = decideV2(mkInputV2({ remote: remoteManifest([], tomb) }))
    expect(d).toHaveLength(0)
  })
})

// ---------- 方向过滤 ----------

describe('applyDirection', () => {
  const make = (): MergeDecisionV2[] => [
    { key: 'skill:up', kind: 'skill', name: 'up', action: 'upload', reason: 'r' },
    { key: 'skill:down', kind: 'skill', name: 'down', action: 'download', reason: 'r' },
    { key: 'skill:merge-local', kind: 'skill', name: 'merge-local', action: 'merge', reason: 'r', winner: 'local' },
    { key: 'skill:merge-remote', kind: 'skill', name: 'merge-remote', action: 'merge', reason: 'r', winner: 'remote' },
    { key: 'skill:del-local', kind: 'skill', name: 'del-local', action: 'delete-local', reason: 'r' },
    { key: 'skill:del-remote', kind: 'skill', name: 'del-remote', action: 'delete-remote', reason: 'r' },
    { key: 'skill:skip', kind: 'skill', name: 'skip', action: 'skip', reason: 'r' },
    { key: 'skill:conflict', kind: 'skill', name: 'conflict', action: 'conflict', reason: 'r' },
  ]

  it('both：原样返回', () => {
    expect(applyDirection(make(), 'both').map((d) => d.action)).toEqual([
      'upload', 'download', 'merge', 'merge', 'delete-local', 'delete-remote', 'skip', 'conflict',
    ])
  })

  it('upload：下载/删除本机/远端赢的 merge → skip（reason=仅上传模式）', () => {
    const out = applyDirection(make(), 'upload')
    const map = Object.fromEntries(out.map((d) => [d.key, d]))
    expect(map['skill:up'].action).toBe('upload')
    expect(map['skill:merge-local'].action).toBe('merge')
    expect(map['skill:del-remote'].action).toBe('delete-remote')
    expect(map['skill:down'].action).toBe('skip')
    expect(map['skill:down'].reason).toContain('仅上传模式')
    expect(map['skill:del-local'].action).toBe('skip')
    expect(map['skill:merge-remote'].action).toBe('skip')
    // 原本的 skip / conflict 不在过滤范围
    expect(map['skill:skip'].action).toBe('skip')
    expect(map['skill:conflict'].action).toBe('conflict')
  })

  it('download：上传/删除远端/本机赢的 merge → skip（reason=仅下载模式）', () => {
    const out = applyDirection(make(), 'download')
    const map = Object.fromEntries(out.map((d) => [d.key, d]))
    expect(map['skill:down'].action).toBe('download')
    expect(map['skill:merge-remote'].action).toBe('merge')
    expect(map['skill:del-local'].action).toBe('delete-local')
    expect(map['skill:up'].action).toBe('skip')
    expect(map['skill:up'].reason).toContain('仅下载模式')
    expect(map['skill:del-remote'].action).toBe('skip')
    expect(map['skill:merge-local'].action).toBe('skip')
  })
})

// ---------- v1 兼容导线 ----------

describe('createMerger（v1 兼容）', () => {
  function mkInput(over: Partial<MergeInput>): MergeInput {
    return {
      local: [],
      remote: emptyManifest(),
      lastSyncedHashes: {},
      policy: 'merge-backup',
      machineId: 'm1',
      ...over,
    }
  }

  it('identical hash → skip', () => {
    const d = createMerger().decide(mkInput({ local: [mkLocal()], remote: remoteManifest([mkRemote()]) }))
    expect(d).toHaveLength(1)
    expect(d[0].action).toBe('skip')
  })

  it('local-only → upload；remote-only → download', () => {
    expect(createMerger().decide(mkInput({ local: [mkLocal()] }))[0].action).toBe('upload')
    expect(createMerger().decide(mkInput({ remote: remoteManifest([mkRemote()]) }))[0].action).toBe('download')
  })

  it('merge-backup 分叉 → download（远端赢 + 备份）；ask → conflict', () => {
    const local = mkLocal({ hash: 'a'.repeat(64) })
    const remote = remoteManifest([mkRemote({ hash: 'b'.repeat(64) })])
    const mergeBackup = createMerger().decide(
      mkInput({ local: [local], remote, lastSyncedHashes: { 'skill:s1': 'c'.repeat(64) }, policy: 'merge-backup' }),
    )
    expect(mergeBackup[0].action).toBe('download')
    const ask = createMerger().decide(
      mkInput({ local: [local], remote, lastSyncedHashes: { 'skill:s1': 'c'.repeat(64) }, policy: 'ask' }),
    )
    expect(ask[0].action).toBe('conflict')
  })

  it('local-wins 分叉 → upload', () => {
    const d = createMerger().decide(
      mkInput({
        local: [mkLocal({ hash: 'a'.repeat(64) })],
        remote: remoteManifest([mkRemote({ hash: 'b'.repeat(64) })]),
        lastSyncedHashes: { 'skill:s1': 'c'.repeat(64) },
        policy: 'local-wins',
      }),
    )
    expect(d[0].action).toBe('upload')
  })

  it('conflict copy name is readable and unique', () => {
    const n = conflictCopyName('my-skill', 'home-pc-abc', new Date('2026-06-15T12:34:56Z'))
    expect(n).toMatch(/^my-skill\.conflict-home-pc-abc-/)
  })
})

/**
 * 回归：同步范围必须在决策层再过滤一遍。
 * 否则 scope=none 的类别仍会从远端被下载；更糟的是进了 lastSynced 之后，
 * 下一轮「本机缺失 + 远端未变」会被判成删除传播，把远端数据删掉。
 */
describe('filterByScope', () => {
  const allScope = {
    bundles: { mode: 'all' as const, exclude: [] },
    skills: { mode: 'all' as const, exclude: [] },
    configs: { mode: 'none' as const, includeKeys: [] },
  }

  function decision(kind: 'bundle' | 'skill' | 'config', name: string, action: 'upload' | 'download' = 'download') {
    return { key: kind + ':' + name, kind, name, action }
  }

  it('keeps everything when scope is all', () => {
    const input = [decision('bundle', 'b1'), decision('skill', 's1')]
    expect(filterByScope(input, allScope)).toHaveLength(2)
  })

  it('drops a bundle that is set to none', () => {
    const input = [decision('bundle', 'b1'), decision('skill', 's1')]
    const scope = { ...allScope, bundles: { mode: 'none' as const, exclude: [] } }
    expect(filterByScope(input, scope).map((d) => d.key)).toEqual(['skill:s1'])
  })

  it('drops an excluded skill', () => {
    const input = [decision('skill', 's1'), decision('skill', 's2')]
    const scope = { ...allScope, skills: { mode: 'selected' as const, exclude: ['s2'] } }
    expect(filterByScope(input, scope).map((d) => d.key)).toEqual(['skill:s1'])
  })

  it('drops config when configs scope is none', () => {
    const input = [decision('config', 'settings')]
    expect(filterByScope(input, allScope)).toHaveLength(0)
  })

  it('keeps config when configs scope is all', () => {
    const input = [decision('config', 'settings')]
    const scope = { ...allScope, configs: { mode: 'all' as const, includeKeys: [] } }
    expect(filterByScope(input, scope)).toHaveLength(1)
  })

  it('never turns a disabled scope into a delete decision', () => {
    const input = [
      { key: 'skill:s1', kind: 'skill' as const, name: 's1', action: 'delete-remote' as const },
      { key: 'bundle:b1', kind: 'bundle' as const, name: 'b1', action: 'delete-remote' as const },
    ]
    const scope = { ...allScope, skills: { mode: 'none' as const, exclude: [] } }
    expect(filterByScope(input, scope).map((d) => d.key)).toEqual(['bundle:b1'])
  })
})