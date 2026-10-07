import 'server-only'

import { getL4PiDeskDataDir } from '@server/l4_foundation/pi/l4-pi-desk-data-dir'

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import type {
  L4ModelCatalogItem,
  L4ModelCatalogRefreshResult,
  L4ModelCatalogRequest,
  L4ModelCatalogResponse,
  L4ModelCatalogSource,
  L4ModelCost,
  L4ModelThinkingLevelConfig
} from './l4-model-settings-types'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const FETCH_TIMEOUT_MS = 20_000
const AGGREGATOR_PROVIDERS = new Set([
  'openrouter',
  'vercel-ai-gateway',
  'ai-router',
  'cloudflare-ai-gateway',
  'opencode',
  'opencode-go'
])

type JsonRecord = Record<string, unknown>
type SourceOrigin = 'models-dev' | 'pi'

interface CachedSource extends L4ModelCatalogSource {
  origin: SourceOrigin
  modelName: string
}

interface CachedModel {
  referenceId: string
  name: string
  sources: CachedSource[]
}

interface ModelCatalogCache {
  etag: string | null
  updatedAt: number
  models: CachedModel[]
}

interface ModelsDevRefresh {
  etag: string | null
  unchanged: boolean
  sources: CachedSource[]
}

let refreshPromise: Promise<{
  cache: ModelCatalogCache
  result: L4ModelCatalogRefreshResult
}> | null = null

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cachePath(): string {
  return join(getL4PiDeskDataDir(), 'model-catalog.json')
}

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-')
    .replace(/-+/gu, '-')
}

function normalizeModelIdentity(modelId: string): string {
  const normalized = normalizeSearchText(modelId).replace(/:(free|online)$/u, '')
  const segments = normalized.split('/').filter(Boolean)
  return segments.length > 1 ? segments.at(-1)! : normalized
}

function sourceKey(source: Pick<CachedSource, 'provider' | 'modelId'>): string {
  return `${source.provider}\u0000${source.modelId}`
}

function referenceIdFor(modelId: string): string {
  return normalizeModelIdentity(modelId)
}

function parseCachedSource(value: JsonRecord): CachedSource | null {
  if (
    (value.origin !== 'models-dev' && value.origin !== 'pi') ||
    typeof value.modelName !== 'string' ||
    typeof value.provider !== 'string' ||
    typeof value.providerName !== 'string' ||
    typeof value.modelId !== 'string' ||
    typeof value.official !== 'boolean' ||
    !isRecord(value.defaults)
  ) {
    return null
  }
  const defaults = value.defaults
  if (
    typeof defaults.reasoning !== 'boolean' ||
    !Array.isArray(defaults.thinkingLevels) ||
    !Array.isArray(defaults.input) ||
    typeof defaults.contextWindow !== 'number' ||
    typeof defaults.maxTokens !== 'number'
  ) {
    return null
  }

  const thinkingLevels: L4ModelThinkingLevelConfig[] = []
  for (const item of defaults.thinkingLevels) {
    if (!isRecord(item) || typeof item.level !== 'string') return null
    if (
      item.level !== 'off' &&
      item.level !== 'minimal' &&
      item.level !== 'low' &&
      item.level !== 'medium' &&
      item.level !== 'high' &&
      item.level !== 'xhigh' &&
      item.level !== 'max'
    ) {
      return null
    }
    if (item.providerValue !== null && typeof item.providerValue !== 'string') return null
    thinkingLevels.push({ level: item.level, providerValue: item.providerValue })
  }
  const input = defaults.input.filter(
    (item): item is 'text' | 'image' => item === 'text' || item === 'image'
  )
  if (thinkingLevels.length === 0 || input.length === 0) return null

  let cost: L4ModelCost | null = null
  if (defaults.cost !== null) {
    if (!isRecord(defaults.cost)) return null
    const inputCost = numberField(defaults.cost, 'input')
    const outputCost = numberField(defaults.cost, 'output')
    const cacheRead = numberField(defaults.cost, 'cacheRead')
    const cacheWrite = numberField(defaults.cost, 'cacheWrite')
    if (inputCost === null || outputCost === null || cacheRead === null || cacheWrite === null) {
      return null
    }
    cost = { input: inputCost, output: outputCost, cacheRead, cacheWrite }
  }

  return {
    origin: value.origin,
    modelName: value.modelName,
    provider: value.provider,
    providerName: value.providerName,
    modelId: value.modelId,
    official: value.official,
    defaults: {
      reasoning: defaults.reasoning,
      thinkingLevels,
      input,
      contextWindow: Math.trunc(defaults.contextWindow),
      maxTokens: Math.trunc(defaults.maxTokens),
      cost
    }
  }
}

