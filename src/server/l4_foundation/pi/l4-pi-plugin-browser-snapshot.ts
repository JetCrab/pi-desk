import 'server-only'

import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

const MAX_FILES = 2_048
const MAX_ENTRIES = 4_096
const MAX_MODULE_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024

export interface L4PiBrowserModuleSnapshot {
  readonly size: number
  readonly modules: ReadonlyMap<string, { readonly content: Buffer; readonly etag: string }>
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export async function captureL4PiBrowserModules(
  entryPath: string
): Promise<L4PiBrowserModuleSnapshot> {
  if (basename(entryPath) !== 'entry.js') throw new Error('Browser Entry 必须命名为 entry.js')
  const root = await realpath(dirname(entryPath))
  const modules = new Map<string, { content: Buffer; etag: string }>()
  let size = 0
  let visitedEntries = 0
  const captured: Array<{ path: string; size: number; mtimeMs: number; ino: number }> = []

  const visit = async (
    directory: string,
    prefix: string,
    ancestors: Set<string>
  ): Promise<void> => {
    const actual = await realpath(directory)
    if (!inside(root, actual)) return
    if (ancestors.has(actual)) throw new Error('Browser 模块目录存在符号链接循环')
    const nextAncestors = new Set(ancestors).add(actual)
    const entries = await readdir(actual, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (++visitedEntries > MAX_ENTRIES) throw new Error('Browser 模块目录条目超过上限')
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(actual, entry.name)
      const target = await realpath(path)
      if (!inside(root, target)) continue
      const metadata = await stat(target)
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (metadata.isDirectory()) {
        await visit(target, key, nextAncestors)
        continue
      }
      if (!metadata.isFile() || !entry.name.endsWith('.js')) continue
      if (key === 'entry.js' && basename(target) !== 'entry.js') {
        throw new Error('Browser Entry 符号链接必须指向 entry.js')
      }
      if (
        modules.size >= MAX_FILES ||
        metadata.size > MAX_MODULE_BYTES ||
        size + metadata.size > MAX_SNAPSHOT_BYTES
      ) {
        throw new Error('Browser 模块快照超过数量或容量上限')
      }
      const content = await readFile(target)
      const after = await stat(target)
      if (
        content.length !== metadata.size ||
        after.size !== metadata.size ||
        after.mtimeMs !== metadata.mtimeMs
      ) {
        throw new Error('Browser 模块在读取时发生变化，请构建完成后重新加载')
      }
      size += content.length
      captured.push({ path: target, size: after.size, mtimeMs: after.mtimeMs, ino: after.ino })
      modules.set(key, { content, etag: `"${createHash('sha256').update(content).digest('hex')}"` })
    }
  }

  await visit(root, '', new Set())
  for (const file of captured) {
    const current = await stat(file.path)
    if (
      current.size !== file.size ||
      current.mtimeMs !== file.mtimeMs ||
      current.ino !== file.ino
    ) {
      throw new Error('Browser 模块组在读取时发生变化，请构建完成后重新加载')
    }
  }
  if (!modules.has('entry.js')) throw new Error('Browser Entry 模块缺失或越出专用目录')
  return { size, modules }
}
