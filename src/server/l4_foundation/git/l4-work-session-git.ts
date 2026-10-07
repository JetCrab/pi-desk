import 'server-only'

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { L4_PROJECT_TEXT_FILE_MAX_BYTES } from '@common/l4_foundation/file/l4-project-file-contract'
import { createL4BilingualText } from '@common/l4_foundation/locale/l4-localized-text'
import {
  getL4FileSystemKey as fileSystemKey,
  isL4PathInsideRoot as isInsideRoot
} from '@server/l4_foundation/file/l4-file-path'
import { L4WorkSessionGitError } from './internal/l4-git-error'
import { decodeGitDiffText } from './internal/l4-git-diff-text'
import {
  L4_GIT_MAX_BRANCHES,
  L4_GIT_MAX_CHANGES,
  L4_GIT_MAX_RECENT_BRANCHES,
  L4_GIT_MAX_REPOSITORIES,
  type L4GitBranches,
  type L4GitBranchTarget,
  type L4GitDiff,
  type L4GitFileChange,
  type L4GitFileStatus,
  type L4GitHead,
  type L4GitRepository,
  type L4GitRepositoryHead,
  type L4GitRepositoryReady
} from '@common/l4_foundation/git/l4-git-contract'

type L4GitSnapshot = {
  repositories: L4GitRepository[]
}

import {
  executeGitText,
  executeGitBuffer,
  type GitTextResult,
  type GitBufferResult
} from './internal/l4-git-command'

const GIT_OPERATION_TIMEOUT_MS = 120_000
const REPOSITORY_DISCOVERY_TTL_MS = 30_000
const REPOSITORY_DISCOVERY_MAX_CWDS = 20
const REPOSITORY_MARKER_SCAN_CONCURRENCY = 32
const REPOSITORY_SCAN_CONCURRENCY = 4

const IGNORED_SCAN_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo'
])

export {
  L4WorkSessionGitError,
  getL4WorkSessionGitErrorKind,
  type L4WorkSessionGitErrorKind
} from './internal/l4-git-error'

interface RepositoryLocation {
  absoluteRoot: string
  protocolRoot: string
}

interface RepositoryDiscoveryCacheEntry {
  repositories: RepositoryLocation[]
  expiresAt: number
}

const repositoryDiscoveryCache = new Map<string, RepositoryDiscoveryCacheEntry>()
const repositoryDiscoveryRequests = new Map<string, Promise<RepositoryLocation[]>>()
const repositoryOperationTails = new Map<string, Promise<void>>()

function toProtocolPath(root: string, target: string): string {
  return relative(root, target).split(sep).join('/')
}

function trimGitMessage(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ')
  return normalized.length > 1600 ? `${normalized.slice(0, 1597)}...` : normalized
}

function gitFailureMessage(action: string, result: GitTextResult | GitBufferResult): string {
  const detail = trimGitMessage(result.stderr) || `Git 退出码 ${String(result.code)}`
  return `${action}失败：${detail}`
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

async function resolveProjectRoot(cwd: string): Promise<string> {
  try {
    const root = await realpath(cwd)
    if (!(await stat(root)).isDirectory()) {
      throw new L4WorkSessionGitError('project-not-found', '项目目录不存在')
    }
    return root
  } catch (error) {
    if (error instanceof L4WorkSessionGitError) throw error
    throw new L4WorkSessionGitError('project-not-found', '项目目录不存在')
  }
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    // directory 已经是绝对路径；resolve 的隐式 cwd 会让 NFT 将未知目录扩散为全项目 glob。
    const marker = await stat(join(directory, '.git'))
    return marker.isDirectory() || marker.isFile()
  } catch {
    return false
  }
}

