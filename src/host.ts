/*
 * 宿主入口（v2）：Cordis bundle 标准结构（name + Config + apply）。
 * - Config 用 Schemastery 定义，默认值齐全，改配置触发热更新。
 * - 注册 HTTP 路由（/api/webdav-enhanced/*）供设置页调用，另注册两个 Agent 工具。
 * - 引擎单例（连接配置变化才重建）+ 全局互斥（D5）；调度器随配置保存启停（D4）。
 * - 持有 ConfigStore / CredentialStore / RunLogger / RunProgressTracker 生命周期；卸载时清理定时器。
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from 'schemastery'
import { resolveEnv } from './core/env.js'
import { ConfigStore, defaultConfig, generateMachineId, migrateLegacyData } from './core/config-store.js'
import { CredentialStore } from './core/credentials.js'
import { createBusyReport, SyncEngineImpl } from './core/sync.js'
import { createWebDavClient } from './core/webdav.js'
import { WebDavSyncStore } from './core/webdav-store.js'
import { RunLogger } from './core/runlog.js'
import { countsFromReport, generateRunId, RunProgressTracker } from './core/progress.js'
import { scanLocal, HashCache, listConfigTopKeys } from './core/scan.js'
import { applyDirection, decideV2, filterByScope } from './core/merge.js'
import { emptyManifest } from './core/manifest.js'
import { registerHttpRoutes, type HttpContext, type ItemInfo, type StartSyncResult, type WebServerLike } from './http.js'
import {
  DEFAULT_SYNC_OPTIONS,
  type ConflictPolicy,
  type EntryKind,
  type LogCategory,
  type LogLevel,
  type LogQuery,
  type PlanItem,
  type PlanResult,
  type PluginConfig,
  type PluginConnectionConfig,
  type PluginOptions,
  type PublicConfig,
  type RemoteManifest,
  type ResolvedEnv,
  type RunProgress,
  type ScheduleConfig,
  type ServerCapabilities,
  type StatusPayload,
  type SyncDirection,
  type SyncOptions,
  type SyncRunReport,
  type SyncScope,
  type SyncTrigger,
  type TestConnectionResult,
} from './types.js'

export const name = 'webdav-enhanced'

/** 远端同步根目录（与 README 的目录布局一致） */
const REMOTE_ROOT = '/dsh-sync/'

/** 本包根目录：用于反查「当前插件装在哪个 profile 里」+ 读版本号 */
const SELF_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const DIRECTIONS: SyncDirection[] = ['both', 'upload', 'download']
const POLICIES: ConflictPolicy[] = ['auto', 'merge-backup', 'ask', 'local-wins', 'remote-wins']
const AUTO_RESOLVE: SyncOptions['autoResolve'][] = ['auto', 'local', 'remote', 'manual']
const SCOPE_MODES: SyncScope['bundles']['mode'][] = ['all', 'selected', 'none']

export interface Config {
  connection: {
    url: string
    username: string
    password: string
    passwordRef: 'keychain' | 'credentials'
  }
  options: {
    timeoutMs: number
    remoteRoot: string
    ignoreTlsErrors: boolean
  }
  schedule: {
    enabled: boolean
    intervalHours: number
    direction: SyncDirection
  }
  scope: SyncScope
  conflictPolicy: ConflictPolicy
  syncOptions: SyncOptions
  machineId: string
  /** 要同步的 dsh profile 名；留空自动探测（桌面版 desktop / Web 版 web） */
  profile: string
}

