/*
 * 结构化运行日志（v2）。
 * - 内存 ring（默认最近 500 条）+ JSONL 落盘：$DSH_HOME/.webdav-enhanced/logs/sync.jsonl
 * - 单文件 > 1MB 轮转为 sync.1.jsonl（只保留 1 份旧文件）。
 * - 启动时读回末尾 200 条，保证重启后 UI 仍有历史。
 * - GET /logs 支持 level / category / limit 过滤，返回新→旧。
 * 日志写入永远不抛异常（日志失败不能拖垮同步）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIRNAME } from './config-store.js'
import type { LogCategory, LogEntry, LogLevel, LogQuery } from '../types.js'

export const LOG_DIRNAME = 'logs'
export const LOG_FILENAME = 'sync.jsonl'
export const LOG_ROTATED_FILENAME = 'sync.1.jsonl'

/** 设计契约：单文件阈值 1MB、ring 500 条、启动读回 200 条 */
export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024
export const DEFAULT_LOG_RING_SIZE = 500
export const DEFAULT_LOG_BOOTSTRAP_TAIL = 200
export const LOG_QUERY_DEFAULT_LIMIT = 200
export const LOG_QUERY_MAX_LIMIT = 500

export interface RunLoggerOptions {
  /** 单文件轮转阈值（测试用小值） */
  maxBytes?: number
  /** 内存 ring 上限 */
  ringSize?: number
  /** 启动时读回条数 */
  bootstrapTail?: number
}

const LEVELS: LogLevel[] = ['info', 'success', 'warn', 'error']
const CATEGORIES: LogCategory[] = [
  'sync', 'upload', 'download', 'merge', 'conflict', 'skip', 'delete',
  'dedupe', 'connection', 'schedule', 'env', 'system', 'prune',
]

function isLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LEVELS as string[]).includes(value)
}

function isCategory(value: unknown): value is LogCategory {
  return typeof value === 'string' && (CATEGORIES as string[]).includes(value)
}

export class RunLogger {
  readonly filePath: string
  readonly rotatedPath: string
  private readonly maxBytes: number
  private readonly ringSize: number
  private readonly bootstrapTail: number
  private ring: LogEntry[] = []
  private nextId = 1
  private bytes = 0

