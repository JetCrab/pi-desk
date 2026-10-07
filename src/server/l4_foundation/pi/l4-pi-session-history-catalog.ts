import 'server-only'

import { getL4PiDeskDataDir } from './l4-pi-desk-data-dir'

import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
  type FileEntry
} from '@earendil-works/pi-coding-agent'
import { z } from 'zod'

const SCAN_CONCURRENCY = 10
const MATCH_PREVIEW_MAX_LENGTH = 120
const MATCH_PREVIEW_PREFIX_LENGTH = 16
const FIRST_MESSAGE_PREVIEW_MAX_LENGTH = 160
const CACHE_VALIDATION_INTERVAL_MS = 2_000
const CACHE_IDLE_MS = 15 * 60_000
const CACHE_CWD_LIMIT = 8
const CACHE_TEXT_BYTES_LIMIT = 32 * 1024 * 1024
const CACHE_FILE_LIMIT = 4_096
const PERSISTED_CACHE_DIRECTORY_NAME = 'pi-session-history'
const LEGACY_CACHE_FILE_NAME = 'pi-session-history.json'
const PERSISTED_CACHE_VERSION = 2
const CACHE_DISK_BYTES_LIMIT = 64 * 1024 * 1024

export type L4PiSessionHistorySearchScope = 'title' | 'user' | 'assistant' | 'sessionId'

const DEFAULT_SEARCH_IN: readonly L4PiSessionHistorySearchScope[] = ['title', 'user']

interface L4PiSessionFileDescriptor {
  path: string
  size: number
  modifiedAt: number
}

interface L4PiSessionScanEntry {
  id: string
  parentId: string | null
  type: string
  timestampMs: number
  messageRole: string | null
  messageText: string
}

export interface L4PiSessionUserMessage {
  entryId: string
  timestampMs: number
  text: string
}

interface L4PiSessionAssistantMessage {
  entryId: string
  timestampMs: number
  text: string
}

export interface L4PiSessionHistoryMatch {
  scope: L4PiSessionHistorySearchScope
  count: number
  entryId: string | null
  timestampMs: number | null
  preview: string
}

export interface L4PiSessionHistoryItem {
  sessionId: string
  cwd: string
  name: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  userMessageCount: number
  firstMessage: string
  matches: L4PiSessionHistoryMatch[] | null
}

interface L4PiSessionHistoryRecord extends Omit<L4PiSessionHistoryItem, 'matches'> {
  path: string
  userMessages: L4PiSessionUserMessage[]
  assistantMessages: L4PiSessionAssistantMessage[]
  textBytes: number
}

interface L4PiSessionFileCacheEntry {
  descriptor: L4PiSessionFileDescriptor
  record: L4PiSessionHistoryRecord | null
}

const L4PersistedPiSessionMessageSchema = z
  .object({
    entryId: z.string().min(1),
    timestampMs: z.number().int().nonnegative(),
    text: z.string()
  })
  .strict()

const L4PersistedPiSessionHistoryRecordSchema = z
  .object({
    path: z.string().min(1),
    sessionId: z.string().min(1),
    cwd: z.string().min(1),
    name: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    userMessageCount: z.number().int().nonnegative(),
    firstMessage: z.string(),
    userMessages: z.array(L4PersistedPiSessionMessageSchema),
    assistantMessages: z.array(L4PersistedPiSessionMessageSchema),
    textBytes: z.number().int().nonnegative()
  })
  .strict()

const L4PersistedPiSessionFileCacheEntrySchema = z
  .object({
    descriptor: z
      .object({
        path: z.string().min(1),
        size: z.number().int().nonnegative(),
        modifiedAt: z.number().int().nonnegative()
      })
      .strict(),
    record: L4PersistedPiSessionHistoryRecordSchema.nullable()
  })
  .strict()

const L4PersistedPiSessionHistoryCatalogSchema = z
  .object({
    cwd: z.string().min(1),
    files: z.array(L4PersistedPiSessionFileCacheEntrySchema)
  })
  .strict()

const L4PersistedPiSessionHistoryCacheSchema = L4PersistedPiSessionHistoryCatalogSchema.extend({
  version: z.literal(PERSISTED_CACHE_VERSION)
})

