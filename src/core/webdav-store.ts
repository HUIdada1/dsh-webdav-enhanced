/*
 * M4/M2 远端清单与锁的 WebDAV 实现。
 * - 逻辑（并发合并/去重）在 manifest.ts（纯函数）。
 * - 本模块只做远端读写 + 锁，依赖 webdav-client（createWebDavClient）。
 * - 通过 SyncStore 抽象暴露给 sync.ts，方便单测 mock。
 */
import path from 'node:path'
import { createWebDavClient } from './webdav.js'
import type { WebDavClient } from '../types.js'
import { ManifestConflictError, type LockHandle, type MachineInfo, type RemoteEntry, type RemoteManifest } from '../types.js'
import { emptyManifest, entryKey, markDeleted, remoteZipRelPath, upsertEntry, withManifestLock } from './manifest.js'

export const MANIFEST_REL = 'manifest.json'
const LOCK_REL = 'locks/sync.lock'
const TRASH_REL = 'trash'

export interface SyncStore {
  read(): Promise<{ manifest: RemoteManifest; etag: string | null }>
  commit(next: RemoteManifest, etag: string | null, lock: LockHandle | null): Promise<string | null>
  acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null>
  currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null>
}

export interface WebDavStoreOptions {
  url: string
  username: string
  password: string
  timeoutMs?: number
  remoteRoot?: string
}

export class WebDavSyncStore implements SyncStore {
  private readonly client: WebDavClient

  constructor(opts: WebDavStoreOptions) {
    this.client = createWebDavClient({
      url: opts.url,
      username: opts.username,
      password: opts.password,
      timeoutMs: opts.timeoutMs,
      remoteRoot: opts.remoteRoot,
    })
  }

  async read(): Promise<{ manifest: RemoteManifest; etag: string | null }> {
    const etagHolder: { etag: string | null } = { etag: null }
    const m = await this.client.getJson<RemoteManifest | null>(MANIFEST_REL)
    const stat = await this.client.stat(MANIFEST_REL).catch(() => null)
    etagHolder.etag = stat?.etag ?? null
    return { manifest: m ?? emptyManifest(), etag: etagHolder.etag }
  }

  async commit(next: RemoteManifest, etag: string | null, _lock: LockHandle | null): Promise<string | null> {
    // 直接条件写；If-Match 由服务端校验，412 → ManifestConflictError
    return await this.client.putJsonIfMatch(MANIFEST_REL, next, etag)
  }

  async acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null> {
    return await this.client.acquireLock(machineId, ttlMs)
  }

  async currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null> {
    return await this.client.currentLockHolder()
  }
}

// ---------- 便捷封装：upsert + 条件写 + 冲突重试 ----------

export interface PushEntryInput {
  entry: Omit<RemoteEntry, 'firstSeenAt' | 'updatedAt' | 'file' | 'deleted'>
  /** 本地 zip 绝对路径 */
  zipPath: string
  machineId: string
}

/** 上传条目 zip（若 hash 已存在则跳过）并更新 manifest，返回最新 etag */
export async function pushEntry(
  store: SyncStore,
  client: WebDavClient,
  input: PushEntryInput,
): Promise<{ etag: string | null; uploaded: boolean }> {
  const file = remoteZipRelPath(input.entry)
  // 1) 先读清单，判断是否需要上传（hash 去重）
  const { manifest, etag } = await store.read()
  const key = entryKey(input.entry)
  const existing = manifest.entries.find((e) => entryKey(e) === key)
  if (existing && existing.hash === input.entry.hash && !existing.deleted) {
    return { etag, uploaded: false } // 去重：内容相同，无需重复上传
  }

  // 2) 上传 zip 到 staging 目录（若服务端没有同 hash 文件）
  const stagingRel = `staging/${path.basename(file)}`
  await client.ensureDir('staging')
  await client.putFile(stagingRel, input.zipPath)
  await client.move(stagingRel, file)

  // 3) 更新 manifest（带条件写 + 冲突重试）
  const now = new Date().toISOString()
  const res = await withManifestLock(
    store,
    input.machineId,
    (m) => ({ manifest: upsertEntry(m, { ...input.entry, file, deleted: false }, now), result: null }),
  )
  return { etag: res.etag, uploaded: true }
}

/** 软删除条目（墓碑 + 文件移到回收站） */
export async function deleteEntry(
  store: SyncStore,
  client: WebDavClient,
  kind: RemoteEntry['kind'],
  name: string,
  machineId: string,
): Promise<void> {
  const { manifest } = await store.read()
  const target = manifest.entries.find((e) => entryKey(e) === entryKey({ kind, name }) && !e.deleted)
  if (!target) return
  // 移入回收站（尽力而为，失败不阻塞 manifest 更新）
  const trashRel = `${TRASH_REL}/${path.basename(target.file)}.${Date.now()}`
  await client.ensureDir(TRASH_REL)
  await client.move(target.file, trashRel).catch(() => undefined)
  const now = new Date().toISOString()
  await withManifestLock(store, machineId, (m) => ({ manifest: markDeleted(m, kind, name, now), result: null }))
}