export const Config = Schema.object({
  connection: Schema.object({
    url: Schema.string().default(''),
    username: Schema.string().default(''),
    password: Schema.string().default(''),
    passwordRef: Schema.union(['keychain', 'credentials'] as const).default('credentials'),
  }),
  options: Schema.object({
    timeoutMs: Schema.number().default(30000),
    remoteRoot: Schema.string().default(REMOTE_ROOT),
    ignoreTlsErrors: Schema.boolean().default(false),
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
  conflictPolicy: Schema.union(['auto', 'merge-backup', 'ask', 'local-wins', 'remote-wins'] as const).default('auto'),
  syncOptions: Schema.object({
    propagateDeletions: Schema.boolean().default(DEFAULT_SYNC_OPTIONS.propagateDeletions),
    autoResolve: Schema.union(['auto', 'local', 'remote', 'manual'] as const).default(DEFAULT_SYNC_OPTIONS.autoResolve),
    dedupeRemote: Schema.boolean().default(DEFAULT_SYNC_OPTIONS.dedupeRemote),
    autoInstall: Schema.boolean().default(DEFAULT_SYNC_OPTIONS.autoInstall),
    contentMerge: Schema.boolean().default(DEFAULT_SYNC_OPTIONS.contentMerge),
    maxBackups: Schema.number().default(DEFAULT_SYNC_OPTIONS.maxBackups),
    pruneTombstones: Schema.boolean().default(DEFAULT_SYNC_OPTIONS.pruneTombstones),
    hardDelete: Schema.boolean().default(DEFAULT_SYNC_OPTIONS.hardDelete),
  }),
  machineId: Schema.string().default(generateMachineId()),
  profile: Schema.string().default(''),
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
  engineSig: string | null
  password: string
  logger: RunLogger | null
  progress: RunProgressTracker
  capabilities: ServerCapabilities | null
  running: boolean
  currentRunId: string | null
  version: string
  /** POST /config 里显式指定的 profile（覆盖自动探测） */
  profileOverride: string | null
}

type ReadyRuntime = Runtime & { store: ConfigStore; creds: CredentialStore; env: ResolvedEnv }

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(SELF_ROOT, 'package.json'), 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 读取 settings.yaml 的可勾选顶层 key（排除敏感段）；文件缺失/损坏返回 [] */
function listConfigTopKeysSafe(settingsFile: string | null): string[] {
  if (!settingsFile) return []
  try {
    return listConfigTopKeys(readFileSync(settingsFile, 'utf8'))
  } catch {
    return []
  }
}

// ---------- 请求参数校验/合并（浅合并语义：未出现的键不清空） ----------

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function mergeConnection(cur: PluginConnectionConfig, raw: unknown): PluginConnectionConfig | null {
  if (!isObj(raw)) return null
  const next = { ...cur }
  if (typeof raw.url === 'string') next.url = raw.url
  if (typeof raw.username === 'string') next.username = raw.username
  if (raw.passwordRef === 'keychain' || raw.passwordRef === 'credentials') next.passwordRef = raw.passwordRef
  return next
}

function mergeOptions(cur: PluginOptions, raw: unknown): PluginOptions | null {
  if (!isObj(raw)) return null
  const next = { ...cur }
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) next.timeoutMs = Math.floor(raw.timeoutMs)
  if (typeof raw.remoteRoot === 'string' && raw.remoteRoot.trim()) next.remoteRoot = raw.remoteRoot.trim()
  if (typeof raw.ignoreTlsErrors === 'boolean') next.ignoreTlsErrors = raw.ignoreTlsErrors
  return next
}

function mergeSchedule(cur: ScheduleConfig, raw: unknown): ScheduleConfig | null {
  if (!isObj(raw)) return null
  const next = { ...cur }
  if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled
  if (typeof raw.intervalHours === 'number' && Number.isFinite(raw.intervalHours) && raw.intervalHours >= 0) {
    next.intervalHours = raw.intervalHours
  }
  if (typeof raw.direction === 'string' && (DIRECTIONS as string[]).includes(raw.direction)) {
    next.direction = raw.direction as SyncDirection
  }
  return next
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((v): v is string => typeof v === 'string')
}

function mergeScope(cur: SyncScope, raw: unknown): SyncScope | null {
  if (!isObj(raw)) return null
  const next: SyncScope = {
    bundles: { mode: cur.bundles.mode, exclude: [...cur.bundles.exclude] },
    skills: { mode: cur.skills.mode, exclude: [...cur.skills.exclude] },
    configs: { mode: cur.configs.mode, includeKeys: [...cur.configs.includeKeys] },
  }
  for (const kind of ['bundles', 'skills'] as const) {
    const part = raw[kind]
    if (!isObj(part)) continue
    if (typeof part.mode === 'string' && (SCOPE_MODES as string[]).includes(part.mode)) {
      next[kind].mode = part.mode as SyncScope['bundles']['mode']
    }
    const exclude = stringArray(part.exclude)
    if (exclude) next[kind].exclude = exclude
  }
  const cfgPart = raw.configs
  if (isObj(cfgPart)) {
    if (typeof cfgPart.mode === 'string' && (SCOPE_MODES as string[]).includes(cfgPart.mode)) {
      next.configs.mode = cfgPart.mode as SyncScope['configs']['mode']
    }
    const includeKeys = stringArray(cfgPart.includeKeys)
    if (includeKeys) next.configs.includeKeys = includeKeys
  }
  return next
}

function mergeSyncOptions(cur: SyncOptions, raw: unknown): SyncOptions | null {
  if (!isObj(raw)) return null
  const next: SyncOptions = { ...cur }
  for (const key of ['propagateDeletions', 'dedupeRemote', 'autoInstall', 'contentMerge', 'pruneTombstones', 'hardDelete'] as const) {
    if (typeof raw[key] === 'boolean') next[key] = raw[key] as boolean
  }
  if (typeof raw.autoResolve === 'string' && (AUTO_RESOLVE as string[]).includes(raw.autoResolve)) {
    next.autoResolve = raw.autoResolve as SyncOptions['autoResolve']
  }
  if (typeof raw.maxBackups === 'number' && Number.isFinite(raw.maxBackups) && raw.maxBackups >= 0) {
    next.maxBackups = Math.floor(raw.maxBackups)
  }
  return next
}

export function apply(ctx: unknown, config: Config) {
  const host = ctx as HostCtx
  const runtime: Runtime = {
    store: null,
    creds: null,
    env: null,
    engine: null,
    engineSig: null,
    password: config.connection.password,
    logger: null,
    progress: new RunProgressTracker(),
    capabilities: null,
    running: false,
    currentRunId: null,
    version: readPackageVersion(),
    profileOverride: null,
  }

  let initPromise: Promise<void> | null = null

  function log(level: LogLevel, category: LogCategory, message: string, extra?: { name?: string; runId?: string; detail?: string }): void {
    runtime.logger?.log(level, category, message, extra)
  }

  // ---------- 初始化 ----------

  async function init(): Promise<void> {
    if (runtime.store) return
    const profileName = runtime.profileOverride || config.profile
    const env = await resolveEnv({ profile: profileName, selfRoot: SELF_ROOT })
    const dshHome = env.dshHome || process.env.DSH_HOME || os.homedir()

    // 旧版 webdav-sync 的数据目录/配置文件名一次性迁移到新命名
    migrateLegacyData(dshHome)

    const store = new ConfigStore(dshHome)
    const creds = new CredentialStore(dshHome)
    const logger = new RunLogger(dshHome)

    // 本地凭据文件优先；首次运行把 cordis 配置里的明文密码迁移过去
    const stored = creds.read()
    if (!stored && config.connection.password) creds.write(config.connection.password)
    runtime.password = stored || config.connection.password

    // 关键：设置页保存的值以本地 store 为准。
    // cordis 配置里的默认值（空 URL、默认 scope…）不能反过来把用户填的东西清掉，
    // 所以只有「显式给了非默认值」时才覆盖，否则原样保留。
    const previous = store.load()
    const patch: Partial<PluginConfig> = {
      machineId: config.machineId || previous.machineId,
      env,
    }
    if (config.connection.url.trim() || config.connection.username.trim()) {
      patch.connection = {
        url: config.connection.url,
        username: config.connection.username,
        passwordRef: config.connection.passwordRef,
      }
    }
    const opt = config.options
    if (opt.timeoutMs !== 30000 || opt.remoteRoot !== REMOTE_ROOT || opt.ignoreTlsErrors) {
      patch.options = opt
    }
    const sched = config.schedule
    if (sched.enabled || sched.intervalHours !== 1 || sched.direction !== 'both') {
      patch.schedule = sched
    }
    const scope = config.scope
    const scopeIsDefault =
      scope.bundles.mode === 'all' &&
      scope.skills.mode === 'all' &&
      scope.configs.mode === 'none' &&
      scope.bundles.exclude.length === 0 &&
      scope.skills.exclude.length === 0 &&
      scope.configs.includeKeys.length === 0
    if (!scopeIsDefault) patch.scope = scope
    if (config.conflictPolicy !== 'auto') patch.conflictPolicy = config.conflictPolicy
    const syncChanged = (Object.keys(DEFAULT_SYNC_OPTIONS) as (keyof SyncOptions)[]).some(
      (key) => config.syncOptions?.[key] !== DEFAULT_SYNC_OPTIONS[key],
    )
    if (syncChanged) patch.syncOptions = { ...previous.syncOptions, ...config.syncOptions }

    store.update(patch)

    runtime.store = store
    runtime.creds = creds
    runtime.env = env
    runtime.logger = logger
    log('info', 'env', `环境探测完成：${env.dshHome || '(未找到)'} · profile ${env.profile} [${env.generation}]`)

    // D4：启动时按「本地保存的 schedule」启停调度器（而不是只看 cordis 配置）
    const saved = store.load()
    if (saved.schedule.enabled) {
      startSchedulerFor(getEngine(), saved)
    }
  }

  async function ensureReady(): Promise<ReadyRuntime> {
    if (!initPromise) {
      initPromise = init().catch((err: unknown) => {
        initPromise = null
        throw err
      })
    }
    await initPromise
    return runtime as ReadyRuntime
  }

  // ---------- 引擎单例（D5） ----------

  function connectionConfigOf(cfg: PluginConfig, password: string) {
    const options = cfg.options ?? { timeoutMs: 30000, remoteRoot: REMOTE_ROOT, ignoreTlsErrors: false }
    return {
      url: cfg.connection.url,
      username: cfg.connection.username,
      password,
      remoteRoot: options.remoteRoot || REMOTE_ROOT,
      timeoutMs: options.timeoutMs,
      ignoreTlsErrors: options.ignoreTlsErrors === true,
    }
  }

  function engineSignatureOf(cfg: PluginConfig, password: string): string {
    const conn = connectionConfigOf(cfg, password)
    return [conn.url, conn.username, conn.password, conn.remoteRoot, String(conn.timeoutMs), conn.ignoreTlsErrors ? '1' : '0'].join('\u0000')
  }

  /** 取引擎：连接配置变化才重建（D5：不再每次 runSync 新建，互斥才有效） */
  function getEngine(): SyncEngineImpl {
    const ready = runtime as ReadyRuntime
    const cfg = ready.store.load()
    const sig = engineSignatureOf(cfg, ready.password)
    if (ready.engine && ready.engineSig === sig) return ready.engine
    if (ready.running && ready.engine) return ready.engine
    ready.engine?.stopScheduler()
    const conn = connectionConfigOf(cfg, ready.password)
    const engine = new SyncEngineImpl({
      env: ready.env,
      configStore: ready.store,
      store: new WebDavSyncStore(conn),
      client: createWebDavClient(conn),
      progress: ready.progress,
      logger: ready.logger!,
    })
    ready.engine = engine
    ready.engineSig = sig
    // 重建后按当前配置恢复调度器
    startSchedulerFor(engine, cfg)
    return engine
  }

  /** D4：调度器随配置保存启停 */
  function startSchedulerFor(engine: SyncEngineImpl, cfg: PluginConfig): void {
    engine.stopScheduler()
    if (cfg.schedule.enabled && cfg.schedule.intervalHours > 0) {
      engine.startScheduler(cfg.schedule.intervalHours, (report) => {
        log('info', 'schedule', `定时同步结束：上传 ${report.uploaded.length}，下载 ${report.downloaded.length}，失败 ${report.errors.length}`, {
          runId: report.runId,
        })
      })
      log('info', 'schedule', `定时同步已启动：每 ${cfg.schedule.intervalHours} 小时`)
    }
  }

  // ---------- 同步启动（全局互斥 + 立即返回） ----------

  interface Launch {
    started: boolean
    alreadyRunning: boolean
    runId: string
    promise: Promise<SyncRunReport> | null
  }

  function launch(trigger: SyncTrigger): Launch {
    if (runtime.running) {
      const runId = runtime.currentRunId ?? runtime.progress.snapshot().runId ?? generateRunId()
      return { started: false, alreadyRunning: true, runId, promise: null }
    }
    const engine = getEngine()
    const runId = generateRunId()
    runtime.running = true
    runtime.currentRunId = runId
    const promise = engine.runOnce(trigger, { runId }).finally(() => {
      runtime.running = false
      runtime.currentRunId = null
    })
    return { started: true, alreadyRunning: false, runId, promise }
  }

  function startSync(trigger: SyncTrigger = 'manual'): StartSyncResult {
    const launched = launch(trigger)
    if (launched.promise) {
      launched.promise.catch((err: unknown) => {
        log('error', 'sync', `同步失败：${(err as Error).message}`, { runId: launched.runId })
      })
    }
    return { started: launched.started, runId: launched.runId, alreadyRunning: launched.alreadyRunning }
  }

  /** Agent 工具用：等待整轮结束并返回报告 */
  async function runSync(): Promise<SyncRunReport> {
    await ensureReady()
    const launched = launch('manual')
    if (!launched.promise) return createBusyReport(launched.runId, 'manual')
    return launched.promise
  }

  // ---------- 业务实现 ----------

  function publicConfigOf(rt: ReadyRuntime): PublicConfig {
    const cfg = rt.store.load()
    return {
      connection: {
        url: cfg.connection.url,
        username: cfg.connection.username,
        passwordRef: cfg.connection.passwordRef,
        hasPassword: runtime.password !== '',
      },
      options: cfg.options,
      scope: cfg.scope,
      schedule: cfg.schedule,
      conflictPolicy: cfg.conflictPolicy,
      syncOptions: cfg.syncOptions,
      machineId: cfg.machineId,
      profile: rt.env.profile,
      lastSyncAt: cfg.lastSyncAt,
      version: runtime.version,
      env: rt.env,
    }
  }

  async function saveConfig(body: Record<string, unknown>): Promise<PublicConfig> {
    const rt = await ensureReady()
    const cur = rt.store.load()

    // 密码只写本地凭据（永不进远端/日志）
    if (isObj(body.connection) && typeof body.connection.password === 'string' && body.connection.password !== '') {
      rt.creds.write(body.connection.password)
      runtime.password = body.connection.password
    }

    const patch: Partial<PluginConfig> = {}
    const connection = mergeConnection(cur.connection, body.connection)
    if (connection) patch.connection = connection
    const options = mergeOptions(cur.options, body.options)
    if (options) patch.options = options
    const scope = mergeScope(cur.scope, body.scope)
    if (scope) patch.scope = scope
    const schedule = mergeSchedule(cur.schedule, body.schedule)
    if (schedule) patch.schedule = schedule
    if (typeof body.conflictPolicy === 'string' && (POLICIES as string[]).includes(body.conflictPolicy)) {
      patch.conflictPolicy = body.conflictPolicy as ConflictPolicy
    }
    const syncOptions = mergeSyncOptions(cur.syncOptions, body.syncOptions)
    if (syncOptions) patch.syncOptions = syncOptions

    const next = Object.keys(patch).length > 0 ? rt.store.update(patch) : cur
    const scheduleChanged = JSON.stringify(cur.schedule) !== JSON.stringify(next.schedule)
    const connectionChanged =
      JSON.stringify(cur.connection) !== JSON.stringify(next.connection) ||
      JSON.stringify(cur.options) !== JSON.stringify(next.options)

    // profile 显式指定：重新探测环境（下次同步使用新 profile）
    if (typeof body.profile === 'string' && body.profile.trim() && body.profile.trim() !== rt.env.profile) {
      runtime.profileOverride = body.profile.trim()
      await doReprobe(runtime.profileOverride, rt)
    } else if (scheduleChanged || connectionChanged) {
      const engine = getEngine()
      if (scheduleChanged) startSchedulerFor(engine, next)
    }
    log('info', 'system', '设置已保存')
    return publicConfigOf(rt)
  }

  async function statusOf(): Promise<StatusPayload> {
    const rt = await ensureReady()
    const cfg = rt.store.load()
    let lock: StatusPayload['lock'] = null
    if (cfg.connection.url) {
      try {
        lock = await createWebDavClient(connectionConfigOf(cfg, runtime.password)).currentLockHolder()
      } catch {
        lock = null
      }
    }
    const snapshot = runtime.progress.snapshot()
    const report = snapshot.report ?? runtime.engine?.lastReport() ?? null
    return {
      lastSyncAt: cfg.lastSyncAt,
      machineId: cfg.machineId,
      env: rt.env,
      schedule: cfg.schedule,
      conflictPolicy: cfg.conflictPolicy,
      syncOptions: cfg.syncOptions,
      direction: cfg.schedule.direction,
      lock,
      counts: countsFromReport(report),
      lastReport: report,
      capabilities: runtime.capabilities,
    }
  }

  async function testConnection(body: Record<string, unknown>): Promise<TestConnectionResult> {
    const rt = await ensureReady()
    const cfg = rt.store.load()
    // 页面上密码框保存后会被清空（提示「留空表示不修改」），这里必须回退到本地凭据
    const typed = typeof body.password === 'string' ? body.password : ''
    const password = typed !== '' ? typed : runtime.password
    const client = createWebDavClient({
      url: typeof body.url === 'string' ? body.url : cfg.connection.url,
      username: typeof body.username === 'string' ? body.username : cfg.connection.username,
      password,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : cfg.options.timeoutMs,
      ignoreTlsErrors: typeof body.ignoreTlsErrors === 'boolean' ? body.ignoreTlsErrors : cfg.options.ignoreTlsErrors === true,
      remoteRoot: typeof body.remoteRoot === 'string' && body.remoteRoot ? body.remoteRoot : cfg.options.remoteRoot,
    })
    const result = await client.testConnection()
    runtime.capabilities = result.capabilities
    const failed = result.steps.filter((s) => !s.ok)
    if (result.ok) log('success', 'connection', '连接测试通过')
    else log('error', 'connection', `连接测试失败：${failed.map((s) => `${s.step} ${s.detail}`).join('；')}`)
    return result
  }

  async function items(kind: EntryKind): Promise<ItemInfo[]> {
    const rt = await ensureReady()
    // 「内容」页要展示全部可选条目（与当前 scope.mode 无关），勾选状态由前端按 scope 回填。
    // config 类额外返回可勾选的顶层 key 列表（敏感 key 永远不出现）。
    const listingScope: SyncScope = {
      bundles: { mode: 'all', exclude: [] },
      skills: { mode: 'all', exclude: [] },
      configs: { mode: 'all', includeKeys: [] },
    }
    const errors: { stage: string; message: string }[] = []
    const entries = await scanLocal(rt.env, listingScope, errors, { cache: new HashCache(rt.env.dshHome || os.tmpdir()) })
    if (errors.length > 0) log('warn', 'env', `扫描条目时出现 ${errors.length} 条告警`)
    const configKeys = listConfigTopKeysSafe(rt.env.settingsFile)
    return entries
      .filter((e) => e.kind === kind)
      .map((e) => {
        const item: ItemInfo = {
          name: e.name,
          version: e.version,
          kind: e.kind,
          hash: e.hash,
          sizeBytes: e.sizeBytes,
          modifiedAt: e.modifiedAt,
        }
        if (e.kind === 'config' && configKeys.length > 0) item.keys = configKeys
        return item
      })
  }

  /** GET /plan：干跑分析，不写远端、不写本地状态（hash 缓存与 config 桩都不落盘） */
  async function plan(): Promise<PlanResult> {
    const rt = await ensureReady()
    const cfg = rt.store.load()
    const errors: { stage: string; message: string }[] = []
    const local = await scanLocal(rt.env, cfg.scope, errors, { cache: null, writeConfigStub: false })
    let remote: RemoteManifest = emptyManifest()
    if (cfg.connection.url) {
      try {
        remote = (await new WebDavSyncStore(connectionConfigOf(cfg, runtime.password)).read()).manifest
      } catch (err) {
        errors.push({ stage: 'manifest', message: `读取远端清单失败：${(err as Error).message}` })
      }
    } else {
      errors.push({ stage: 'manifest', message: 'WebDAV 未配置，按空远端清单分析' })
    }
    const decisions = filterByScope(
      applyDirection(
        decideV2({
          local,
          remote,
          lastSynced: cfg.lastSynced ?? {},
          policy: cfg.conflictPolicy,
          options: { autoResolve: cfg.syncOptions.autoResolve, propagateDeletions: cfg.syncOptions.propagateDeletions },
          direction: cfg.schedule.direction,
          machineId: cfg.machineId,
        }),
        cfg.schedule.direction,
      ),
      cfg.scope,
    )
    const items: PlanItem[] = decisions.map((d) => ({
      key: d.key,
      kind: d.kind,
      name: d.name,
      action: d.action,
      reason: d.reason,
      winner: d.winner,
      local: d.local
        ? {
            hash: d.local.hash,
            version: d.local.version,
            sizeBytes: d.local.sizeBytes,
            modifiedAt: d.local.modifiedAt,
          }
        : undefined,
      remote: d.remote
        ? {
            hash: d.remote.hash,
            version: d.remote.version,
            size: d.remote.size,
            updatedAt: d.remote.updatedAt,
            machineId: d.remote.source.machineId,
          }
        : undefined,
    }))
    const summary = { upload: 0, download: 0, merge: 0, skip: 0, remove: 0, conflict: 0, total: items.length }
    for (const item of items) {
      if (item.action === 'upload') summary.upload += 1
      else if (item.action === 'download') summary.download += 1
      else if (item.action === 'merge') summary.merge += 1
      else if (item.action === 'skip') summary.skip += 1
      else if (item.action === 'conflict') summary.conflict += 1
      else summary.remove += 1
    }
    return {
      generatedAt: new Date().toISOString(),
      direction: cfg.schedule.direction,
      items,
      summary,
      errors,
    }
  }

  async function doReprobe(profile: string, rt?: ReadyRuntime): Promise<ResolvedEnv> {
    const ready = rt ?? (await ensureReady())
    const env = await resolveEnv({ profile: profile || config.profile, selfRoot: SELF_ROOT })
    ready.env = env
    runtime.env = env
    ready.store.updateEnv(env)
    ready.engine?.stopScheduler()
    ready.engine = null
    ready.engineSig = null
    log('info', 'env', `重新探测环境：${env.dshHome || '(未找到)'} · profile ${env.profile} [${env.generation}]`)
    const cfg = ready.store.load()
    if (cfg.schedule.enabled) startSchedulerFor(getEngine(), cfg)
    return env
  }

  async function reset(): Promise<{ ok: true }> {
    const rt = await ensureReady()
    runtime.engine?.stopScheduler()
    runtime.engine = null
    runtime.engineSig = null
    rt.creds.clear()
    runtime.password = ''
    const machineId = rt.store.load().machineId
    const next = defaultConfig(machineId)
    next.env = rt.env
    rt.store.save(next)
    runtime.progress.reset()
    runtime.capabilities = null
    log('warn', 'system', '已重置本机同步状态（machineId 保留）')
    return { ok: true as const }
  }

  async function clearRemote(): Promise<{ ok: true; removed: number }> {
    const rt = await ensureReady()
    const cfg = rt.store.load()
    if (!cfg.connection.url) throw new Error('WebDAV 未配置')
    const conn = connectionConfigOf(cfg, runtime.password)
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
    rt.store.update({ lastSynced: {} })
    log('warn', 'system', `已清空远端同步数据：删除 ${removed} 个文件`)
    return { ok: true as const, removed }
  }

  // ---------- HTTP 路由（设置页） ----------

  const httpContext: HttpContext = {
    getConfig: async () => publicConfigOf(await ensureReady()),
    saveConfig,
    testConnection,
    items,
    status: statusOf,
    progress: (): RunProgress => runtime.progress.snapshot(),
    plan,
    startSync,
    cancelSync: () => ({ cancelled: runtime.engine?.cancel() ?? false }),
    logs: (query: LogQuery) => runtime.logger?.query(query) ?? { entries: [], total: 0 },
    reprobe: (profile?: string) => doReprobe(profile ?? runtime.profileOverride ?? config.profile),
    reset,
    clearRemote,
    runSync,
  }

  // ---------- 服务注入 ----------
  // cordis 的 ctx 是代理：直接读 ctx.webServer / ctx.tools 会抛
  // "cannot get property without inject"，必须先声明再在回调里访问。
  host.inject(['webServer'], (services) => {
    if (!services.webServer) {
      log('warn', 'system', 'webServer 服务不可用，设置页 API 未注册')
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
        return await statusOf()
      },
    })

    tools.register({
      name: 'webdav_sync_now',
      description: '立即执行一次 WebDAV 同步（方向与冲突策略按当前配置）',
      parameters: {},
      output: { schema: { type: 'object' } },
      async execute() {
        return runSync()
      },
    })
  })

  // ---------- 启动即初始化（让持久化的定时同步在无人打开设置页时也能生效） ----------
  // 只在明确知道 dshHome（DSH_HOME）或 cordis 配置显式开启定时同步时预初始化，
  // 避免在测试/未配置环境里无谓地探测并创建数据目录。
  if (config.schedule.enabled || process.env.DSH_HOME) {
    void ensureReady().catch((err: unknown) => {
      log('warn', 'system', `初始化失败：${(err as Error).message}`)
    })
  }

  // ---------- 卸载清理 ----------
  host.on?.('dispose', () => {
    runtime.engine?.stopScheduler()
    runtime.engine = null
    runtime.engineSig = null
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