async function scanRepositoryCandidates(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    throw new L4WorkSessionGitError('read-failed', '无法读取项目目录')
  }

  const directories = [
    root,
    ...entries
      .filter((entry) => entry.isDirectory() && !IGNORED_SCAN_NAMES.has(entry.name))
      .map((entry) => resolve(root, entry.name))
  ]
  const candidates = (
    await mapWithConcurrency(directories, REPOSITORY_MARKER_SCAN_CONCURRENCY, async (directory) =>
      (await hasGitMarker(directory)) ? directory : null
    )
  ).filter((directory): directory is string => directory !== null)

  if (candidates.length > L4_GIT_MAX_REPOSITORIES) {
    throw new L4WorkSessionGitError('scan-limit', '项目中的 Git 仓库数量超过 100 个')
  }
  return candidates
}

async function validateRepositoryCandidate(
  projectRoot: string,
  candidate: string
): Promise<RepositoryLocation | null> {
  const result = await executeGitText(candidate, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0 || !result.stdout.trim()) {
    // 已发现 .git 标记：保留候选，让 Snapshot 将错误归属该仓库。
    const absoluteRoot = await realpath(candidate)
    return isInsideRoot(projectRoot, absoluteRoot)
      ? { absoluteRoot, protocolRoot: toProtocolPath(projectRoot, absoluteRoot) }
      : null
  }

  try {
    const absoluteRoot = await realpath(result.stdout.trim())
    if (!isInsideRoot(projectRoot, absoluteRoot)) return null
    const candidateRoot = await realpath(candidate)
    if (fileSystemKey(candidateRoot) !== fileSystemKey(absoluteRoot)) return null
    return {
      absoluteRoot,
      protocolRoot: toProtocolPath(projectRoot, absoluteRoot)
    }
  } catch {
    return null
  }
}

function pruneDiscoveryCache(now: number): void {
  for (const [key, entry] of repositoryDiscoveryCache) {
    if (entry.expiresAt <= now) repositoryDiscoveryCache.delete(key)
  }
  while (repositoryDiscoveryCache.size >= REPOSITORY_DISCOVERY_MAX_CWDS) {
    const oldestKey = repositoryDiscoveryCache.keys().next().value as string | undefined
    if (!oldestKey) break
    repositoryDiscoveryCache.delete(oldestKey)
  }
}

async function discoverRepositories(cwd: string): Promise<RepositoryLocation[]> {
  const projectRoot = await resolveProjectRoot(cwd)
  const key = fileSystemKey(projectRoot)
  const now = Date.now()
  const cached = repositoryDiscoveryCache.get(key)
  if (cached && cached.expiresAt > now) return cached.repositories

  const pending = repositoryDiscoveryRequests.get(key)
  if (pending) return pending

  const request = (async () => {
    const candidates = await scanRepositoryCandidates(projectRoot)
    const resolved = await mapWithConcurrency(
      candidates,
      REPOSITORY_SCAN_CONCURRENCY,
      (candidate) => validateRepositoryCandidate(projectRoot, candidate)
    )
    const unique = new Map<string, RepositoryLocation>()
    for (const repository of resolved) {
      if (repository) unique.set(fileSystemKey(repository.absoluteRoot), repository)
    }
    const repositories = [...unique.values()].sort((left, right) => {
      if (left.protocolRoot === '') return -1
      if (right.protocolRoot === '') return 1
      return left.protocolRoot.localeCompare(right.protocolRoot, undefined, {
        numeric: true,
        sensitivity: 'base'
      })
    })
    pruneDiscoveryCache(now)
    repositoryDiscoveryCache.set(key, {
      repositories,
      expiresAt: now + REPOSITORY_DISCOVERY_TTL_MS
    })
    return repositories
  })()
  repositoryDiscoveryRequests.set(key, request)
  try {
    return await request
  } finally {
    if (repositoryDiscoveryRequests.get(key) === request) {
      repositoryDiscoveryRequests.delete(key)
    }
  }
}

export async function listL4WorkSessionGitRepositoryRoots(cwd: string): Promise<string[]> {
  return (await discoverRepositories(cwd)).map((repository) => repository.protocolRoot)
}

function splitStatusRecord(
  record: string,
  fieldCount: number
): { fields: string[]; path: string } | null {
  const fields: string[] = []
  let offset = 0
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(' ', offset)
    if (separator < 0) return null
    fields.push(record.slice(offset, separator))
    offset = separator + 1
  }
  const path = record.slice(offset)
  return path ? { fields, path } : null
}

