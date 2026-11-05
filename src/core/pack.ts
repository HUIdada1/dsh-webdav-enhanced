/*
 * M3 打包 / 压缩 / 校验。
 * - 上传用 zip（用户需求），库：archiver + unzipper（纯 JS 跨平台，兼容 data descriptor）。
 * - 内容寻址：hash 由目录内容本身决定（与 zip 产物无关），保证跨机一致 → 天然去重。
 * - 解压安全：拒绝路径穿越 + zip 炸弹体积护栏。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import archiver from 'archiver'
import unzipper from 'unzipper'
import {
  DEFAULT_SAFETY_GUARD,
  type LocalEntry,
  type PackMeta,
  type PackedEntry,
  type Packager,
  type SafetyGuard,
} from '../types.js'

const META_FILE = '_meta.json'

// ---------- 默认排除：bundle 依赖本体不上传（体积 + 跨平台二进制差异） ----------

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'logs', 'cache', '.cache', 'dist', 'lib'])
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'npm-debug.log'])

function shouldIncludeRel(relPath: string): boolean {
  const segments = relPath.split('/')
  if (segments.some((s) => EXCLUDE_DIRS.has(s))) return false
  return !EXCLUDE_FILES.has(segments[segments.length - 1])
}

// ---------- hash ----------

export async function hashFileContent(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(filePath)
      .on('data', (d: string | Buffer) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

/** 目录内容的稳定 hash：kind + name + version + 相对路径(排序) + 各文件 sha256 级联 */
export async function hashDirectory(entry: Pick<LocalEntry, 'kind' | 'name' | 'version' | 'sourceDir'>): Promise<string> {
  const h = createHash('sha256')
  h.update(entry.kind)
  h.update('\0')
  h.update(entry.name)
  h.update('\0')
  h.update(entry.version ?? '')
  h.update('\0')

  const files = await collectFiles(entry.sourceDir)
  for (const rel of files.sort()) {
    const abs = path.join(entry.sourceDir, rel)
    h.update(rel)
    h.update('\0')
    h.update(await hashFileContent(abs))
    h.update('\0')
  }
  return h.digest('hex')
}

async function collectFiles(dir: string, base = '', out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await readdir(base ? path.join(dir, base) : dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue
      await collectFiles(dir, rel, out)
    } else if (e.isFile()) {
      if (EXCLUDE_FILES.has(e.name)) continue
      out.push(rel)
    }
  }
  return out
}

// ---------- zip 命名：hash 前缀决定去重 ----------

export function zipBaseName(e: Pick<LocalEntry, 'name' | 'version' | 'hash'>): string {
  const hash8 = e.hash.slice(0, 8)
  const ver = e.version ? `@${e.version}` : ''
  return `${e.name.replace(/[^\w.@+-]+/g, '_')}${ver}-${hash8}`
}

function remoteDirFor(kind: LocalEntry['kind']): string {
  return kind === 'bundle' ? 'bundles' : kind === 'skill' ? 'skills' : 'configs'
}

// ---------- Packager ----------

class PackagerImpl implements Packager {
  async pack(entry: LocalEntry, outDir: string): Promise<PackedEntry> {
    mkdirSync(outDir, { recursive: true })
    const hash = await hashDirectory(entry)
    const zipPath = path.join(outDir, `${zipBaseName({ ...entry, hash })}.zip`)

    const meta: PackMeta = {
      kind: entry.kind,
      name: entry.name,
      version: entry.version,
      source: entry.machine ?? { machineId: 'unknown', platform: process.platform, dshVersion: null },
      originalPath: entry.sourceDir,
      packedAt: new Date().toISOString(),
      dshVersion: null,
    }

    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 6 } })
      output.on('close', () => resolve())
      archive.on('error', reject)
      archive.pipe(output)
      archive.append(JSON.stringify(meta, null, 2), { name: META_FILE })
      archive.glob('**/*', {
        cwd: entry.sourceDir,
        dot: true,
        ignore: [...EXCLUDE_DIRS].map((d) => `${d}/**`),
      })
      void archive.finalize()
    })

    const size = (await stat(zipPath)).size
    return { entry: { ...entry, hash, sizeBytes: size }, zipPath, sha256: hash, size }
  }

  async unpack(zipPath: string, destDir: string, guard: SafetyGuard = DEFAULT_SAFETY_GUARD): Promise<PackMeta> {
    mkdirSync(destDir, { recursive: true })
    const destResolved = path.resolve(destDir)
    let meta: PackMeta | null = null
    let total = 0

    const dir = await unzipper.Open.file(zipPath)
    for (const file of dir.files) {
      const rel = file.path.replace(/\\/g, '/')
      if (!shouldIncludeRel(rel)) continue

      const target = path.resolve(destResolved, rel)
      if (target !== destResolved && !target.startsWith(destResolved + path.sep)) {
        throw new Error(`unsafe path in zip: ${rel}`)
      }

      if (file.type === 'Directory') {
        // 目录节点跳过（文件写时会 mkdir -p）
        file.stream().resume()
        continue
      }

      const size = file.uncompressedSize ?? 0
      if (size > guard.maxFileBytes) throw new Error(`file too large: ${rel} (${size})`)
      total += size
      if (total > guard.maxTotalBytes) {
        throw new Error(`zip bomb protection: total ${total} exceeds ${guard.maxTotalBytes}`)
      }

      if (rel === META_FILE) {
        meta = JSON.parse((await file.buffer()).toString('utf8')) as PackMeta
        continue
      }

      mkdirSync(path.dirname(target), { recursive: true })
      await new Promise<void>((resolve, reject) => {
        file.stream()
          .pipe(createWriteStream(target, { flags: 'w' }))
          .on('finish', () => resolve())
          .on('error', reject)
      })
    }

    if (!meta) throw new Error('invalid pack: missing _meta.json')
    return meta
  }

  hashFile(filePath: string): Promise<string> {
    return hashFileContent(filePath)
  }
}

export function createPackager(): Packager {
  return new PackagerImpl()
}

// 远端 zip 相对路径（供 manifest / sync 使用）
export function remoteZipRelPath(e: Pick<LocalEntry, 'kind' | 'name' | 'version' | 'hash'>): string {
  return `${remoteDirFor(e.kind)}/${zipBaseName(e)}.zip`
}
