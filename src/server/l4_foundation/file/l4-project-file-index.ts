import 'server-only'

import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { listL4WorkSessionGitRepositoryRoots } from '@server/l4_foundation/git/l4-work-session-git'
import { getL4FileSystemKey as fileSystemKey } from './l4-file-path'

const execFileAsync = promisify(execFile)
const SEARCH_CACHE_TTL_MS = 30_000
const SEARCH_CACHE_MAX_CWDS = 20
const SEARCH_INDEX_MAX_FILES = 50_000

export const IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo'
])

interface SearchIndexCacheEntry {
  files: string[]
  truncated: boolean
  expiresAt: number
}

const searchIndexCache = new Map<string, SearchIndexCacheEntry>()
const pendingSearchIndexes = new Map<string, Promise<SearchIndexCacheEntry>>()

function joinProtocolPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

export function isSupportedProtocolName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
}

function pathContainsIgnoredSegment(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_NAMES.has(segment))
}

export function invalidateSearchIndex(root: string): void {
  const key = fileSystemKey(root)
  searchIndexCache.delete(key)
  pendingSearchIndexes.delete(key)
}

const GIT_SEARCH_OPTIONS = {
  timeout: 10_000,
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
}

async function listFilesWithContainingGit(
  root: string
): Promise<{ files: string[]; truncated: boolean } | null> {
  try {
    const { stdout: topLevelOutput } = await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--show-toplevel'],
      GIT_SEARCH_OPTIONS
    )
    const topLevel = await realpath(topLevelOutput.trim())
    const prefix = relative(topLevel, root).split(sep).join('/')
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        topLevel,
        'ls-files',
        '--full-name',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        prefix || '.'
      ],
      GIT_SEARCH_OPTIONS
    )
    const prefixWithSlash = prefix ? `${prefix}/` : ''
    const all = stdout
      .split('\0')
      .flatMap((path) => {
        if (!path) return []
        const projectPath = prefixWithSlash
          ? path.startsWith(prefixWithSlash)
            ? path.slice(prefixWithSlash.length)
            : ''
          : path
        return projectPath ? [projectPath] : []
      })
      .filter(
        (path) =>
          isSupportedProtocolName(basename(path)) &&
          !path.includes('\\') &&
          !pathContainsIgnoredSegment(path)
      )
    return {
      files: all.slice(0, SEARCH_INDEX_MAX_FILES),
      truncated: all.length > SEARCH_INDEX_MAX_FILES
    }
  } catch {
    return null
  }
}

function isPathInsideRepository(path: string, repositoryRoot: string): boolean {
  return path === repositoryRoot || path.startsWith(`${repositoryRoot}/`)
}

async function listFilesInRepository(
  projectRoot: string,
  repositoryRoot: string,
  nestedRepositoryRoots: readonly string[]
): Promise<{ files: string[]; truncated: boolean } | null> {
  const absoluteRoot = repositoryRoot
    ? resolve(projectRoot, ...repositoryRoot.split('/'))
    : projectRoot
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        absoluteRoot,
        'ls-files',
        '--full-name',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z'
      ],
      GIT_SEARCH_OPTIONS
    )
    const files = stdout.split('\0').flatMap((path) => {
      if (!path || path.includes('\\') || pathContainsIgnoredSegment(path)) return []
      const projectPath = joinProtocolPath(repositoryRoot, path)
      if (
        nestedRepositoryRoots.some((nestedRoot) => isPathInsideRepository(projectPath, nestedRoot))
      ) {
        return []
      }
      return isSupportedProtocolName(basename(projectPath)) ? [projectPath] : []
    })
    return {
      files: files.slice(0, SEARCH_INDEX_MAX_FILES),
      truncated: files.length > SEARCH_INDEX_MAX_FILES
    }
  } catch {
    return null
  }
}

