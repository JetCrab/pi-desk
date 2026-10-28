import 'server-only'

import type { SessionManager } from '@earendil-works/pi-coding-agent'

export type L4PiSessionSearchScope = 'title' | 'user' | 'assistant' | 'sessionId'

export interface L4PiSessionSearchMatch {
  scope: L4PiSessionSearchScope
  count: number
  entryId: string | null
  timestampMs: number | null
  preview: string
}

export interface L4PiSessionSearchQuery {
  query: string
  searchIn: readonly L4PiSessionSearchScope[]
}

const MATCH_PREVIEW_MAX_LENGTH = 120
const MATCH_PREVIEW_PREFIX_LENGTH = 16

export interface L4PiSessionSearchMessage {
  entryId: string
  timestampMs: number
  text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readL4PiSessionTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export function normalizeL4PiSessionSearch(value: string): string {
  return value.trim().toLowerCase()
}

export function compactL4PiSessionPreview(text: string, maxLength: number): string {
  const content = text.replace(/\s+/g, ' ').trim()
  if (content.length <= maxLength) return content
  return `${content.slice(0, maxLength - 1).trimEnd()}…`
}

export function readL4PiSessionMessageText(message: unknown): string {
  if (!isRecord(message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => {
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') return []
      return [part.text]
    })
    .join('\n')
}

function previewForMatch(text: string, normalizedQuery: string): string {
  const matchIndex = text.toLowerCase().indexOf(normalizedQuery)
  if (matchIndex < 0) return ''
  const start = Math.max(0, matchIndex - MATCH_PREVIEW_PREFIX_LENGTH)
  const requiredEnd = matchIndex + normalizedQuery.length
  const end = Math.min(text.length, Math.max(start + MATCH_PREVIEW_MAX_LENGTH, requiredEnd))
  const content = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${content}${end < text.length ? '…' : ''}`
}

function messageMatch(
  scope: 'user' | 'assistant',
  messages: Iterable<L4PiSessionSearchMessage>,
  normalizedQuery: string
): L4PiSessionSearchMatch | null {
  let count = 0
  let latest: L4PiSessionSearchMessage | undefined
  for (const message of messages) {
    if (!message.text.toLowerCase().includes(normalizedQuery)) continue
    count += 1
    latest = message
  }
  if (!latest) return null
  return {
    scope,
    count,
    entryId: latest.entryId,
    timestampMs: latest.timestampMs,
    preview: previewForMatch(latest.text, normalizedQuery)
  }
}

export function matchL4PiSessionSearch(
  session: {
    sessionId: string
    name: string | null
    userMessages: Iterable<L4PiSessionSearchMessage>
    assistantMessages: Iterable<L4PiSessionSearchMessage>
  },
  normalizedQuery: string,
  searchIn: ReadonlySet<L4PiSessionSearchScope>
): L4PiSessionSearchMatch[] {
  if (!normalizedQuery) return []
  const matches: L4PiSessionSearchMatch[] = []
  if (searchIn.has('title') && session.name?.toLowerCase().includes(normalizedQuery)) {
    matches.push({
      scope: 'title',
      count: 1,
      entryId: null,
      timestampMs: null,
      preview: compactL4PiSessionPreview(session.name, 160)
    })
  }
  if (searchIn.has('user')) {
    const match = messageMatch('user', session.userMessages, normalizedQuery)
    if (match) matches.push(match)
  }
  if (searchIn.has('assistant')) {
    const match = messageMatch('assistant', session.assistantMessages, normalizedQuery)
    if (match) matches.push(match)
  }
  if (searchIn.has('sessionId') && session.sessionId.toLowerCase().includes(normalizedQuery)) {
    matches.push({
      scope: 'sessionId',
      count: 1,
      entryId: null,
      timestampMs: null,
      preview: session.sessionId
    })
  }
  return matches
}

export function searchL4PiSessionBranch(
  sessionManager: SessionManager,
  input: L4PiSessionSearchQuery
): L4PiSessionSearchMatch[] {
  const branch = sessionManager.getBranch()
  function* messages(role: 'user' | 'assistant'): Generator<L4PiSessionSearchMessage> {
    for (const entry of branch) {
      if (entry.type !== 'message' || entry.message.role !== role) continue
      const text = readL4PiSessionMessageText(entry.message)
      if (!text.trim()) continue
      yield {
        entryId: entry.id,
        timestampMs:
          readL4PiSessionTimestamp(entry.timestamp) ??
          readL4PiSessionTimestamp(entry.message.timestamp) ??
          0,
        text
      }
    }
  }
  return matchL4PiSessionSearch(
    {
      sessionId: sessionManager.getSessionId(),
      name: sessionManager.getSessionName()?.trim() || null,
      userMessages: messages('user'),
      assistantMessages: messages('assistant')
    },
    normalizeL4PiSessionSearch(input.query),
    new Set(input.searchIn)
  )
}
