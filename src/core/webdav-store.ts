/*
 * M4/M2 远端清单与锁的 WebDAV 实现（v2）。
 * - 逻辑（并发合并/去重）在 manifest.ts（纯函数）。
 * - 本模块只做远端读写 + 锁 + 上传去重 + prune，依赖 webdav-client（createWebDavClient）。
 * - 通过 SyncStore 抽象暴露给 sync.ts，方便单测 mock。
 */
import path from 'node:path'
import { createWebDavClient } from './webdav.js'
import type { WebDavClient } from '../types.js'
import { type LockHandle, type MachineInfo, type RemoteEntry, type RemoteManifest } from '../types.js'
import { emptyManifest, entryKey, markDeleted, remoteZipRelPath, upsertEntry, withManifestLock } from './manifest.js'

export const MANIFEST_REL = 'manifest.json'
const LOCK_REL = 'locks/sync.lock'
export const TRASH_REL = 'trash'

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
    const m = await this.client.getJson<RemoteManifest | null>(MANIFEST_REL)
    const stat = await this.client.stat(MANIFEST_REL).catch(() => null)
    return { manifest: m ?? emptyManifest(), etag: stat?.etag ?? null }
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

// ---------- 便捷封装：upsert + 条件写 + 去重 ----------

export interface PushEntryInput {
  entry: Omit<RemoteEntry, 'firstSeenAt' | 'updatedAt' | 'file' | 'deleted'>
  /** 本地 zip 绝对路径 */
  zipPath: string
  machineId: string
  /**
   * v2（D9）：远端任意条目已有同 hash 文件时，不复传文件，只把本条目登记进 manifest，
   * 并复用那个远端文件路径（保证后续可下载）。默认 false 保持旧行为。
   */
  dedupeRemote?: boolean
}

export interface PushEntryResult {
  etag: string | null
  /** 是否真的执行了 PUT */
  uploaded: boolean
  /** 是否复用了远端已有的同内容文件（跨条目去重 / 同路径已存在） */
  deduped: boolean
  /** 条目最终指向的远端 zip 相对路径 */
  file: string
}

/** 上传条目 zip（按 hash 去重，含跨条目复用）并更新 manifest，返回最新 etag */
export async function pushEntry(
  store: SyncStore,
  client: WebDavClient,
  input: PushEntryInput,
): Promise<PushEntryResult> {
  const file = remoteZipRelPath(input.entry)
  // 1) 先读清单，判断是否需要上传（同 key 同 hash 去重）
  const { manifest, etag } = await store.read()
  const key = entryKey(input.entry)
  const existing = manifest.entries.find((e) => entryKey(e) === key)
  if (existing && existing.hash === input.entry.hash && !existing.deleted) {
    return { etag, uploaded: false, deduped: false, file: existing.file } // 内容相同，无需重复上传
  }

  // 2) 跨条目同内容复用（D9）：远端任意 alive 条目 hash 相同 → 不传文件
  const reusable = input.dedupeRemote
    ? manifest.entries.find((e) => !e.deleted && e.hash === input.entry.hash && entryKey(e) !== key)
    : undefined
  let targetFile = file
  let uploaded = false
  let deduped = false

  if (reusable) {
    targetFile = reusable.file
    deduped = true
  } else if (input.dedupeRemote && (await client.exists(file))) {
    // 文件名带 hash 前缀：同路径已存在 = 同内容，跳过 PUT 只更新 manifest
    deduped = true
  } else {
    const stagingRel = `staging/${path.basename(file)}`
    // 目标集合必须先建：实测部分服务端（muhuix DAV / 部分 Nginx WebDAV 模块）
    // 对「MOVE 到不存在的集合」返回 403 而不是 409，不建目录会直接导致首次上传全失败。
    const targetDir = path.posix.dirname(targetFile)
    await client.ensureDir('staging')
    await client.putFile(stagingRel, input.zipPath)
    try {
      if (targetDir && targetDir !== '.' && targetDir !== '/') await client.ensureDir(targetDir)
      await client.move(stagingRel, targetFile)
    } catch (err) {
      // MOVE 失败时清掉 staging 残留，避免远端堆积无引用的 zip
      await client.deleteFile(stagingRel).catch(() => undefined)
      throw err
    }
    uploaded = true
  }

  // 3) 更新 manifest（带条件写 + 冲突重试）
  const now = new Date().toISOString()
  const res = await withManifestLock(store, input.machineId, (m) => ({
    manifest: upsertEntry(m, { ...input.entry, file: targetFile, deleted: false }, now),
    result: null,
  }))
  return { etag: res.etag, uploaded, deduped, file: targetFile }
}

