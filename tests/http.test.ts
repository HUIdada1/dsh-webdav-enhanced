import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { HTTP_PREFIX, registerHttpRoutes, type HttpContext } from '../src/http.js'
import type {
  LogEntry,
  LogQuery,
  PlanResult,
  PublicConfig,
  RunProgress,
  StatusPayload,
} from '../src/types.js'

function mkProgress(over: Partial<RunProgress> = {}): RunProgress {
  return {
    runId: 'run-1',
    active: false,
    phase: 'idle',
    phaseLabel: '空闲',
    trigger: 'manual',
    startedAt: '',
    finishedAt: null,
    total: 0,
    done: 0,
    percent: 0,
    current: null,
    message: '空闲',
    items: [],
    counts: { upload: 0, download: 0, merge: 0, skip: 0, remove: 0, conflict: 0, failed: 0, deduped: 0 },
    report: null,
    ...over,
  }
}

function mkConfig(): PublicConfig {
  return {
    connection: { url: 'https://dav.example.com/', username: 'alice', passwordRef: 'credentials', hasPassword: true },
    options: { timeoutMs: 30000, remoteRoot: '/dsh-sync/', ignoreTlsErrors: false },
    scope: {
      bundles: { mode: 'all', exclude: [] },
      skills: { mode: 'all', exclude: [] },
      configs: { mode: 'none', includeKeys: [] },
    },
    schedule: { enabled: false, intervalHours: 1, direction: 'both' },
    conflictPolicy: 'auto',
    syncOptions: {
      propagateDeletions: true,
      autoResolve: 'auto',
      dedupeRemote: true,
      autoInstall: true,
      contentMerge: true,
      maxBackups: 10,
      pruneTombstones: true,
      hardDelete: false,
    },
    machineId: 'm1',
    profile: 'web',
    lastSyncAt: null,
    version: '0.4.0',
    env: null,
  }
}

function mkCtx(over: Partial<HttpContext> = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const record = (method: string, result: unknown) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push({ method, args })
      return result
    })
  const ctx: HttpContext = {
    getConfig: vi.fn(async () => mkConfig()),
    saveConfig: vi.fn(async () => mkConfig()),
    testConnection: vi.fn(async () => ({ ok: true, steps: [], capabilities: { supportsLock: false, supportsIfHeader: false, server: null } })),
    items: vi.fn(async () => []),
    status: vi.fn(async (): Promise<StatusPayload> => ({
      lastSyncAt: null,
      machineId: 'm1',
      env: null,
      schedule: { enabled: false, intervalHours: 1, direction: 'both' },
      conflictPolicy: 'auto',
      syncOptions: mkConfig().syncOptions,
      direction: 'both',
      lock: null,
      counts: { upload: 0, download: 0, merge: 0, skip: 0, remove: 0, conflict: 0, failed: 0, deduped: 0 },
      lastReport: null,
      capabilities: null,
    })),
    progress: () => mkProgress(),
    plan: vi.fn(async (): Promise<PlanResult> => ({
      generatedAt: new Date().toISOString(),
      direction: 'both',
      items: [],
      summary: { upload: 0, download: 0, merge: 0, skip: 0, remove: 0, conflict: 0, total: 0 },
      errors: [],
    })),
    startSync: vi.fn(() => ({ started: true, runId: 'run-1', alreadyRunning: false })),
    cancelSync: vi.fn(() => ({ cancelled: false })),
    logs: vi.fn((query: LogQuery) => ({ entries: [] as LogEntry[], total: 0, query })),
    reprobe: vi.fn(async () => ({}) as never),
    reset: vi.fn(async () => ({ ok: true as const })),
    clearRemote: vi.fn(async () => ({ ok: true as const, removed: 3 })),
    runSync: vi.fn(async () => ({}) as never),
    ...over,
  }
  void record
  return { ctx, calls }
}

interface Captured {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
}

function harness(ctx: HttpContext) {
  const routes: Captured[] = []
  const off = registerHttpRoutes(
    {
      register: (route: Captured) => {
        routes.push(route)
        return () => undefined
      },
    },
    ctx,
  )
  const route = routes[0]

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    ;(req as unknown as { method: string }).method = method
    ;(req as unknown as { url: string }).url = HTTP_PREFIX + path
    let status = 0
    const res = {
      writableEnded: false,
      writeHead(code: number) {
        status = code
        return this
      },
      end(text: string) {
        this.writableEnded = true
        return JSON.parse(text) as unknown
      },
    } as unknown as ServerResponse
    await new Promise<void>((resolve, reject) => {
      const originalEnd = res.end.bind(res) as (text: string) => void
      ;(res as unknown as { end: (text: string) => void }).end = (text: string) => {
        const parsed = originalEnd(text)
        ;(res as unknown as { parsed: unknown }).parsed = parsed
        resolve()
      }
      route.handler(req, res)
    })
    return { status, body: (res as unknown as { parsed: unknown }).parsed }
  }

  return { routes, route, call, off }
}

