import 'server-only'

import { execFile, spawn } from 'node:child_process'
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import {
  L4_PROJECT_FILE_LIST_MAX_ENTRIES,
  L4_PROJECT_FILE_SEARCH_MAX_RESULTS,
  L4_PROJECT_IMAGE_FILE_MAX_BYTES,
  L4_PROJECT_IMAGE_MAX_PIXELS,
  L4_PROJECT_TEXT_FILE_MAX_BYTES,
  type L4ProjectFileEntry,
  type L4ProjectFileList,
  type L4ProjectFileSearch,
  type L4ProjectFileContent,
  type L4ProjectFileImageMimeType,
  type L4ProjectFileImagePreviewMode
} from '@common/l4_foundation/file/l4-project-file-contract'
import { listL4WorkSessionGitRepositoryRoots } from '@server/l4_foundation/git/l4-work-session-git'
import {
  getL4FileSystemKey as fileSystemKey,
  isL4PathInsideRoot as isInsideRoot
} from './l4-file-path'

const execFileAsync = promisify(execFile)
const SEARCH_CACHE_TTL_MS = 30_000
const SEARCH_CACHE_MAX_CWDS = 20
const SEARCH_INDEX_MAX_FILES = 50_000
const IMAGE_COMPRESSION_MIN_BYTES = 512 * 1024
const IMAGE_COMPRESSION_MAX_WIDTH = 2560
const IMAGE_COMPRESSION_MIN_SAVING_RATIO = 0.15

const IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo'
])

export type L4WorkSessionProjectFileErrorKind =
  | 'not-found'
  | 'not-directory'
  | 'not-file'
  | 'outside-project'
  | 'text-too-large'
  | 'image-too-large'
  | 'unsupported'
  | 'read-failed'
  | 'reveal-failed'

export class L4WorkSessionProjectFileError extends Error {
  constructor(
    readonly kind: L4WorkSessionProjectFileErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'L4WorkSessionProjectFileError'
  }
}

export function getL4WorkSessionProjectFileErrorKind(
  error: unknown
): L4WorkSessionProjectFileErrorKind | null {
  return error instanceof L4WorkSessionProjectFileError ? error.kind : null
}

export type L4WorkSessionProjectFileEntry = L4ProjectFileEntry
export type L4WorkSessionProjectFileList = L4ProjectFileList
export type L4WorkSessionProjectFileSearch = L4ProjectFileSearch
export type L4WorkSessionProjectFileGet = L4ProjectFileContent

interface SearchIndexCacheEntry {
  files: string[]
  truncated: boolean
  expiresAt: number
}

interface ProjectFileRevealTarget {
  target: string
  directory: string
  exists: boolean
}

type ProjectFileRevealRunner = (command: string, args: string[]) => Promise<void>

const searchIndexCache = new Map<string, SearchIndexCacheEntry>()
const pendingSearchIndexes = new Map<string, Promise<SearchIndexCacheEntry>>()

function joinProtocolPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function isSupportedProtocolName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
}

function pathContainsIgnoredSegment(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_NAMES.has(segment))
}

async function resolveProjectRoot(cwd: string): Promise<string> {
  try {
    const root = await realpath(cwd)
    if (!(await stat(root)).isDirectory()) {
      throw new L4WorkSessionProjectFileError(
        'not-directory',
        `Project root is not a directory: ${cwd}`
      )
    }
    return root
  } catch (error) {
    if (error instanceof L4WorkSessionProjectFileError) throw error
    throw new L4WorkSessionProjectFileError('not-found', `Project root was not found: ${cwd}`)
  }
}

async function resolveExistingProjectPath(root: string, protocolPath: string): Promise<string> {
  const unresolved = protocolPath ? resolve(root, ...protocolPath.split('/')) : root
  if (!isInsideRoot(root, unresolved)) {
    throw new L4WorkSessionProjectFileError(
      'outside-project',
      `Project path escapes root: ${protocolPath}`
    )
  }

  try {
    const target = await realpath(unresolved)
    if (!isInsideRoot(root, target)) {
      throw new L4WorkSessionProjectFileError(
        'outside-project',
        `Project path resolves outside root: ${protocolPath}`
      )
    }
    return target
  } catch (error) {
    if (error instanceof L4WorkSessionProjectFileError) throw error
    throw new L4WorkSessionProjectFileError(
      'not-found',
      `Project path was not found: ${protocolPath}`
    )
  }
}

