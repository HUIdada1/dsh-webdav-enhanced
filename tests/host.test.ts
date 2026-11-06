import { describe, expect, it } from 'vitest'
import { apply, Config, name } from '../src/host.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

interface CapturedRoute {
  kind: string
  path: string
  handler: unknown
}

/** 最小 host ctx：只记录 apply() 注册了什么，不启动任何真实服务 */
function makeCtx() {
  const routes: CapturedRoute[] = []
  const tools: string[] = []
  const events: string[] = []
  return {
    routes,
    tools,
    events,
    ctx: {
      webServer: {
        register: (route: CapturedRoute) => {
          routes.push(route)
          return () => undefined
        },
      },
      tools: {
        register: (tool: { name: string }) => {
          tools.push(tool.name)
        },
      },
      on: (event: string) => {
        events.push(event)
      },
    },
  }
}

describe('host', () => {
  it('exports expected Cordis bundle shape', () => {
    expect(name).toBe('webdav-sync')
    expect(typeof apply).toBe('function')
    // Schemastery Config 是函数（可调用），不是 plain object
    expect(['function', 'object']).toContain(typeof Config)
  })

  it('Config exposes profile with desktop default', () => {
    const cfg = Config({})
    expect(cfg.profile).toBe('desktop')
  })

  it('apply() registers the settings-page HTTP route', () => {
    const { ctx, routes } = makeCtx()
    apply(ctx, Config({}))
    expect(routes).toHaveLength(1)
    expect(routes[0].kind).toBe('prefix')
    expect(routes[0].path).toBe('/api/webdav-sync')
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

  it('apply() survives a host without webServer', () => {
    expect(() => apply({ tools: { register: () => undefined } }, Config({}))).not.toThrow()
  })

  it('client.js is a dsh module wired to the settings slot', () => {
    const clientJs = readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')
    expect(clientJs).toContain('__ModuleLoader__')
    expect(clientJs).toContain('plugins.bundle.config')
    expect(clientJs).toContain('/api/webdav-sync')
    // 旧的全局挂载机制已废弃
    expect(clientJs).not.toContain('__webdavSyncMount')
  })
})