describe('http routes（DESIGN-v2 §5）', () => {
  it('只注册一个 prefix 路由', () => {
    const { ctx } = mkCtx()
    const { routes } = harness(ctx)
    expect(routes).toHaveLength(1)
    expect(routes[0].kind).toBe('prefix')
    expect(routes[0].path).toBe('/api/webdav-enhanced')
  })

  it('POST /sync 立即返回 {started, runId, alreadyRunning}，不 await 整轮', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    const res = await call('POST', '/sync', { trigger: 'manual' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ started: true, runId: 'run-1', alreadyRunning: false })
    expect(ctx.startSync).toHaveBeenCalledWith('manual')
    // 是同步调用（提交给 ctx 后立刻返回），不是等 runSync 的 Promise
    expect(ctx.runSync).not.toHaveBeenCalled()
  })

  it('运行中 POST /sync 仍返回 HTTP 200 + alreadyRunning', async () => {
    const { ctx } = mkCtx({
      startSync: vi.fn(() => ({ started: false, runId: 'run-9', alreadyRunning: true })),
    })
    const { call } = harness(ctx)
    const res = await call('POST', '/sync', {})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ started: false, runId: 'run-9', alreadyRunning: true })
  })

  it('POST /cancel 空闲时也返回 200 {cancelled:false}', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    const res = await call('POST', '/cancel')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ cancelled: false })
  })

  it('GET /progress 返回空闲快照（phase=idle）', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    const res = await call('GET', '/progress')
    expect(res.status).toBe(200)
    expect(res.body.phase).toBe('idle')
    expect(res.body.active).toBe(false)
  })

  it('GET /logs 解析 limit / level / category', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    const res = await call('GET', '/logs?limit=5&level=error&category=upload')
    expect(res.status).toBe(200)
    expect(ctx.logs).toHaveBeenCalledWith({ limit: 5, level: 'error', category: 'upload' })
  })

  it('GET /items 按 kind 参数映射到 EntryKind', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    await call('GET', '/items?kind=skills')
    expect(ctx.items).toHaveBeenCalledWith('skill')
    await call('GET', '/items?kind=configs')
    expect(ctx.items).toHaveBeenCalledWith('config')
    await call('GET', '/items')
    expect(ctx.items).toHaveBeenCalledWith('bundle')
  })

  it('POST /config 直接透传请求体', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    const body = { schedule: { enabled: true, intervalHours: 2, direction: 'upload' } }
    const res = await call('POST', '/config', body)
    expect(res.status).toBe(200)
    expect(ctx.saveConfig).toHaveBeenCalledWith(body)
  })

  it('GET /config 返回 PublicConfig 关键字段（不含明文密码）', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    const res = await call('GET', '/config')
    expect(res.status).toBe(200)
    expect(res.body.connection).toMatchObject({
      url: 'https://dav.example.com/',
      username: 'alice',
      passwordRef: 'credentials',
      hasPassword: true,
    })
    expect(res.body.syncOptions).toBeTruthy()
    expect(res.body.version).toBe('0.4.0')
    expect(JSON.stringify(res.body)).not.toContain('password":"')
  })

  it('POST /test /reprobe /reset /clear-remote 正常透传', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    expect((await call('POST', '/test', { url: 'https://x' })).status).toBe(200)
    expect((await call('POST', '/reprobe')).status).toBe(200)
    expect((await call('POST', '/reset')).body).toEqual({ ok: true })
    const cleared = await call('POST', '/clear-remote')
    expect(cleared.body).toEqual({ ok: true, removed: 3 })
  })

  it('未知路由 / 方法不匹配返回 400 {error}', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    const unknown = await call('GET', '/nope')
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toContain('unknown route')
    const badMethod = await call('GET', '/sync')
    expect(badMethod.status).toBe(400)
    expect(badMethod.body.error).toContain('requires POST')
  })

  it('GET /status 返回 StatusPayload', async () => {
    const { ctx } = mkCtx()
    const { call } = harness(ctx)
    const res = await call('GET', '/status')
    expect(res.status).toBe(200)
    expect(res.body.machineId).toBe('m1')
    expect(res.body.direction).toBe('both')
  })
})
