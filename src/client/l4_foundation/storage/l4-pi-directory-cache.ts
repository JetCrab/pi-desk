'use client'

const DIRECTORIES_CACHE_KEY = 'pi-desk:pi-directories'
const IGNORED_DIRECTORIES_CACHE_KEY = 'pi-desk:ignored-pi-directories'
const DIRECTORY_ENTRIES_CACHE_KEY = 'pi-desk:pi-directory-entries'
const MAX_DIRECTORY_ENTRY_CACHE_ITEMS = 64

let directoryListsLoaded = false
let directoriesCache: unknown = null
let ignoredDirectoriesCache: unknown = null
let directoryEntriesLoaded = false
const directoryEntriesCache = new Map<string, unknown>()

function directoryCacheKey(cwd: string | null): string {
  if (cwd === null) return '<root>'
  const normalized = cwd.replaceAll('\\', '/')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function readStored(key: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

function loadDirectoryLists(): void {
  if (directoryListsLoaded || typeof window === 'undefined') return
  directoryListsLoaded = true
  directoriesCache = readStored(DIRECTORIES_CACHE_KEY)
  ignoredDirectoriesCache = readStored(IGNORED_DIRECTORIES_CACHE_KEY)
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 缓存不可用时仍在当前页面使用最新响应。
  }
}

export function readL4PiDirectoriesCache(): unknown {
  loadDirectoryLists()
  return directoriesCache
}

export function saveL4PiDirectoriesCache(value: unknown): void {
  loadDirectoryLists()
  directoriesCache = value
  writeStored(DIRECTORIES_CACHE_KEY, value)
}

export function readL4PiIgnoredDirectoriesCache(): unknown {
  loadDirectoryLists()
  return ignoredDirectoriesCache
}

export function saveL4PiIgnoredDirectoriesCache(value: unknown): void {
  loadDirectoryLists()
  ignoredDirectoriesCache = value
  writeStored(IGNORED_DIRECTORIES_CACHE_KEY, value)
}

function loadDirectoryEntries(): void {
  if (directoryEntriesLoaded || typeof window === 'undefined') return
  directoryEntriesLoaded = true

  const value = readStored(DIRECTORY_ENTRIES_CACHE_KEY)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const entries = (value as { entries?: unknown }).entries
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return

  for (const [key, item] of Object.entries(entries)) {
    directoryEntriesCache.set(key, item)
  }
}

function persistDirectoryEntries(): void {
  writeStored(DIRECTORY_ENTRIES_CACHE_KEY, {
    entries: Object.fromEntries(directoryEntriesCache)
  })
}

function valueCwd(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const cwd = (value as { cwd?: unknown }).cwd
  if (typeof cwd === 'string' || cwd === null) return cwd
  return undefined
}

export function readL4PiDirectoryEntriesCache(cwd: string | null): unknown {
  loadDirectoryEntries()
  return directoryEntriesCache.get(directoryCacheKey(cwd)) ?? null
}

export function saveL4PiDirectoryEntriesCache(value: unknown): void {
  const cwd = valueCwd(value)
  if (cwd === undefined) return
  loadDirectoryEntries()

  const key = directoryCacheKey(cwd)
  directoryEntriesCache.delete(key)
  directoryEntriesCache.set(key, value)
  while (directoryEntriesCache.size > MAX_DIRECTORY_ENTRY_CACHE_ITEMS) {
    const oldest = directoryEntriesCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    directoryEntriesCache.delete(oldest)
  }
  persistDirectoryEntries()
}
