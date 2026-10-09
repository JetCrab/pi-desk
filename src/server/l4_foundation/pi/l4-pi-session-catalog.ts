import 'server-only'

import { getL4PiDeskDataDir } from './l4-pi-desk-data-dir'

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

import {
  discoverL4PiDirectories,
  findL4PiSessionFile,
  type L4PiDirectorySummary
} from './l4-pi-session-discovery'

export type { L4PiDirectorySummary } from './l4-pi-session-discovery'

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

export async function resolveL4PiSessionPath(
  cwd: string,
  sessionId: string
): Promise<string | null> {
  return findL4PiSessionFile(
    normalizeCwd(cwd),
    sessionId,
    resolveCachedL4PiSessionHistoryPath(cwd, sessionId)
  )
}

function refreshDirectorySummary(): Promise<L4PiDirectorySummary[]> {
  const state = sessionCatalogState()
  if (state.directorySummaryCache) return state.directorySummaryCache

  const startedAt = performance.now()
  const cache = discoverL4PiDirectories()
  state.directorySummaryCache = cache
  void cache
    .then(
      (directories) => {
        state.directorySummaryValue = directories
        state.directorySummaryNeedsRefresh = false
        persistDirectorySummary(directories)
        console.info('[Pi Desk][PiSessionCatalog] 已更新 Pi 目录元数据缓存', {
          directoryCount: directories.length,
          durationMs: Math.round(performance.now() - startedAt)
        })
      },
      (error) => {
        state.directorySummaryNeedsRefresh = true
        console.warn('[Pi Desk][PiSessionCatalog] 更新 Pi 目录元数据缓存失败', {
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
export function listL4PiDirectorySummaries(forceRefresh = false): Promise<L4PiDirectorySummary[]> {
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
  const directories = await listL4PiDirectorySummaries(forceRefresh)
  const ignored = ignoredDirectoryKeys()
  return directories.filter((directory) => !ignored.has(getL4PiDirectoryKey(directory.cwd)))
}

export async function listL4IgnoredPiDirectories(
  forceRefresh = false
): Promise<L4PiDirectorySummary[]> {
  const directories = await listL4PiDirectorySummaries(forceRefresh)
  const ignored = ignoredDirectoryKeys()
  return directories.filter((directory) => ignored.has(getL4PiDirectoryKey(directory.cwd)))
}

export function invalidateL4PiDirectoryCache(cwd?: string): void {
  const state = sessionCatalogState()
  if (!cwd) state.directorySummaryNeedsRefresh = true
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
