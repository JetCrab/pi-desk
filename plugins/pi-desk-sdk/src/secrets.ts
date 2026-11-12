import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { getConfigPath } from './config.ts'
import {
  ensureStorageDirectory,
  readStorageFile,
  withStorageLock,
  writeStorageFile
} from './config-storage.ts'

export interface SecretStoreOptions {
  agentDir?: string
  /** 仅供隔离测试或受控集成注入；生产默认使用系统钥匙串。 */
  keyProvider?: () => Promise<Uint8Array>
}

export interface SecretStore {
  get(reference: string): Promise<string | null>
  put(value: string, reference?: string): Promise<string>
  /** 仅显式删除已确认不再被任何配置引用的凭据；发布过的旧引用不会自动回收。 */
  delete(reference: string): Promise<void>
  export(references: readonly string[]): Promise<Record<string, string>>
  import(values: Readonly<Record<string, string>>): Promise<Record<string, string>>
}

const header = Buffer.from('PIDSECR1')
class KeyError extends Error {}
const nonceLength = 12
const tagLength = 16
const maxVaultBytes = 8 * 1024 * 1024
const maxVaultRecords = 4096

function assertVaultCapacity(values: Record<string, string>): void {
  const entries = Object.entries(values)
  const guidance =
    '请先导出需要保留的凭据，并仅显式删除已确认不再被任何配置引用的凭据后重试；不会自动清空保险库'
  if (entries.length > maxVaultRecords) {
    throw new Error(`凭据保险库最多保存 ${maxVaultRecords} 条记录；${guidance}`)
  }
  let bytes = header.length + nonceLength + tagLength + 2 + Math.max(entries.length - 1, 0)
  for (const [reference, value] of entries) {
    if (Buffer.byteLength(value, 'utf8') > maxVaultBytes) {
      throw new Error(`凭据保险库完整密文不能超过 8 MiB；${guidance}`)
    }
    bytes +=
      Buffer.byteLength(JSON.stringify(reference), 'utf8') +
      1 +
      Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (bytes > maxVaultBytes) throw new Error(`凭据保险库完整密文不能超过 8 MiB；${guidance}`)
  }
}

const referencePattern =
  /^secret:\/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u

export function isSecretReference(value: unknown): value is string {
  return typeof value === 'string' && referencePattern.test(value)
}

function assertReference(reference: string): void {
  if (!isSecretReference(reference)) throw new Error('凭据引用必须为 secret://UUID')
}

function decodeVault(content: Buffer, key: Buffer): Record<string, string> {
  try {
    if (
      content.length < header.length + nonceLength + tagLength ||
      !content.subarray(0, header.length).equals(header)
    ) {
      throw new Error()
    }
    const nonceEnd = header.length + nonceLength
    const decipher = createDecipheriv('aes-256-gcm', key, content.subarray(header.length, nonceEnd))
    decipher.setAAD(header)
    decipher.setAuthTag(content.subarray(nonceEnd, nonceEnd + tagLength))
    const plaintext = Buffer.concat([
      decipher.update(content.subarray(nonceEnd + tagLength)),
      decipher.final()
    ])
    try {
      const values: unknown = JSON.parse(plaintext.toString('utf8'))
      if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error()
      for (const [reference, value] of Object.entries(values)) {
        if (!isSecretReference(reference) || typeof value !== 'string') throw new Error()
      }
      return values as Record<string, string>
    } finally {
      plaintext.fill(0)
    }
  } catch {
    throw new Error('凭据保险库认证失败或格式无效，请确认密钥与文件完整性')
  }
}

function encodeVault(values: Record<string, string>, key: Buffer): Buffer {
  const nonce = randomBytes(nonceLength)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(header)
  const plaintext = Buffer.from(JSON.stringify(values))
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return Buffer.concat([header, nonce, cipher.getAuthTag(), ciphertext])
  } finally {
    plaintext.fill(0)
  }
}

function validateKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error('凭据主密钥必须是 32 字节')
  }
  return Buffer.from(key)
}

