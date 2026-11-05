/*
 * 最小可用的 WebDAV 测试服务器（仅测试用）。
 * - 支持 PROPFIND / GET / PUT / MKCOL / MOVE / DELETE
 * - Basic Auth（可选）
 * - 内存文件系统（Map<path, Buffer>）
 * - 返回 ETag（sha1 of content）用于条件写测试
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'

export interface MockWebDavServerOptions {
  port?: number
  username?: string
  password?: string
}

export class MockWebDavServer {
  private server: Server | null = null
  private files = new Map<string, Buffer>()
  private dirs = new Set<string>(['/'])
  readonly port: number
  readonly baseUrl: string

  constructor(private readonly opts: MockWebDavServerOptions = {}) {
    this.port = opts.port ?? 0
    this.baseUrl = ''
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        const addr = this.server!.address()
        const port = typeof addr === 'object' && addr ? addr.port : 1900
        ;(this as { port: number }).port = port
        ;(this as { baseUrl: string }).baseUrl = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.opts.username) return true
    const auth = req.headers.authorization
    if (!auth || !auth.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      res.end('Unauthorized')
      return false
    }
    const expected = `Basic ${Buffer.from(`${this.opts.username}:${this.opts.password}`).toString('base64')}`
    if (auth !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      res.end('Unauthorized')
      return false
    }
    return true
  }

  private normalize(p: string): string {
    return p.endsWith('/') && p !== '/' ? p.slice(0, -1) : p
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAuth(req, res)) return
    const url = new URL(req.url ?? '/', this.baseUrl)
    const pathname = this.normalize(url.pathname)

    switch (req.method) {
      case 'PROPFIND': {
        const isFile = this.files.has(pathname)
        const isDir = this.dirs.has(pathname) || pathname === '/'
        if (!isFile && !isDir) {
          res.writeHead(404)
          res.end()
          return
        }
        const content = isFile ? this.files.get(pathname)! : null
        const size = content ? content.length : 0
        const etag = content ? this.etag(content) : 'dir'
        const type = isFile ? '' : '<d:collection/>'
        // 必须提供 getlastmodified / getcontentlength / getetag，否则 webdav-client 解析会崩
        const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${pathname}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype>${type}</d:resourcetype>
        <d:getcontentlength>${size}</d:getcontentlength>
        <d:getlastmodified>Wed, 05 Nov 2026 10:00:00 GMT</d:getlastmodified>
        <d:getetag>"${etag}"</d:getetag>
        <d:displayname>${pathname.split('/').pop() || '/'}</d:displayname>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
        res.end(xml)
        return
      }
      case 'MKCOL': {
        if (this.dirs.has(pathname) || this.files.has(pathname)) {
          res.writeHead(405)
          res.end('Already exists')
          return
        }
        // 确保父目录存在
        const parent = pathDir(pathname)
        if (!this.dirs.has(parent)) {
          res.writeHead(409)
          res.end('Parent missing')
          return
        }
        this.dirs.add(pathname)
        res.writeHead(201)
        res.end()
        return
      }
      case 'PUT': {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const content = Buffer.concat(chunks)
          const ifMatch = req.headers['if-match']
          const etag = this.etag(content)
          if (ifMatch && this.files.has(pathname)) {
            const cur = this.etag(this.files.get(pathname)!)
            if (ifMatch.replace(/"/g, '') !== cur) {
              res.writeHead(412)
              res.end()
              return
            }
          }
          this.files.set(pathname, content)
          // 确保父目录
          this.ensureParentDirs(pathname)
          res.writeHead(201, { ETag: `"${etag}"` })
          res.end()
        })
        return
      }
      case 'GET': {
        const f = this.files.get(pathname)
        if (!f) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Length': f.length, ETag: `"${this.etag(f)}"` })
        res.end(f)
        return
      }
      case 'MOVE': {
        const dest = this.normalize(req.headers.destination ?? '')
        if (!dest) {
          res.writeHead(400)
          res.end()
          return
        }
        const destUrl = new URL(dest, this.baseUrl)
        const destPath = this.normalize(destUrl.pathname)
        const f = this.files.get(pathname)
        if (f) {
          this.files.set(destPath, f)
          this.files.delete(pathname)
          this.ensureParentDirs(destPath)
        }
        res.writeHead(201)
        res.end()
        return
      }
      case 'DELETE': {
        if (this.files.delete(pathname)) {
          res.writeHead(204)
          res.end()
          return
        }
        if (this.dirs.delete(pathname)) {
          // 清理子项
          for (const k of [...this.files.keys()]) if (k.startsWith(pathname + '/')) this.files.delete(k)
          for (const k of [...this.dirs]) if (k.startsWith(pathname + '/')) this.dirs.delete(k)
          res.writeHead(204)
          res.end()
          return
        }
        res.writeHead(404)
        res.end()
        return
      }
      default: {
        res.writeHead(405)
        res.end(`Method ${req.method} not allowed`)
      }
    }
  }

  private etag(buf: Buffer): string {
    return createHash('sha1').update(buf).digest('hex')
  }

  private ensureParentDirs(p: string): void {
    let cur = pathDir(p)
    while (cur && cur !== '/') {
      this.dirs.add(cur)
      cur = pathDir(cur)
    }
  }
}

function pathDir(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return '/'
  return p.slice(0, idx)
}
