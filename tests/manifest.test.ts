import { describe, expect, it } from 'vitest'
import {
  emptyManifest,
  entryKey,
  markDeleted,
  remoteZipRelPath,
  upsertEntry,
} from '../src/core/manifest.js'
import type { RemoteEntry } from '../src/types.js'

function mkEntry(over: Partial<RemoteEntry>): RemoteEntry {
  return {
    kind: 'skill',
    name: 's1',
    version: '1.0.0',
    hash: 'a'.repeat(64),
    file: 'skills/s1@1.0.0-aaaaaaaa.zip',
    size: 100,
    source: { machineId: 'm1', platform: 'win32', dshVersion: null },
    firstSeenAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deleted: false,
    ...over,
  }
}

describe('manifest', () => {
  it('upsert creates new entry with timestamps', () => {
    const m = emptyManifest()
    const next = upsertEntry(m, mkEntry({}), '2026-01-02T00:00:00Z')
    expect(next.entries).toHaveLength(1)
    expect(next.entries[0].firstSeenAt).toBe('2026-01-02T00:00:00Z')
  })

  it('upsert dedupes by hash (no update when unchanged)', () => {
    const m = upsertEntry(emptyManifest(), mkEntry({}), '2026-01-01T00:00:00Z')
    const again = upsertEntry(m, mkEntry({}), '2026-06-01T00:00:00Z')
    expect(again.entries).toHaveLength(1)
    expect(again.entries[0].updatedAt).toBe('2026-01-01T00:00:00Z') // 未变则不动
  })

  it('upsert bumps updatedAt when hash changes', () => {
    const m = upsertEntry(emptyManifest(), mkEntry({}), '2026-01-01T00:00:00Z')
    const changed = upsertEntry(m, mkEntry({ hash: 'b'.repeat(64), size: 200, file: 'skills/s1@1.0.0-bbbbbbbb.zip' }), '2026-06-01T00:00:00Z')
    expect(changed.entries[0].updatedAt).toBe('2026-06-01T00:00:00Z')
    expect(changed.entries[0].hash).toBe('b'.repeat(64))
  })

  it('markDeleted writes tombstone, keeps entry', () => {
    const m = upsertEntry(emptyManifest(), mkEntry({}), '2026-01-01T00:00:00Z')
    const killed = markDeleted(m, 'skill', 's1', '2026-02-01T00:00:00Z')
    expect(killed.entries[0].deleted).toBe(true)
    expect(killed.entries[0].updatedAt).toBe('2026-02-01T00:00:00Z')
  })

  it('entryKey is kind+name', () => {
    expect(entryKey({ kind: 'bundle', name: 'x' })).toBe('bundle:x')
  })

  it('remoteZipRelPath uses hash prefix', () => {
    expect(remoteZipRelPath(mkEntry({}))).toBe('skills/s1@1.0.0-aaaaaaaa.zip')
  })
})
