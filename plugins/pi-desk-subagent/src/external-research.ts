import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'

const CACHE_VERSION = 1
const CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000
const MAX_FETCH_BYTES = 2 * 1024 * 1024
const MAX_TOOL_CHARS = 30_000
const MAX_CACHE_READ_CHARS = 30_000
const ANYSEARCH_API_URL = 'https://api.anysearch.com/v1/search'
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

type ResearchCacheKind = 'web-search' | 'page' | 'github-search' | 'repository'

type ResearchCacheIndexEntry = {
  key: string
  kind: ResearchCacheKind
  relativePath: string
  source: string
  createdAt: string
  updatedAt: string
  lastUsedAt: string
  contentHash: string
  repositoryPath?: string
}

type ResearchCacheIndex = {
  version: 1
  updatedAt: string
  entries: ResearchCacheIndexEntry[]
}

type ResearchCacheRecord = {
  version: 1
  key: string
  kind: ResearchCacheKind
  source: string
  createdAt: string
  contentHash: string
  data: unknown
}

type CachedResearch = {
  entry: ResearchCacheIndexEntry
  record: ResearchCacheRecord
}

type AnySearchResult = {
  title: string
  url: string
  snippet: string
  content: string
}

type WebSearchRecord = {
  query: string
  maxResults: number
  results: AnySearchResult[]
}

type GitHubSearchRecord = {
  kind: 'repositories' | 'code'
  query: string
  results: unknown[]
}

type PageRecord = {
  requestedUrl: string
  finalUrl: string
  title: string
  content: string
  contentType: string | null
}

type RepositoryRecord = {
  repository: string
  ref: string | null
  localPath: string
  commit: string
}

export type ResearchCacheOptions = {
  cwd: string
  now?: () => number
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString()
}

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function cacheKey(kind: ResearchCacheKind, value: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function emptyIndex(now: () => number): ResearchCacheIndex {
  return { version: CACHE_VERSION, updatedAt: nowIso(now), entries: [] }
}

function asIndex(value: unknown, now: () => number): ResearchCacheIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyIndex(now)
  }
  const candidate = value as Partial<ResearchCacheIndex>
  if (candidate.version !== CACHE_VERSION || !Array.isArray(candidate.entries)) {
    return emptyIndex(now)
  }
  return {
    version: CACHE_VERSION,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : nowIso(now),
    entries: candidate.entries.filter((entry): entry is ResearchCacheIndexEntry =>
      Boolean(
        entry &&
        typeof entry.key === 'string' &&
        typeof entry.kind === 'string' &&
        typeof entry.relativePath === 'string' &&
        typeof entry.source === 'string' &&
        typeof entry.createdAt === 'string' &&
        typeof entry.updatedAt === 'string' &&
        typeof entry.lastUsedAt === 'string' &&
        typeof entry.contentHash === 'string'
      )
    )
  }
}

