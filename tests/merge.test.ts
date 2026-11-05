import { describe, expect, it } from 'vitest'
import { conflictCopyName, createMerger } from '../src/core/merge.js'
import { emptyManifest, upsertEntry } from '../src/core/manifest.js'
import type { LocalEntry, MergeInput, RemoteEntry } from '../src/types.js'

const machine = { machineId: 'm1', platform: 'win32', dshVersion: null }

function mkLocal(over: Partial<LocalEntry>): LocalEntry {
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

function mkRemote(over: Partial<RemoteEntry>): RemoteEntry {
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

describe('merge', () => {
  it('identical hash → skip', () => {
    const local = mkLocal({})
    const remote = mkRemote({})
    const m = createMerger()
    const d = m.decide(mkInput({ local: [local], remote: upsertEntry(emptyManifest(), remote, '2026-01-01T00:00:00Z') }))
    expect(d).toHaveLength(1)
    expect(d[0].action).toBe('skip')
  })

  it('local-only → upload', () => {
    const m = createMerger()
    const d = m.decide(mkInput({ local: [mkLocal({})] }))
    expect(d[0].action).toBe('upload')
  })

  it('remote-only → download', () => {
    const m = createMerger()
    const d = m.decide(mkInput({ remote: upsertEntry(emptyManifest(), mkRemote({}), '2026-01-01T00:00:00Z') }))
    expect(d[0].action).toBe('download')
  })

  it('diverged (both changed from last sync) → conflict', () => {
    const last = 'c'.repeat(64)
    const local = mkLocal({ hash: 'a'.repeat(64) })
    const remote = mkRemote({ hash: 'b'.repeat(64) })
    const m = createMerger()
    const d = m.decide(
      mkInput({
        local: [local],
        remote: upsertEntry(emptyManifest(), remote, '2026-01-01T00:00:00Z'),
        lastSyncedHashes: { 'skill:s1': last },
      }),
    )
    expect(d[0].action).toBe('conflict')
    expect(d[0].conflictNote).toMatch(/diverged/)
  })

  it('local-wins policy turns conflict into upload', () => {
    const local = mkLocal({ hash: 'a'.repeat(64) })
    const remote = mkRemote({ hash: 'b'.repeat(64) })
    const m = createMerger()
    const d = m.decide(
      mkInput({
        local: [local],
        remote: upsertEntry(emptyManifest(), remote, '2026-01-01T00:00:00Z'),
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
