import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import unzipper from 'unzipper'
import { createPackager } from '../src/core/pack.js'
import type { LocalEntry } from '../src/types.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dbg-'))
})
afterEach(() => {
  // 保留目录便于检查
  console.log('DBG root =', root)
})

describe('dbg', () => {
  it('inspect zip entries', async () => {
    const src = path.join(root, 'src')
    mkdirSync(path.join(src, 'sub'), { recursive: true })
    mkdirSync(path.join(src, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(path.join(src, 'a.txt'), 'hello')
    writeFileSync(path.join(src, 'sub', 'b.md'), '# doc')
    writeFileSync(path.join(src, 'node_modules', 'dep', 'x.js'), 'm')

    const pack = createPackager()
    const entry: LocalEntry = {
      kind: 'skill',
      name: 'my-skill',
      version: '1.0.0',
      sourceDir: src,
      hash: '',
      sizeBytes: 0,
      modifiedAt: new Date().toISOString(),
    }
    const packed = await pack.pack(entry, path.join(root, 'out'))

    const dir = await unzipper.Open.file(packed.zipPath)
    for (const f of dir.files) {
      console.log('entry:', JSON.stringify({ p: f.path, t: f.type, s: f.uncompressedSize }))
    }

    const dest = path.join(root, 'dest')
    const meta = await pack.unpack(packed.zipPath, dest)
    console.log('meta:', meta.name)
    console.log('dest list:', readdirSync(dest, { withFileTypes: true }).map((x) => `${x.isDirectory() ? 'D' : 'F'}:${x.name}`))
    console.log('exists a.txt:', existsSync(path.join(dest, 'a.txt')))
    console.log('exists sub/b.md:', existsSync(path.join(dest, 'sub', 'b.md')))
  })
})