function isPathInside(root: string, target: string): boolean {
  const relativeTarget = relative(root, target)
  return (
    relativeTarget === '' || (!relativeTarget.startsWith(`..${sep}`) && relativeTarget !== '..')
  )
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function truncateText(value: string, limit = MAX_TOOL_CHARS): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n\n[输出已截断；请使用 cache_read 分页读取完整缓存。]`
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function htmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? decodeHtml(match[1].replace(/<[^>]+>/g, '')).trim() : ''
}

/**
 * 保留正文中的块级断行，避免把网页压成无法引用的一整段文本。
 */
export function extractReadableText(html: string): string {
  const withoutHiddenContent = html
    .replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|header|footer|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeHtml(withoutHiddenContent)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const operationTails = new Map<string, Promise<void>>()

/**
 * 同一 Pi 进程中，研究缓存与同一路径的 Git 工作树都可能被并行工具调用。
 * 对同一资源完整串行化，而不是只锁最后一次写入，避免索引和证据文件分叉。
 */
async function withExclusiveOperation<T>(resource: string, work: () => Promise<T>): Promise<T> {
  const previous = operationTails.get(resource) ?? Promise.resolve()
  let release: (() => void) | undefined
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn
  })
  const tail = previous.catch(() => undefined).then(() => turn)
  operationTails.set(resource, tail)
  await previous.catch(() => undefined)
  try {
    return await work()
  } finally {
    release?.()
    if (operationTails.get(resource) === tail) operationTails.delete(resource)
  }
}

export class ResearchCache {
  readonly root: string
  private readonly indexPath: string
  private readonly now: () => number

  constructor(options: ResearchCacheOptions) {
    this.root = join(options.cwd, 'temp', 'pi', 'pi-desk-subagent', 'research-cache')
    this.indexPath = join(this.root, 'index.json')
    this.now = options.now ?? Date.now
  }

  async get(key: string): Promise<CachedResearch | undefined> {
    return this.withLock(async () => {
      const index = await this.readIndex()
      await this.cleanupIndexUnlocked(index)
      const entry = index.entries.find((candidate) => candidate.key === key)
      let cached: CachedResearch | undefined
      if (entry) {
        const path = this.resolveEntryPath(entry.relativePath)
        try {
          const record = JSON.parse(await readFile(path, 'utf8')) as ResearchCacheRecord
          entry.lastUsedAt = nowIso(this.now)
          cached = { entry, record }
        } catch {
          index.entries = index.entries.filter((candidate) => candidate.key !== key)
        }
      }
      await this.writeIndexUnlocked(index)
      return cached
    })
  }

  async put(params: {
    key: string
    kind: ResearchCacheKind
    source: string
    data: unknown
    repositoryPath?: string
  }): Promise<CachedResearch> {
    return this.withLock(async () => {
      const index = await this.readIndex()
      await this.cleanupIndexUnlocked(index)
      const createdAt = nowIso(this.now)
      const serializedData = JSON.stringify(params.data)
      const record: ResearchCacheRecord = {
        version: CACHE_VERSION,
        key: params.key,
        kind: params.kind,
        source: params.source,
        createdAt,
        contentHash: hashText(serializedData),
        data: params.data
      }
      const relativePath = join('records', `${hashText(params.key).slice(7)}.json`)
      await this.writeJson(this.resolveEntryPath(relativePath), record)

      const entry: ResearchCacheIndexEntry = {
        key: params.key,
        kind: params.kind,
        relativePath,
        source: params.source,
        createdAt,
        updatedAt: createdAt,
        lastUsedAt: createdAt,
        contentHash: record.contentHash,
        repositoryPath: params.repositoryPath
      }
      index.entries = [...index.entries.filter((candidate) => candidate.key !== entry.key), entry]
      await this.writeIndexUnlocked(index)
      return { entry, record }
    })
  }

  async cleanup(): Promise<void> {
    await this.withLock(() => this.cleanupUnlocked())
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    return withExclusiveOperation(this.indexPath, work)
  }

  private async cleanupUnlocked(): Promise<void> {
    const index = await this.readIndex()
    await this.cleanupIndexUnlocked(index)
    await this.writeIndexUnlocked(index)
  }

  private async cleanupIndexUnlocked(index: ResearchCacheIndex): Promise<void> {
    const threshold = this.now() - CACHE_RETENTION_MS
    const kept: ResearchCacheIndexEntry[] = []
    for (const entry of index.entries) {
      const lastUsedAt = Date.parse(entry.lastUsedAt)
      if (Number.isFinite(lastUsedAt) && lastUsedAt >= threshold) {
        kept.push(entry)
        continue
      }
      await rm(this.resolveEntryPath(entry.relativePath), { force: true })
      if (entry.repositoryPath) {
        await rm(this.resolveEntryPath(entry.repositoryPath), {
          recursive: true,
          force: true
        })
      }
    }
    index.entries = kept
  }

  private async readIndex(): Promise<ResearchCacheIndex> {
    try {
      return asIndex(JSON.parse(await readFile(this.indexPath, 'utf8')), this.now)
    } catch {
      return emptyIndex(this.now)
    }
  }

  private async writeIndexUnlocked(index: ResearchCacheIndex): Promise<void> {
    index.updatedAt = nowIso(this.now)
    await this.writeJson(this.indexPath, index)
  }

  private resolveEntryPath(relativePath: string): string {
    const path = resolve(this.root, relativePath)
    if (!isPathInside(resolve(this.root), path)) {
      throw new Error('研究缓存路径越界')
    }
    return path
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tempPath, path)
  }
}

function cacheReadText(record: ResearchCacheRecord): string {
  if (record.kind === 'page') {
    const page = record.data as PageRecord
    return page.content
  }
  return JSON.stringify(record.data, null, 2)
}

function formatCacheMetadata(cached: CachedResearch, status: 'hit' | 'miss'): string {
  return [
    `缓存：${status}`,
    `缓存键：${cached.entry.key}`,
    `来源：${cached.entry.source}`,
    `获取时间：${cached.entry.updatedAt}`,
    `内容 Hash：${cached.entry.contentHash}`
  ].join('\n')
}

function filterDomains(
  results: AnySearchResult[],
  domains: string[] | undefined
): AnySearchResult[] {
  if (!domains || domains.length === 0) return results
  const allows = domains
    .filter((domain) => !domain.startsWith('-'))
    .map((domain) => domain.toLowerCase())
  const denies = domains
    .filter((domain) => domain.startsWith('-'))
    .map((domain) => domain.slice(1).toLowerCase())
  return results.filter((result) => {
    let hostname: string
    try {
      hostname = new URL(result.url).hostname.toLowerCase()
    } catch {
      return false
    }
    const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`)
    if (denies.some(matches)) return false
    return allows.length === 0 || allows.some(matches)
  })
}

