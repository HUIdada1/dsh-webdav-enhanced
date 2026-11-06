import { describe, expect, it } from 'vitest'
import { apply, Config, name } from '../src/host.js'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

interface CapturedRoute {
  kind: string
  path: string
  handler: unknown
}

interface CapturedTool {
  name: string
  execute: () => Promise<unknown>
}

/**
 * 最小 host ctx：模拟 cordis 的服务注入。
 * 真实 cordis 里直接读 ctx.webServer 会抛 "cannot get property without inject"，
 * 所以 apply() 必须先 inject 再在回调里访问。
 */
function makeCtx() {
  const routes: CapturedRoute[] = []
  const tools: string[] = []
  const handlers: CapturedTool[] = []
  const events: string[] = []
  const injected: string[] = []

  const services = {
    webServer: {
      register: (route: CapturedRoute) => {
        routes.push(route)
        return () => undefined
      },
    },
    tools: {
      register: (tool: CapturedTool) => {
        tools.push(tool.name)
        handlers.push(tool)
      },
    },
  }

  const ctx = {
    inject: (names: string[], callback: (s: typeof services) => void) => {
      injected.push(...names)
      callback(services)
    },
    on: (event: string) => {
      events.push(event)
    },
  }

  return { routes, tools, handlers, events, injected, ctx }
}

describe('host', () => {
  it('exports expected Cordis bundle shape', () => {
    expect(name).toBe('webdav-enhanced')
    expect(typeof apply).toBe('function')
    // Schemastery Config 是函数（可调用），不是 plain object
    expect(['function', 'object']).toContain(typeof Config)
  })

  it('does not export a default plugin (cordis would lose Config)', () => {
    // 有 default 导出时 loader 会拿到裸函数，函数上没有 Config，
    // resolveConfig 被跳过 → apply 收到 undefined → 插件 "did not activate"
    const source = readFileSync(path.join(here, '..', 'src', 'host.ts'), 'utf8')
    expect(source).not.toMatch(/^export default /m)
  })

  it('Config leaves profile empty so the host can auto-detect it', () => {
    const cfg = Config({})
    expect(cfg.profile).toBe('')
  })

  it('Config fills defaults for an empty config object', () => {
    const cfg = Config({})
    expect(cfg.connection.url).toBe('')
    expect(cfg.schedule.enabled).toBe(false)
    expect(cfg.scope.configs.mode).toBe('none')
  })

  it('apply() declares the services it touches via inject', () => {
    const { ctx, injected } = makeCtx()
    apply(ctx, Config({}))
    expect(injected).toContain('webServer')
    expect(injected).toContain('tools')
  })

  it('apply() registers the settings-page HTTP route', () => {
    const { ctx, routes } = makeCtx()
    apply(ctx, Config({}))
    expect(routes).toHaveLength(1)
    expect(routes[0].kind).toBe('prefix')
    expect(routes[0].path).toBe('/api/webdav-enhanced')
    expect(typeof routes[0].handler).toBe('function')
  })

  it('apply() registers both agent tools', () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({}))
    expect(tools).toEqual(['webdav_sync_status', 'webdav_sync_now'])
  })

  it('apply() subscribes to dispose for cleanup', () => {
    const { ctx, events } = makeCtx()
    apply(ctx, Config({}))
    expect(events).toContain('dispose')
  })

  it('does not wipe what the settings page saved when cordis config is default', async () => {
    // 回归：旧实现每次启动都拿 cordis 的空默认值覆盖本地 store，
    // 设置页填好的地址/账号会在重启后消失。
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-host-'))
    const dataDir = path.join(home, '.webdav-enhanced')
    mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    const file = path.join(dataDir, 'webdav-enhanced.json')
    writeFileSync(
      file,
      JSON.stringify({
        connection: { url: 'https://dav.example.com/dsh/', username: 'alice', passwordRef: 'credentials' },
        options: { timeoutMs: 45000, remoteRoot: '/custom/', ignoreTlsErrors: true },
        schedule: { enabled: true, intervalHours: 3, direction: 'upload' },
      }),
    )

    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const { ctx, handlers } = makeCtx()
      apply(ctx, Config({}))
      const status = handlers.find((t) => t.name === 'webdav_sync_status')
      await status!.execute()
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.connection.url).toBe('https://dav.example.com/dsh/')
      expect(saved.connection.username).toBe('alice')
      expect(saved.options.timeoutMs).toBe(45000)
      expect(saved.options.remoteRoot).toBe('/custom/')
      expect(saved.schedule.enabled).toBe(true)
      expect(saved.schedule.direction).toBe('upload')
    } finally {
      process.env.DSH_HOME = previous ?? ''
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('client.js is a dsh module wired to both config slots', () => {
    const clientJs = readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')
    expect(clientJs).toContain('__ModuleLoader__')
    // 组合包详情页 + 行「配置」页，两个入口都注册，哪个版本渲染哪个就用哪个
    expect(clientJs).toContain("'plugins.bundle.config'")
    expect(clientJs).toContain("'plugins.row.config'")
    expect(clientJs).toContain("const PKG = 'dsh-webdav-enhanced'")
    expect(clientJs).toContain('/api/webdav-enhanced')
    // 旧实现把 DOM 节点当文本传，按钮退化成 "[object HTMLButtonElement]"
    expect(clientJs).not.toMatch(/el\('div', 'wds-actions'/)
    expect(clientJs).not.toContain('__webdavSyncMount')
  })

  it('package manifest declares a boot-loaded web client bundle with display metadata', () => {
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client.platform).toBe('web')
    // 没有 immediately 时 dsh 只在 application batch 里 preload，
    // 不会 materialize，apply 永不执行 → 设置页不出现
    expect(pkg.dsh.client.immediately).toBe(true)
    expect(pkg.exports['./client']).toBeDefined()
    // 插件列表的标题 / 描述 / 图标来自这三处，缺一个就退回包名与默认插画
    expect(pkg.icon).toBe('./icon.svg')
    expect(pkg.exports['./icon']).toBe('./icon.svg')
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
  })

  it('locale files carry meta.title / meta.description / meta.detail', () => {
    for (const locale of ['zh', 'en']) {
      const dict = JSON.parse(readFileSync(path.join(here, '..', 'locale', `${locale}.json`), 'utf8'))
      expect(typeof dict.meta.title).toBe('string')
      expect(dict.meta.title.length).toBeGreaterThan(0)
      expect(typeof dict.meta.description).toBe('string')
      // meta.detail 必须是包内 .md 相对路径，否则插件页会报 invalid
      expect(dict.meta.detail).toMatch(/^docs\/[\w.-]+\.md$/)
      expect(readFileSync(path.join(here, '..', dict.meta.detail), 'utf8').length).toBeGreaterThan(0)
    }
  })
})
