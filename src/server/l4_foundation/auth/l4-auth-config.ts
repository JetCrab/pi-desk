import 'server-only'

import { getL4PiDeskDataDir } from '@server/l4_foundation/pi/l4-pi-desk-data-dir'

import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const AuthConfigSchema = z
  .object({
    passwordHash: z.string().regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/)
  })
  .strict()

const ReadAuthConfigSchema = AuthConfigSchema.extend({
  username: z.string().trim().min(1).max(64).optional()
})

type AuthConfig = z.infer<typeof AuthConfigSchema>

export interface L4AuthCredentials extends AuthConfig {
  sessionSecret: string
}

export class L4AuthConfigError extends Error {
  constructor() {
    super('登录保护配置无法读取，请修复配置或删除 auth.json 后重新设置')
    this.name = 'L4AuthConfigError'
  }
}

export function getL4AuthConfigPath(): string {
  return join(getL4PiDeskDataDir(), 'auth.json')
}

function sessionKeyPath(): string {
  return join(getL4PiDeskDataDir(), 'auth-session-key')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function readSessionKey(): string {
  const key = readFileSync(sessionKeyPath(), 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(key)) throw new L4AuthConfigError()
  return key
}

export function readL4AuthCredentials(): L4AuthCredentials | null {
  let content: string
  try {
    content = readFileSync(getL4AuthConfigPath(), 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw new L4AuthConfigError()
  }

  try {
    const config = ReadAuthConfigSchema.parse(JSON.parse(content) as unknown)
    // 旧配置沿用原签名材料，保存为仅密码配置后使旧 Cookie 失效。
    const sessionMaterial =
      config.username === undefined ? [config.passwordHash] : [config.username, config.passwordHash]
    // 摘要只参与凭据绑定；Cookie 的签名能力来自另一个文件中的随机密钥。
    const sessionSecret = createHmac('sha256', readSessionKey())
      .update(JSON.stringify(sessionMaterial))
      .digest('hex')
    return { passwordHash: config.passwordHash, sessionSecret }
  } catch {
    throw new L4AuthConfigError()
  }
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(salt, 'hex'),
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error)
        else resolve(key)
      }
    )
  })
}

export async function hashL4AuthPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = await derivePassword(password, salt)
  return `scrypt:${salt}:${hash.toString('hex')}`
}

export async function verifyL4AuthPassword(
  password: string,
  passwordHash: string
): Promise<boolean> {
  const [, salt, expected] = passwordHash.split(':')
  const actual = await derivePassword(password, salt)
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'))
}

export function writeL4AuthConfig(config: AuthConfig | null): void {
  const path = getL4AuthConfigPath()
  if (!config) {
    try {
      unlinkSync(path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    return
  }

  const parsed = AuthConfigSchema.parse(config)
  mkdirSync(dirname(path), { recursive: true })
  if (readL4AuthCredentials() === null) {
    writeFileSync(sessionKeyPath(), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  }
  readSessionKey()
  // mode 只约束新建文件；恢复时可能复用权限较宽的旧密钥文件。
  chmodSync(sessionKeyPath(), 0o600)

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, path)
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}
