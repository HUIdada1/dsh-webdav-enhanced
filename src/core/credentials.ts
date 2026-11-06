/*
 * 本地凭据存储：WebDAV 密码单独落 0600 文件，不进 cordis 配置、不进远端。
 * ConfigStore 只保留 passwordRef 标记，明文密码永远只在这一处。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import path from 'node:path'

export const CREDENTIALS_FILENAME = 'credentials.json'

interface CredentialsFile {
  password?: string
}

export class CredentialStore {
  private readonly filePath: string

  constructor(dshHome: string) {
    const dir = path.join(dshHome, '.webdav-sync')
    mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, CREDENTIALS_FILENAME)
  }

  /** 读取明文密码；文件缺失或损坏返回空串 */
  read(): string {
    try {
      if (!existsSync(this.filePath)) return ''
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as CredentialsFile
      return typeof raw.password === 'string' ? raw.password : ''
    } catch {
      return ''
    }
  }

  write(password: string): void {
    writeFileSync(this.filePath, JSON.stringify({ password }, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      // Windows 上 chmod 基本无效，失败不影响功能
      chmodSync(this.filePath, 0o600)
    } catch {
      /* 尽力而为 */
    }
  }

  clear(): void {
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath)
    } catch {
      /* 尽力而为 */
    }
  }
}