async function searchWeb(params: {
  query: string
  maxResults: number
  signal?: AbortSignal
}): Promise<AnySearchResult[]> {
  const response = await fetch(ANYSEARCH_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: params.query, max_results: params.maxResults }),
    signal: params.signal
      ? AbortSignal.any([params.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`AnySearch 请求失败：HTTP ${response.status}`)
  }
  const body = (await response.json()) as {
    code?: unknown
    data?: { results?: unknown }
  }
  if (body.code !== 0 || !Array.isArray(body.data?.results)) {
    throw new Error('AnySearch 返回了无效结果')
  }
  return body.data.results
    .filter((result): result is AnySearchResult =>
      Boolean(
        result &&
        typeof result === 'object' &&
        typeof (result as AnySearchResult).title === 'string' &&
        typeof (result as AnySearchResult).url === 'string' &&
        typeof (result as AnySearchResult).snippet === 'string' &&
        typeof (result as AnySearchResult).content === 'string'
      )
    )
    .slice(0, params.maxResults)
}

async function fetchPage(params: { url: string; signal?: AbortSignal }): Promise<PageRecord> {
  const parsed = new URL(params.url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只能抓取 HTTP(S) 网页')
  }
  const response = await fetch(parsed, {
    headers: { 'User-Agent': 'pi-task-subagent-research/1.0' },
    signal: params.signal
      ? AbortSignal.any([params.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`网页抓取失败：HTTP ${response.status}`)

  const body = await response.arrayBuffer()
  if (body.byteLength > MAX_FETCH_BYTES) {
    throw new Error(`网页正文超过 ${MAX_FETCH_BYTES / 1024 / 1024}MB 限制`)
  }
  const rawText = new TextDecoder().decode(body)
  const contentType = response.headers.get('content-type')
  const content = contentType?.includes('html') ? extractReadableText(rawText) : rawText.trim()
  if (!content) throw new Error('网页没有可读取的文本内容')
  return {
    requestedUrl: params.url,
    finalUrl: response.url,
    title: contentType?.includes('html') ? htmlTitle(rawText) : basename(parsed.pathname),
    content,
    contentType
  }
}

async function runGh(pi: ExtensionAPI, args: string[], cwd: string): Promise<string> {
  const result = await pi.exec('gh', args, { cwd, timeout: FETCH_TIMEOUT_MS })
  if (result.code !== 0) {
    throw new Error(`GitHub 查询失败：${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

async function runGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<string> {
  const result = await pi.exec('git', args, { cwd, timeout: 120_000 })
  if (result.code !== 0) {
    throw new Error(`Git 操作失败：${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout
}

function repositoryRelativePath(repository: string, ref: string | null): string {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('repository 必须使用 owner/repo 格式')
  }
  const [owner, name] = repository.split('/')
  // Ref 可包含 / 等路径字符，使用稳定摘要同时保证不同引用拥有独立工作树。
  const refId = hashText(ref ?? 'default').slice(7, 23)
  return join('repos', 'github.com', owner, name, `ref-${refId}`)
}

async function repositoryExists(pi: ExtensionAPI, path: string, cwd: string): Promise<boolean> {
  const result = await pi.exec('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], {
    cwd,
    timeout: 10_000
  })
  return result.code === 0 && result.stdout.trim() === 'true'
}

export async function ensureCachedRepository(params: {
  pi: ExtensionAPI
  cache: ResearchCache
  cwd: string
  repository: string
  ref?: string
  refresh: boolean
  onProgress?: (text: string) => void
}): Promise<{ cached: CachedResearch; cacheStatus: 'hit' | 'miss' }> {
  const requestedRef = params.ref?.trim() || null
  const relativeRepositoryPath = repositoryRelativePath(params.repository, requestedRef)
  const localPath = join(params.cache.root, relativeRepositoryPath)
  const key = cacheKey('repository', {
    repository: params.repository,
    ref: requestedRef
  })

  return withExclusiveOperation(localPath, async () => {
    let cached = params.refresh ? undefined : await params.cache.get(key)
    const exists = await repositoryExists(params.pi, localPath, params.cwd)
    if (cached && exists) {
      const expected = cached.record.data as RepositoryRecord
      const currentCommit = (
        await runGit(params.pi, ['-C', localPath, 'rev-parse', 'HEAD'], params.cwd)
      ).trim()
      if (expected.commit !== currentCommit) cached = undefined
    } else if (!exists) {
      cached = undefined
    }

    const cacheStatus = cached ? 'hit' : 'miss'
    if (!cached) {
      params.onProgress?.('正在准备本地 GitHub 仓库…')
      if (!exists) {
        await mkdir(dirname(localPath), { recursive: true })
        await runGh(
          params.pi,
          ['repo', 'clone', params.repository, localPath, '--', '--depth=1'],
          params.cwd
        )
      }
      // 首次 clone 后也必须切到请求的 ref；已有目录在缓存未命中时同时刷新默认分支。
      if (requestedRef || exists) {
        await runGit(
          params.pi,
          ['-C', localPath, 'fetch', '--depth=1', 'origin', requestedRef ?? 'HEAD'],
          params.cwd
        )
        await runGit(params.pi, ['-C', localPath, 'checkout', '--detach', 'FETCH_HEAD'], params.cwd)
      }
      const commit = (
        await runGit(params.pi, ['-C', localPath, 'rev-parse', 'HEAD'], params.cwd)
      ).trim()
      cached = await params.cache.put({
        key,
        kind: 'repository',
        source: `GitHub repository: ${params.repository}`,
        data: {
          repository: params.repository,
          ref: requestedRef,
          localPath,
          commit
        } satisfies RepositoryRecord,
        repositoryPath: relativeRepositoryPath
      })
    }
    return { cached, cacheStatus }
  })
}

function createResearchToolExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'external_research',
      label: 'External Research',
      description:
        '在 research 子代理内检索网页、GitHub 和项目级持久缓存。所有操作优先复用缓存；仅在需要最新资料时传 refresh=true。',
      promptSnippet: '检索外部网页、GitHub 项目和持久证据缓存；二次验证优先读取已有 cacheKey。',
      promptGuidelines: [
        'external_research：先搜索并读取缓存，再作出外部事实结论；任务要求最新信息时才传 refresh=true。',
        'external_research：GitHub 项目确认相关后使用 github_clone，本地路径中的文件必须用 read、grep、find 或 ls 继续取证。',
        'external_research：二次验证使用 cache_read 回读原始证据，并在最终报告中注明缓存键、时间、Hash 与网页偏移或 GitHub 行号。'
      ],
      parameters: Type.Object({
        action: StringEnum(
          ['web_search', 'fetch_url', 'github_search', 'github_clone', 'cache_read'] as const,
          { description: '执行的研究操作' }
        ),
        query: Type.Optional(Type.String({ description: '网页或 GitHub 搜索查询' })),
        url: Type.Optional(Type.String({ description: '要抓取的单个网页 URL' })),
        repository: Type.Optional(Type.String({ description: 'GitHub 仓库，格式 owner/repo' })),
        ref: Type.Optional(
          Type.String({ description: '要 checkout 的 Git ref；省略则使用缓存或默认分支' })
        ),
        githubKind: Type.Optional(
          StringEnum(['repositories', 'code'] as const, {
            description: 'GitHub 搜索类型；默认 repositories'
          })
        ),
        maxResults: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 20, description: '最大结果数，默认 5' })
        ),
        domainFilter: Type.Optional(
          Type.Array(Type.String(), {
            description: '网页结果域名过滤；-example.com 表示排除'
          })
        ),
        cacheKey: Type.Optional(Type.String({ description: 'cache_read 要读取的缓存键' })),
        offset: Type.Optional(Type.Integer({ minimum: 0, description: 'cache_read 字符偏移' })),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_CACHE_READ_CHARS,
            description: 'cache_read 最大字符数'
          })
        ),
        refresh: Type.Optional(Type.Boolean({ description: '忽略已有缓存并重新获取当前资料' }))
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const cache = new ResearchCache({ cwd: ctx.cwd })
        const refresh = params.refresh === true
        const maxResults = clampInteger(params.maxResults, 5, 1, 20)
        onUpdate?.({ content: [{ type: 'text', text: '正在检查研究缓存…' }], details: {} })

        if (params.action === 'cache_read') {
          const key = params.cacheKey?.trim()
          if (!key) throw new Error('cache_read 需要 cacheKey')
          const cached = await cache.get(key)
          if (!cached) throw new Error(`未找到研究缓存：${key}`)
          const offset = clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER)
          const limit = clampInteger(params.limit, MAX_CACHE_READ_CHARS, 1, MAX_CACHE_READ_CHARS)
          const content = cacheReadText(cached.record)
          const slice = content.slice(offset, offset + limit)
          return {
            content: [
              {
                type: 'text',
                text: `${formatCacheMetadata(cached, 'hit')}\n字符范围：${offset}-${offset + slice.length}\n\n${slice}`
              }
            ],
            details: {
              cacheKey: key,
              cacheStatus: 'hit',
              offset,
              limit,
              contentHash: cached.entry.contentHash
            }
          }
        }

        if (params.action === 'web_search') {
          const query = params.query?.trim()
          if (!query) throw new Error('web_search 需要 query')
          const key = cacheKey('web-search', {
            query,
            maxResults,
            domainFilter: params.domainFilter ?? []
          })
          let cached = refresh ? undefined : await cache.get(key)
          const cacheStatus = cached ? 'hit' : 'miss'
          if (!cached) {
            onUpdate?.({ content: [{ type: 'text', text: '正在搜索网页…' }], details: {} })
            const results = filterDomains(
              await searchWeb({ query, maxResults, signal }),
              params.domainFilter
            )
            cached = await cache.put({
              key,
              kind: 'web-search',
              source: `AnySearch: ${query}`,
              data: { query, maxResults, results } satisfies WebSearchRecord
            })
          }
          const record = cached.record.data as WebSearchRecord
          const resultText = record.results
            .map(
              (result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`
            )
            .join('\n\n')
          return {
            content: [
              {
                type: 'text',
                text: `${formatCacheMetadata(cached, cacheStatus)}\n\n${truncateText(resultText || '未找到结果。')}`
              }
            ],
            details: {
              cacheKey: key,
              cacheStatus,
              resultCount: record.results.length,
              contentHash: cached.entry.contentHash
            }
          }
        }

        if (params.action === 'fetch_url') {
          const url = params.url?.trim()
          if (!url) throw new Error('fetch_url 需要 url')
          const key = cacheKey('page', { url })
          let cached = refresh ? undefined : await cache.get(key)
          const cacheStatus = cached ? 'hit' : 'miss'
          if (!cached) {
            onUpdate?.({ content: [{ type: 'text', text: '正在抓取网页正文…' }], details: {} })
            const page = await fetchPage({ url, signal })
            cached = await cache.put({ key, kind: 'page', source: page.finalUrl, data: page })
          }
          const page = cached.record.data as PageRecord
          const preview = page.content.slice(0, 4_000)
          return {
            content: [
              {
                type: 'text',
                text: `${formatCacheMetadata(cached, cacheStatus)}\n标题：${page.title || '(无标题)'}\n正文总字符：${page.content.length}\n\n${preview}${page.content.length > preview.length ? '\n\n[正文预览已截断；使用 cache_read 继续读取。]' : ''}`
              }
            ],
            details: {
              cacheKey: key,
              cacheStatus,
              url: page.finalUrl,
              contentHash: cached.entry.contentHash,
              contentLength: page.content.length
            }
          }
        }

        if (params.action === 'github_search') {
          const query = params.query?.trim()
          if (!query) throw new Error('github_search 需要 query')
          const kind = params.githubKind ?? 'repositories'
          const key = cacheKey('github-search', { kind, query, maxResults })
          let cached = refresh ? undefined : await cache.get(key)
          const cacheStatus = cached ? 'hit' : 'miss'
          if (!cached) {
            onUpdate?.({ content: [{ type: 'text', text: '正在搜索 GitHub…' }], details: {} })
            const fields =
              kind === 'repositories'
                ? 'nameWithOwner,description,url,stargazersCount,updatedAt,defaultBranch'
                : 'repository,path,url,textMatches'
            const stdout = await runGh(
              pi,
              [
                'search',
                kind === 'repositories' ? 'repos' : 'code',
                query,
                '--limit',
                String(maxResults),
                '--json',
                fields
              ],
              ctx.cwd
            )
            let results: unknown
            try {
              results = JSON.parse(stdout)
            } catch {
              throw new Error('GitHub 搜索结果不是有效 JSON')
            }
            if (!Array.isArray(results)) throw new Error('GitHub 搜索结果格式无效')
            cached = await cache.put({
              key,
              kind: 'github-search',
              source: `GitHub ${kind}: ${query}`,
              data: { kind, query, results } satisfies GitHubSearchRecord
            })
          }
          const record = cached.record.data as GitHubSearchRecord
          return {
            content: [
              {
                type: 'text',
                text: `${formatCacheMetadata(cached, cacheStatus)}\n\n${truncateText(JSON.stringify(record.results, null, 2))}`
              }
            ],
            details: {
              cacheKey: key,
              cacheStatus,
              resultCount: record.results.length,
              contentHash: cached.entry.contentHash
            }
          }
        }

        const repository = params.repository?.trim()
        if (!repository) throw new Error('github_clone 需要 repository')
        const { cached, cacheStatus } = await ensureCachedRepository({
          pi,
          cache,
          cwd: ctx.cwd,
          repository,
          ref: params.ref,
          refresh,
          onProgress: (text) => onUpdate?.({ content: [{ type: 'text', text }], details: {} })
        })
        const record = cached.record.data as RepositoryRecord
        const key = cached.entry.key
        return {
          content: [
            {
              type: 'text',
              text: `${formatCacheMetadata(cached, cacheStatus)}\n仓库：${record.repository}\nRef：${record.ref ?? '默认分支'}\nCommit：${record.commit}\n本地路径：${record.localPath}\n\n请使用 read、grep、find 或 ls 从该本地路径继续取证。`
            }
          ],
          details: {
            cacheKey: key,
            cacheStatus,
            repository: record.repository,
            localPath: record.localPath,
            commit: record.commit,
            contentHash: cached.entry.contentHash
          }
        }
      }
    })
  }
}

export function createExternalResearchExtension(): ExtensionFactory {
  return createResearchToolExtension()
}

export const __test__ = {
  cacheKey,
  hashText
}
