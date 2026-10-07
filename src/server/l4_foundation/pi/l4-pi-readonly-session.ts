import 'server-only'

import { readFile } from 'node:fs/promises'
import {
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader
} from '@earendil-works/pi-coding-agent'
import {
  projectL4PiChatEntries,
  readL4PiChatImageContent,
  type L4PiChatProjectedEntry
} from './l4-pi-chat-projection'

export interface L4PiReadonlySessionSnapshot {
  header: SessionHeader
  branch: SessionEntry[]
  entries: L4PiChatProjectedEntry[]
  truncated: boolean
}

function branchFromEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  const leaf = entries.at(-1)
  if (!leaf) return []
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const))
  const reversed: SessionEntry[] = []
  const visited = new Set<string>()
  let current: SessionEntry | undefined = leaf
  while (current) {
    if (visited.has(current.id)) throw new Error(`Pi session parent cycle detected: ${current.id}`)
    visited.add(current.id)
    reversed.push(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return reversed.reverse()
}

export async function readL4PiReadonlySessionFile(
  sessionFile: string
): Promise<L4PiReadonlySessionSnapshot> {
  const content = await readFile(sessionFile, 'utf8')
  const fileEntries = parseSessionEntries(content)
  const header = fileEntries[0]
  if (!header || header.type !== 'session' || !header.id || !header.cwd) {
    throw new Error(`Pi session file has an invalid header: ${sessionFile}`)
  }
  const entries = fileEntries
    .slice(1)
    .filter((entry): entry is SessionEntry => entry.type !== 'session')
  const branch = branchFromEntries(entries)
  return {
    header,
    branch,
    entries: projectL4PiChatEntries(branch),
    truncated: false
  }
}

export async function readL4PiReadonlySessionEntry(
  sessionFile: string,
  entryId: string
): Promise<{
  snapshot: L4PiReadonlySessionSnapshot
  entry: SessionEntry
  projected: L4PiChatProjectedEntry
}> {
  const snapshot = await readL4PiReadonlySessionFile(sessionFile)
  const branchIndex = snapshot.branch.findIndex((entry) => entry.id === entryId)
  if (branchIndex < 0) throw new Error(`Pi session entry is not on the current branch: ${entryId}`)
  const projected = projectL4PiChatEntries(snapshot.branch.slice(0, branchIndex + 1)).at(-1)
  if (!projected || projected.entryId !== entryId) {
    throw new Error(`Pi session entry is not a visible message: ${entryId}`)
  }
  return { snapshot, entry: snapshot.branch[branchIndex]!, projected }
}

export async function readL4PiReadonlySessionImage(
  sessionFile: string,
  entryId: string,
  imageIndex: number
): Promise<{ mimeType: string; data: string }> {
  if (!Number.isSafeInteger(imageIndex) || imageIndex < 0) throw new Error('图片位置无效')
  const { entry } = await readL4PiReadonlySessionEntry(sessionFile, entryId)
  if (
    entry.type !== 'message' ||
    (entry.message.role !== 'user' && entry.message.role !== 'toolResult')
  ) {
    throw new Error(`Pi session entry has no message images: ${entryId}`)
  }
  const image = readL4PiChatImageContent(entry.message.content, imageIndex)
  if (!image) throw new Error(`Pi message image was not found: ${entryId}/${imageIndex}`)
  return image
}
