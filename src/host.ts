/*
 * 宿主入口：Cordis bundle 标准结构（name + Config + apply）。
 * - Config 用 Schemastery 定义，默认值齐全，改配置触发热更新。
 * - 注册 HTTP 路由（/api/webdav-enhanced/*）供设置页调用，另注册两个 Agent 工具。
 * - 持有 SyncEngine / ConfigStore / CredentialStore 生命周期；卸载时清理定时器。
 */
import os from 'node:os'
import Schema from 'schemastery'
import { resolveEnv } from './core/env.js'
import { ConfigStore, defaultConfig, generateMachineId, migrateLegacyData } from './core/config-store.js'
import { CredentialStore } from './core/credentials.js'
import { createSyncEngine, type SyncEngineImpl } from './core/sync.js'
import { createWebDavClient } from './core/webdav.js'
import { WebDavSyncStore } from './core/webdav-store.js'
import { registerHttpRoutes, type HttpContext, type HttpRuntime, type WebServerLike } from './http.js'
import type { ResolvedEnv } from './types.js'

export const name = 'webdav-enhanced'

/** 远端同步根目录（与 README 的目录布局一致） */
const REMOTE_ROOT = '/dsh-sync/'

/** 内存中保留的最近日志条数 */
const MAX_LOGS = 50

export interface Config {
  connection: {
    url: string
    username: string
    password: string
    passwordRef: 'keychain' | 'credentials'
  }
  schedule: {
    enabled: boolean
    intervalHours: number
    direction: 'both' | 'upload' | 'download'
  }
  scope: {
    bundles: { mode: 'all' | 'selected' | 'none'; exclude: string[] }
    skills: { mode: 'all' | 'selected' | 'none'; exclude: string[] }
    configs: { mode: 'all' | 'selected' | 'none'; includeKeys: string[] }
  }
  conflictPolicy: 'merge-backup' | 'ask' | 'local-wins' | 'remote-wins'
  machineId: string
  /** 要同步的 dsh profile 名（桌面版为 desktop，Web 版为 web） */
  profile: string
}

export const Config = Schema.object({
  connection: Schema.object({
    url: Schema.string().default(''),
    username: Schema.string().default(''),
    password: Schema.string().default(''),
    passwordRef: Schema.union(['keychain', 'credentials'] as const).default('credentials'),
  }),
  schedule: Schema.object({
    enabled: Schema.boolean().default(false),
    intervalHours: Schema.number().default(1),
    direction: Schema.union(['both', 'upload', 'download'] as const).default('both'),
  }),
  scope: Schema.object({
    bundles: Schema.object({
      mode: Schema.union(['all', 'selected', 'none'] as const).default('all'),
      exclude: Schema.array(String).default([]),
    }),
    skills: Schema.object({
      mode: Schema.union(['all', 'selected', 'none'] as const).default('all'),
      exclude: Schema.array(String).default([]),
    }),
    configs: Schema.object({
      mode: Schema.union(['all', 'selected', 'none'] as const).default('none'),
      includeKeys: Schema.array(String).default([]),
    }),
  }),
  conflictPolicy: Schema.union(['merge-backup', 'ask', 'local-wins', 'remote-wins'] as const).default('merge-backup'),
  machineId: Schema.string().default(generateMachineId()),
  profile: Schema.string().default('desktop'),
})

interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown> }
  execute: () => Promise<unknown>
}

/** cordis 服务容器：只有经过 ctx.inject 声明后才能访问 */
interface ServiceCtx {
  tools?: { register(tool: ToolRegistration): void }
  webServer?: WebServerLike
}

/** dsh 宿主 ctx 的最小契约 */
interface HostCtx {
  /** cordis 服务注入：访问服务前必须声明，否则抛 "cannot get property without inject" */
  inject(services: string[], callback: (ctx: ServiceCtx) => void): void
  on?(event: string, fn: () => void): void
}

interface Runtime {
  store: ConfigStore | null
  creds: CredentialStore | null
  env: ResolvedEnv | null
  engine: SyncEngineImpl | null
  password: string
  logs: { at: string; message: string }[]
}

