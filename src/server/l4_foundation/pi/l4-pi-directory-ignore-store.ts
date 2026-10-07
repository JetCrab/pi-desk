import 'server-only'

import { getL4PiDeskDataDir } from './l4-pi-desk-data-dir'

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const IGNORED_PI_DIRECTORIES_FILE_NAME = 'ignored-pi-directories.json'

function storePath(): string {
  return join(getL4PiDeskDataDir(), IGNORED_PI_DIRECTORIES_FILE_NAME)
}

export function getL4PiDirectoryKey(cwd: string): string {
  const normalized = resolve(cwd)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function parseDirectories(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((cwd) => typeof cwd !== 'string' || cwd.trim().length === 0)
  ) {
    throw new Error('Ignored Pi directories must be a string array')
  }
  return value
}

function normalizeDirectories(cwds: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const cwd of cwds) {
    const resolved = resolve(cwd.trim())
    const key = getL4PiDirectoryKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(resolved)
  }
  return normalized
}

export function listL4IgnoredPiDirectoryCwds(): string[] {
  const path = storePath()
  if (!existsSync(path)) return []

  try {
    return normalizeDirectories(parseDirectories(JSON.parse(readFileSync(path, 'utf8')) as unknown))
  } catch (error) {
    console.warn('[Pi Desk][PiDirectoryIgnoreStore] 忽略目录配置无效，将按空列表处理', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return []
  }
}

export function replaceL4PiDirectoryIgnore(cwdInput: string, ignored: boolean): void {
  const cwd = resolve(cwdInput)
  const key = getL4PiDirectoryKey(cwd)
  const current = listL4IgnoredPiDirectoryCwds()
  const exists = current.some((item) => getL4PiDirectoryKey(item) === key)
  if (exists === ignored) return

  const next = ignored
    ? [...current, cwd]
    : current.filter((item) => getL4PiDirectoryKey(item) !== key)
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }

  console.info('[Pi Desk][PiDirectoryIgnoreStore] 已更新忽略目录', {
    cwd,
    ignored,
    ignoredCount: next.length
  })
}
