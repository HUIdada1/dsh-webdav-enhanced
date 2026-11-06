/*
 * HTTP 路由层：把 core 能力暴露给设置页前端（/api/webdav-enhanced/*）。
 * 只依赖 host 注入的 HttpContext，不直接接触 cordis 运行时，
 * 因此可以在纯 node 环境下用 mock 测试。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWebDavClient } from './core/webdav.js'
import { WebDavSyncStore } from './core/webdav-store.js'
import { scanLocal } from './core/scan.js'
import { defaultConfig, type ConfigStore } from './core/config-store.js'
import { emptyManifest } from './core/manifest.js'
import type { CredentialStore } from './core/credentials.js'
import type { EntryKind, PluginConfig, ResolvedEnv, SyncRunReport } from './types.js'

export const HTTP_PREFIX = '/api/webdav-enhanced'

export interface HttpRuntime {
  store: ConfigStore
  creds: CredentialStore
  env: ResolvedEnv
  remoteRoot: string
  /** 明文密码：本地凭据文件优先，其次 cordis 配置 */
  getPassword(): string
  setPassword(password: string): void
}

export interface HttpContext {
  ready(): Promise<HttpRuntime>
  reprobe(): Promise<ResolvedEnv>
  logs(): { at: string; message: string }[]
  stopScheduler(): void
  /** 立即执行一次完整同步（面板「立即同步」与 Agent 工具共用） */
  runSync(): Promise<SyncRunReport>
}

/** dsh webServer 服务的最小契约（与 @deepseek-ai/dsh-host-webserver 对齐） */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

export function registerHttpRoutes(webServer: WebServerLike, ctx: HttpContext): () => void {
  return webServer.register({
    kind: 'prefix',
    path: HTTP_PREFIX,
    handler: (req, res) => {
      void handle(req, res, ctx).catch((err: unknown) => {
        sendJson(res, 500, { error: (err as Error).message })
      })
    },
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(HTTP_PREFIX.length) || '/'
  const method = (req.method ?? 'GET').toUpperCase()
  try {
    const payload = await dispatch(route, method, req, url, ctx)
    sendJson(res, 200, payload)
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message })
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text) as Record<string, any>
}

async function dispatch(
  route: string,
  method: string,
  req: IncomingMessage,
  url: URL,
  ctx: HttpContext,
): Promise<unknown> {
  switch (route) {
    case '/config':
      return method === 'POST' ? saveConfig(req, ctx) : getConfig(ctx)
    case '/status':
      return getStatus(ctx)
    case '/test':
      return testConnection(req)
    case '/items':
      return listItems(url, ctx)
    case '/sync':
      if (method !== 'POST') throw new Error('/sync requires POST')
      return ctx.runSync()
    case '/reprobe':
      return await ctx.reprobe()
    case '/reset':
      return resetLocal(ctx)
    case '/clear-remote':
      return clearRemote(ctx)
    default:
      throw new Error(`unknown route: ${route}`)
  }
}

const KIND_MAP: Record<string, EntryKind> = { bundles: 'bundle', skills: 'skill', configs: 'config' }

/** 对外配置视图：永不包含明文密码 */
function publicConfig(cfg: PluginConfig) {
  return {
    connection: {
      url: cfg.connection.url,
      username: cfg.connection.username,
      passwordRef: cfg.connection.passwordRef,
    },
    options: cfg.options,
    scope: cfg.scope,
    schedule: cfg.schedule,
    conflictPolicy: cfg.conflictPolicy,
    machineId: cfg.machineId,
    lastSyncAt: cfg.lastSyncAt,
  }
}

function connectionOf(rt: HttpRuntime) {
  const cfg = rt.store.load()
  const options = cfg.options ?? { timeoutMs: 30000, remoteRoot: rt.remoteRoot, ignoreTlsErrors: false }
  return {
    url: cfg.connection.url,
    username: cfg.connection.username,
    password: rt.getPassword(),
    remoteRoot: options.remoteRoot || rt.remoteRoot,
    timeoutMs: options.timeoutMs,
    ignoreTlsErrors: options.ignoreTlsErrors === true,
  }
}

