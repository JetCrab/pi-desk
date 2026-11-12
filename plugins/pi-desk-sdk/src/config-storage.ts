import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
}

function storageError(operation: string, path: string, error: unknown): Error {
  return new Error(`${operation}失败：${path}（${errorCode(error)}）`)
}

// 只创建目标文件需要的目录；AgentDir 及其他已有目录仍由调用方管理。
export function ensureStorageDirectory(path: string): void {
  assertDirectories(path)
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw storageError('创建配置目录', path, error)
  }
}

function assertDirectories(path: string): void {
  const parent = dirname(path)
  if (parent !== path) assertDirectories(parent)
  try {
    if (!lstatSync(path).isDirectory()) throw new Error(`配置目录不是普通目录：${path}`)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    if (error instanceof Error && error.message.startsWith('配置目录')) throw error
    throw storageError('检查配置目录', path, error)
  }
}

export function readStorageFile(path: string): Buffer | null {
  assertDirectories(dirname(path))
  let descriptor: number | undefined
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) throw new Error(`拒绝读取非普通配置文件或符号链接：${path}`)
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw new Error(`读取期间配置文件已变化：${path}`)
    }
    return readFileSync(descriptor)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    if (error instanceof Error && /^(拒绝读取|读取期间)/u.test(error.message)) throw error
    throw storageError('读取配置文件', path, error)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function assertFileUnchanged(path: string, expected: Buffer | null): void {
  const actual = readStorageFile(path)
  if (expected === null ? actual !== null : actual === null || !actual.equals(expected)) {
    throw new Error(`配置文件已变化，拒绝覆盖：${path}`)
  }
}

function syncDirectory(path: string): void {
  // Windows 不支持以普通文件描述符 fsync 目录；文件本身始终先 fsync。
  if (process.platform === 'win32') return
  const descriptor = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function writeStorageFile(path: string, content: Buffer, expected: Buffer | null): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  let committed = false
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    assertFileUnchanged(path, expected)
    if (expected === null) {
      // 硬链接发布保证目标在锁外被创建时也不会被覆盖。
      linkSync(temporary, path)
    } else {
      renameSync(temporary, path)
    }
    syncDirectory(dirname(path))
    const actual = readStorageFile(path)
    if (!actual?.equals(content)) throw new Error(`配置文件写入校验失败：${path}`)
    committed = true
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('配置文件')) throw error
    throw storageError('原子写入配置文件', path, error)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(temporary)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        const status = committed ? '配置已提交，不应回收其引用的凭据' : '配置写入失败，保留原始错误'
        console.warn(
          `${storageError('清理配置临时文件', temporary, error).message}；${status}，请清理该临时文件`
        )
      }
    }
  }
}

const lockOptions = { realpath: false, stale: 120_000, update: 10_000 }

export async function withStorageLock<T>(
  path: string,
  action: (assertLocked: () => void) => Promise<T>
): Promise<T> {
  let compromised = false
  let release: () => Promise<void>
  try {
    release = await lockfile.lock(path, {
      ...lockOptions,
      retries: { retries: 150, minTimeout: 100, maxTimeout: 100, randomize: false },
      onCompromised() {
        compromised = true
      }
    })
  } catch (error) {
    throw storageError('获取配置文件锁', path, error)
  }
  const assertLocked = (): void => {
    if (compromised) throw new Error(`配置文件锁已失效：${path}`)
  }
  try {
    const result = await action(assertLocked)
    assertLocked()
    return result
  } finally {
    try {
      await release()
    } catch (error) {
      console.warn(
        `${storageError('释放配置文件锁', path, error).message}；操作结果不回滚，请检查锁目录`
      )
    }
  }
}