async function loadKey(
  path: string,
  vaultExists: boolean,
  keyProvider: SecretStoreOptions['keyProvider'],
  assertLocked: () => void
): Promise<Buffer> {
  if (keyProvider) {
    try {
      return validateKey(await keyProvider())
    } catch {
      throw new Error('注入的凭据密钥提供器失败或未返回 32 字节密钥')
    }
  }
  const keyFile = process.env.PI_DESK_SECRET_KEY_FILE
  if (keyFile !== undefined) {
    if (!keyFile) throw new Error('PI_DESK_SECRET_KEY_FILE 必须指定外部密钥文件')
    const content = readStorageFile(resolve(keyFile))
    if (content === null) throw new Error('外部凭据密钥文件不存在，拒绝生成或替换密钥')
    try {
      // 外部文件由部署方持有；SDK 只读原始 32 字节，从不创建或改写它。
      return validateKey(content)
    } finally {
      content.fill(0)
    }
  }
  try {
    // 延迟加载原生模块，注入测试及外部密钥文件模式不访问系统钥匙串。
    const { Entry } = await import('@napi-rs/keyring')
    const directory = realpathSync(dirname(path))
    const identity = process.platform === 'win32' ? directory.toLowerCase() : directory
    const account = createHash('sha256').update(identity).digest('hex')
    const entry = new Entry('pi-desk.credentials', account, { linux: { store: 'secret-service' } })
    const password = entry.getPassword()
    if (password !== null) {
      if (!/^[A-Za-z0-9+/]{43}=$/u.test(password)) throw new KeyError('凭据主密钥格式无效')
      const key = Buffer.from(password, 'base64')
      if (key.length !== 32 || key.toString('base64') !== password)
        throw new KeyError('凭据主密钥格式无效')
      return key
    }
    if (vaultExists) throw new KeyError('凭据保险库已存在，但系统钥匙串中的主密钥缺失，拒绝重建')
    assertLocked()
    const key = randomBytes(32)
    try {
      entry.setPassword(key.toString('base64'))
      if (entry.getPassword() !== key.toString('base64')) throw new Error('凭据主密钥写入校验失败')
      return key
    } catch {
      key.fill(0)
      throw new KeyError('凭据主密钥写入失败，请检查系统钥匙串')
    }
  } catch (error) {
    if (error instanceof KeyError) throw error
    // 原生错误正文可能包含凭据；仅给出可定位且不泄漏秘密的操作原因。
    throw new Error(
      '系统钥匙串不可用，无法解锁凭据；Linux 需要 Secret Service，也可设置 PI_DESK_SECRET_KEY_FILE'
    )
  }
}

export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const path = resolve(getConfigPath('credentials.enc', options.agentDir))
  const keyProvider = options.keyProvider

  async function access<T>(
    action: (values: Record<string, string>) => { result: T; changed: boolean }
  ): Promise<T> {
    ensureStorageDirectory(dirname(path))
    return withStorageLock(path, async (assertLocked) => {
      const existing = readStorageFile(path)
      let key: Buffer | undefined
      try {
        let values: Record<string, string> = {}
        if (existing !== null) {
          key = await loadKey(path, true, keyProvider, assertLocked)
          values = decodeVault(existing, key)
        }
        assertLocked()
        const { result, changed } = action(values)
        if (changed) {
          assertVaultCapacity(values)
          key ??= await loadKey(path, false, keyProvider, assertLocked)
          const content = encodeVault(values, key)
          // 写前先用同一解密路径验证完整格式，再原子发布并逐字节回读校验。
          decodeVault(content, key)
          assertLocked()
          writeStorageFile(path, content, existing)
        }
        return result
      } finally {
        key?.fill(0)
      }
    })
  }

  return {
    async get(reference): Promise<string | null> {
      assertReference(reference)
      return access((values) => ({ result: values[reference] ?? null, changed: false }))
    },
    async put(value, reference): Promise<string> {
      if (typeof value !== 'string') throw new Error('凭据值必须是字符串')
      if (reference !== undefined) assertReference(reference)
      return access((values) => {
        let next = reference ?? `secret://${randomUUID()}`
        while (reference === undefined && Object.hasOwn(values, next))
          next = `secret://${randomUUID()}`
        values[next] = value
        return { result: next, changed: true }
      })
    },
    async delete(reference): Promise<void> {
      assertReference(reference)
      return access((values) => {
        const changed = Object.hasOwn(values, reference)
        delete values[reference]
        return { result: undefined, changed }
      })
    },
    async export(references): Promise<Record<string, string>> {
      for (const reference of references) assertReference(reference)
      return access((values) => {
        const exported: Record<string, string> = {}
        for (const reference of references) {
          if (!Object.hasOwn(values, reference)) throw new Error('导出的凭据引用不存在')
          exported[reference] = values[reference]
        }
        return { result: exported, changed: false }
      })
    },
    async import(values): Promise<Record<string, string>> {
      const entries = Object.entries(values)
      for (const [reference, value] of entries) {
        assertReference(reference)
        if (typeof value !== 'string') throw new Error('导入的凭据值必须是字符串')
      }
      return access((stored) => {
        const mapping: Record<string, string> = {}
        for (const [oldReference, value] of entries) {
          let next: string
          do {
            next = `secret://${randomUUID()}`
          } while (Object.hasOwn(stored, next) || Object.hasOwn(values, next))
          stored[next] = value
          mapping[oldReference] = next
        }
        return { result: mapping, changed: entries.length > 0 }
      })
    }
  }
}