function readCache(): ModelCatalogCache | null {
  const path = cachePath()
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(value) || typeof value.updatedAt !== 'number' || !Array.isArray(value.models)) {
      return null
    }
    const models: CachedModel[] = []
    for (const item of value.models) {
      if (!isRecord(item) || !Array.isArray(item.sources)) continue
      const parsedSources: CachedSource[] = []
      for (const source of item.sources) {
        if (
          !isRecord(source) ||
          (source.origin !== 'models-dev' && source.origin !== 'pi') ||
          typeof source.modelName !== 'string'
        ) {
          continue
        }
        const parsed = parseCachedSource(source)
        if (parsed) parsedSources.push(parsed)
      }
      if (
        typeof item.referenceId === 'string' &&
        typeof item.name === 'string' &&
        parsedSources.length > 0
      ) {
        models.push({ referenceId: item.referenceId, name: item.name, sources: parsedSources })
      }
    }
    if (models.length === 0) return null
    return {
      etag: typeof value.etag === 'string' ? value.etag : null,
      updatedAt: value.updatedAt,
      models
    }
  } catch (error) {
    console.warn('[Pi Desk][ModelCatalog] 模型参考缓存无效', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return null
  }
}

function writeCache(cache: ModelCatalogCache): void {
  const path = cachePath()
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(cache)}\n`, 'utf8')
    renameSync(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

function numberField(record: JsonRecord, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function normalizeCost(value: unknown): L4ModelCost | null {
  if (!isRecord(value)) return null
  const input = numberField(value, 'input')
  const output = numberField(value, 'output')
  if (input === null || output === null) return null
  return {
    input,
    output,
    cacheRead: numberField(value, 'cache_read') ?? 0,
    cacheWrite: numberField(value, 'cache_write') ?? 0
  }
}

function normalizeModelsDevThinking(model: JsonRecord): L4ModelThinkingLevelConfig[] {
  if (model.reasoning !== true) return [{ level: 'off', providerValue: null }]
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : []
  const effort = options.find(
    (option) => isRecord(option) && option.type === 'effort' && Array.isArray(option.values)
  )
  if (isRecord(effort) && Array.isArray(effort.values)) {
    const levels: L4ModelThinkingLevelConfig[] = []
    for (const value of effort.values) {
      if (typeof value !== 'string') continue
      const level = value === 'none' ? 'off' : value
      if (
        level === 'off' ||
        level === 'minimal' ||
        level === 'low' ||
        level === 'medium' ||
        level === 'high' ||
        level === 'xhigh' ||
        level === 'max'
      ) {
        levels.push({ level, providerValue: value })
      }
    }
    if (levels.length > 0) return levels
  }
  return [{ level: 'high', providerValue: null }]
}

function isOfficialSource(provider: string, modelId: string): boolean {
  if (AGGREGATOR_PROVIDERS.has(provider)) return false
  const normalizedProvider = normalizeSearchText(provider)
  const normalizedId = normalizeSearchText(modelId)
  if (modelId.includes('/')) return normalizedId.split('/')[0] === normalizedProvider

  const identity = normalizeModelIdentity(modelId)
  const expectedProviders = identity.match(/^(gpt|chatgpt|o1|o3|o4)-/u)
    ? ['openai']
    : identity.startsWith('claude-')
      ? ['anthropic']
      : identity.match(/^(gemini|gemma)-/u)
        ? ['google', 'google-vertex']
        : identity.startsWith('deepseek-')
          ? ['deepseek']
          : identity.startsWith('glm-')
            ? ['zai', 'zai-coding-cn']
            : identity.match(/^(kimi|moonshot)-/u)
              ? ['moonshotai', 'moonshotai-cn']
              : identity.match(/^(mistral|codestral|pixtral)-/u)
                ? ['mistral']
                : []
  return expectedProviders.includes(normalizedProvider)
}

function normalizeModelsDevSource(
  provider: string,
  providerName: string,
  modelId: string,
  model: JsonRecord
): CachedSource | null {
  const limits = isRecord(model.limit) ? model.limit : {}
  const contextWindow = numberField(limits, 'context')
  const maxTokens = numberField(limits, 'output')
  if (!contextWindow || !maxTokens) return null
  const modalities =
    isRecord(model.modalities) && Array.isArray(model.modalities.input)
      ? model.modalities.input
      : ['text']
  const input = [...new Set(modalities.filter((item) => item === 'text' || item === 'image'))]
  return {
    origin: 'models-dev',
    modelName: typeof model.name === 'string' && model.name.trim() ? model.name : modelId,
    provider,
    providerName,
    modelId,
    official: isOfficialSource(provider, modelId),
    defaults: {
      reasoning: model.reasoning === true,
      thinkingLevels: normalizeModelsDevThinking(model),
      input: input.length > 0 ? input : ['text'],
      contextWindow: Math.trunc(contextWindow),
      maxTokens: Math.trunc(maxTokens),
      cost: normalizeCost(model.cost)
    }
  }
}

async function refreshModelsDev(cache: ModelCatalogCache | null): Promise<ModelsDevRefresh> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(MODELS_DEV_URL, {
      headers: cache?.etag ? { 'If-None-Match': cache.etag } : undefined,
      signal: controller.signal
    })
    if (response.status === 304) {
      const sources = cache?.models.flatMap((model) =>
        model.sources.filter((source) => source.origin === 'models-dev')
      )
      if (!sources?.length) throw new Error('models.dev 返回 304，但本地没有可用缓存')
      return { etag: cache?.etag ?? null, unchanged: true, sources }
    }
    if (!response.ok) throw new Error(`models.dev 请求失败：HTTP ${response.status}`)
    const value = (await response.json()) as unknown
    if (!isRecord(value)) throw new Error('models.dev 返回格式无效')

    const sources: CachedSource[] = []
    for (const [providerId, providerValue] of Object.entries(value)) {
      if (!isRecord(providerValue) || !isRecord(providerValue.models)) continue
      const providerName =
        typeof providerValue.name === 'string' && providerValue.name.trim()
          ? providerValue.name
          : providerId
      for (const [entryModelId, modelValue] of Object.entries(providerValue.models)) {
        if (!isRecord(modelValue)) continue
        const modelId =
          typeof modelValue.id === 'string' && modelValue.id.trim() ? modelValue.id : entryModelId
        const source = normalizeModelsDevSource(providerId, providerName, modelId, modelValue)
        if (source) sources.push(source)
      }
    }
    if (sources.length === 0) throw new Error('models.dev 没有返回可用模型')
    return {
      etag: response.headers.get('etag'),
      unchanged: false,
      sources
    }
  } finally {
    clearTimeout(timeout)
  }
}

function piThinkingLevels(model: Model<Api>): L4ModelThinkingLevelConfig[] {
  return getSupportedThinkingLevels(model).map((level) => ({
    level,
    providerValue:
      typeof model.thinkingLevelMap?.[level] === 'string' ? model.thinkingLevelMap[level]! : null
  }))
}

function normalizePiSource(model: Model<Api>, providerName: string): CachedSource {
  return {
    origin: 'pi',
    modelName: model.name,
    provider: model.provider,
    providerName,
    modelId: model.id,
    official: isOfficialSource(model.provider, model.id),
    defaults: {
      reasoning: model.reasoning,
      thinkingLevels: piThinkingLevels(model),
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite
      }
    }
  }
}

async function refreshPiSources(): Promise<{
  sources: CachedSource[]
  failed: boolean
}> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let failed = false
  try {
    const result = await runtime.refresh({
      allowNetwork: true,
      force: true,
      signal: controller.signal
    })
    failed = result.aborted || result.errors.size > 0
    if (failed) {
      console.warn('[Pi Desk][ModelCatalog] Pi 模型目录部分刷新失败', {
        aborted: result.aborted,
        providers: [...result.errors.keys()]
      })
    }
  } catch (error) {
    failed = true
    console.warn('[Pi Desk][ModelCatalog] Pi 模型目录刷新失败', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
  } finally {
    clearTimeout(timeout)
  }
  const sources = runtime
    .getModels()
    .map((model) =>
      normalizePiSource(model, runtime.getProvider(model.provider)?.name ?? model.provider)
    )
  return { sources, failed }
}

function groupSources(sources: CachedSource[]): CachedModel[] {
  const grouped = new Map<string, CachedModel>()
  for (const source of sources) {
    const referenceId = referenceIdFor(source.modelId)
    if (!referenceId) continue
    const current = grouped.get(referenceId)
    const name = current?.name ?? source.modelName
    const nextName = source.official ? source.modelName : name
    if (!current) {
      grouped.set(referenceId, {
        referenceId,
        name: nextName,
        sources: [source]
      })
      continue
    }
    const existingIndex = current.sources.findIndex((item) => sourceKey(item) === sourceKey(source))
    if (existingIndex >= 0) {
      if (source.origin === 'pi') current.sources[existingIndex] = source
    } else {
      current.sources.push(source)
    }
    if (source.official) current.name = nextName
  }

  return [...grouped.values()]
    .map((model) => ({
      ...model,
      name:
        model.sources.find((source) => source.official)?.modelName ??
        model.sources[0]?.modelName ??
        model.name,
      sources: model.sources.sort(
        (left, right) =>
          Number(right.official) - Number(left.official) ||
          left.provider.localeCompare(right.provider)
      )
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function performRefresh(cache: ModelCatalogCache | null): Promise<{
  cache: ModelCatalogCache
  result: L4ModelCatalogRefreshResult
}> {
  const previousModelsDev =
    cache?.models.flatMap((model) =>
      model.sources.filter((source) => source.origin === 'models-dev')
    ) ?? []
  const previousPi =
    cache?.models.flatMap((model) => model.sources.filter((source) => source.origin === 'pi')) ?? []
  const [modelsDevSettled, piSettled] = await Promise.allSettled([
    refreshModelsDev(cache),
    refreshPiSources()
  ])

  const modelsDevSuccess = modelsDevSettled.status === 'fulfilled'
  const piSuccess = piSettled.status === 'fulfilled' && !piSettled.value.failed
  const modelsDevSources = modelsDevSuccess ? modelsDevSettled.value.sources : previousModelsDev
  const piSources = piSettled.status === 'fulfilled' ? piSettled.value.sources : previousPi

  if (!modelsDevSources.length && !piSources.length) {
    const reason = modelsDevSettled.status === 'rejected' ? modelsDevSettled.reason : '没有可用缓存'
    throw new Error(
      `模型参考目录没有可用数据：${reason instanceof Error ? reason.message : String(reason)}`
    )
  }

  if (modelsDevSettled.status === 'rejected') {
    console.warn('[Pi Desk][ModelCatalog] models.dev 刷新失败，继续使用可用目录', {
      errorName:
        modelsDevSettled.reason instanceof Error ? modelsDevSettled.reason.name : 'UnknownError'
    })
  }

  const models = groupSources([...modelsDevSources, ...piSources])
  const changed = !cache || JSON.stringify(models) !== JSON.stringify(cache.models)
  const nextCache: ModelCatalogCache = {
    etag:
      modelsDevSettled.status === 'fulfilled' ? modelsDevSettled.value.etag : (cache?.etag ?? null),
    updatedAt: changed ? Date.now() : (cache?.updatedAt ?? Date.now()),
    models
  }
  writeCache(nextCache)

  const successCount = Number(modelsDevSuccess) + Number(piSuccess)
  const result: L4ModelCatalogRefreshResult =
    successCount === 0
      ? 'cached'
      : successCount === 1
        ? 'partial'
        : changed
          ? 'updated'
          : 'unchanged'
  return { cache: nextCache, result }
}

async function refreshCatalog(cache: ModelCatalogCache | null): Promise<{
  cache: ModelCatalogCache
  result: L4ModelCatalogRefreshResult
}> {
  if (refreshPromise) return refreshPromise
  refreshPromise = performRefresh(cache).finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

function searchCatalog(
  cache: ModelCatalogCache,
  input: L4ModelCatalogRequest
): {
  total: number
  models: L4ModelCatalogItem[]
} {
  const query = normalizeSearchText(input.query)
  const candidates = cache.models
    .map((model) => {
      if (!query) return { model, exact: false, similar: true }
      const modelIdentities = [
        normalizeSearchText(model.referenceId),
        ...model.sources.flatMap((source) => [
          normalizeSearchText(source.modelId),
          normalizeModelIdentity(source.modelId)
        ])
      ]
      const searchTexts = [
        ...modelIdentities,
        normalizeSearchText(model.name),
        ...model.sources.map((source) => normalizeSearchText(source.providerName))
      ]
      const exact = modelIdentities.some((identity) => identity === query)
      const similar = exact || searchTexts.some((identity) => identity.includes(query))
      return { model, exact, similar }
    })
    .filter((candidate) => candidate.similar)
  const exactCount = candidates.filter((candidate) => candidate.exact).length
  candidates.sort(
    (left, right) =>
      Number(right.exact) - Number(left.exact) || left.model.name.localeCompare(right.model.name)
  )

  const start = (input.page.index - 1) * input.page.size
  const models = candidates
    .slice(start, start + input.page.size)
    .map<L4ModelCatalogItem>(({ model, exact }) => ({
      referenceId: model.referenceId,
      name: model.name,
      match: query ? (exact && exactCount === 1 ? 'exact' : 'similar') : null,
      sources: model.sources.map(({ origin: _origin, modelName: _modelName, ...source }) => source)
    }))
  return { total: candidates.length, models }
}

export async function listL4ModelCatalog(
  input: L4ModelCatalogRequest
): Promise<L4ModelCatalogResponse> {
  let cache = readCache()
  let refreshResult: L4ModelCatalogRefreshResult = 'not-requested'
  if (input.refresh || !cache) {
    const refreshed = await refreshCatalog(cache)
    cache = refreshed.cache
    refreshResult = refreshed.result
  }
  const result = searchCatalog(cache, input)
  return {
    updatedAt: cache.updatedAt,
    refreshResult,
    page: {
      index: input.page.index,
      size: input.page.size,
      total: result.total
    },
    models: result.models
  }
}
