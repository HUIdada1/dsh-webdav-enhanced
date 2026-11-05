import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPackager, hashDirectory, zipBaseName } from '../src/core/pack.js'
import { DEFAULT_SAFETY_GUARD, type LocalEntry } from '../src/types.js'

let root: string
let srcDir: string
let outDir: string
const tmpRoots: string[] = []

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-pack-'))
  tmpRoots.push(root)
  srcDir = path.join(root, 'src')
  outDir = path.join(root, 'out')
  mkdirSync(path.join(srcDir, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(path.join(srcDir, 'sub'), { recursive: true })
  writeFileSync(path.join(srcDir, 'a.txt'), 'hello')
  writeFileSync(path.join(srcDir, 'sub', 'b.md'), '# doc')
  writeFileSync(path.join(srcDir, 'node_modules', 'dep', 'x.js'), 'module')
})

afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function makeEntry(): LocalEntry {
  return {
    kind: 'skill',
    name: 'my-skill',
    version: '1.0.0',
    sourceDir: srcDir,
    hash: '',
    sizeBytes: 0,
    modifiedAt: new Date().toISOString(),
  }
}

describe('pack', () => {
  it('hash is stable regardless of zip output', async () => {
    const h1 = await hashDirectory(makeEntry())
    const h2 = await hashDirectory(makeEntry())
    expect(h1).toBe(h2)
    expect(zipBaseName({ ...makeEntry(), hash: h1 })).toBe('my-skill@1.0.0-' + h1.slice(0, 8))
  })

  it('pack excludes node_modules and unpack restores content with meta', async () => {
    const packager = createPackager()
    const packed = await packager.pack(makeEntry(), outDir)
    const dest = path.join(root, 'dest')
    const meta = await packager.unpack(packed.zipPath, dest, DEFAULT_SAFETY_GUARD)
    expect(meta.name).toBe('my-skill')
    expect(meta.kind).toBe('skill')
    expect(readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(path.join(dest, 'sub', 'b.md'), 'utf8')).toBe('# doc')
    expect(existsSync(path.join(dest, 'node_modules'))).toBe(false)
  })
})

describe('unpack safety', () => {
  it('rejects zip bomb when file exceeds guard limit', async () => {
    const packager = createPackager()
    const bigRoot = mkdtempSync(path.join(tmpdir(), 'dsh-pack-big-'))
    tmpRoots.push(bigRoot)
    const bigSrc = path.join(bigRoot, 'big-src')
    mkdirSync(bigSrc, { recursive: true })
    writeFileSync(path.join(bigSrc, 'big.bin'), Buffer.alloc(10 * 1024 * 1024, 1))
    const bigEntry: LocalEntry = {
      ...makeEntry(),
      name: 'big',
      sourceDir: bigSrc,
    }
    const packed = await packager.pack(bigEntry, path.join(bigRoot, 'out'))
    const dest = path.join(bigRoot, 'dest')
    await expect(
      packager.unpack(packed.zipPath, dest, { maxTotalBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 }),
    ).rejects.toThrow(/too large|zip bomb/)
  })
})
