import 'server-only'

import { getL4PiDeskDataDir } from '@server/l4_foundation/pi/l4-pi-desk-data-dir'

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { z } from 'zod'
import {
  bindConfigStore,
  getUnifiedConfigPath,
  readConfigSection
} from '@jetcrab/pi-desk-sdk/config'
import {
  L4AuthConfigSchema as AuthConfigSchema,
  L4AuthConfigError,
  initializeL4AuthSessionKey,
  readL4AuthSessionKey
} from './l4-auth-storage'

export { L4AuthConfigError, restoreL4AuthSessionKey } from './l4-auth-storage'

type AuthConfig = z.infer<typeof AuthConfigSchema>

let activePasswordVerifications = 0

export class L4AuthBusyError extends Error {
  constructor() {
    super('登录尝试过多，请稍后重试。')
    this.name = 'L4AuthBusyError'
  }
}

export interface L4AuthCredentials extends AuthConfig {
  sessionSecret: string
}

export function getL4AuthConfigPath(): string {
  return getUnifiedConfigPath()
}

function sessionKeyPath(): string {
  return join(getL4PiDeskDataDir(), 'auth-session-key')
}

export function readL4AuthCredentials(): L4AuthCredentials | null {
  try {
    const value = readConfigSection('pi-desk', 'auth')
    if (Object.keys(value).length === 0) return null
    const config = AuthConfigSchema.parse(value)
    // 摘要只参与凭据绑定；Cookie 的签名能力来自另一个文件中的随机密钥。
    const sessionSecret = createHmac('sha256', readL4AuthSessionKey(sessionKeyPath()))
      .update(JSON.stringify([config.passwordHash]))
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
  if (activePasswordVerifications >= 2) throw new L4AuthBusyError()
  activePasswordVerifications += 1
  try {
    const [, salt, expected] = passwordHash.split(':')
    const actual = await derivePassword(password, salt)
    return timingSafeEqual(actual, Buffer.from(expected, 'hex'))
  } finally {
    // 计算完成才释放，不随 HTTP 连接提前关闭而释放。
    activePasswordVerifications -= 1
  }
}

export async function writeL4AuthConfig(config: AuthConfig | null): Promise<void> {
  const store = bindConfigStore('pi-desk', 'auth')
  if (!config) {
    await store.set({})
    return
  }

  const parsed = AuthConfigSchema.parse(config)
  if (readL4AuthCredentials() === null) {
    initializeL4AuthSessionKey(sessionKeyPath())
  }
  readL4AuthSessionKey(sessionKeyPath())
  // mode 只约束新建文件；恢复时可能复用权限较宽的旧密钥文件。
  chmodSync(sessionKeyPath(), 0o600)

  await store.set(parsed)
}
