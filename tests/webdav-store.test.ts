import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MockWebDavServer } from './mock-webdav-server.js'
import { WebDavSyncStore, deleteEntry, pushEntry } from '../src/core/webdav-store.js'
import { createWebDavClient } from '../src/core/webdav.js'
import { createPackager } from '../src/core/pack.js'
import { emptyManifest } from '../src/core/manifest.js'
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

function makeStore(remoteRoot = '/dsh-sync-test/'): WebDavSyncStore {
  return new WebDavSyncStore({ url: baseUrl, username: 'test', password: 'test', remoteRoot })
}

function makeClient(remoteRoot = '/dsh-sync-test/') {
  return createWebDavClient({ url: baseUrl, username: 'test', password: 'test', remoteRoot })
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

// ---------- v2：跨条目远端去重（D9） + 共享文件删除保护 ----------

describe('pushEntry dedupeRemote（D9）', () => {
  const source = { machineId: 'm1', platform: 'win32', dshVersion: null }

  async function packOnce(name: string) {
    const packager = createPackager()
    return packager.pack({ ...makeEntry(), name }, path.join(localRoot, `out-${name}`))
  }

  it('远端已有同 hash 文件时第二个条目只登记 manifest，不复传', async () => {
    const root = '/dsh-sync-dedupe/'
    const store = makeStore(root)
    const client = makeClient(root)
    const packed = await packOnce('skill-a')

    const first = await pushEntry(store, client, {
      entry: { kind: 'skill', name: 'skill-a', version: '1.0.0', hash: packed.sha256, size: packed.size, source },
      zipPath: packed.zipPath,
      machineId: 'm1',
      dedupeRemote: true,
    })
    expect(first.uploaded).toBe(true)
    expect(first.deduped).toBe(false)

    const second = await pushEntry(store, client, {
      entry: { kind: 'skill', name: 'skill-b', version: '1.0.0', hash: packed.sha256, size: packed.size, source },
      zipPath: packed.zipPath,
      machineId: 'm1',
      dedupeRemote: true,
    })
    expect(second.uploaded).toBe(false)
    expect(second.deduped).toBe(true)

    const { manifest } = await store.read()
    const a = manifest.entries.find((e) => e.name === 'skill-a')!
    const b = manifest.entries.find((e) => e.name === 'skill-b')!
    expect(manifest.entries).toHaveLength(2)
    expect(b.file).toBe(a.file) // 复用同一个远端文件
    expect(b.hash).toBe(a.hash)
  }, 20000)

  it('dedupeRemote=false 时同 hash 不同条目照常上传', async () => {
    const root = '/dsh-sync-dedupe-off/'
    const store = makeStore(root)
    const client = makeClient(root)
    const packed = await packOnce('skill-c')
    const first = await pushEntry(store, client, {
      entry: { kind: 'skill', name: 'skill-c', version: '1.0.0', hash: packed.sha256, size: packed.size, source },
      zipPath: packed.zipPath,
      machineId: 'm1',
    })
    expect(first.uploaded).toBe(true)
    const second = await pushEntry(store, client, {
      entry: { kind: 'skill', name: 'skill-c2', version: '1.0.0', hash: packed.sha256, size: packed.size, source },
      zipPath: packed.zipPath,
      machineId: 'm1',
    })
    // 未开启去重：即便远端已有同 hash 文件，也走 PUT（旧行为）
    expect(second.uploaded).toBe(true)
    expect(second.deduped).toBe(false)
  }, 20000)

  it('删除共享文件的条目只打墓碑、不动另一个条目在用的文件', async () => {
    const root = '/dsh-sync-shared/'
    const store = makeStore(root)
    const client = makeClient(root)
    const packed = await packOnce('shared-1')
    for (const name of ['shared-1', 'shared-2']) {
      await pushEntry(store, client, {
        entry: { kind: 'skill', name, version: '1.0.0', hash: packed.sha256, size: packed.size, source },
        zipPath: packed.zipPath,
        machineId: 'm1',
        dedupeRemote: true,
      })
    }
    const before = (await store.read()).manifest
    const file = before.entries[0].file
    expect(before.entries[0].file).toBe(before.entries[1].file)

    await deleteEntry(store, client, 'skill', 'shared-1', 'm1')
    const after = (await store.read()).manifest
    expect(after.entries.find((e) => e.name === 'shared-1')!.deleted).toBe(true)
    expect(after.entries.find((e) => e.name === 'shared-2')!.deleted).toBe(false)
    // 共享文件仍在远端（另一个条目要用）
    expect(await client.exists(file)).toBe(true)
  }, 20000)
})

/**
 * 回归：真实服务端（muhuix DAV 实测）对「MOVE 到不存在的集合」返回 403 而不是 409。
 * pushEntry 必须在 MOVE 之前把目标集合建出来，否则首次上传全部失败。
 */
describe('pushEntry 目标集合与失败清理', () => {
  function fakeEntry() {
    return {
      kind: 'skill' as const,
      name: 'demo-skill',
      version: '1.0.0',
      hash: 'a'.repeat(64),
      size: 10,
      source: { machineId: 'm1', platform: 'linux', dshVersion: null },
    }
  }

  function fakeStore() {
    return {
      read: async () => ({ manifest: emptyManifest(), etag: null }),
      commit: async () => 'etag-1',
      acquireLock: async () => null,
      currentLockHolder: async () => null,
    }
  }

  it('MOVE 之前先 ensureDir 目标目录', async () => {
    const calls: string[] = []
    const client = {
      ensureDir: async (rel: string) => {
        calls.push('ensureDir:' + rel)
      },
      putFile: async (rel: string) => {
        calls.push('putFile:' + rel)
      },
      move: async (from: string, to: string) => {
        calls.push('move:' + from + '->' + to)
      },
      deleteFile: async (rel: string) => {
        calls.push('deleteFile:' + rel)
      },
      exists: async () => false,
      stat: async () => null,
      listDir: async () => [],
    }
    // 类型：只实现 pushEntry 实际调用的方法
    await pushEntry(fakeStore() as never, client as never, {
      entry: fakeEntry(),
      zipPath: '/tmp/not-used.zip',
      machineId: 'm1',
      dedupeRemote: true,
    })
    const moveIndex = calls.findIndex((c) => c.startsWith('move:'))
    const dirIndex = calls.findIndex((c) => c === 'ensureDir:skills')
    expect(moveIndex).toBeGreaterThan(-1)
    expect(dirIndex).toBeGreaterThan(-1)
    expect(dirIndex).toBeLessThan(moveIndex)
  })

  it('MOVE 失败时清掉 staging 残留后抛错', async () => {
    const calls: string[] = []
    const client = {
      ensureDir: async () => undefined,
      putFile: async () => undefined,
      move: async () => {
        throw new Error('403 Forbidden')
      },
      deleteFile: async (rel: string) => {
        calls.push(rel)
      },
      exists: async () => false,
      stat: async () => null,
      listDir: async () => [],
    }
    await expect(
      pushEntry(fakeStore() as never, client as never, {
        entry: fakeEntry(),
        zipPath: '/tmp/not-used.zip',
        machineId: 'm1',
        dedupeRemote: true,
      }),
    ).rejects.toThrow(/403/)
    expect(calls.some((c) => c.startsWith('staging/'))).toBe(true)
  })
})
