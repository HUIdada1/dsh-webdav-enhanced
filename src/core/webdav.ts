/*
 * M2 WebDAV 客户端。
 * - 库：webdav（webdav-client v5），纯 JS 跨平台。
 * - 容错：指数退避重试（仅网络类 / 5xx / 429）；401/403 直接失败；断点续传。
 * - 锁：优先服务端原生 LOCK（client.lock），失败降级为软锁文件（last-writer + 冲突副本）。
 * - 条件写：putJsonIfMatch 用 If-Match（etag），服务端 412 → ManifestConflictError。
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createClient, AuthType, type Headers, type LockResponse, type WebDAVClient } from 'webdav'
import {
  ManifestConflictError,
  type LockHandle,
  type RemoteDirItem,
  type ServerCapabilities,
  type TestConnectionResult,
  type WebDavClient,
  type WebDavConnectionConfig,
} from '../types.js'

const PART_SUFFIX = '.part'

function normalizeRoot(root?: string): string {
  const r = (root ?? '/dsh-sync/').trim()
  const withSlash = r.startsWith('/') ? r : '/' + r
  return withSlash.endsWith('/') ? withSlash : withSlash + '/'
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number; response?: { status?: number } })?.status ??
    (err as { response?: { status?: number } })?.response?.status
}

function isAuthError(err: unknown): boolean {
  const s = statusOf(err)
  return s === 401 || s === 403
}

function isRetryable(err: unknown): boolean {
  if (isAuthError(err)) return false
  const s = statusOf(err)
  if (s === undefined || s === null) return true // 网络错
  if (s >= 500) return true
  if (s === 429) return true
  return false
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

class WebDavClientImpl implements WebDavClient {
  private client: WebDAVClient
  private readonly root: string
  private capabilities: ServerCapabilities | null = null

  constructor(private readonly cfg: WebDavConnectionConfig) {
    this.root = normalizeRoot(cfg.remoteRoot)
    const creds: Record<string, unknown> = {}
    if (cfg.username) {
      creds.username = cfg.username
      creds.password = cfg.password
      // AuthType.Password = Basic，一次性头无需 challenge 往返，
      // 对 customRequest / 条件写 都直接生效（坚果云、Nextcloud 都支持 Basic over HTTPS）。
      // Digest 模式在 customRequest 下无法 re-challenge，会卡在 401。
      creds.authType = AuthType.Password
    }
    this.client = createClient(cfg.url, {
      ...creds,
      headers: { 'User-Agent': 'dsh-webdav-enhanced/0.2.0' } as Headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    } as Parameters<typeof createClient>[1])
  }

  private abs(rel: string): string {
    return this.root + rel.replace(/^\/+/, '')
  }

  private async withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 4): Promise<T> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (!isRetryable(err)) throw err
        const delay = 1000 * 2 ** attempt
        console.warn(`[webdav-enhanced] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retry in ${delay}ms`)
        await sleep(delay)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  // ---------- connection test ----------

  async testConnection(): Promise<TestConnectionResult> {
    const steps: TestConnectionResult['steps'] = []

    const run = async (step: TestConnectionResult['steps'][number]['step'], fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
        steps.push({ step, ok: true, detail: 'ok' })
      } catch (err) {
        const code = statusOf(err)
        const detail = code ? `HTTP ${code}` : (err as Error).message
        steps.push({ step, ok: false, detail })
      }
    }

    await run('propfind', async () => {
      await this.client.stat('/')
    })
    await run('mkcol', async () => {
      try {
        await this.client.createDirectory(this.root)
      } catch (err) {
        const code = statusOf(err)
        // 405：已存在。423：集合存在但被锁（部分服务端对已存在目录返回它），
        // 只要 PROPFIND 能读到就当目录就绪，真正的写入问题留给 put 报。
        if (code === 405) return
        if (code === 423 && (await this.client.stat(this.root).catch(() => null))) return
        throw err
      }
    })
    const probeRel = `_probe-${Date.now()}.txt`
    await run('put', async () => {
      await this.client.putFileContents(this.abs(probeRel), 'probe', { overwrite: true })
    })
    await run('readback', async () => {
      const back = (await this.client.getFileContents(this.abs(probeRel), { format: 'text' })) as string
      if (back !== 'probe') throw new Error(`readback mismatch: got ${back}`)
      await this.client.deleteFile(this.abs(probeRel)).catch(() => undefined)
    })

    // 能力探测放在最后：不产生副作用（OPTIONS，不再对真实目录 LOCK）。
    // 旧实现先 LOCK 根目录再 unlock，unlock 失败就会把整棵子树锁住，
    // 随后的 MKCOL/PUT 全部 423 —— 测试把自己测挂了。
    const caps = await this.probeCapabilities()

    if (process.env.DBG_WEBDAV) console.log('[testConnection]', JSON.stringify(steps, null, 2))
    return { ok: steps.every((s) => s.ok), steps, capabilities: caps }
  }

  private async probeCapabilities(): Promise<ServerCapabilities> {
    if (this.capabilities) return this.capabilities
    let supportsLock = false
    let supportsIfHeader = false
    let server: string | null = null
    try {
      const res = await this.client.customRequest(this.root, { method: 'OPTIONS' })
      const headers = (res.headers ?? {}) as unknown as Record<string, string>
      const pick = (name: string): string => {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
        return key ? String(headers[key]) : ''
      }
      const dav = pick('dav').toLowerCase()
      const allow = pick('allow').toUpperCase()
      // DAV: 2 表示支持锁定；也有服务端只在 Allow 里列 LOCK
      supportsLock = dav.split(',').map((s) => s.trim()).includes('2') || /(^|,)\s*LOCK\s*(,|$)/.test(allow)
      supportsIfHeader = dav.includes('2') || allow.includes('LOCK')
      server = pick('server') || null
    } catch {
      supportsLock = false
      supportsIfHeader = true
    }
    this.capabilities = { supportsLock, supportsIfHeader, server }
    return this.capabilities
  }

  // ---------- basic ops ----------

  async exists(rel: string): Promise<boolean> {
    try {
      await this.client.stat(this.abs(rel))
      return true
    } catch {
      return false
    }
  }

  async ensureDir(rel: string): Promise<void> {
    const target = this.abs(rel).replace(/\/+$/, '')
    const segments = target.split('/').filter(Boolean)
    let cur = ''
    for (const seg of segments) {
      cur += '/' + seg
      try {
        await this.client.createDirectory(cur)
      } catch (err) {
        if (statusOf(err) !== 405) throw err
      }
    }
  }

  async stat(rel: string) {
    try {
      const s = await this.client.stat(this.abs(rel))
      const st = s as { etag?: string; size?: number; lastmod?: string }
      return { etag: st.etag ?? null, size: st.size ?? 0, mtime: st.lastmod ?? null }
    } catch {
      return null
    }
  }

  // ---------- upload / download with resume ----------

  async putFile(rel: string, localPath: string, _opts?: { resume?: boolean }): Promise<void> {
    const remote = this.abs(rel)
    const part = remote + PART_SUFFIX
    const size = statSync(localPath).size
    const uploaded = await this.remoteSize(part).catch(() => 0)
    const start = uploaded > 0 && uploaded < size ? uploaded : 0

    await this.withRetry(async () => {
      const buf = await readFile(localPath)
      const chunk = start > 0 ? buf.subarray(start) : buf
      await this.client.putFileContents(part, chunk, {
        overwrite: true,
        headers: start > 0 ? ({ 'Content-Range': `bytes ${start}-${size - 1}/${size}` } as Headers) : undefined,
      })
    }, `put ${rel}`)

    await this.withRetry(() => this.client.moveFile(part, remote), `move ${rel}`)
  }

  async getFile(rel: string, localPath: string, _opts?: { resume?: boolean }): Promise<void> {
    const remote = this.abs(rel)
    const part = localPath + PART_SUFFIX
    const remoteSize = (await this.stat(rel))?.size ?? 0
    const have = existsSync(part) ? statSync(part).size : 0
    const start = have > 0 && have < remoteSize ? have : 0

    await mkdir(path.dirname(localPath), { recursive: true })
    await this.withRetry(async () => {
      const stream = this.client.createReadStream(remote, {
        range: start > 0 ? { start } : undefined,
      } as Parameters<WebDAVClient['createReadStream']>[1])
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(part, { flags: start > 0 ? 'a' : 'w' })
        stream.pipe(out as unknown as NodeJS.WritableStream).on('finish', () => resolve()).on('error', reject)
      })
    }, `get ${rel}`)

    const finalSize = statSync(part).size
    if (remoteSize > 0 && finalSize !== remoteSize) {
      await unlink(part).catch(() => undefined)
      throw new Error(`download size mismatch for ${rel}: ${finalSize} != ${remoteSize}`)
    }
    await rename(part, localPath)
  }

  private async remoteSize(rel: string): Promise<number> {
    const s = await this.stat(rel)
    return s?.size ?? 0
  }

  // ---------- json helpers ----------

  async getJson<T>(rel: string): Promise<T | null> {
    if (!(await this.exists(rel))) return null
    const tmp = path.join(this.tmpDir(), `${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    try {
      await this.getFile(rel, tmp)
      return JSON.parse(await readFile(tmp, 'utf8')) as T
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  }

  async putJsonIfMatch(rel: string, data: unknown, etag: string | null): Promise<string | null> {
    const remote = this.abs(rel)
    const body = JSON.stringify(data, null, 2)
    const headers: Headers = { 'Content-Type': 'application/json' }
    if (etag) headers['If-Match'] = etag
    const res = await this.client.customRequest(remote, { method: 'PUT', headers, data: body })
    const status = res.status
    if (status === 412) throw new ManifestConflictError(etag)
    if (status < 200 || status >= 300) throw new Error(`PUT ${rel} failed: HTTP ${status}`)
    const newEtag = (res.headers as unknown as Record<string, string>)?.['etag'] ?? null
    return newEtag ? String(newEtag).replace(/"/g, '') : null
  }

  async deleteFile(rel: string): Promise<void> {
    await this.client.deleteFile(this.abs(rel)).catch(() => undefined)
  }

  /** 列出远端目录（prune 清理回收站用）；目录不存在 / 服务端报错返回空数组 */
  async listDir(rel: string): Promise<RemoteDirItem[]> {
    try {
      const items = (await this.client.getDirectoryContents(this.abs(rel))) as unknown as Array<{
        basename?: string
        type?: string
        size?: number
        lastmod?: string
      }>
      if (!Array.isArray(items)) return []
      return items
        .filter((i) => typeof i?.basename === 'string' && i.basename !== '.' && i.basename !== '..')
        .map((i) => ({
          name: i.basename as string,
          type: i.type === 'directory' ? ('directory' as const) : ('file' as const),
          size: typeof i.size === 'number' ? i.size : 0,
          mtime: typeof i.lastmod === 'string' ? i.lastmod : null,
        }))
    } catch {
      return []
    }
  }

  async move(rel: string, destPath: string): Promise<void> {
    await this.client.moveFile(this.abs(rel), this.abs(destPath))
  }

  // ---------- locks ----------

  async acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null> {
    // 锁文件在 locks/ 子目录里：必须先建集合，否则「PUT 到不存在的集合」
    // 在部分服务端（实测 muhuix DAV）直接 403 —— 那一刻整个同步会在取锁阶段就失败。
    await this.ensureDir('locks').catch(() => undefined)
    // 优先原生 LOCK
    const caps = await this.probeCapabilities()
    if (caps.supportsLock) {
      try {
        const res: LockResponse = await this.client.lock(this.root + 'locks/sync.lock', {
          timeout: `Second-${Math.max(1, Math.round(ttlMs / 1000))}`,
        })
        if (res?.token) {
          const token = res.token
          return {
            machineId,
            acquiredAt: new Date().toISOString(),
            release: async () => {
              await this.client.unlock(this.root + 'locks/sync.lock', token).catch(() => undefined)
            },
          }
        }
      } catch {
        /* 降级软锁 */
      }
    }
    // 软锁：读-改-写（非原子，manifest 条件写兜底）
    const rel = 'locks/sync.lock'
    const now = Date.now()
    const cur = await this.getJson<{ machineId: string; expiresAt: string }>(rel).catch(() => null)
    if (cur && new Date(cur.expiresAt).getTime() > now && cur.machineId !== machineId) return null
    const body = JSON.stringify({
      machineId,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    })
    await this.withTmpFile(body, (tmp) => this.putFile(rel, tmp))
    return {
      machineId,
      acquiredAt: new Date().toISOString(),
      release: async () => {
        await this.deleteFile(rel).catch(() => undefined)
      },
    }
  }

  async currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null> {
    return await this.getJson<{ machineId: string; startedAt: string; expiresAt: string }>('locks/sync.lock').catch(() => null)
  }

  // ---------- helpers ----------

  private tmpDir(): string {
    // 用系统临时目录：早期版本落在 process.cwd()，会往用户项目里堆垃圾
    const dir = path.join(os.tmpdir(), 'dsh-webdav-enhanced')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private async writeTmp(content: string): Promise<string> {
    const p = path.join(this.tmpDir(), `${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
    await writeFile(p, content, 'utf8')
    return p
  }

  /** 写临时文件执行 fn，结束后无论成败都清理 */
  private async withTmpFile<T>(content: string, fn: (tmpPath: string) => Promise<T>): Promise<T> {
    const p = await this.writeTmp(content)
    try {
      return await fn(p)
    } finally {
      await unlink(p).catch(() => undefined)
    }
  }
}

export function createWebDavClient(cfg: WebDavConnectionConfig): WebDavClient {
  return new WebDavClientImpl(cfg)
}
