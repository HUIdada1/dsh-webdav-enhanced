/*
 * M9 宿主入口：Cordis bundle 标准结构（name + Config + apply）。
 * - Config 用 Schemastery 定义，默认值齐全，改配置触发热更新。
 * - 注册设置页（client.js）、Agent 工具（webdav_sync_status / webdav_sync_now）。
 * - 持有 SyncEngine 与 ConfigStore 生命周期；卸载时清理定时器。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import Schema from 'schemastery'
import { resolveEnv } from './core/env.js'
import { ConfigStore, defaultConfig, generateMachineId } from './core/config-store.js'
import { createSyncEngine, type SyncEngineImpl } from './core/sync.js'
import { createWebDavClient } from './core/webdav.js'
import { WebDavSyncStore } from './core/webdav-store.js'

export const name = 'webdav-sync'

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
})

// 运行时上下文（避免重复创建）
interface Runtime {
  store: ConfigStore | null
  engine: SyncEngineImpl | null
  clientJs: string | null
}

const runtime: Runtime = { store: null, engine: null, clientJs: null }

function readClientJs(): string {
  if (runtime.clientJs) return runtime.clientJs
  // lib/host.js 与 client.js 同级（构建后）；开发时从 src/client.js 读
  const candidates = [
    path.join(__dirname, 'client.js'),
    path.join(__dirname, '..', 'src', 'client.js'),
  ]
  for (const p of candidates) {
    try {
      runtime.clientJs = readFileSync(p, 'utf8')
      return runtime.clientJs
    } catch {
      /* 尝试下一个 */
    }
  }
  return '// client.js not found'
}

export function apply(ctx: unknown, config: Config) {
  // 延迟初始化（避免启动时阻塞宿主）
  let initialized = false

  async function ensureInit() {
    if (initialized) return
    initialized = true
    const env = await resolveEnv({ profile: 'web' })
    const store = new ConfigStore(env.dshHome || process.env.DSH_HOME || require('node:os').homedir())
    // 合并 cordis 配置到本地存储
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
  }

  // 暴露工具接口（dsh-tools 风格）
  const anyCtx = ctx as {
    tools?: { register: (t: unknown) => void }
    on?: (event: string, fn: () => void) => void
    inject?: string[]
  }

  // 工具：状态查询
  anyCtx.tools?.register({
    name: 'webdav_sync_status',
    description: '查询 WebDAV 同步状态：上次同步时间、当前锁持有者、环境探测结果',
    parameters: {},
    output: { schema: { type: 'object' } },
    async execute() {
      await ensureInit()
      const cfg = runtime.store!.load()
      return {
        lastSyncAt: cfg.lastSyncAt,
        machineId: cfg.machineId,
        env: cfg.env,
        schedule: cfg.schedule,
      }
    },
  })

  // 工具：立即同步
  anyCtx.tools?.register({
    name: 'webdav_sync_now',
    description: '立即执行一次 WebDAV 同步（双向）',
    parameters: {},
    output: { schema: { type: 'object' } },
    async execute() {
      await ensureInit()
      const cfg = runtime.store!.load()
      const client = createWebDavClient({
        url: cfg.connection.url,
        username: cfg.connection.username,
        password: config.connection.password,
        remoteRoot: '/dsh-sync/',
      })
      const syncStore = new WebDavSyncStore({
        url: cfg.connection.url,
        username: cfg.connection.username,
        password: config.connection.password,
      })
      const engine = createSyncEngine({
        env: cfg.env!,
        configStore: runtime.store!,
        store: syncStore,
        client,
      })
      const report = await engine.runOnce('manual')
      return report
    },
  })

  // 启动定时调度（若开启）
  if (config.schedule.enabled) {
    void ensureInit().then(() => {
      const cfg = runtime.store!.load()
      const client = createWebDavClient({
        url: cfg.connection.url,
        username: cfg.connection.username,
        password: config.connection.password,
        remoteRoot: '/dsh-sync/',
      })
      const syncStore = new WebDavSyncStore({
        url: cfg.connection.url,
        username: cfg.connection.username,
        password: config.connection.password,
      })
      runtime.engine = createSyncEngine({
        env: cfg.env!,
        configStore: runtime.store!,
        store: syncStore,
        client,
      }) as SyncEngineImpl
      runtime.engine.startScheduler(config.schedule.intervalHours, (_report) => {
        // 结果仅记录到本地存储，UI 主动查询
      })
    })
  }

  // 卸载清理
  anyCtx.on?.('dispose', () => {
    runtime.engine?.stopScheduler()
    runtime.engine = null
    runtime.store = null
    initialized = false
  })

  // 返回一个对象，dsh 可能用于设置页注册
  return {
    clientJs: readClientJs(),
  }
}

export default apply
