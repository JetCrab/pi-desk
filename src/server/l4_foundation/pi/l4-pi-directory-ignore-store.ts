import 'server-only'

import { resolve } from 'node:path'
import { bindConfigStore, readConfigSection } from '@jetcrab/pi-desk-sdk/config'

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
  try {
    return normalizeDirectories(
      parseDirectories(readConfigSection('pi-desk', 'ignored-directories').directories ?? [])
    )
  } catch (error) {
    console.warn('[Pi Desk][PiDirectoryIgnoreStore] 忽略目录配置无效，将按空列表处理', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return []
  }
}

export async function replaceL4PiDirectoryIgnore(
  cwdInput: string,
  ignored: boolean
): Promise<void> {
  const cwd = resolve(cwdInput)
  const key = getL4PiDirectoryKey(cwd)
  const current = listL4IgnoredPiDirectoryCwds()
  const exists = current.some((item) => getL4PiDirectoryKey(item) === key)
  if (exists === ignored) return

  const next = ignored
    ? [...current, cwd]
    : current.filter((item) => getL4PiDirectoryKey(item) !== key)
  await bindConfigStore('pi-desk', 'ignored-directories').set({ directories: next })

  console.info('[Pi Desk][PiDirectoryIgnoreStore] 已更新忽略目录', {
    cwd,
    ignored,
    ignoredCount: next.length
  })
}