/** 软删除条目（墓碑 + 文件移到回收站）；同文件被其它条目复用时不动文件 */
export async function deleteEntry(
  store: SyncStore,
  client: WebDavClient,
  kind: RemoteEntry['kind'],
  name: string,
  machineId: string,
): Promise<void> {
  const { manifest } = await store.read()
  const key = entryKey({ kind, name })
  const target = manifest.entries.find((e) => entryKey(e) === key && !e.deleted)
  if (!target) return
  const sharedByOther = manifest.entries.some((e) => !e.deleted && entryKey(e) !== key && e.file === target.file)
  if (!sharedByOther) {
    // 移入回收站（尽力而为，失败不阻塞 manifest 更新）
    const trashRel = `${TRASH_REL}/${path.basename(target.file)}.${Date.now()}`
    await client.ensureDir(TRASH_REL)
    await client.move(target.file, trashRel).catch(() => undefined)
  }
  const now = new Date().toISOString()
  await withManifestLock(store, machineId, (m) => ({ manifest: markDeleted(m, kind, name, now), result: null }))
}

// ---------- prune：清理超期 trash 与墓碑 ----------

export interface PruneOptions {
  /** 硬删除墓碑（默认 false：只清超期 trash） */
  hardDelete?: boolean
  /** trash 保留时长，默认 7 天 */
  trashMaxAgeMs?: number
}

export interface PruneResult {
  trashRemoved: number
  tombstonesRemoved: number
}

export const DEFAULT_TRASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 同步结束后的远端清理（D8 的远端侧）：
 * - 回收站文件超过 7 天 → 物理删除；
 * - hardDelete=true 时，墓碑条目永久移除，并清掉对应回收站文件。
 */
export async function pruneRemote(
  store: SyncStore,
  client: WebDavClient,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const maxAge = opts.trashMaxAgeMs ?? DEFAULT_TRASH_MAX_AGE_MS
  const now = Date.now()
  const trash = await client.listDir(TRASH_REL)
  let trashRemoved = 0
  for (const item of trash) {
    if (item.type !== 'file') continue
    const at = item.mtime ? Date.parse(item.mtime) : Number.NaN
    const expired = Number.isNaN(at) ? true : now - at > maxAge
    if (!expired) continue
    await client.deleteFile(`${TRASH_REL}/${item.name}`)
    trashRemoved += 1
  }

  let tombstonesRemoved = 0
  if (opts.hardDelete) {
    const { manifest, etag } = await store.read()
    const tombstones = manifest.entries.filter((e) => e.deleted)
    if (tombstones.length > 0) {
      // 先清墓碑对应的回收站文件（trash 名 = <原文件名>.<时间戳>）
      for (const tomb of tombstones) {
        const base = path.basename(tomb.file)
        for (const item of trash) {
          if (item.type === 'file' && item.name.startsWith(`${base}.`)) {
            await client.deleteFile(`${TRASH_REL}/${item.name}`)
            trashRemoved += 1
          }
        }
      }
      const next: RemoteManifest = {
        ...manifest,
        updatedAt: new Date().toISOString(),
        entries: manifest.entries.filter((e) => !e.deleted),
      }
      await store.commit(next, etag, null)
      tombstonesRemoved = tombstones.length
    }
  }
  return { trashRemoved, tombstonesRemoved }
}

export type { MachineInfo, LockHandle, RemoteManifest, RemoteEntry }
export { LOCK_REL }
