import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOG_FILENAME, LOG_ROTATED_FILENAME, RunLogger } from '../src/core/runlog.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dsh-runlog-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function logFile(): string {
  return path.join(root, '.webdav-enhanced', 'logs', LOG_FILENAME)
}

function rotatedFile(): string {
  return path.join(root, '.webdav-enhanced', 'logs', LOG_ROTATED_FILENAME)
}

describe('RunLogger', () => {
  it('写入 JSONL，查询新→旧、total 为过滤前条数', () => {
    const logger = new RunLogger(root)
    logger.info('sync', '开始同步', { runId: 'r1' })
    logger.success('upload', '已上传：s1', { name: 's1', runId: 'r1' })
    logger.error('download', '下载失败', { name: 's2', detail: 'timeout' })

    expect(existsSync(logFile())).toBe(true)
    const lines = readFileSync(logFile(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    const first = JSON.parse(lines[0]) as { id: number; level: string; category: string; message: string }
    expect(first.level).toBe('info')
    expect(first.category).toBe('sync')
    expect(first.message).toBe('开始同步')

    const all = logger.query({ limit: 10 })
    expect(all.total).toBe(3)
    expect(all.entries.map((e) => e.message)).toEqual(['下载失败', '已上传：s1', '开始同步'])
    // id 单调递增：最新的一条 id 最大
    expect(all.entries[0].id).toBeGreaterThan(all.entries[1].id)
    // total 是过滤前总数，不随 level/category 过滤变化
    expect(logger.query({ level: 'error' }).total).toBe(3)
  })

  it('支持 level / category / limit 过滤', () => {
    const logger = new RunLogger(root)
    logger.info('sync', 'a')
    logger.success('upload', 'b', { name: 's1' })
    logger.warn('merge', 'c')
    logger.error('download', 'd')

    const errors = logger.query({ level: 'error' })
    expect(errors.entries.map((e) => e.message)).toEqual(['d'])
    const uploads = logger.query({ category: 'upload' })
    expect(uploads.entries).toHaveLength(1)
    expect(uploads.entries[0].name).toBe('s1')
    expect(logger.query({ limit: 1 }).entries).toHaveLength(1)
    expect(logger.query({ limit: 1 }).entries[0].message).toBe('d')
    // limit 上限 500
    expect(logger.query({ limit: 99999 }).entries.length).toBeLessThanOrEqual(500)
    // 非法 level 视为不过滤
    expect(logger.query({ level: 'nonsense' as never }).entries).toHaveLength(4)
  })

  it('ring 上限与启动读回末尾 N 条', () => {
    const writer = new RunLogger(root)
    for (let i = 0; i < 10; i++) writer.info('sync', `entry-${i}`)
    expect(writer.all()).toHaveLength(10)

    const reader = new RunLogger(root, { bootstrapTail: 3 })
    expect(reader.loadedCount).toBe(3)
    expect(reader.all().map((e) => e.message)).toEqual(['entry-7', 'entry-8', 'entry-9'])
    // id 接着历史继续递增，不重复
    const next = reader.info('sync', 'after-reload')
    expect(next.id).toBeGreaterThan(10)

    // ring 上限裁剪（只保留最新）
    const small = new RunLogger(root, { ringSize: 5 })
    for (let i = 0; i < 10; i++) small.info('sync', `n-${i}`)
    expect(small.all()).toHaveLength(5)
    expect(small.all().at(-1)?.message).toBe('n-9')
  })

  it('超过阈值轮转，只保留一份旧文件', () => {
    const logger = new RunLogger(root, { maxBytes: 300 })
    for (let i = 0; i < 40; i++) logger.info('sync', `rotate-${i}-${'x'.repeat(40)}`)
    expect(existsSync(rotatedFile())).toBe(true)
    expect(statSync(rotatedFile()).size).toBeGreaterThan(0)
    // 当前文件不应无限膨胀
    expect(statSync(logFile()).size).toBeLessThanOrEqual(300 + 1024)
    // 轮转后仍能继续读回
    const reader = new RunLogger(root, { bootstrapTail: 5 })
    expect(reader.loadedCount).toBeGreaterThan(0)
  })

  it('损坏行 / 半截行被忽略，不影响其余日志', () => {
    const file = logFile()
    // 先建目录并写一条合法 + 一条损坏
    const logger = new RunLogger(root)
    logger.info('sync', 'good-1')
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, '{not-json}\n')
    const reader = new RunLogger(root)
    expect(reader.all().map((e) => e.message)).toEqual(['good-1'])
    expect(reader.query({ limit: 10 }).total).toBe(1)
  })

  it('clear 清空内存与文件', () => {
    const logger = new RunLogger(root)
    logger.info('sync', 'x')
    logger.clear()
    expect(logger.loadedCount).toBe(0)
    expect(existsSync(logFile())).toBe(false)
  })
})