  constructor(dshHome: string, options: RunLoggerOptions = {}) {
    const dir = path.join(dshHome, DATA_DIRNAME, LOG_DIRNAME)
    this.filePath = path.join(dir, LOG_FILENAME)
    this.rotatedPath = path.join(dir, LOG_ROTATED_FILENAME)
    this.maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES
    this.ringSize = options.ringSize ?? DEFAULT_LOG_RING_SIZE
    this.bootstrapTail = options.bootstrapTail ?? DEFAULT_LOG_BOOTSTRAP_TAIL
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 目录建不了也继续：内存 ring 仍可用 */
    }
    this.loadTail()
  }

  /** 写一条日志（level 泛化为 string 时兜底为 info） */
  log(level: LogLevel, category: LogCategory, message: string, extra: { name?: string; runId?: string; detail?: string } = {}): LogEntry {
    const entry: LogEntry = {
      id: this.nextId++,
      at: new Date().toISOString(),
      level: isLevel(level) ? level : 'info',
      category: isCategory(category) ? category : 'system',
      message,
    }
    if (extra.name) entry.name = extra.name
    if (extra.runId) entry.runId = extra.runId
    if (extra.detail) entry.detail = extra.detail
    this.push(entry)
    this.append(entry)
    return entry
  }

  info(category: LogCategory, message: string, extra?: { name?: string; runId?: string; detail?: string }): LogEntry {
    return this.log('info', category, message, extra)
  }

  success(category: LogCategory, message: string, extra?: { name?: string; runId?: string; detail?: string }): LogEntry {
    return this.log('success', category, message, extra)
  }

  warn(category: LogCategory, message: string, extra?: { name?: string; runId?: string; detail?: string }): LogEntry {
    return this.log('warn', category, message, extra)
  }

  error(category: LogCategory, message: string, extra?: { name?: string; runId?: string; detail?: string }): LogEntry {
    return this.log('error', category, message, extra)
  }

  /** 查询：返回新→旧；total = 过滤前 ring 总条数（DESIGN-v2 §4.3 + Lead 确认） */
  query(query: LogQuery = {}): { entries: LogEntry[]; total: number } {
    const level = isLevel(query.level) ? query.level : undefined
    const category = isCategory(query.category) ? query.category : undefined
    const rawLimit = typeof query.limit === 'number' && Number.isFinite(query.limit) ? Math.floor(query.limit) : LOG_QUERY_DEFAULT_LIMIT
    const limit = Math.max(1, Math.min(LOG_QUERY_MAX_LIMIT, rawLimit))
    const total = this.ring.length
    const filtered = this.ring.filter((e) => (!level || e.level === level) && (!category || e.category === category))
    const entries = filtered.slice().reverse().slice(0, limit).map((e) => ({ ...e }))
    return { entries, total }
  }

  /** 内存中全部日志（时间正序，测试 / 导出用） */
  all(): LogEntry[] {
    return this.ring.map((e) => ({ ...e }))
  }

  /** 读回条数（启动加载后用于自检） */
  get loadedCount(): number {
    return this.ring.length
  }

  clear(): void {
    this.ring = []
    this.nextId = 1
    this.bytes = 0
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath)
      if (existsSync(this.rotatedPath)) unlinkSync(this.rotatedPath)
    } catch {
      /* 尽力而为 */
    }
  }

  // ---------- 内部 ----------

  private push(entry: LogEntry): void {
    this.ring.push(entry)
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize)
    }
  }

  private append(entry: LogEntry): void {
    try {
      this.rotateIfNeeded()
      const line = JSON.stringify(entry) + '\n'
      appendFileSync(this.filePath, line, 'utf8')
      this.bytes += Buffer.byteLength(line)
    } catch {
      /* 落盘失败不影响内存日志与同步主流程 */
    }
  }

  private rotateIfNeeded(): void {
    let size = this.bytes
    if (!size) {
      try {
        size = existsSync(this.filePath) ? statSync(this.filePath).size : 0
      } catch {
        size = 0
      }
    }
    if (size <= this.maxBytes) return
    try {
      if (existsSync(this.rotatedPath)) unlinkSync(this.rotatedPath)
      if (existsSync(this.filePath)) renameSync(this.filePath, this.rotatedPath)
      else writeFileSync(this.filePath, '', 'utf8')
      this.bytes = 0
    } catch {
      // 轮转失败：清空当前文件，至少不再无限膨胀
      try {
        writeFileSync(this.filePath, '', 'utf8')
        this.bytes = 0
      } catch {
        /* 放弃 */
      }
    }
  }

  private loadTail(): void {
    try {
      if (!existsSync(this.filePath)) {
        this.bytes = 0
        return
      }
      this.bytes = statSync(this.filePath).size
      const text = readFileSync(this.filePath, 'utf8')
      const lines = text.split('\n').filter((l) => l.trim() !== '')
      const tail = lines.slice(-this.bootstrapTail)
      const entries: LogEntry[] = []
      let maxId = 0
      for (const line of tail) {
        try {
          const parsed = JSON.parse(line) as LogEntry
          if (typeof parsed?.id !== 'number' || typeof parsed?.message !== 'string') continue
          if (!isLevel(parsed.level) || !isCategory(parsed.category)) continue
          entries.push(parsed)
          if (parsed.id > maxId) maxId = parsed.id
        } catch {
          /* 半截行 / 损坏行跳过 */
        }
      }
      this.ring = entries
      if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize)
      this.nextId = maxId + 1
    } catch {
      this.ring = []
      this.nextId = 1
      this.bytes = 0
    }
  }
}

export function createRunLogger(dshHome: string, options?: RunLoggerOptions): RunLogger {
  return new RunLogger(dshHome, options)
}
