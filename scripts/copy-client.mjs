/*
 * 构建收尾：client.js 是纯 JS（无 import、无需转译），
 * 直接复制到 lib/ 供 dsh 通过 exports["./client"] 加载。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src', 'client.js')
const outDir = path.join(root, 'lib')
const out = path.join(outDir, 'client.js')

if (!existsSync(src)) {
  console.error(`[copy-client] 源文件不存在: ${src}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
copyFileSync(src, out)
console.log('[copy-client] src/client.js → lib/client.js')