export function apply(ctx: unknown, config: Config) {
  const host = ctx as HostCtx
  const runtime: Runtime = {
    store: null,
    creds: null,
    env: null,
    engine: null,
    password: config.connection.password,
    logs: [],
  }

  let initPromise: Promise<void> | null = null

  function pushLog(message: string): void {
    runtime.logs.push({ at: new Date().toISOString(), message })
    if (runtime.logs.length > MAX_LOGS) runtime.logs.splice(0, runtime.logs.length - MAX_LOGS)
  }

  async function init(): Promise<void> {
    if (runtime.store) return
    const env = await resolveEnv({ profile: config.profile })
    const dshHome = env.dshHome || process.env.DSH_HOME || os.homedir()

    // 旧版 webdav-sync 的数据目录/配置文件名一次性迁移到新命名
    migrateLegacyData(dshHome)

    const store = new ConfigStore(dshHome)
    const creds = new CredentialStore(dshHome)

    // 本地凭据文件优先；首次运行把 cordis 配置里的明文密码迁移过去
    const stored = creds.read()
    if (!stored && config.connection.password) creds.write(config.connection.password)
    runtime.password = stored || config.connection.password

    store.update({
      connection: {
        url: config.connection.url,
        username: config.connection.username,
        passwordRef: config.connection.passwordRef,
      },
      schedule: config.schedule,
      scope: config.scope,
      conflictPolicy: config.conflictPolicy,
      machineId: config.machineId || store.load().machineId,
      env,
    })

    runtime.store = store
    runtime.creds = creds
    runtime.env = env
    pushLog(`环境探测完成：${env.dshHome || '(未找到)'} [${env.generation}]`)
  }

  async function ensureReady(): Promise<HttpRuntime> {
    if (!initPromise) {
      initPromise = init().catch((err: unknown) => {
        initPromise = null
        throw err
      })
    }
    await initPromise
    return {
      store: runtime.store!,
      creds: runtime.creds!,
      env: runtime.env!,
      remoteRoot: REMOTE_ROOT,
      getPassword: () => runtime.password,
      setPassword: (password: string) => {
        runtime.password = password
      },
    }
  }

  function buildEngine(): SyncEngineImpl {
    const cfg = runtime.store!.load()
    const conn = {
      url: cfg.connection.url,
      username: cfg.connection.username,
      password: runtime.password,
      remoteRoot: REMOTE_ROOT,
    }
    const client = createWebDavClient(conn)
    const store = new WebDavSyncStore(conn)
    return createSyncEngine({
      env: runtime.env!,
      configStore: runtime.store!,
      store,
      client,
    }) as SyncEngineImpl
  }

  function stopScheduler(): void {
    runtime.engine?.stopScheduler()
    runtime.engine = null
  }

  // ---------- HTTP 路由（设置页） ----------
  const httpContext: HttpContext = {
    ready: ensureReady,
    reprobe: async () => {
      await ensureReady()
      const env = await resolveEnv({ profile: config.profile })
      runtime.env = env
      runtime.store!.updateEnv(env)
      pushLog(`重新探测环境：${env.dshHome || '(未找到)'} [${env.generation}]`)
      return env
    },
    logs: () => runtime.logs,
    stopScheduler,
  }

  // ---------- 服务注入 ----------
  // cordis 的 ctx 是代理：直接读 ctx.webServer / ctx.tools 会抛
  // "cannot get property without inject"，必须先声明再在回调里访问。
  host.inject(['webServer'], (services) => {
    if (!services.webServer) {
      pushLog('webServer 服务不可用，设置页 API 未注册')
      return
    }
    registerHttpRoutes(services.webServer, httpContext)
  })

  host.inject(['tools'], (services) => {
    const tools = services.tools
    if (!tools) return

    tools.register({
      name: 'webdav_sync_status',
      description: '查询 WebDAV 同步状态：上次同步时间、当前锁持有者、环境探测结果',
      parameters: {},
      output: { schema: { type: 'object' } },
      async execute() {
        await ensureReady()
        const cfg = runtime.store!.load()
        return {
          lastSyncAt: cfg.lastSyncAt,
          machineId: cfg.machineId,
          env: cfg.env,
          schedule: cfg.schedule,
          conflictPolicy: cfg.conflictPolicy,
        }
      },
    })

    tools.register({
      name: 'webdav_sync_now',
      description: '立即执行一次 WebDAV 同步（方向与冲突策略按当前配置）',
      parameters: {},
      output: { schema: { type: 'object' } },
      async execute() {
        await ensureReady()
        const report = await buildEngine().runOnce('manual')
        pushLog(
          `手动同步完成：上传 ${report.uploaded.length}，下载 ${report.downloaded.length}，` +
            `冲突 ${report.conflicts.length}，错误 ${report.errors.length}`,
        )
        return report
      },
    })
  })

  // ---------- 定时同步 ----------
  if (config.schedule.enabled) {
    void ensureReady()
      .then(() => {
        runtime.engine = buildEngine()
        runtime.engine.startScheduler(config.schedule.intervalHours, (report) => {
          pushLog(
            `定时同步完成：上传 ${report.uploaded.length}，下载 ${report.downloaded.length}，` +
              `冲突 ${report.conflicts.length}，错误 ${report.errors.length}`,
          )
        })
        pushLog(`定时同步已启动：每 ${config.schedule.intervalHours} 小时`)
      })
      .catch((err: unknown) => {
        pushLog(`定时同步启动失败：${(err as Error).message}`)
      })
  }

  // ---------- 卸载清理 ----------
  host.on?.('dispose', () => {
    stopScheduler()
    runtime.store = null
    runtime.creds = null
    runtime.env = null
    initPromise = null
  })
}

/*
 * 注意：这里绝对不能加 `export default apply`。
 * cordis 的 plugin() 里 `runtime.Config = plugin.Config`：loader 若拿到 default
 * 导出的裸函数，函数上没有 Config，配置校验被跳过，apply 收到的 config 就是
 * undefined，插件会在挂载瞬间抛错并标记为 "did not activate"。
 * 必须让 loader 拿到模块命名空间对象（含 Config + apply）。
 */
