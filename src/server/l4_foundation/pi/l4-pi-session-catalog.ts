import 'server-only'

import { getL4PiDeskDataDir } from './l4-pi-desk-data-dir'

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import { getL4PiDirectoryKey, listL4IgnoredPiDirectoryCwds } from './l4-pi-directory-ignore-store'
import {
  invalidateL4PiSessionHistoryCache as invalidateSessionHistoryCache,
  listL4PiSessionHistory as loadL4PiSessionHistory,
  listL4PiSessionUserMessages as loadL4PiSessionUserMessages,
  resolveCachedL4PiSessionHistoryPath,
  type L4PiSessionHistoryItem,
  type L4PiSessionHistorySearchScope,
  type L4PiSessionUserMessagePage
} from './l4-pi-session-history-catalog'

export interface L4PiDirectorySummary {
  cwd: string
  sessionCount: number
  updatedAt: number
}

const DIRECTORY_SUMMARY_CACHE_FILE_NAME = 'pi-directories.json'
const L4PiDirectorySummarySchema = z
  .object({
    cwd: z.string().trim().min(1),
    sessionCount: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
const L4PiDirectorySummaryCacheSchema = z
  .object({ directories: z.array(L4PiDirectorySummarySchema) })
  .strict()

interface L4PiSessionCatalogState {
  activePathLookups: Map<string, Promise<ReadonlyMap<string, string>>>
  directorySummaryCache: Promise<L4PiDirectorySummary[]> | null
  directorySummaryValue: L4PiDirectorySummary[] | null
  directorySummaryNeedsRefresh: boolean
}

function directorySummaryCachePath(): string {
  return join(getL4PiDeskDataDir(), DIRECTORY_SUMMARY_CACHE_FILE_NAME)
}

function readPersistedDirectorySummary(): L4PiDirectorySummary[] | null {
  const path = directorySummaryCachePath()
  if (!existsSync(path)) return null

  try {
    return L4PiDirectorySummaryCacheSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).directories
  } catch (error) {
    console.warn('[Pi Desk][PiSessionCatalog] 项目目录持久缓存无效', {
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return null
  }
}

function persistDirectorySummary(directories: readonly L4PiDirectorySummary[]): void {
  const path = directorySummaryCachePath()
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify({ directories }, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, path)
  } catch (error) {
    console.warn('[Pi Desk][PiSessionCatalog] 写入项目目录持久缓存失败', {
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

function sessionCatalogState(): L4PiSessionCatalogState {
  if (!globalThis.__piDeskPiSessionCatalogState) {
    const persisted = readPersistedDirectorySummary()
    globalThis.__piDeskPiSessionCatalogState = {
      activePathLookups: new Map(),
      directorySummaryCache: null,
      directorySummaryValue: persisted,
      directorySummaryNeedsRefresh: persisted !== null
    }
  }
  return globalThis.__piDeskPiSessionCatalogState
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd)
}

async function loadSessionPaths(cwd: string): Promise<ReadonlyMap<string, string>> {
  const sessions = await SessionManager.list(cwd)
  return new Map(sessions.map((session) => [session.id, session.path]))
}

function getSessionPathLookup(cwd: string): Promise<ReadonlyMap<string, string>> {
  const normalizedCwd = normalizeCwd(cwd)
  const state = sessionCatalogState()
  const active = state.activePathLookups.get(normalizedCwd)
  if (active) return active

  const lookup = loadSessionPaths(normalizedCwd)
  state.activePathLookups.set(normalizedCwd, lookup)
  const clear = () => {
    if (state.activePathLookups.get(normalizedCwd) === lookup) {
      state.activePathLookups.delete(normalizedCwd)
    }
  }
  void lookup.then(clear, clear)
  return lookup
}

export async function resolveL4PiSessionPath(
  cwd: string,
  sessionId: string
): Promise<string | null> {
  const cached = resolveCachedL4PiSessionHistoryPath(cwd, sessionId)
  if (cached !== undefined) return cached
  return (await getSessionPathLookup(cwd)).get(sessionId) ?? null
}

async function loadAllL4PiDirectories(): Promise<L4PiDirectorySummary[]> {
  const sessions = await SessionManager.listAll()
  const directories = new Map<string, L4PiDirectorySummary>()

  for (const session of sessions) {
    if (!session.cwd) continue
    const cwd = normalizeCwd(session.cwd)
    const updatedAt = session.modified.getTime()
    const current = directories.get(cwd)
    if (!current) {
      directories.set(cwd, { cwd, sessionCount: 1, updatedAt })
      continue
    }

    current.sessionCount += 1
    if (updatedAt > current.updatedAt) current.updatedAt = updatedAt
  }

  return Array.from(directories.values()).sort((left, right) => right.updatedAt - left.updatedAt)
}

function refreshDirectorySummary(): Promise<L4PiDirectorySummary[]> {
  const state = sessionCatalogState()
  if (state.directorySummaryCache) return state.directorySummaryCache

  const cache = loadAllL4PiDirectories()
  state.directorySummaryCache = cache
  void cache
    .then(
      (directories) => {
        state.directorySummaryValue = directories
        state.directorySummaryNeedsRefresh = false
        persistDirectorySummary(directories)
        console.info('[Pi Desk][PiSessionCatalog] 已更新 Pi 完整目录缓存', {
          directoryCount: directories.length
        })
      },
      (error) => {
        state.directorySummaryNeedsRefresh = true
        console.warn('[Pi Desk][PiSessionCatalog] 更新 Pi 完整目录缓存失败', {
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    )
    .finally(() => {
      if (state.directorySummaryCache === cache) state.directorySummaryCache = null
    })
  return cache
}

/** 已有持久缓存时先返回旧目录，后台重建最新摘要；显式刷新才等待扫描完成。 */
function listAllL4PiDirectories(forceRefresh = false): Promise<L4PiDirectorySummary[]> {
  const state = sessionCatalogState()
  if (!forceRefresh && state.directorySummaryValue) {
    if (state.directorySummaryNeedsRefresh) void refreshDirectorySummary()
    return Promise.resolve(state.directorySummaryValue)
  }
  return refreshDirectorySummary()
}

function ignoredDirectoryKeys(): Set<string> {
  return new Set(listL4IgnoredPiDirectoryCwds().map(getL4PiDirectoryKey))
}

export async function listL4PiDirectories(forceRefresh = false): Promise<L4PiDirectorySummary[]> {
  const directories = await listAllL4PiDirectories(forceRefresh)
  const ignored = ignoredDirectoryKeys()
  return directories.filter((directory) => !ignored.has(getL4PiDirectoryKey(directory.cwd)))
}

export async function listL4IgnoredPiDirectories(
  forceRefresh = false
): Promise<L4PiDirectorySummary[]> {
  const directories = await listAllL4PiDirectories(forceRefresh)
  const ignored = ignoredDirectoryKeys()
  return directories.filter((directory) => ignored.has(getL4PiDirectoryKey(directory.cwd)))
}

export function invalidateL4PiDirectoryCache(cwd?: string): void {
  const state = sessionCatalogState()
  state.directorySummaryNeedsRefresh = true
  if (cwd && state.directorySummaryValue) {
    const normalizedCwd = normalizeCwd(cwd)
    const current = state.directorySummaryValue.find(
      (directory) => getL4PiDirectoryKey(directory.cwd) === getL4PiDirectoryKey(normalizedCwd)
    )
    if (current) {
      current.sessionCount += 1
      current.updatedAt = Math.max(current.updatedAt, Date.now())
    } else {
      state.directorySummaryValue = [
        ...state.directorySummaryValue,
        { cwd: normalizedCwd, sessionCount: 1, updatedAt: Date.now() }
      ].sort((left, right) => right.updatedAt - left.updatedAt)
    }
    persistDirectorySummary(state.directorySummaryValue)
  }
  if (state.directorySummaryValue) void refreshDirectorySummary()
  invalidateSessionHistoryCache(cwd)
}

export function invalidateL4PiSessionHistoryCache(cwd?: string): void {
  invalidateSessionHistoryCache(cwd)
}

export function listL4PiSessionHistory(
  cwdInput: string,
  query = '',
  forceRefresh = false,
  searchIn?: readonly L4PiSessionHistorySearchScope[]
): Promise<L4PiSessionHistoryItem[]> {
  return loadL4PiSessionHistory(normalizeCwd(cwdInput), query, forceRefresh, searchIn)
}

export function listL4PiSessionUserMessages(input: {
  cwd: string
  sessionId: string
  query: string
  page: { index: number; size: number }
}): Promise<L4PiSessionUserMessagePage | null> {
  return loadL4PiSessionUserMessages({ ...input, cwd: normalizeCwd(input.cwd) })
}

declare global {
  var __piDeskPiSessionCatalogState: L4PiSessionCatalogState | undefined
}
