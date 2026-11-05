import { describe, expect, it } from 'vitest'
import { apply, Config, name } from '../src/host.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('host', () => {
  it('exports expected Cordis bundle shape', () => {
    expect(name).toBe('webdav-sync')
    expect(typeof apply).toBe('function')
    // Schemastery Config 是函数（可调用），不是 plain object
    expect(['function', 'object']).toContain(typeof Config)
  })

  it('apply() returns an object with clientJs', () => {
    const ctx = { tools: { register: () => undefined }, on: () => undefined }
    const cfg = Config({})
    const result = apply(ctx, cfg)
    expect(result).toHaveProperty('clientJs')
    expect(result.clientJs.length).toBeGreaterThan(1000)
    expect(result.clientJs).toContain('WebDAV')
  })

  it('client.js is loadable from disk', () => {
    const clientJs = readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')
    expect(clientJs).toContain('__webdavSyncMount')
  })
})
