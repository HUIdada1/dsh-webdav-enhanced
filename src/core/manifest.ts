/*
 * M4 远端同步清单。
 * - 逻辑：纯数据操作 + 并发合并铁轨（read → merge → commit with etag 条件写，冲突重读重合并重试）。
 * - 去重的唯一依据是内容 sha256（hash），与来源机器无关。
 * - 本模块不直接持有 WebDavClient 实现，通过 ManifestStore 接口注入，方便单测 mock。
 */
import type {
  LockHandle,
  MachineInfo,
  RemoteEntry,
  RemoteManifest,
} from '../types.js'
import { MANIFEST_VERSION, ManifestConflictError } from '../types.js'

export function emptyManifest(): RemoteManifest {
  return { version: MANIFEST_VERSION, updatedAt: new Date().toISOString(), entries: [] }
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** 以 name + kind 作为条目的逻辑主键（同名同类视为同一条目） */
export function entryKey(e: Pick<RemoteEntry, 'kind' | 'name'>): string {
  return `${e.kind}:${e.name}`
}

export interface ManifestStoreLike {
  read(): Promise<{ manifest: RemoteManifest; etag: string | null }>
  commit(next: RemoteManifest, etag: string | null, lock: LockHandle | null): Promise<string | null>
  acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null>
  currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null>
}

/**
 * 乐观并发合并：fn 拿到最新 manifest，产出新 manifest；
 * 若 commit 期间 etag 变了（别的机器抢先），重读 → 重合并，最多 maxRetries 次。
 */
export async function withManifestLock<T>(
  store: ManifestStoreLike,
  machineId: string,
  fn: (manifest: RemoteManifest) => { manifest: RemoteManifest; result: T },
  opts: { maxRetries?: number; ttlMs?: number } = {},
): Promise<{ result: T; etag: string | null }> {
  const maxRetries = opts.maxRetries ?? 3
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000

  let lastErr: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const lock = await store.acquireLock(machineId, ttlMs)
    try {
      const { manifest, etag } = await store.read()
      const { manifest: next, result } = fn(manifest)
      next.updatedAt = nowIso()
      const newEtag = await store.commit(next, etag, lock)
      return { result, etag: newEtag }
    } catch (err) {
      lastErr = err
      if (!(err instanceof ManifestConflictError)) throw err
      // 冲突：稍等后重试整个回合
      await sleep(200 * (attempt + 1))
    } finally {
      if (lock) await lock.release().catch(() => undefined)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('manifest merge failed')
}

/** 条目去重与更新的纯函数：按 hash 判定是否需要新条目 */
export function upsertEntry(
  manifest: RemoteManifest,
  entry: Omit<RemoteEntry, 'firstSeenAt' | 'updatedAt'>,
  now: string,
): RemoteManifest {
  const key = entryKey(entry)
  const idx = manifest.entries.findIndex((e) => entryKey(e) === key)
  if (idx === -1) {
    return {
      ...manifest,
      entries: [...manifest.entries, { ...entry, firstSeenAt: now, updatedAt: now }],
    }
  }
  const existing = manifest.entries[idx]
  if (existing.hash === entry.hash && existing.version === entry.version && !entry.deleted) {
    // 内容没变：去重，直接原地跳过（不动 updatedAt，避免无意义版本漂移）
    return manifest
  }
  const next: RemoteEntry = {
    ...existing,
    ...entry,
    firstSeenAt: existing.firstSeenAt ?? now,
    updatedAt: now,
  }
  const entries = [...manifest.entries]
  entries[idx] = next
  return { ...manifest, entries }
}

/** 软删除：墓碑 + 文件进回收站（文件移动由调用方用 WebDavClient 完成） */
export function markDeleted(manifest: RemoteManifest, kind: RemoteEntry['kind'], name: string, now: string): RemoteManifest {
  const key = `${kind}:${name}`
  return {
    ...manifest,
    entries: manifest.entries.map((e) =>
      entryKey(e) === key ? { ...e, deleted: true, updatedAt: now } : e,
    ),
  }
}

// ---------- 远端文件命名 ----------

export function remoteZipRelPath(e: Pick<RemoteEntry, 'kind' | 'name' | 'version' | 'hash'>): string {
  const hash8 = e.hash.slice(0, 8)
  const ver = e.version ? `@${e.version}` : ''
  const dir = e.kind === 'bundle' ? 'bundles' : e.kind === 'skill' ? 'skills' : 'configs'
  const safeName = e.name.replace(/[^\w.@+-]+/g, '_')
  return `${dir}/${safeName}${ver}-${hash8}.zip`
}

// ---------- helpers ----------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export type { ManifestStoreLike as ManifestStoreImpl }
export type { MachineInfo }
