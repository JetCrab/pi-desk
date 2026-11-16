import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { readStorageFile } from './config-storage.ts'
import type { PluginJsonValue } from './shared.js'

const prefix = 'enc:v1:'
const aad = Buffer.from('pi-desk/config/v1')

export interface ConfigKeyOptions {
  /** 仅由宿主或隔离测试注入，不属于插件配置接口。 */
  keyProvider?: () => Promise<Uint8Array>
}

export function isEncryptedConfigValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(prefix)
}

export function hasEncryptedConfigValue(value: PluginJsonValue): boolean {
  if (isEncryptedConfigValue(value)) return true
  return value !== null && typeof value === 'object'
    ? Object.values(value).some(hasEncryptedConfigValue)
    : false
}

function keyBytes(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error('配置主密钥必须是原始 32 字节')
  }
  return Buffer.from(value)
}

export async function loadConfigKey(
  path: string,
  encryptedExists: boolean,
  options: ConfigKeyOptions,
  assertActive: () => void
): Promise<Buffer> {
  if (options.keyProvider) return keyBytes(await options.keyProvider())
  const file = process.env.PI_DESK_SECRET_KEY_FILE
  if (file !== undefined) {
    if (!file) throw new Error('PI_DESK_SECRET_KEY_FILE 必须指定外部密钥文件')
    const bytes = readStorageFile(resolve(file))
    if (bytes === null) throw new Error('配置外部密钥文件不存在')
    try {
      return keyBytes(bytes)
    } finally {
      bytes.fill(0)
    }
  }
  try {
    const { Entry } = await import('@napi-rs/keyring')
    const directory = realpathSync(dirname(path))
    const identity = process.platform === 'win32' ? directory.toLowerCase() : directory
    const account = createHash('sha256').update(identity).digest('hex')
    const entry = new Entry('pi-desk.config', account, { linux: { store: 'secret-service' } })
    const stored = entry.getPassword()
    if (stored !== null) {
      const key = Buffer.from(stored, 'base64')
      if (key.length !== 32 || key.toString('base64') !== stored) {
        key.fill(0)
        throw new Error('配置主密钥格式无效')
      }
      return key
    }
    if (encryptedExists) throw new Error('配置密文已存在但主密钥缺失，拒绝生成替代密钥')
    assertActive()
    const key = randomBytes(32)
    try {
      entry.setPassword(key.toString('base64'))
      if (entry.getPassword() !== key.toString('base64')) throw new Error('主密钥回读失败')
      return key
    } catch {
      key.fill(0)
      throw new Error('保存配置主密钥失败')
    }
  } catch (cause) {
    // 系统原生错误可能带凭据正文，不向插件转发。
    const message =
      cause instanceof Error && /^配置(密文|主密钥)/u.test(cause.message)
        ? cause.message
        : '系统钥匙串不可用，无法取得配置主密钥'
    throw new Error(message)
  }
}

export function encryptConfigValue(value: PluginJsonValue, key: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const plaintext = Buffer.from(JSON.stringify(z.json().parse(value)))
  try {
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return prefix + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64')
  } finally {
    plaintext.fill(0)
  }
}

export function decryptConfigValue(value: string, key: Buffer): PluginJsonValue {
  try {
    if (!isEncryptedConfigValue(value)) throw new Error()
    const encoded = value.slice(prefix.length)
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length < 29 || bytes.toString('base64') !== encoded) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    decipher.setAAD(aad)
    decipher.setAuthTag(bytes.subarray(12, 28))
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
    try {
      return z.json().parse(JSON.parse(plaintext.toString('utf8')))
    } finally {
      plaintext.fill(0)
    }
  } catch {
    throw new Error('配置密文认证失败或格式无效')
  }
}