function statusFromCode(code: string): L4GitFileStatus | null {
  switch (code) {
    case '.':
    case ' ':
      return null
    case 'A':
    case 'C':
      return 'added'
    case 'M':
    case 'T':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'U':
      return 'unmerged'
    case '?':
      return 'untracked'
    default:
      throw new L4WorkSessionGitError('read-failed', `无法识别 Git 文件状态：${code}`)
  }
}

function changeFromXY(path: string, xy: string, oldPath: string | null): L4GitFileChange {
  if (xy.length !== 2) {
    throw new L4WorkSessionGitError('read-failed', `无法识别 Git XY 状态：${xy}`)
  }
  return {
    path,
    oldPath,
    indexStatus: statusFromCode(xy[0]!),
    worktreeStatus: statusFromCode(xy[1]!)
  }
}

function parseGitStatus(output: string): {
  head: L4GitHead
  changes: L4GitFileChange[]
} {
  const records = output.split('\0')
  let branchName: string | null = null
  let branchOid: string | null = null
  const changes: L4GitFileChange[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    if (!record) continue
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      branchName = value === '(detached)' ? null : value
      continue
    }
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length)
      branchOid = value === '(initial)' ? null : value
      continue
    }
    if (record.startsWith('# ')) continue

    if (record.startsWith('? ')) {
      changes.push({
        path: record.slice(2),
        oldPath: null,
        indexStatus: null,
        worktreeStatus: 'untracked'
      })
      continue
    }
    if (record.startsWith('! ')) continue

    if (record.startsWith('1 ')) {
      const parsed = splitStatusRecord(record, 8)
      if (!parsed) throw new L4WorkSessionGitError('read-failed', 'Git 状态记录格式无效')
      changes.push(changeFromXY(parsed.path, parsed.fields[1]!, null))
      continue
    }
    if (record.startsWith('2 ')) {
      const parsed = splitStatusRecord(record, 9)
      const oldPath = records[index + 1]
      if (!parsed || !oldPath) {
        throw new L4WorkSessionGitError('read-failed', 'Git 重命名状态记录格式无效')
      }
      index += 1
      changes.push(changeFromXY(parsed.path, parsed.fields[1]!, oldPath))
      continue
    }
    if (record.startsWith('u ')) {
      const parsed = splitStatusRecord(record, 10)
      if (!parsed) throw new L4WorkSessionGitError('read-failed', 'Git 冲突状态记录格式无效')
      changes.push({
        path: parsed.path,
        oldPath: null,
        indexStatus: 'unmerged',
        worktreeStatus: 'unmerged'
      })
      continue
    }

    throw new L4WorkSessionGitError('read-failed', 'Git 返回了不支持的状态记录')
  }

  const head: L4GitHead = branchName
    ? { type: 'branch', name: branchName }
    : branchOid && /^[0-9a-f]{40,64}$/.test(branchOid)
      ? { type: 'detached', commit: branchOid }
      : { type: 'branch', name: 'HEAD' }

  return {
    head,
    changes: changes.sort((left, right) => left.path.localeCompare(right.path))
  }
}

function nestedRepositoryPrefixes(
  repository: RepositoryLocation,
  repositories: readonly RepositoryLocation[]
): string[] {
  return repositories
    .filter(
      (candidate) =>
        candidate.absoluteRoot !== repository.absoluteRoot &&
        isInsideRoot(repository.absoluteRoot, candidate.absoluteRoot)
    )
    .map((candidate) => toProtocolPath(repository.absoluteRoot, candidate.absoluteRoot))
    .filter(Boolean)
}