async function resolveExistingPreviewPath(root: string, path: string): Promise<string> {
  if (!isAbsolute(path)) return resolveExistingProjectPath(root, path)
  try {
    return await realpath(resolve(path))
  } catch {
    throw new L4WorkSessionProjectFileError('not-found', `Preview path was not found: ${path}`)
  }
}

async function resolveProjectFileRevealTarget(
  root: string,
  protocolPath: string
): Promise<ProjectFileRevealTarget> {
  const unresolved = resolve(root, ...protocolPath.split('/'))
  if (!isInsideRoot(root, unresolved)) {
    throw new L4WorkSessionProjectFileError(
      'outside-project',
      `Project path escapes root: ${protocolPath}`
    )
  }

  let directory: string
  try {
    directory = await realpath(dirname(unresolved))
  } catch {
    throw new L4WorkSessionProjectFileError(
      'not-found',
      `Containing directory was not found: ${protocolPath}`
    )
  }
  if (!isInsideRoot(root, directory)) {
    throw new L4WorkSessionProjectFileError(
      'outside-project',
      `Containing directory resolves outside root: ${protocolPath}`
    )
  }
  if (!(await stat(directory)).isDirectory()) {
    throw new L4WorkSessionProjectFileError(
      'not-directory',
      `Containing path is not a directory: ${protocolPath}`
    )
  }

  let target: string
  try {
    target = await realpath(unresolved)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { target: unresolved, directory, exists: false }
    }
    throw new L4WorkSessionProjectFileError('read-failed', `无法读取定位目标：${protocolPath}`)
  }
  if (!isInsideRoot(root, target)) {
    throw new L4WorkSessionProjectFileError(
      'outside-project',
      `Project path resolves outside root: ${protocolPath}`
    )
  }
  if (!(await stat(target)).isFile()) {
    throw new L4WorkSessionProjectFileError('not-file', `Target is not a file: ${protocolPath}`)
  }
  return { target, directory, exists: true }
}

function projectFileRevealInvocation(target: ProjectFileRevealTarget): {
  command: string
  args: string[]
} {
  if (process.platform === 'win32') {
    return target.exists
      ? { command: 'explorer.exe', args: ['/select,', target.target] }
      : { command: 'explorer.exe', args: [target.directory] }
  }
  if (process.platform === 'darwin') {
    return target.exists
      ? { command: 'open', args: ['-R', target.target] }
      : { command: 'open', args: [target.directory] }
  }
  return { command: 'xdg-open', args: [target.directory] }
}

async function runProjectFileRevealCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    const handleError = (error: Error): void => {
      child.off('spawn', handleSpawn)
      rejectRun(error)
    }
    const handleSpawn = (): void => {
      child.off('error', handleError)
      child.unref()
      resolveRun()
    }
    child.once('error', handleError)
    child.once('spawn', handleSpawn)
  })
}

function invalidateSearchIndex(root: string): void {
  const key = fileSystemKey(root)
  searchIndexCache.delete(key)
  pendingSearchIndexes.delete(key)
}

export async function listL4WorkSessionProjectFiles(
  cwd: string,
  protocolPath: string
): Promise<L4WorkSessionProjectFileList> {
  const root = await resolveProjectRoot(cwd)
  const target = await resolveExistingProjectPath(root, protocolPath)
  let targetStat
  try {
    targetStat = await stat(target)
  } catch {
    throw new L4WorkSessionProjectFileError('not-found', `Directory was not found: ${protocolPath}`)
  }
  if (!targetStat.isDirectory()) {
    throw new L4WorkSessionProjectFileError(
      'not-directory',
      `Target is not a directory: ${protocolPath}`
    )
  }

  let dirents
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch {
    throw new L4WorkSessionProjectFileError(
      'read-failed',
      `Directory cannot be read: ${protocolPath}`
    )
  }

  const entries = (
    await Promise.all(
      dirents.map(async (entry) => {
        if (IGNORED_NAMES.has(entry.name) || !isSupportedProtocolName(entry.name)) return null
        if (entry.isDirectory()) return { name: entry.name, type: 'directory' as const }
        if (entry.isFile()) return { name: entry.name, type: 'file' as const }
        if (!entry.isSymbolicLink()) return null

        try {
          const child = await realpath(resolve(target, entry.name))
          if (!isInsideRoot(root, child)) return null
          const childStat = await stat(child)
          if (childStat.isDirectory()) return { name: entry.name, type: 'directory' as const }
          if (childStat.isFile()) return { name: entry.name, type: 'file' as const }
          return null
        } catch {
          return null
        }
      })
    )
  )
    .filter((entry): entry is { name: string; type: 'directory' | 'file' } => entry !== null)
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    })

  if (protocolPath === '') invalidateSearchIndex(root)
  return {
    entries: entries.slice(0, L4_PROJECT_FILE_LIST_MAX_ENTRIES),
    truncated: entries.length > L4_PROJECT_FILE_LIST_MAX_ENTRIES
  }
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