async function getConfig(ctx: HttpContext): Promise<unknown> {
  const rt = await ctx.ready()
  return publicConfig(rt.store.load())
}

async function saveConfig(req: IncomingMessage, ctx: HttpContext): Promise<unknown> {
  const rt = await ctx.ready()
  const body = await readJson(req)
  const cur = rt.store.load()

  if (body.connection && typeof body.connection.password === 'string' && body.connection.password !== '') {
    rt.creds.write(body.connection.password)
    rt.setPassword(body.connection.password)
  }

  const patch: Partial<PluginConfig> = {}
  if (body.connection) {
    patch.connection = {
      url: String(body.connection.url ?? cur.connection.url),
      username: String(body.connection.username ?? cur.connection.username),
      passwordRef: body.connection.passwordRef === 'keychain' ? 'keychain' : cur.connection.passwordRef,
    }
  }
  if (body.scope) patch.scope = { ...cur.scope, ...body.scope }
  if (body.options) patch.options = { ...cur.options, ...body.options }
  if (body.schedule) patch.schedule = { ...cur.schedule, ...body.schedule }
  if (body.conflictPolicy) patch.conflictPolicy = body.conflictPolicy

  rt.store.update(patch)
  return publicConfig(rt.store.load())
}

async function getStatus(ctx: HttpContext): Promise<unknown> {
  const rt = await ctx.ready()
  const cfg = rt.store.load()
  let lock: { machineId: string; startedAt: string; expiresAt: string } | null = null
  if (cfg.connection.url) {
    try {
      lock = await createWebDavClient(connectionOf(rt)).currentLockHolder()
    } catch {
      lock = null
    }
  }
  return {
    lastSyncAt: cfg.lastSyncAt,
    machineId: cfg.machineId,
    env: rt.env,
    schedule: cfg.schedule,
    conflictPolicy: cfg.conflictPolicy,
    lock,
    logs: ctx.logs(),
  }
}

async function testConnection(req: IncomingMessage): Promise<unknown> {
  const body = await readJson(req)
  const client = createWebDavClient({
    url: String(body.url ?? ''),
    username: String(body.username ?? ''),
    password: String(body.password ?? ''),
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    ignoreTlsErrors: body.ignoreTlsErrors === true,
    remoteRoot: typeof body.remoteRoot === 'string' && body.remoteRoot ? body.remoteRoot : '/dsh-sync/',
  })
  return await client.testConnection()
}

async function listItems(url: URL, ctx: HttpContext): Promise<unknown> {
  const rt = await ctx.ready()
  const kind = KIND_MAP[url.searchParams.get('kind') ?? 'bundles'] ?? 'bundle'
  const cfg = rt.store.load()
  const errors: { stage: string; message: string }[] = []
  const entries = scanLocal(rt.env, cfg.scope, errors).filter((e) => e.kind === kind)
  return entries.map((e) => ({ name: e.name, version: e.version, kind: e.kind }))
}

async function resetLocal(ctx: HttpContext): Promise<unknown> {
  const rt = await ctx.ready()
  const machineId = rt.store.load().machineId
  ctx.stopScheduler()
  rt.creds.clear()
  const next = defaultConfig()
  next.machineId = machineId
  rt.store.save(next)
  return { ok: true }
}

async function clearRemote(ctx: HttpContext): Promise<unknown> {
  const rt = await ctx.ready()
  const cfg = rt.store.load()
  if (!cfg.connection.url) throw new Error('WebDAV 未配置')
  const conn = connectionOf(rt)
  const client = createWebDavClient(conn)
  const store = new WebDavSyncStore(conn)
  const { manifest, etag } = await store.read()
  const alive = manifest.entries.filter((e) => !e.deleted)
  let removed = 0
  for (const entry of alive) {
    try {
      await client.deleteFile(entry.file)
      removed += 1
    } catch {
      /* 尽力而为：单文件失败不阻塞整体清空 */
    }
  }
  await store.commit(emptyManifest(), etag, null)
  return { ok: true, removed }
}