async function listFilesWithWalk(
  root: string,
  excludedRepositoryRoots: readonly string[] = []
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const queue: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }]
  let queueIndex = 0

  while (queueIndex < queue.length) {
    const current = queue[queueIndex]!
    queueIndex += 1
    let dirents
    try {
      dirents = await readdir(current.absolute, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of dirents) {
      if (IGNORED_NAMES.has(entry.name) || !isSupportedProtocolName(entry.name)) continue
      const childRelative = joinProtocolPath(current.relative, entry.name)
      if (entry.isDirectory()) {
        if (excludedRepositoryRoots.includes(childRelative)) continue
        queue.push({ absolute: resolve(current.absolute, entry.name), relative: childRelative })
        continue
      }
      if (!entry.isFile()) continue
      files.push(childRelative)
      if (files.length >= SEARCH_INDEX_MAX_FILES) return { files, truncated: true }
    }
  }

  return { files, truncated: false }
}

async function listFilesWithRepositoryRoots(
  projectRoot: string,
  repositoryRoots: readonly string[]
): Promise<{ files: string[]; truncated: boolean }> {
  const files = new Set<string>()
  let truncated = false
  const hasProjectRootRepository = repositoryRoots.includes('')

  if (!hasProjectRootRepository) {
    const workspaceFiles = await listFilesWithWalk(projectRoot, repositoryRoots.filter(Boolean))
    for (const path of workspaceFiles.files) files.add(path)
    truncated ||= workspaceFiles.truncated
  }

  for (const repositoryRoot of repositoryRoots) {
    const nestedRoots = repositoryRoots.filter(
      (candidate) =>
        candidate !== repositoryRoot &&
        (repositoryRoot === '' || candidate.startsWith(`${repositoryRoot}/`))
    )
    let listing = await listFilesInRepository(projectRoot, repositoryRoot, nestedRoots)
    if (!listing) {
      const absoluteRoot = repositoryRoot
        ? resolve(projectRoot, ...repositoryRoot.split('/'))
        : projectRoot
      const nestedRelativeRoots = nestedRoots.map((root) =>
        repositoryRoot ? root.slice(repositoryRoot.length + 1) : root
      )
      const fallback = await listFilesWithWalk(absoluteRoot, nestedRelativeRoots)
      listing = {
        files: fallback.files.map((path) => joinProtocolPath(repositoryRoot, path)),
        truncated: fallback.truncated
      }
    }
    for (const path of listing.files) {
      files.add(path)
      if (files.size >= SEARCH_INDEX_MAX_FILES) {
        return { files: [...files], truncated: true }
      }
    }
    truncated ||= listing.truncated
  }

  return { files: [...files], truncated }
}

export async function getSearchIndex(root: string): Promise<SearchIndexCacheEntry> {
  const key = fileSystemKey(root)
  const now = Date.now()
  const cached = searchIndexCache.get(key)
  if (cached && cached.expiresAt > now) return cached

  const active = pendingSearchIndexes.get(key)
  if (active) return active

  const load: Promise<SearchIndexCacheEntry> = Promise.resolve().then(async () => {
    const repositoryRoots = await listL4WorkSessionGitRepositoryRoots(root)
    const listing =
      repositoryRoots.length > 0
        ? await listFilesWithRepositoryRoots(root, repositoryRoots)
        : ((await listFilesWithContainingGit(root)) ?? (await listFilesWithWalk(root)))
    const next: SearchIndexCacheEntry = {
      ...listing,
      expiresAt: now + SEARCH_CACHE_TTL_MS
    }
    if (pendingSearchIndexes.get(key) === load) {
      for (const [cacheKey, entry] of searchIndexCache) {
        if (entry.expiresAt <= Date.now()) searchIndexCache.delete(cacheKey)
      }
      while (searchIndexCache.size >= SEARCH_CACHE_MAX_CWDS) {
        const oldestKey = searchIndexCache.keys().next().value as string
        searchIndexCache.delete(oldestKey)
      }
      searchIndexCache.set(key, next)
    }
    return next
  })
  pendingSearchIndexes.set(key, load)
  try {
    return await load
  } finally {
    if (pendingSearchIndexes.get(key) === load) pendingSearchIndexes.delete(key)
  }
}
