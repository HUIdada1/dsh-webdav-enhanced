import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockWebDavServer } from './mock-webdav-server.js'
import { WebDavSyncStore, pushEntry } from '../src/core/webdav-store.js'
import { createWebDavClient } from '../src/core/webdav.js'
import { createPackager } from '../src/core/pack.js'
import type { LocalEntry } from '../src/types.js'

let server: MockWebDavServer
let baseUrl: string
const tmpRoots: string[] = []

beforeAll(async () => {
  server = new MockWebDavServer({ username: 'test', password: 'test' })
  await server.start()
  baseUrl = server.baseUrl
})

afterAll(async () => {
  await server?.stop()
})

let localRoot: string
let srcDir: string

beforeEach(() => {
  localRoot = mkdtempSync(path.join(tmpdir(), 'dsh-webdav-'))
  tmpRoots.push(localRoot)
  srcDir = path.join(localRoot, 'src')
  mkdirSync(path.join(srcDir, 'sub'), { recursive: true })
  writeFileSync(path.join(srcDir, 'a.txt'), 'hello webdav')
  writeFileSync(path.join(srcDir, 'sub', 'b.md'), '# nested')
})

afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function makeStore(): WebDavSyncStore {
  return new WebDavSyncStore({ url: baseUrl, username: 'test', password: 'test', remoteRoot: '/dsh-sync-test/' })
}

function makeEntry(): LocalEntry {
  return {
    kind: 'skill',
    name: 'webdav-skill',
    version: '1.0.0',
    sourceDir: srcDir,
    hash: '',
    sizeBytes: 0,
    modifiedAt: new Date().toISOString(),
  }
}

describe('webdav integration', () => {
  it('connects and passes testConnection', async () => {
    const client = createWebDavClient({ url: baseUrl, username: 'test', password: 'test', remoteRoot: '/dsh-sync-test/' })
    const res = await client.testConnection()
    // 失败时把每步详情带进错误信息，便于定位
    expect(JSON.stringify(res.steps), `steps: ${JSON.stringify(res.steps)}`).toEqual(
      JSON.stringify(['propfind', 'mkcol', 'put', 'readback'].map((step) => ({ step, ok: true, detail: 'ok' }))),
    )
  }, 20000)

  it('pushEntry uploads zip and updates manifest', async () => {
    const store = makeStore()
    const client = createWebDavClient({ url: baseUrl, username: 'test', password: 'test', remoteRoot: '/dsh-sync-test/' })
    const packager = createPackager()
    const packed = await packager.pack(makeEntry(), path.join(localRoot, 'out'))

    const res = await pushEntry(store, client, {
      entry: {
        kind: 'skill',
        name: 'webdav-skill',
        version: '1.0.0',
        hash: packed.sha256,
        size: packed.size,
        source: { machineId: 'm1', platform: 'win32', dshVersion: null },
      },
      zipPath: packed.zipPath,
      machineId: 'm1',
    })
    expect(res.uploaded).toBe(true)

    const again = await pushEntry(store, client, {
      entry: {
        kind: 'skill',
        name: 'webdav-skill',
        version: '1.0.0',
        hash: packed.sha256,
        size: packed.size,
        source: { machineId: 'm1', platform: 'win32', dshVersion: null },
      },
      zipPath: packed.zipPath,
      machineId: 'm1',
    })
    expect(again.uploaded).toBe(false)

    const { manifest } = await store.read()
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.entries[0].name).toBe('webdav-skill')
  }, 20000)
})