const L4LegacyPiSessionHistoryCacheSchema = z
  .object({
    version: z.literal(1),
    catalogs: z.array(L4PersistedPiSessionHistoryCatalogSchema)
  })
  .strict()

interface L4PiSessionHistoryCatalog {
  cwd: string
  files: Map<string, L4PiSessionFileCacheEntry>
  sessions: L4PiSessionHistoryRecord[]
  textBytes: number
  dirty: boolean
  validatedAt: number
  lastAccessedAt: number
}

interface L4PiSessionHistoryCatalogLoad {
  epoch: number
  promise: Promise<L4PiSessionHistoryCatalog>
}

interface L4PiSessionHistoryCatalogRefresh {
  catalog: L4PiSessionHistoryCatalog
  changed: boolean
}

interface L4PiSessionHistoryCatalogState {
  epochs: Map<string, number>
  activeLoads: Map<string, L4PiSessionHistoryCatalogLoad>
  catalogs: Map<string, L4PiSessionHistoryCatalog>
}

interface L4PiSessionScanState {
  sessionId: string
  headerCwd: string
  createdAt: number
  name: string | null
  leafId: string | null
  entriesById: Map<string, L4PiSessionScanEntry>
}

export interface L4PiSessionUserMessagePage {
  page: {
    index: number
    size: number
    total: number
  }
  messages: L4PiSessionUserMessage[]
}

function persistedHistoryCacheDirectory(): string {
  return join(getL4PiDeskDataDir(), PERSISTED_CACHE_DIRECTORY_NAME)
}

function persistedHistoryCachePath(cwd: string): string {
  const name = createHash('sha256').update(cwd).digest('hex')
  return join(persistedHistoryCacheDirectory(), `${name}.json`)
}