function belongsToNestedRepository(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

async function readRepositoryHead(repository: string): Promise<L4GitHead> {
  const branch = await executeGitText(repository, ['symbolic-ref', '--quiet', 'HEAD'])
  const ref = branch.stdout.trim()
  if (branch.code === 0 && ref.startsWith('refs/heads/')) {
    return { type: 'branch', name: ref.slice('refs/heads/'.length) }
  }
  if (branch.code === 1) {
    const commit = await executeGitText(repository, ['rev-parse', '--verify', 'HEAD'])
    if (commit.code === 0 && /^[0-9a-f]{40,64}$/.test(commit.stdout.trim())) {
      return { type: 'detached', commit: commit.stdout.trim() }
    }
    throw new L4WorkSessionGitError('read-failed', gitFailureMessage('读取 Git HEAD', commit))
  }
  throw new L4WorkSessionGitError('read-failed', gitFailureMessage('读取 Git 分支', branch))
}

export async function getL4WorkSessionGitHeads(
  cwd: string
): Promise<{ repositories: L4GitRepositoryHead[] }> {
  const repositories = await discoverRepositories(cwd)
  return {
    repositories: await mapWithConcurrency(
      repositories,
      REPOSITORY_SCAN_CONCURRENCY,
      async (repository): Promise<L4GitRepositoryHead> => {
        try {
          return {
            root: repository.protocolRoot,
            state: 'ready',
            head: await readRepositoryHead(repository.absoluteRoot)
          }
        } catch (error) {
          const message =
            error instanceof Error ? trimGitMessage(error.message) : '读取 Git 分支失败'
          console.warn('[Pi Desk][Git] 读取仓库分支失败', {
            cwd,
            repositoryRoot: repository.protocolRoot,
            error: message
          })
          return { root: repository.protocolRoot, state: 'unavailable', message }
        }
      }
    )
  }
}

async function readRepositoryStatus(
  repository: RepositoryLocation,
  allRepositories: readonly RepositoryLocation[]
): Promise<L4GitRepositoryReady> {
  const result = await executeGitText(repository.absoluteRoot, [
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    '--renames',
    '--untracked-files=all'
  ])
  if (result.code !== 0) {
    const detail = trimGitMessage(result.stderr) || `Git 退出码 ${String(result.code)}`
    throw new L4WorkSessionGitError(
      'read-failed',
      gitFailureMessage('读取 Git 状态', result),
      createL4BilingualText(`读取 Git 状态失败：${detail}`, `Could not read Git status: ${detail}`)
    )
  }

  const parsed = parseGitStatus(result.stdout)
  const nestedPrefixes = nestedRepositoryPrefixes(repository, allRepositories)
  const changes = parsed.changes.filter(
    (change) => !belongsToNestedRepository(change.path, nestedPrefixes)
  )
  if (changes.length > L4_GIT_MAX_CHANGES) {
    throw new L4WorkSessionGitError(
      'scan-limit',
      '仓库变更文件超过 50000 个',
      createL4BilingualText('仓库变更文件超过 50000 个', 'Repository changes exceed 50,000 files')
    )
  }
  return {
    root: repository.protocolRoot,
    state: 'ready',
    head: parsed.head,
    changes
  }
}

export async function getL4WorkSessionGitSnapshot(
  cwd: string,
  refresh = false
): Promise<L4GitSnapshot> {
  if (refresh) repositoryDiscoveryCache.delete(fileSystemKey(await resolveProjectRoot(cwd)))
  const repositories = await discoverRepositories(cwd)
  const snapshots = await mapWithConcurrency(
    repositories,
    REPOSITORY_SCAN_CONCURRENCY,
    async (repository) => {
      try {
        return await readRepositoryStatus(repository, repositories)
      } catch (error) {
        return {
          root: repository.protocolRoot,
          state: 'unavailable' as const,
          message:
            error instanceof L4WorkSessionGitError && error.localizedMessage
              ? error.localizedMessage
              : error instanceof Error && trimGitMessage(error.message)
                ? trimGitMessage(error.message)
                : createL4BilingualText('读取 Git 仓库失败', 'Could not read the Git repository')
        }
      }
    }
  )
  return { repositories: snapshots }
}

async function resolveRepositoryLocation(
  cwd: string,
  repositoryRoot: string
): Promise<RepositoryLocation> {
  const projectRoot = await resolveProjectRoot(cwd)
  if (repositoryRoot.includes('/')) {
    throw new L4WorkSessionGitError('not-repository', '只支持项目根目录及其直接子目录中的 Git 仓库')
  }
  const unresolved = repositoryRoot
    ? resolve(projectRoot, ...repositoryRoot.split('/'))
    : projectRoot
  if (!isInsideRoot(projectRoot, unresolved)) {
    throw new L4WorkSessionGitError('outside-project', 'Git 仓库不在当前项目目录内')
  }

  let target: string
  try {
    target = await realpath(unresolved)
  } catch {
    throw new L4WorkSessionGitError('not-repository', 'Git 仓库不存在')
  }
  if (!isInsideRoot(projectRoot, target)) {
    throw new L4WorkSessionGitError('outside-project', 'Git 仓库不在当前项目目录内')
  }

  const topLevel = await executeGitText(target, ['rev-parse', '--show-toplevel'])
  if (topLevel.code !== 0 || !topLevel.stdout.trim()) {
    throw new L4WorkSessionGitError('not-repository', '目标目录不是 Git 仓库')
  }
  try {
    const actualRoot = await realpath(topLevel.stdout.trim())
    if (fileSystemKey(actualRoot) !== fileSystemKey(target)) {
      throw new L4WorkSessionGitError('not-repository', '目标目录不是 Git 仓库根目录')
    }
  } catch (error) {
    if (error instanceof L4WorkSessionGitError) throw error
    throw new L4WorkSessionGitError('not-repository', 'Git 仓库根目录无效')
  }

  return { absoluteRoot: target, protocolRoot: toProtocolPath(projectRoot, target) }
}

// 历史读取复用同一仓库边界，不自行拼接并信任客户端目录。
export async function resolveL4GitRepository(cwd: string, repositoryRoot: string): Promise<string> {
  return (await resolveRepositoryLocation(cwd, repositoryRoot)).absoluteRoot
}

async function readRefNames(repository: string, namespace: 'heads' | 'remotes'): Promise<string[]> {
  const result = await executeGitText(repository, [
    'for-each-ref',
    '--sort=refname',
    '--format=%(refname:short)%09%(symref)',
    `refs/${namespace}`
  ])
  if (result.code !== 0) {
    throw new L4WorkSessionGitError('read-failed', gitFailureMessage('读取 Git 分支', result))
  }
  const refs = result.stdout.split(/\r?\n/).flatMap((line) => {
    if (!line) return []
    const [name, symref = ''] = line.split('\t')
    return name && !symref ? [name] : []
  })
  if (refs.length > L4_GIT_MAX_BRANCHES) {
    throw new L4WorkSessionGitError('scan-limit', 'Git 分支数量超过 10000 个')
  }
  return refs
}

async function readRecentBranches(
  repository: string,
  local: ReadonlySet<string>
): Promise<string[]> {
  const result = await executeGitText(repository, [
    'reflog',
    'show',
    '--format=%gs',
    '--max-count=80',
    'HEAD'
  ])
  if (result.code !== 0) return []

  const recent: string[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^checkout: moving from .+ to (.+)$/.exec(line)
    const branch = match?.[1]
    if (!branch || !local.has(branch) || recent.includes(branch)) continue
    recent.push(branch)
    if (recent.length >= L4_GIT_MAX_RECENT_BRANCHES) break
  }
  return recent
}

export async function listL4WorkSessionGitBranches(
  cwd: string,
  repositoryRoot: string
): Promise<L4GitBranches> {
  const repository = await resolveRepositoryLocation(cwd, repositoryRoot)
  const [head, local, remote] = await Promise.all([
    readRepositoryHead(repository.absoluteRoot),
    readRefNames(repository.absoluteRoot, 'heads'),
    readRefNames(repository.absoluteRoot, 'remotes')
  ])
  return {
    head,
    recent: await readRecentBranches(repository.absoluteRoot, new Set(local)),
    local,
    remote
  }
}

async function verifyBranchTarget(repository: string, target: L4GitBranchTarget): Promise<string> {
  const ref = target.type === 'local' ? `refs/heads/${target.name}` : `refs/remotes/${target.name}`
  const result = await executeGitText(repository, ['show-ref', '--verify', '--quiet', ref])
  if (result.code !== 0) {
    throw new L4WorkSessionGitError(
      'invalid-ref',
      `${target.type === 'local' ? '本地' : '远程'}分支不存在：${target.name}`
    )
  }
  return target.name
}

async function verifyNewBranchName(repository: string, name: string): Promise<void> {
  const result = await executeGitText(repository, ['check-ref-format', '--branch', name])
  if (result.code !== 0) {
    throw new L4WorkSessionGitError('invalid-ref', `分支名称无效：${name}`)
  }
  const existing = await executeGitText(repository, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${name}`
  ])
  if (existing.code === 0) {
    throw new L4WorkSessionGitError('invalid-ref', `本地分支已经存在：${name}`)
  }
}

async function runRepositoryOperation<T>(
  repository: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = fileSystemKey(repository)
  const previous = repositoryOperationTails.get(key) ?? Promise.resolve()
  let release = (): void => undefined
  const lock = new Promise<void>((resolveLock) => {
    release = resolveLock
  })
  const tail = previous.catch(() => undefined).then(() => lock)
  repositoryOperationTails.set(key, tail)
  await previous.catch(() => undefined)

  try {
    return await operation()
  } finally {
    release()
    if (repositoryOperationTails.get(key) === tail) repositoryOperationTails.delete(key)
  }
}

async function statusAfterOperation(
  cwd: string,
  repository: RepositoryLocation
): Promise<L4GitRepositoryReady> {
  return readRepositoryStatus(repository, await discoverRepositories(cwd))
}

export async function replaceL4WorkSessionGitBranch(
  cwd: string,
  repositoryRoot: string,
  target: L4GitBranchTarget
): Promise<L4GitRepositoryReady> {
  const repository = await resolveRepositoryLocation(cwd, repositoryRoot)
  return runRepositoryOperation(repository.absoluteRoot, async () => {
    const branch = await verifyBranchTarget(repository.absoluteRoot, target)
    const args = target.type === 'local' ? ['switch', branch] : ['switch', '--track', branch]
    const result = await executeGitText(repository.absoluteRoot, args, {
      timeout: GIT_OPERATION_TIMEOUT_MS,
      readOnly: false
    })
    if (result.code !== 0) {
      throw new L4WorkSessionGitError(
        'operation-failed',
        gitFailureMessage('切换 Git 分支', result)
      )
    }
    return statusAfterOperation(cwd, repository)
  })
}

export async function addL4WorkSessionGitBranch(
  cwd: string,
  repositoryRoot: string,
  name: string,
  startPoint: L4GitBranchTarget | null
): Promise<L4GitRepositoryReady> {
  const repository = await resolveRepositoryLocation(cwd, repositoryRoot)
  return runRepositoryOperation(repository.absoluteRoot, async () => {
    await verifyNewBranchName(repository.absoluteRoot, name)
    const verifiedStart = startPoint
      ? await verifyBranchTarget(repository.absoluteRoot, startPoint)
      : null
    const result = await executeGitText(
      repository.absoluteRoot,
      verifiedStart ? ['switch', '-c', name, verifiedStart] : ['switch', '-c', name],
      { timeout: GIT_OPERATION_TIMEOUT_MS, readOnly: false }
    )
    if (result.code !== 0) {
      throw new L4WorkSessionGitError(
        'operation-failed',
        gitFailureMessage('新建 Git 分支', result)
      )
    }
    return statusAfterOperation(cwd, repository)
  })
}

type DiffBufferResult = { kind: 'content'; value: Buffer } | { kind: 'too_large' }

async function readHeadFile(repository: string, path: string): Promise<DiffBufferResult> {
  const head = await executeGitText(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (head.code !== 0) {
    const branch = await executeGitText(repository, ['symbolic-ref', '-q', 'HEAD'])
    if (branch.code === 0) {
      const exists = await executeGitText(repository, [
        'show-ref',
        '--verify',
        '--quiet',
        branch.stdout.trim()
      ])
      if (exists.code === 1) return { kind: 'content', value: Buffer.alloc(0) }
    }
    throw new L4WorkSessionGitError('read-failed', '读取 HEAD 提交失败')
  }
  const tree = await executeGitText(repository, [
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    head.stdout.trim(),
    '--',
    path
  ])
  if (tree.code !== 0) throw new L4WorkSessionGitError('read-failed', '读取 HEAD 文件记录失败')
  if (!tree.stdout) return { kind: 'content', value: Buffer.alloc(0) }
  const [mode, type, object] = tree.stdout.slice(0, tree.stdout.indexOf('\t')).split(' ')
  if (!mode || !type || !object) throw new L4WorkSessionGitError('read-failed', 'HEAD 文件记录无效')
  if (type !== 'blob') return { kind: 'content', value: Buffer.from([0]) }
  const size = await executeGitText(repository, ['cat-file', '-s', object])
  if (size.code !== 0) throw new L4WorkSessionGitError('read-failed', '读取 Git 文件大小失败')
  const byteLength = Number(size.stdout.trim())
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new L4WorkSessionGitError('read-failed', 'Git 文件大小无效')
  }
  if (byteLength > L4_PROJECT_TEXT_FILE_MAX_BYTES) return { kind: 'too_large' }
  const content = await executeGitBuffer(repository, ['cat-file', 'blob', object])
  if (content.code !== 0) {
    throw new L4WorkSessionGitError('read-failed', gitFailureMessage('读取 Git 原始文件', content))
  }
  return { kind: 'content', value: content.stdout }
}

async function readWorktreeFile(repository: string, path: string): Promise<DiffBufferResult> {
  const unresolved = resolve(repository, ...path.split('/'))
  if (!isInsideRoot(repository, unresolved)) {
    throw new L4WorkSessionGitError('outside-project', 'Diff 文件不在 Git 仓库内')
  }

  let target: string
  try {
    target = await realpath(unresolved)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { kind: 'content', value: Buffer.alloc(0) }
    throw new L4WorkSessionGitError('read-failed', '解析工作区文件失败')
  }
  if (!isInsideRoot(repository, target)) {
    throw new L4WorkSessionGitError('outside-project', 'Diff 文件不在 Git 仓库内')
  }

  let metadata
  try {
    metadata = await stat(target)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { kind: 'content', value: Buffer.alloc(0) }
    throw new L4WorkSessionGitError('read-failed', '读取工作区文件属性失败')
  }
  if (!metadata.isFile()) return { kind: 'content', value: Buffer.alloc(0) }
  if (metadata.size > L4_PROJECT_TEXT_FILE_MAX_BYTES) return { kind: 'too_large' }

  try {
    const value = await readFile(target)
    return value.length > L4_PROJECT_TEXT_FILE_MAX_BYTES
      ? { kind: 'too_large' }
      : { kind: 'content', value }
  } catch {
    throw new L4WorkSessionGitError('read-failed', '读取工作区文件失败')
  }
}

export async function getL4WorkSessionGitDiff(
  cwd: string,
  repositoryRoot: string,
  path: string
): Promise<L4GitDiff> {
  const repository = await resolveRepositoryLocation(cwd, repositoryRoot)
  const snapshot = await readRepositoryStatus(repository, [repository])
  const change = snapshot.changes.find((candidate) => candidate.path === path)
  const originalPath = change?.oldPath ?? path
  const [original, modified] = await Promise.all([
    readHeadFile(repository.absoluteRoot, originalPath),
    readWorktreeFile(repository.absoluteRoot, path)
  ])
  if (original.kind === 'too_large' || modified.kind === 'too_large') {
    return { kind: 'too_large' }
  }

  const originalContent = decodeGitDiffText(original.value)
  const modifiedContent = decodeGitDiffText(modified.value)
  if (originalContent === null || modifiedContent === null) return { kind: 'binary' }

  return {
    kind: 'text',
    original: { path: originalPath, content: originalContent },
    modified: { path, content: modifiedContent }
  }
}
