import 'server-only'

import { open, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent'

export interface L4PiDirectorySummary {
  cwd: string
  sessionCount: number
  updatedAt: number
}

interface SessionHeader {
  id: string
  cwd: string
}

// 与 Pi 的发现边界一致；损坏或异常大的文件头不能导致读取整个会话正文。
const MAX_HEADER_BYTES = 1024 * 1024

async function readSessionHeader(path: string): Promise<SessionHeader | null> {
  let handle
  try {
    handle = await open(path, 'r')
    const chunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(4096)
    let scanned = 0
    while (scanned < MAX_HEADER_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      scanned += bytesRead
      let start = 0
      for (let index = 0; index <= bytesRead; index += 1) {
        if (index === bytesRead && bytesRead > 0) break
        if (index < bytesRead && buffer[index] !== 10) continue
        chunks.push(Buffer.from(buffer.subarray(start, index)))
        const line = Buffer.concat(chunks).toString('utf8').trim()
        chunks.length = 0
        start = index + 1
        if (!line) continue
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        if (!value || typeof value !== 'object') return null
        const header = value as Record<string, unknown>
        return header.type === 'session' && typeof header.id === 'string'
          ? { id: header.id, cwd: typeof header.cwd === 'string' ? header.cwd : '' }
          : null
      }
      if (bytesRead === 0) return null
      chunks.push(Buffer.from(buffer.subarray(start, bytesRead)))
    }
    console.warn('[Pi Desk][PiSessionDiscovery] 会话文件头超过读取上限', { path })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[Pi Desk][PiSessionDiscovery] 无法读取会话文件头', {
        path,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  } finally {
    await handle?.close()
  }
  return null
}

export async function findL4PiSessionFile(
  cwd: string,
  sessionId: string,
  cachedPath?: string
): Promise<string | null> {
  const matches = async (path: string): Promise<boolean> => {
    const header = await readSessionHeader(path)
    return header?.id === sessionId && header.cwd !== '' && resolve(header.cwd) === cwd
  }
  const directory = SessionManager.create(cwd).getSessionDir()
  if (
    cachedPath &&
    dirname(resolve(cachedPath)) === resolve(directory) &&
    (await matches(cachedPath))
  )
    return cachedPath

  const names = await readdir(directory)
  for (const name of names) {
    if (name !== `${sessionId}.jsonl` && !name.endsWith(`_${sessionId}.jsonl`)) continue
    const path = join(directory, name)
    if (await matches(path)) return path
  }
  // 兼容被重命名的会话；SDK 的定向发现只读取有界文件头，不构建全文列表。
  const path = SessionManager.findById(cwd, sessionId, directory)
  return path && (await matches(path)) ? path : null
}

export async function discoverL4PiDirectories(): Promise<L4PiDirectorySummary[]> {
  const root = join(getAgentDir(), 'sessions')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const pending = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
  const summaries = new Map<string, L4PiDirectorySummary>()
  let nextIndex = 0
  async function discover(): Promise<void> {
    while (nextIndex < pending.length) {
      const directory = join(root, pending[nextIndex++]!.name)
      let names
      try {
        names = await readdir(directory)
      } catch (error) {
        console.warn('[Pi Desk][PiSessionDiscovery] 无法读取会话目录', {
          directory,
          message: error instanceof Error ? error.message : String(error)
        })
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(directory, name)
        const header = await readSessionHeader(path)
        if (!header?.cwd) continue
        const metadata = await stat(path).catch(() => null)
        if (!metadata?.isFile()) continue
        const cwd = resolve(header.cwd)
        const current = summaries.get(cwd) ?? { cwd, sessionCount: 0, updatedAt: 0 }
        current.sessionCount += 1
        current.updatedAt = Math.max(current.updatedAt, metadata.mtime.getTime())
        summaries.set(cwd, current)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(10, pending.length) }, () => discover()))
  return [...summaries.values()].sort((left, right) => right.updatedAt - left.updatedAt)
}