async function getSearchIndex(root: string): Promise<SearchIndexCacheEntry> {
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

function subsequenceGapScore(value: string, query: string): number | null {
  let queryIndex = 0
  let firstIndex = -1
  let previousIndex = -1
  let gaps = 0

  for (
    let valueIndex = 0;
    valueIndex < value.length && queryIndex < query.length;
    valueIndex += 1
  ) {
    if (value[valueIndex] !== query[queryIndex]) continue
    if (firstIndex < 0) firstIndex = valueIndex
    if (previousIndex >= 0) gaps += valueIndex - previousIndex - 1
    previousIndex = valueIndex
    queryIndex += 1
  }

  return queryIndex === query.length ? firstIndex * 4 + gaps : null
}

function searchScore(path: string, query: string): number | null {
  const normalizedPath = path.toLocaleLowerCase()
  const name = basename(normalizedPath)
  if (name === query) return 0
  if (name.startsWith(query)) return 100 + name.length - query.length
  const nameIndex = name.indexOf(query)
  if (nameIndex >= 0) return 1_000 + nameIndex * 4 + name.length
  const pathIndex = normalizedPath.indexOf(query)
  if (pathIndex >= 0) return 10_000 + pathIndex * 4 + normalizedPath.length
  const fuzzy = subsequenceGapScore(normalizedPath, query)
  return fuzzy === null ? null : 100_000 + fuzzy + normalizedPath.length
}

export async function searchL4WorkSessionProjectFiles(
  cwd: string,
  query: string
): Promise<L4WorkSessionProjectFileSearch> {
  const root = await resolveProjectRoot(cwd)
  const index = await getSearchIndex(root)
  const normalizedQuery = query.toLocaleLowerCase()
  const matches = index.files
    .flatMap((path) => {
      const score = searchScore(path, normalizedQuery)
      return score === null ? [] : [{ path, score }]
    })
    .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))

  return {
    matches: matches.slice(0, L4_PROJECT_FILE_SEARCH_MAX_RESULTS).map((match) => match.path),
    truncated: index.truncated || matches.length > L4_PROJECT_FILE_SEARCH_MAX_RESULTS
  }
}

export async function revealL4WorkSessionProjectFile(
  cwd: string,
  protocolPath: string,
  run: ProjectFileRevealRunner = runProjectFileRevealCommand,
  targetType: 'file' | 'directory' = 'file'
): Promise<void> {
  const root = await resolveProjectRoot(cwd)
  let invocation: { command: string; args: string[] }
  if (targetType === 'directory') {
    const directory = await resolveExistingProjectPath(root, protocolPath)
    if (!(await stat(directory)).isDirectory()) {
      throw new L4WorkSessionProjectFileError('not-directory', '当前路径不是目录')
    }
    invocation = {
      command:
        process.platform === 'win32'
          ? 'explorer.exe'
          : process.platform === 'darwin'
            ? 'open'
            : 'xdg-open',
      args: [directory]
    }
  } else {
    const target = await resolveProjectFileRevealTarget(root, protocolPath)
    invocation = projectFileRevealInvocation(target)
  }
  try {
    await run(invocation.command, invocation.args)
  } catch {
    throw new L4WorkSessionProjectFileError(
      'reveal-failed',
      `Containing directory could not be opened: ${protocolPath}`
    )
  }
}