function sessionRecords(
  files: ReadonlyMap<string, L4PiSessionFileCacheEntry>
): L4PiSessionHistoryRecord[] {
  return Array.from(files.values())
    .flatMap((entry) => (entry.record ? [entry.record] : []))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

function sessionTextBytes(sessions: readonly L4PiSessionHistoryRecord[]): number {
  return sessions.reduce((total, session) => total + session.textBytes, 0)
}

function toHistoryCatalog(
  persisted: z.infer<typeof L4PersistedPiSessionHistoryCatalogSchema>
): L4PiSessionHistoryCatalog {
  const cwd = resolve(persisted.cwd)
  const files = new Map<string, L4PiSessionFileCacheEntry>()
  for (const entry of persisted.files) {
    let record: L4PiSessionHistoryRecord | null = null
    if (
      entry.record &&
      entry.record.path === entry.descriptor.path &&
      resolve(entry.record.cwd) === cwd
    ) {
      const assistantMessages = entry.record.assistantMessages.filter((message) =>
        message.text.trim()
      )
      const removedBytes = entry.record.assistantMessages.reduce(
        (total, message) =>
          total + (message.text.trim() ? 0 : Buffer.byteLength(message.text, 'utf8')),
        0
      )
      record = {
        ...entry.record,
        assistantMessages,
        textBytes: entry.record.textBytes - removedBytes
      }
    }
    files.set(entry.descriptor.path, { descriptor: entry.descriptor, record })
  }
  const sessions = sessionRecords(files)
  const now = Date.now()
  return {
    cwd,
    files,
    sessions,
    textBytes: sessionTextBytes(sessions),
    dirty: false,
    validatedAt: 0,
    lastAccessedAt: now
  }
}

function readPersistedHistoryCatalog(cwd: string): L4PiSessionHistoryCatalog | undefined {
  const path = persistedHistoryCachePath(cwd)
  if (!existsSync(path)) return undefined
  try {
    const persisted = L4PersistedPiSessionHistoryCacheSchema.parse(
      JSON.parse(readFileSync(path, 'utf8'))
    )
    if (resolve(persisted.cwd) !== cwd) throw new Error('缓存项目目录不匹配')
    const catalog = toHistoryCatalog(persisted)
    if (catalog.files.size > CACHE_FILE_LIMIT || catalog.textBytes > CACHE_TEXT_BYTES_LIMIT) {
      return undefined
    }
    return catalog
  } catch (error) {
    console.warn('[Pi Desk][PiSessionHistoryCatalog] 历史会话持久缓存无效', {
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return undefined
  }
}

function prunePersistedHistoryCatalogs(): void {
  const directory = persistedHistoryCacheDirectory()
  const files = readdirSync(directory)
    .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
    .map((name) => {
      const path = join(directory, name)
      const info = statSync(path)
      return { path, size: info.size, modifiedAt: info.mtimeMs }
    })
    .sort((left, right) => left.modifiedAt - right.modifiedAt)
  let totalBytes = files.reduce((total, file) => total + file.size, 0)
  while (
    files.length > 1 &&
    (files.length > CACHE_CWD_LIMIT || totalBytes > CACHE_DISK_BYTES_LIMIT)
  ) {
    const oldest = files.shift()!
    unlinkSync(oldest.path)
    totalBytes -= oldest.size
  }
}

function persistHistoryCatalog(catalog: L4PiSessionHistoryCatalog): boolean {
  const path = persistedHistoryCachePath(catalog.cwd)
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({
        version: PERSISTED_CACHE_VERSION,
        cwd: catalog.cwd,
        files: Array.from(catalog.files.values())
      })}\n`,
      'utf8'
    )
    renameSync(temporaryPath, path)
    prunePersistedHistoryCatalogs()
    return true
  } catch (error) {
    console.warn('[Pi Desk][PiSessionHistoryCatalog] 写入历史会话持久缓存失败', {
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return false
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

function migrateLegacyHistoryCatalogs(): void {
  const path = join(getL4PiDeskDataDir(), LEGACY_CACHE_FILE_NAME)
  if (!existsSync(path)) return
  try {
    const legacy = L4LegacyPiSessionHistoryCacheSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    for (const persisted of legacy.catalogs) {
      const catalog = toHistoryCatalog(persisted)
      if (existsSync(persistedHistoryCachePath(catalog.cwd))) continue
      if (!persistHistoryCatalog(catalog)) return
    }
    unlinkSync(path)
    console.info('[Pi Desk][PiSessionHistoryCatalog] 已迁移历史会话缓存', {
      catalogCount: legacy.catalogs.length
    })
  } catch (error) {
    console.warn('[Pi Desk][PiSessionHistoryCatalog] 迁移历史会话缓存失败', {
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
  }
}

function historyCatalogState(): L4PiSessionHistoryCatalogState {
  if (!globalThis.__piDeskPiSessionHistoryCatalogState) {
    migrateLegacyHistoryCatalogs()
    globalThis.__piDeskPiSessionHistoryCatalogState = {
      epochs: new Map(),
      activeLoads: new Map(),
      catalogs: new Map()
    }
  }
  return globalThis.__piDeskPiSessionHistoryCatalogState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase()
}

function compactPreview(text: string, maxLength: number): string {
  const content = text.replace(/\s+/g, ' ').trim()
  if (content.length <= maxLength) return content
  return `${content.slice(0, maxLength - 1).trimEnd()}…`
}

function messageText(message: unknown): string {
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

function messageTimestamp(entry: Record<string, unknown>, fallback: number): number {
  const entryTimestamp = timestampMs(entry.timestamp)
  if (entryTimestamp !== null) return entryTimestamp
  if (isRecord(entry.message)) return timestampMs(entry.message.timestamp) ?? fallback
  return fallback
}

function appendScanEntry(state: L4PiSessionScanState, entry: Record<string, unknown>): void {
  if (entry.type === 'session_info') {
    state.name = typeof entry.name === 'string' ? entry.name.trim() || null : null
  }

  if (typeof entry.id !== 'string' || entry.id.length === 0 || typeof entry.type !== 'string') {
    return
  }

  const message = isRecord(entry.message) ? entry.message : null
  const messageRole =
    entry.type === 'message' && message && typeof message.role === 'string' ? message.role : null
  const parentId = typeof entry.parentId === 'string' ? entry.parentId : null
  const scanEntry: L4PiSessionScanEntry = {
    id: entry.id,
    parentId,
    type: entry.type,
    timestampMs: messageTimestamp(entry, state.createdAt),
    messageRole,
    messageText: messageRole === 'user' || messageRole === 'assistant' ? messageText(message) : ''
  }
  state.entriesById.set(scanEntry.id, scanEntry)
  state.leafId = scanEntry.id
}

function buildHistoryRecord(
  descriptor: L4PiSessionFileDescriptor,
  cwd: string,
  state: L4PiSessionScanState
): L4PiSessionHistoryRecord | null {
  if (!state.sessionId) return null
  if (state.headerCwd && resolve(state.headerCwd) !== cwd) return null

  const branch: L4PiSessionScanEntry[] = []
  const visited = new Set<string>()
  let entry = state.leafId ? state.entriesById.get(state.leafId) : undefined
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id)
    branch.push(entry)
    entry = entry.parentId ? state.entriesById.get(entry.parentId) : undefined
  }
  branch.reverse()

  let messageCount = 0
  let userMessageCount = 0
  let firstMessage = ''
  let updatedAt = state.createdAt
  let textBytes = 0
  const userMessages: L4PiSessionUserMessage[] = []
  const assistantMessages: L4PiSessionAssistantMessage[] = []

  for (const branchEntry of branch) {
    if (branchEntry.type !== 'message') continue
    messageCount += 1
    updatedAt = Math.max(updatedAt, branchEntry.timestampMs)
    if (branchEntry.messageRole === 'user') {
      userMessageCount += 1
      if (!firstMessage && branchEntry.messageText.trim()) {
        firstMessage = compactPreview(branchEntry.messageText, FIRST_MESSAGE_PREVIEW_MAX_LENGTH)
      }
      textBytes += Buffer.byteLength(branchEntry.messageText, 'utf8')
      userMessages.push({
        entryId: branchEntry.id,
        timestampMs: branchEntry.timestampMs,
        text: branchEntry.messageText
      })
      continue
    }
    if (branchEntry.messageRole === 'assistant' && branchEntry.messageText.trim()) {
      textBytes += Buffer.byteLength(branchEntry.messageText, 'utf8')
      assistantMessages.push({
        entryId: branchEntry.id,
        timestampMs: branchEntry.timestampMs,
        text: branchEntry.messageText
      })
    }
  }

  return {
    path: descriptor.path,
    sessionId: state.sessionId,
    cwd,
    name: state.name,
    createdAt: state.createdAt,
    updatedAt: Math.max(updatedAt, descriptor.modifiedAt),
    messageCount,
    userMessageCount,
    firstMessage,
    userMessages,
    assistantMessages,
    textBytes
  }
}

function migratedHistoryRecord(
  descriptor: L4PiSessionFileDescriptor,
  cwd: string,
  lines: readonly string[]
): L4PiSessionHistoryRecord | null {
  const entries = parseSessionEntries(lines.join('\n'))
  migrateSessionEntries(entries)
  const header = entries.find((entry): entry is Extract<FileEntry, { type: 'session' }> => {
    return entry.type === 'session'
  })
  if (!header || typeof header.id !== 'string') return null

  const createdAt = timestampMs(header.timestamp) ?? descriptor.modifiedAt
  const state: L4PiSessionScanState = {
    sessionId: header.id,
    headerCwd: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt,
    name: null,
    leafId: null,
    entriesById: new Map()
  }
  for (const entry of entries) {
    if (entry.type !== 'session') {
      appendScanEntry(state, entry as unknown as Record<string, unknown>)
    }
  }
  return buildHistoryRecord(descriptor, cwd, state)
}

async function scanSessionFile(
  descriptor: L4PiSessionFileDescriptor,
  cwd: string
): Promise<L4PiSessionHistoryRecord | null> {
  const stream = createReadStream(descriptor.path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let state: L4PiSessionScanState | null = null
  let legacyLines: string[] | null = null

  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      if (legacyLines) {
        legacyLines.push(line)
        continue
      }

      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(value)) continue

      if (!state) {
        if (value.type !== 'session' || typeof value.id !== 'string') return null
        const createdAt = timestampMs(value.timestamp) ?? descriptor.modifiedAt
        state = {
          sessionId: value.id,
          headerCwd: typeof value.cwd === 'string' ? value.cwd : '',
          createdAt,
          name: null,
          leafId: null,
          entriesById: new Map()
        }
        const version = typeof value.version === 'number' ? value.version : 1
        if (version < CURRENT_SESSION_VERSION) legacyLines = [line]
        continue
      }

      appendScanEntry(state, value)
    }
  } finally {
    lines.close()
    stream.destroy()
  }

  if (legacyLines) return migratedHistoryRecord(descriptor, cwd, legacyLines)
  return state ? buildHistoryRecord(descriptor, cwd, state) : null
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0

  async function run(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()))
  return results
}

function sessionDirectory(cwd: string): string {
  // SessionManager.create follows the SDK's active agent/session directory rules and does not write JSONL.
  return SessionManager.create(cwd).getSessionDir()
}

async function listSessionFiles(cwd: string): Promise<L4PiSessionFileDescriptor[]> {
  const directory = sessionDirectory(cwd)
  let names: string[]
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()
  } catch {
    return []
  }

  const descriptors = await mapWithConcurrency(
    names,
    SCAN_CONCURRENCY,
    async (name): Promise<L4PiSessionFileDescriptor | null> => {
      const path = resolve(directory, name)
      try {
        const fileStat = await stat(path)
        if (!fileStat.isFile()) return null
        return { path, size: fileStat.size, modifiedAt: fileStat.mtime.getTime() }
      } catch {
        return null
      }
    }
  )
  return descriptors.filter((item): item is L4PiSessionFileDescriptor => item !== null)
}

function sameFileDescriptor(
  left: L4PiSessionFileDescriptor,
  right: L4PiSessionFileDescriptor
): boolean {
  return (
    left.path === right.path && left.size === right.size && left.modifiedAt === right.modifiedAt
  )
}

async function refreshCatalog(
  cwd: string,
  previous: L4PiSessionHistoryCatalog | undefined,
  forceRefresh: boolean
): Promise<L4PiSessionHistoryCatalogRefresh> {
  const descriptors = await listSessionFiles(cwd)
  const entries = await mapWithConcurrency(descriptors, SCAN_CONCURRENCY, async (descriptor) => {
    const cached = previous?.files.get(descriptor.path)
    if (!forceRefresh && cached && sameFileDescriptor(cached.descriptor, descriptor)) {
      return { entry: { descriptor, record: cached.record }, changed: false }
    }

    try {
      return {
        entry: { descriptor, record: await scanSessionFile(descriptor, cwd) },
        changed: true
      }
    } catch (error) {
      console.warn('[Pi Desk][PiSessionHistoryCatalog] 已忽略无法读取的 Pi 会话', {
        cwd,
        path: descriptor.path,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
      return { entry: null, changed: true }
    }
  })
  const files = new Map<string, L4PiSessionFileCacheEntry>()
  for (const result of entries) {
    if (result.entry) files.set(result.entry.descriptor.path, result.entry)
  }
  const sessions = sessionRecords(files)
  const now = Date.now()
  return {
    catalog: {
      cwd,
      files,
      sessions,
      textBytes: sessionTextBytes(sessions),
      dirty: false,
      validatedAt: now,
      lastAccessedAt: now
    },
    changed:
      forceRefresh ||
      previous === undefined ||
      previous.files.size !== files.size ||
      entries.some((entry) => entry.changed)
  }
}

function pruneCatalogs(now: number): void {
  const state = historyCatalogState()
  for (const [cwd, catalog] of state.catalogs) {
    if (now - catalog.lastAccessedAt > CACHE_IDLE_MS) state.catalogs.delete(cwd)
  }
}

function touchCatalog(catalog: L4PiSessionHistoryCatalog, now: number): L4PiSessionHistoryCatalog {
  catalog.lastAccessedAt = now
  const state = historyCatalogState()
  state.catalogs.delete(catalog.cwd)
  state.catalogs.set(catalog.cwd, catalog)
  return catalog
}

function storeCatalog(catalog: L4PiSessionHistoryCatalog, persist: boolean): void {
  const state = historyCatalogState()
  if (catalog.files.size > CACHE_FILE_LIMIT || catalog.textBytes > CACHE_TEXT_BYTES_LIMIT) {
    state.catalogs.delete(catalog.cwd)
    if (persist) {
      const path = persistedHistoryCachePath(catalog.cwd)
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch (error) {
        console.warn('[Pi Desk][PiSessionHistoryCatalog] 清理超限缓存失败', {
          path,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
    console.warn('[Pi Desk][PiSessionHistoryCatalog] 历史会话超过内存缓存上限', {
      cwd: catalog.cwd,
      fileCount: catalog.files.size,
      textBytes: catalog.textBytes
    })
    return
  }

  state.catalogs.delete(catalog.cwd)
  state.catalogs.set(catalog.cwd, catalog)
  let totalBytes = [...state.catalogs.values()].reduce(
    (total, current) => total + current.textBytes,
    0
  )
  while (state.catalogs.size > CACHE_CWD_LIMIT || totalBytes > CACHE_TEXT_BYTES_LIMIT) {
    const oldest = state.catalogs.entries().next().value as
      [string, L4PiSessionHistoryCatalog] | undefined
    if (!oldest) break
    state.catalogs.delete(oldest[0])
    totalBytes -= oldest[1].textBytes
  }
  if (persist) persistHistoryCatalog(catalog)
}

function currentEpoch(cwd: string): number {
  return historyCatalogState().epochs.get(cwd) ?? 0
}

function incrementEpoch(cwd: string): number {
  const epoch = currentEpoch(cwd) + 1
  historyCatalogState().epochs.set(cwd, epoch)
  return epoch
}

async function getCatalog(
  cwdInput: string,
  forceRefresh = false
): Promise<L4PiSessionHistoryCatalog> {
  const cwd = resolve(cwdInput)
  const state = historyCatalogState()
  const now = Date.now()
  pruneCatalogs(now)
  const catalog = state.catalogs.get(cwd) ?? readPersistedHistoryCatalog(cwd)
  const epoch = forceRefresh ? incrementEpoch(cwd) : currentEpoch(cwd)
  if (forceRefresh && catalog) catalog.dirty = true
  const active = state.activeLoads.get(cwd)
  if (active && active.epoch === epoch) return active.promise

  if (
    !forceRefresh &&
    catalog &&
    !catalog.dirty &&
    now - catalog.validatedAt < CACHE_VALIDATION_INTERVAL_MS
  ) {
    return touchCatalog(catalog, now)
  }

  const load = (async (): Promise<L4PiSessionHistoryCatalog> => {
    const refresh = await refreshCatalog(cwd, catalog, forceRefresh)
    const refreshed = refresh.catalog
    if (currentEpoch(cwd) === epoch) storeCatalog(refreshed, refresh.changed)
    console.info('[Pi Desk][PiSessionHistoryCatalog] 已更新历史会话内存投影', {
      cwd,
      sessionCount: refreshed.sessions.length,
      fileCount: refreshed.files.size,
      textBytes: refreshed.textBytes,
      forceRefresh
    })
    return refreshed
  })()
  state.activeLoads.set(cwd, { epoch, promise: load })
  try {
    return await load
  } finally {
    if (state.activeLoads.get(cwd)?.promise === load) state.activeLoads.delete(cwd)
  }
}

function previewForMatch(text: string, normalizedQuery: string): string {
  const normalizedText = text.toLowerCase()
  const matchIndex = normalizedText.indexOf(normalizedQuery)
  if (matchIndex < 0) return ''

  const start = Math.max(0, matchIndex - MATCH_PREVIEW_PREFIX_LENGTH)
  const requiredEnd = matchIndex + normalizedQuery.length
  const end = Math.min(text.length, Math.max(start + MATCH_PREVIEW_MAX_LENGTH, requiredEnd))
  const content = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${content}${end < text.length ? '…' : ''}`
}

function messageMatch(
  scope: 'user' | 'assistant',
  messages: readonly L4PiSessionUserMessage[] | readonly L4PiSessionAssistantMessage[],
  normalizedQuery: string
): L4PiSessionHistoryMatch | null {
  const matching = messages.filter((message) =>
    message.text.toLowerCase().includes(normalizedQuery)
  )
  if (matching.length === 0) return null
  const latest = matching.at(-1)!
  return {
    scope,
    count: matching.length,
    entryId: latest.entryId,
    timestampMs: latest.timestampMs,
    preview: previewForMatch(latest.text, normalizedQuery)
  }
}

function projectHistoryItem(
  session: L4PiSessionHistoryRecord,
  normalizedQuery: string,
  searchIn: ReadonlySet<L4PiSessionHistorySearchScope>
): L4PiSessionHistoryItem | null {
  if (!normalizedQuery) {
    return {
      sessionId: session.sessionId,
      cwd: session.cwd,
      name: session.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      userMessageCount: session.userMessageCount,
      firstMessage: session.firstMessage,
      matches: null
    }
  }

  const matches: L4PiSessionHistoryMatch[] = []
  if (searchIn.has('title') && session.name?.toLowerCase().includes(normalizedQuery)) {
    matches.push({
      scope: 'title',
      count: 1,
      entryId: null,
      timestampMs: null,
      preview: compactPreview(session.name, FIRST_MESSAGE_PREVIEW_MAX_LENGTH)
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
  if (matches.length === 0) return null

  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    userMessageCount: session.userMessageCount,
    firstMessage: session.firstMessage,
    matches
  }
}

export async function listL4PiSessionHistory(
  cwd: string,
  query = '',
  forceRefresh = false,
  searchIn: readonly L4PiSessionHistorySearchScope[] = DEFAULT_SEARCH_IN
): Promise<L4PiSessionHistoryItem[]> {
  const catalog = await getCatalog(cwd, forceRefresh)
  const normalizedQuery = normalizeSearch(query)
  const selectedScopes = new Set(searchIn)
  return catalog.sessions.flatMap((session) => {
    const item = projectHistoryItem(session, normalizedQuery, selectedScopes)
    return item ? [item] : []
  })
}

export async function listL4PiSessionUserMessages(input: {
  cwd: string
  sessionId: string
  query: string
  page: { index: number; size: number }
}): Promise<L4PiSessionUserMessagePage | null> {
  const catalog = await getCatalog(input.cwd)
  const session = catalog.sessions.find((item) => item.sessionId === input.sessionId)
  if (!session) return null

  const normalizedQuery = normalizeSearch(input.query)
  const messages = session.userMessages
    .filter((message) => !normalizedQuery || message.text.toLowerCase().includes(normalizedQuery))
    .reverse()
  const start = (input.page.index - 1) * input.page.size
  return {
    page: {
      index: input.page.index,
      size: input.page.size,
      total: messages.length
    },
    messages: messages
      .slice(start, start + input.page.size)
      .map(({ entryId, timestampMs, text }) => ({ entryId, timestampMs, text }))
  }
}

export function resolveCachedL4PiSessionHistoryPath(
  cwd: string,
  sessionId: string
): string | undefined {
  const catalog = historyCatalogState().catalogs.get(resolve(cwd))
  if (!catalog || catalog.dirty) return undefined
  return catalog.sessions.find((session) => session.sessionId === sessionId)?.path
}

export function invalidateL4PiSessionHistoryCache(cwd?: string): void {
  const state = historyCatalogState()
  if (cwd) {
    const normalizedCwd = resolve(cwd)
    incrementEpoch(normalizedCwd)
    const catalog = state.catalogs.get(normalizedCwd)
    if (catalog) catalog.dirty = true
    return
  }

  const affectedCwds = new Set([...state.catalogs.keys(), ...state.activeLoads.keys()])
  for (const catalogCwd of affectedCwds) {
    incrementEpoch(catalogCwd)
    const catalog = state.catalogs.get(catalogCwd)
    if (catalog) catalog.dirty = true
  }
}

declare global {
  var __piDeskPiSessionHistoryCatalogState: L4PiSessionHistoryCatalogState | undefined
}
