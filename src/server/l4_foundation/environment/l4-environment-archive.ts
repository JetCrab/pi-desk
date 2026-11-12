import { constants } from 'node:fs'
import { open, unlink, type FileHandle } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { extract, pack } from 'tar-stream'
import {
  assertEnvironmentEntryPath,
  assertEnvironmentTargetPaths,
  currentEnvironmentTargetSemantics,
  type EnvironmentPlatform
} from './l4-environment-paths'

// v1: magic(8), version/N/r/p(4 each), salt(16), nonce(12), tag(16)。前52字节为AAD。
const MAGIC = Buffer.from('PDSKBK01')
const AAD_SIZE = 52
const HEADER_SIZE = 68
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export interface EnvironmentArchiveLimits {
  maxArchiveBytes: number
  maxEntryBytes: number
  maxTotalBytes: number
  maxFiles: number
  maxExpansionRatio: number
  targetPlatform: EnvironmentPlatform
}

export const ENVIRONMENT_ARCHIVE_DEFAULT_LIMITS: Readonly<EnvironmentArchiveLimits> = Object.freeze(
  {
    maxArchiveBytes: 8 * 1024 ** 3,
    maxEntryBytes: 2 * 1024 ** 3,
    maxTotalBytes: 16 * 1024 ** 3,
    maxFiles: 100_000,
    maxExpansionRatio: 1000,
    targetPlatform: process.platform === 'win32' ? 'win32' : 'posix'
  }
)

export interface EnvironmentArchiveEntry {
  path: string
  size: number
  content: AsyncIterable<Uint8Array>
}

export interface EnvironmentArchiveEntryHeader {
  path: string
  size: number
}

function limitsFor(overrides?: Partial<EnvironmentArchiveLimits>): EnvironmentArchiveLimits {
  const limits = { ...ENVIRONMENT_ARCHIVE_DEFAULT_LIMITS, ...overrides }
  for (const [key, value] of Object.entries(limits)) {
    if (
      key !== 'targetPlatform' &&
      (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    ) {
      throw new Error('归档资源限制必须为正安全整数')
    }
  }
  if (limits.targetPlatform !== 'posix' && limits.targetPlatform !== 'win32') {
    throw new Error('归档目标平台不受支持')
  }
  return limits
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (!password) throw new Error('备份密码不能为空')
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, SCRYPT, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

async function writeBytes(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset,
      position + offset
    )
    if (bytesWritten === 0) throw new Error('归档文件写入未完成')
    offset += bytesWritten
  }
}

async function readBytes(handle: FileHandle, size: number, position: number): Promise<Buffer> {
  const data = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(data, offset, size - offset, position + offset)
    if (bytesRead === 0) throw new Error('归档文件已截断')
    offset += bytesRead
  }
  return data
}

function byteLimit(maximum: number, expected?: number): Transform {
  let size = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      size += chunk.length
      callback(size > maximum ? new Error('归档内容超过容量限制') : null, chunk)
    },
    flush(callback): void {
      callback(expected !== undefined && size !== expected ? new Error('归档条目长度不符') : null)
    }
  })
}

class EntryValidator {
  private readonly paths = new Set<string>()
  private total = 0

  constructor(private readonly limits: EnvironmentArchiveLimits) {}

  add(path: string, size: number): void {
    assertEnvironmentEntryPath(path)
    if (this.paths.has(path)) throw new Error('归档包含重复条目')
    if (!Number.isSafeInteger(size) || size < 0 || size > this.limits.maxEntryBytes) {
      throw new Error('归档条目长度不合法或超过容量限制')
    }
    this.paths.add(path)
    this.total += size
    if (this.paths.size > this.limits.maxFiles || this.total > this.limits.maxTotalBytes) {
      throw new Error('归档超过文件数或总容量限制')
    }
  }

  finish(): void {
    assertEnvironmentTargetPaths(
      this.paths,
      this.limits.targetPlatform,
      currentEnvironmentTargetSemantics(this.limits.targetPlatform)
    )
  }
}

/** 仅接受普通文件；清单由上层作为普通条目提供，同样被压缩加密。输出独占创建，失败删除半包。 */
export async function writeEnvironmentArchive(input: {
  outputPath: string
  password: string
  entries: AsyncIterable<EnvironmentArchiveEntry>
  limits?: Partial<EnvironmentArchiveLimits>
}): Promise<void> {
  const limits = limitsFor(input.limits)
  const header = Buffer.alloc(HEADER_SIZE)
  MAGIC.copy(header)
  header.writeUInt32BE(1, 8)
  header.writeUInt32BE(SCRYPT.N, 12)
  header.writeUInt32BE(SCRYPT.r, 16)
  header.writeUInt32BE(SCRYPT.p, 20)
  randomBytes(16).copy(header, 24)
  randomBytes(12).copy(header, 40)
  const key = await deriveKey(input.password, header.subarray(24, 40))
  let handle: FileHandle | undefined
  let complete = false
  const archive = pack()
  try {
    handle = await open(input.outputPath, 'wx', 0o600)
    const output = handle
    await writeBytes(output, header, 0)
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(40, 52))
    cipher.setAAD(header.subarray(0, AAD_SIZE))
    let position = HEADER_SIZE
    const writing = pipeline(archive, createGzip(), cipher, async (source): Promise<void> => {
      for await (const chunk of source) {
        const data = Buffer.from(chunk)
        if (position + data.length > limits.maxArchiveBytes) throw new Error('归档文件超过容量限制')
        await writeBytes(output, data, position)
        position += data.length
      }
    })
    const producing = (async (): Promise<void> => {
      const validator = new EntryValidator(limits)
      try {
        for await (const entry of input.entries) {
          validator.add(entry.path, entry.size)
          const destination = archive.entry({
            name: entry.path,
            size: entry.size,
            type: 'file',
            mode: 0o600
          })
          await pipeline(
            Readable.from(entry.content),
            byteLimit(entry.size, entry.size),
            destination
          )
        }
        validator.finish()
        archive.finalize()
      } catch (error) {
        archive.destroy(error instanceof Error ? error : new Error('归档条目读取失败'))
        throw error
      }
    })()
    try {
      await Promise.all([writing, producing])
    } finally {
      archive.destroy()
      await Promise.allSettled([writing, producing])
    }
    await writeBytes(output, cipher.getAuthTag(), AAD_SIZE)
    await output.sync()
    complete = true
  } finally {
    key.fill(0)
    archive.destroy()
    if (handle) {
      try {
        await handle.close()
      } finally {
        if (!complete) await unlink(input.outputPath)
      }
    }
  }
}