function detectSupportedImageMime(bytes: Buffer): L4ProjectFileImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6) {
    const header = bytes.toString('ascii', 0, 6)
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function imageResponse(
  bytes: Buffer,
  mimeType: L4ProjectFileImageMimeType,
  previewMode: L4ProjectFileImagePreviewMode
): Promise<L4WorkSessionProjectFileGet> {
  let metadata
  try {
    metadata = await sharp(bytes, {
      animated: mimeType === 'image/gif',
      limitInputPixels: L4_PROJECT_IMAGE_MAX_PIXELS
    }).metadata()
  } catch {
    throw new L4WorkSessionProjectFileError('unsupported', 'Image metadata is invalid')
  }

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0 || width * height > L4_PROJECT_IMAGE_MAX_PIXELS) {
    throw new L4WorkSessionProjectFileError('image-too-large', 'Image dimensions exceed limit')
  }

  let output = bytes
  let outputMimeType = mimeType
  if (
    previewMode === 'compressed' &&
    mimeType !== 'image/gif' &&
    bytes.length > IMAGE_COMPRESSION_MIN_BYTES
  ) {
    try {
      const compressed = await sharp(bytes, {
        limitInputPixels: L4_PROJECT_IMAGE_MAX_PIXELS
      })
        .rotate()
        .resize({
          width: IMAGE_COMPRESSION_MAX_WIDTH,
          withoutEnlargement: true
        })
        .webp({ quality: 85, alphaQuality: 90, effort: 3, smartSubsample: true })
        .toBuffer()
      if (compressed.length <= bytes.length * (1 - IMAGE_COMPRESSION_MIN_SAVING_RATIO)) {
        output = compressed
        outputMimeType = 'image/webp'
      }
    } catch {
      // 压缩预览失败时回退原图，原文件仍可正常查看。
    }
  }

  return {
    kind: 'image',
    mimeType: outputMimeType,
    data: output.toString('base64'),
    size: output.length
  }
}

export async function getL4WorkSessionProjectFile(
  cwd: string,
  protocolPath: string,
  previewMode: L4ProjectFileImagePreviewMode
): Promise<L4WorkSessionProjectFileGet> {
  const root = await resolveProjectRoot(cwd)
  const target = await resolveExistingPreviewPath(root, protocolPath)
  let targetStat
  try {
    targetStat = await stat(target)
  } catch {
    throw new L4WorkSessionProjectFileError('not-found', `File was not found: ${protocolPath}`)
  }
  if (!targetStat.isFile()) {
    throw new L4WorkSessionProjectFileError('not-file', `Target is not a file: ${protocolPath}`)
  }

  if (targetStat.size > L4_PROJECT_IMAGE_FILE_MAX_BYTES) {
    const header = await readHeader(target)
    throw new L4WorkSessionProjectFileError(
      detectSupportedImageMime(header) ? 'image-too-large' : 'text-too-large',
      `File exceeds preview limit: ${protocolPath}`
    )
  }

  let bytes
  try {
    bytes = await readFile(target)
  } catch {
    throw new L4WorkSessionProjectFileError('read-failed', `File cannot be read: ${protocolPath}`)
  }
  if (bytes.length > L4_PROJECT_IMAGE_FILE_MAX_BYTES) {
    throw new L4WorkSessionProjectFileError(
      detectSupportedImageMime(bytes) ? 'image-too-large' : 'text-too-large',
      `File grew beyond limit: ${protocolPath}`
    )
  }

  const imageMime = detectSupportedImageMime(bytes)
  if (imageMime) return imageResponse(bytes, imageMime, previewMode)
  if (bytes.includes(0)) {
    throw new L4WorkSessionProjectFileError(
      'unsupported',
      `Binary file is unsupported: ${protocolPath}`
    )
  }

  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new L4WorkSessionProjectFileError(
      'unsupported',
      `File is not valid UTF-8: ${protocolPath}`
    )
  }
  if (bytes.length > L4_PROJECT_TEXT_FILE_MAX_BYTES) {
    throw new L4WorkSessionProjectFileError(
      'text-too-large',
      `Text file exceeds limit: ${protocolPath}`
    )
  }

  return {
    kind: 'text',
    content,
    size: bytes.length
  }
}
