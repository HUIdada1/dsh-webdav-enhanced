/*
 * HTTP 路由层（v2）：把 core 能力暴露给设置页前端（/api/webdav-enhanced/*）。
 * 只做「解析请求 → 调 HttpContext → 回 JSON」，不接触 cordis 运行时、不直接碰文件/网络，
 * 因此可以在纯 node 环境下用 mock 测试（host.test.ts）。
 *
 * 契约见 docs/DESIGN-v2.md §5：
 * - POST /sync 立即返回 {started, runId, alreadyRunning}，绝不 await 整轮；
 * - 所有失败响应 { error }（400/500）；
 * - /progress 空闲时 phase='idle' + report=上次报告。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  EntryKind,
  LogCategory,
  LogEntry,
  LogLevel,
  LogQuery,
  PlanResult,
  PublicConfig,
  ResolvedEnv,
  RunProgress,
  StatusPayload,
  SyncRunReport,
  SyncTrigger,
  TestConnectionResult,
} from './types.js'

export const HTTP_PREFIX = '/api/webdav-enhanced'

export interface StartSyncResult {
  started: boolean
  runId: string
  alreadyRunning: boolean
}

export interface ItemInfo {
  name: string
  version: string | null
  kind: EntryKind
  hash: string
  sizeBytes: number
  modifiedAt: string
  /** kind=config 时附带：可勾选的顶层 key 列表（不含敏感 key，供「内容」页做勾选） */
  keys?: string[]
}

/** host 注入的业务能力（全部由 host.ts 实现，http.ts 只转发） */
export interface HttpContext {
  getConfig(): Promise<PublicConfig>
  saveConfig(body: Record<string, unknown>): Promise<PublicConfig>
  testConnection(body: Record<string, unknown>): Promise<TestConnectionResult>
  items(kind: EntryKind): Promise<ItemInfo[]>
  status(): Promise<StatusPayload>
  progress(): RunProgress
  plan(): Promise<PlanResult>
  startSync(trigger?: SyncTrigger): StartSyncResult
  cancelSync(): { cancelled: boolean }
  logs(query: LogQuery): { entries: LogEntry[]; total: number }
  reprobe(profile?: string): Promise<ResolvedEnv>
  reset(): Promise<{ ok: true }>
  clearRemote(): Promise<{ ok: true; removed: number }>
  /** Agent 工具用：等待整轮结束并返回报告 */
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

function requirePost(method: string, route: string): void {
  if (method !== 'POST') throw new Error(`${route} requires POST`)
}

function requireGet(method: string, route: string): void {
  if (method !== 'GET') throw new Error(`${route} requires GET`)
}

const KIND_MAP: Record<string, EntryKind> = { bundles: 'bundle', skills: 'skill', configs: 'config' }

function parseLogQuery(url: URL): LogQuery {
  const query: LogQuery = {}
  const rawLimit = url.searchParams.get('limit')
  if (rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit)
    if (Number.isFinite(n) && n > 0) query.limit = Math.floor(n)
  }
  const level = url.searchParams.get('level')
  if (level) query.level = level as LogLevel
  const category = url.searchParams.get('category')
  if (category) query.category = category as LogCategory
  return query
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
      if (method === 'POST') return ctx.saveConfig(await readJson(req))
      requireGet(method, '/config')
      return ctx.getConfig()

    case '/status':
      requireGet(method, '/status')
      return ctx.status()

    case '/test':
      requirePost(method, '/test')
      return ctx.testConnection(await readJson(req))

    case '/items': {
      requireGet(method, '/items')
      const kind = KIND_MAP[url.searchParams.get('kind') ?? 'bundles'] ?? 'bundle'
      return ctx.items(kind)
    }

    case '/progress':
      requireGet(method, '/progress')
      return ctx.progress()

    case '/plan':
      requireGet(method, '/plan')
      return ctx.plan()

    case '/sync':
      requirePost(method, '/sync')
      // 立即返回，绝不 await 整轮（DESIGN-v2 §5 并发约束）
      return ctx.startSync('manual')

    case '/cancel':
      requirePost(method, '/cancel')
      return ctx.cancelSync()

    case '/logs':
      requireGet(method, '/logs')
      return ctx.logs(parseLogQuery(url))

    case '/reprobe': {
      requirePost(method, '/reprobe')
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
      const profile = typeof body.profile === 'string' ? body.profile : undefined
      return ctx.reprobe(profile)
    }

    case '/reset':
      requirePost(method, '/reset')
      return ctx.reset()

    case '/clear-remote':
      requirePost(method, '/clear-remote')
      return ctx.clearRemote()

    default:
      throw new Error(`unknown route: ${route}`)
  }
}