async function* encryptedBody(handle: FileHandle, size: number): AsyncGenerator<Buffer> {
  let position = HEADER_SIZE
  while (position < size) {
    const data = await readBytes(handle, Math.min(64 * 1024, size - position), position)
    position += data.length
    yield data
  }
}

async function parseArchive(
  handle: FileHandle,
  size: number,
  header: Buffer,
  key: Buffer,
  limits: EnvironmentArchiveLimits,
  consumer?: (
    header: EnvironmentArchiveEntryHeader,
    content: AsyncIterable<Buffer>
  ) => Promise<void>
): Promise<void> {
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(40, 52))
  decipher.setAAD(header.subarray(0, AAD_SIZE))
  decipher.setAuthTag(header.subarray(AAD_SIZE))
  const archive = extract()
  const validator = new EntryValidator(limits)
  archive.on('entry', (entry, content, next): void => {
    content.on('error', (error: Error): void => {
      archive.destroy(error)
    })
    void (async (): Promise<void> => {
      if (entry.type !== 'file' || entry.linkname) throw new Error('归档仅允许普通文件')
      validator.add(entry.name, entry.size ?? 0)
      // tar-stream 输出字节 Buffer；其 streamx 基类将迭代元素声明为 unknown。
      if (consumer) {
        await consumer(
          { path: entry.name, size: entry.size ?? 0 },
          content as AsyncIterable<Buffer>
        )
      }
      // 消费者可跳过内容，仍须排空并校验整个流。
      for await (const _chunk of content) {
        void _chunk
      }
      next()
    })().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error('归档条目处理失败')
      content.destroy(failure)
      archive.destroy(failure)
    })
  })
  // 包含 tar 头、padding 与扩展头，避免零长度文件或异常 gzip 占用无限资源。
  const maxTarBytes = Math.min(
    limits.maxTotalBytes + limits.maxFiles * 2048 + 1024,
    (size - HEADER_SIZE) * limits.maxExpansionRatio
  )
  await pipeline(
    Readable.from(encryptedBody(handle, size)),
    decipher,
    createGunzip(),
    byteLimit(maxTarBytes),
    archive
  )
  validator.finish()
}

/**
 * 同一文件句柄两遍读取：第一遍完成认证及全部结构校验，之后才调用消费者。
 * 第二遍仍会认证，防止原 inode 被原地修改。消费者只能写隔离暂存，不得直接应用到有效环境；
 * 必须等本 Promise 成功后才提交，失败丢弃本次全部结果。流仅在回调内有效，由本函数排空/释放。
 * 不创建明文临时包、不持有跨调用缓存；输入句柄和密钥在所有退出路径释放。
 */
export async function readEnvironmentArchive(input: {
  archivePath: string
  password: string
  consumeEntry: (
    header: EnvironmentArchiveEntryHeader,
    content: AsyncIterable<Buffer>
  ) => Promise<void>
  limits?: Partial<EnvironmentArchiveLimits>
}): Promise<void> {
  const limits = limitsFor(input.limits)
  const handle = await open(input.archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let key: Buffer | undefined
  try {
    const initial = await handle.stat()
    if (!initial.isFile() || initial.size <= HEADER_SIZE || initial.size > limits.maxArchiveBytes) {
      throw new Error('归档不是普通文件或容量不合法')
    }
    const header = await readBytes(handle, HEADER_SIZE, 0)
    if (
      !header.subarray(0, 8).equals(MAGIC) ||
      header.readUInt32BE(8) !== 1 ||
      header.readUInt32BE(12) !== SCRYPT.N ||
      header.readUInt32BE(16) !== SCRYPT.r ||
      header.readUInt32BE(20) !== SCRYPT.p
    ) {
      throw new Error('归档版本或加密参数不受支持')
    }
    key = await deriveKey(input.password, header.subarray(24, 40))
    const unchanged = async (): Promise<void> => {
      const current = await handle.stat()
      if (
        current.size !== initial.size ||
        current.mtimeMs !== initial.mtimeMs ||
        !(await readBytes(handle, HEADER_SIZE, 0)).equals(header)
      ) {
        throw new Error('归档在读取期间发生变化')
      }
    }
    await parseArchive(handle, initial.size, header, key, limits)
    await unchanged()
    await parseArchive(handle, initial.size, header, key, limits, input.consumeEntry)
    await unchanged()
  } finally {
    key?.fill(0)
    await handle.close()
  }
}
