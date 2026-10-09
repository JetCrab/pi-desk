import 'server-only'

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import { listL4PiDirectorySummaries } from '@server/l4_foundation/pi/l4-pi-session-catalog'
import type {
  L4AccountModelSelection,
  L4ModelAccount,
  L4ModelCompatConfig,
  L4ModelConfig,
  L4ModelOption,
  L4ModelNativeConfig,
  L4ModelPreset,
  L4ModelProviderConfig,
  L4ModelSelection,
  L4ModelSettingsReplaceInput
} from './l4-model-settings-types'

import {
  applyAccountModelSelections,
  collectedModelKey,
  collectedModelKeys,
  filterCollectedModels,
  readAccountModelSelections
} from './l4-model-collection'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

type JsonRecord = Record<string, unknown>

let writeQueue = Promise.resolve()

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => Boolean(entry[0].trim()) && typeof entry[1] === 'string'
    )
  )
}

function modelsPath(): string {
  return join(getAgentDir(), 'models.json')
}

function readJsonRecord(path: string): JsonRecord {
  if (!existsSync(path)) return {}
  const content = readFileSync(path, 'utf8')
  let value: unknown
  try {
    // Pi 的解析器未公开导出；保持相同的单行注释/尾逗号语法，匹配时保留字符串。
    const json = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content)
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ''))
      .replace(
        /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
        (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : '')
      )
    value = JSON.parse(json)
  } catch (cause) {
    throw new Error(
      `配置文件 ${path} 解析失败：${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause
      }
    )
  }
  if (!isRecord(value)) throw new Error(`${path} 必须是 JSON 对象`)
  return value
}

function writeJsonRecordAtomic(path: string, value: JsonRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(task, task)
  writeQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`
}

function normalizeCompat(value: unknown): L4ModelCompatConfig | null {
  if (!isRecord(value)) return null
  const thinkingFormat = stringOrNull(value.thinkingFormat)
  const compat: L4ModelCompatConfig = {
    supportsDeveloperRole: booleanOrNull(value.supportsDeveloperRole),
    thinkingFormat,
    requiresReasoningContentOnAssistantMessages: booleanOrNull(
      value.requiresReasoningContentOnAssistantMessages
    )
  }
  return Object.values(compat).some((item) => item !== null) ? compat : null
}

function normalizeModelConfig(
  raw: JsonRecord,
  effective: Model<Api> | undefined,
  override: unknown
): L4ModelConfig {
  const modelId = stringOrNull(raw.id) ?? effective?.id
  if (!modelId) throw new Error('模型缺少 id')

  const reasoning = effective?.reasoning ?? booleanOrNull(raw.reasoning) ?? false
  const thinkingMap =
    effective?.thinkingLevelMap ?? (isRecord(raw.thinkingLevelMap) ? raw.thinkingLevelMap : {})
  const effectiveThinkingLevels = effective
    ? getSupportedThinkingLevels(effective)
    : reasoning
      ? THINKING_LEVELS.filter((level) =>
          level === 'xhigh' || level === 'max'
            ? typeof thinkingMap[level] === 'string'
            : thinkingMap[level] !== null
        )
      : (['off'] as const)
  const thinkingLevels = effectiveThinkingLevels.map((level) => ({
    level,
    providerValue: typeof thinkingMap[level] === 'string' ? thinkingMap[level] : null
  }))
  const input = effective?.input ?? (Array.isArray(raw.input) ? raw.input : ['text'])
  const normalizedInput = [...new Set(input.filter((item) => item === 'text' || item === 'image'))]
  const rawCost = isRecord(raw.cost) ? raw.cost : null
  const overrideCost = isRecord(override) && isRecord(override.cost) ? override.cost : null
  const costSource = rawCost || overrideCost ? (effective?.cost ?? rawCost) : null
  const cost =
    costSource &&
    typeof costSource.input === 'number' &&
    typeof costSource.output === 'number' &&
    typeof costSource.cacheRead === 'number' &&
    typeof costSource.cacheWrite === 'number'
      ? {
          input: costSource.input,
          output: costSource.output,
          cacheRead: costSource.cacheRead,
          cacheWrite: costSource.cacheWrite
        }
      : null

  return {
    modelId,
    name: effective?.name ?? stringOrNull(raw.name) ?? modelId,
    api: stringOrNull(raw.api),
    baseUrl: stringOrNull(raw.baseUrl),
    reasoning,
    thinkingLevels,
    input: normalizedInput.length > 0 ? normalizedInput : ['text'],
    contextWindow:
      effective?.contextWindow ??
      (typeof raw.contextWindow === 'number' && raw.contextWindow > 0
        ? Math.trunc(raw.contextWindow)
        : 128_000),
    maxTokens:
      effective?.maxTokens ??
      (typeof raw.maxTokens === 'number' && raw.maxTokens > 0 ? Math.trunc(raw.maxTokens) : 16_384),
    cost,
    headers: {
      ...stringRecord(isRecord(override) ? override.headers : undefined),
      ...stringRecord(raw.headers),
      ...stringRecord(effective?.headers)
    },
    compat: normalizeCompat(effective?.compat ?? raw.compat)
  }
}

function normalizeProviders(rawRoot: JsonRecord, runtime: ModelRuntime): L4ModelProviderConfig[] {
  const rawProviders = isRecord(rawRoot.providers) ? rawRoot.providers : {}
  const providers: L4ModelProviderConfig[] = []

  for (const [providerId, providerValue] of Object.entries(rawProviders)) {
    if (!providerId.trim() || !isRecord(providerValue)) continue
    if (
      providerValue.modelOverrides !== undefined &&
      Object.keys(providerValue).every((key) => key === 'modelOverrides')
    )
      continue
    const rawModels = Array.isArray(providerValue.models) ? providerValue.models : []
    providers.push({
      provider: providerId,
      name: stringOrNull(providerValue.name),
      baseUrl: stringOrNull(providerValue.baseUrl),
      api: stringOrNull(providerValue.api),
      apiKey: typeof providerValue.apiKey === 'string' ? providerValue.apiKey : null,
      authHeader: booleanOrNull(providerValue.authHeader),
      headers: stringRecord(providerValue.headers),
      models: rawModels
        .filter(isRecord)
        .map((model) =>
          normalizeModelConfig(
            model,
            typeof model.id === 'string' ? runtime.getModel(providerId, model.id) : undefined,
            isRecord(providerValue.modelOverrides) && typeof model.id === 'string'
              ? providerValue.modelOverrides[model.id]
              : undefined
          )
        )
    })
  }
  return providers
}

function toModelOption(model: Model<Api>): L4ModelOption {
  return {
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    input: [...model.input],
    contextWindow: model.contextWindow,
    thinkingLevels: [...getSupportedThinkingLevels(model)]
  }
}

async function availableModelOptions(
  runtime: ModelRuntime,
  cwd?: string,
  root = readJsonRecord(modelsPath())
): Promise<L4ModelOption[]> {
  // 调用方均使用已完成初始化刷新的 Runtime，不重复检查全部供应商凭据。
  let models = [...runtime.getAvailableSnapshot()]
  if (cwd) {
    const settings = SettingsManager.create(cwd, getAgentDir())
    const enabledModels = settings.getEnabledModels()
    if (enabledModels?.length) {
      models = (await resolveModelScopeWithDiagnostics(enabledModels, runtime)).scopedModels.map(
        (item) => item.model
      )
    }
  }

  const unique = new Map<string, Model<Api>>()
  for (const model of filterCollectedModels(models, runtime, root)) {
    unique.set(modelKey(model.provider, model.id), model)
  }
  return [...unique.values()].map(toModelOption)
}

function normalizePresets(rawRoot: JsonRecord): L4ModelPreset[] {
  if (!Array.isArray(rawRoot.modelPresets)) return []
  const presets: L4ModelPreset[] = []
  for (const item of rawRoot.modelPresets) {
    if (!isRecord(item)) continue
    const provider = stringOrNull(item.provider)
    const modelId = stringOrNull(item.modelId)
    const thinkingLevel = stringOrNull(item.thinkingLevel)
    if (
      !provider ||
      !modelId ||
      !thinkingLevel ||
      !THINKING_LEVELS.includes(thinkingLevel as (typeof THINKING_LEVELS)[number])
    ) {
      continue
    }
    presets.push({
      provider,
      modelId,
      thinkingLevel: thinkingLevel as L4ModelPreset['thinkingLevel'],
      color: typeof item.color === 'string' && COLOR_PATTERN.test(item.color) ? item.color : null
    })
  }
  return presets
}

function setNullable(target: JsonRecord, key: string, value: string | boolean | null): void {
  if (value === null) delete target[key]
  else target[key] = value
}

function setRecord(target: JsonRecord, key: string, value: JsonRecord): void {
  if (Object.keys(value).length > 0) target[key] = value
  else delete target[key]
}

function applyThinkingLevels(
  target: JsonRecord,
  model: L4ModelConfig,
  baseline: L4ModelConfig | undefined
): void {
  const map = isRecord(target.thinkingLevelMap) ? { ...target.thinkingLevelMap } : {}
  const previous = new Map(baseline?.thinkingLevels.map((item) => [item.level, item.providerValue]))
  const selected = new Map(model.thinkingLevels.map((item) => [item.level, item.providerValue]))
  for (const level of THINKING_LEVELS) {
    if (
      baseline &&
      previous.has(level) === selected.has(level) &&
      previous.get(level) === selected.get(level)
    ) {
      continue
    }
    if (!selected.has(level)) {
      // 缺失 xhigh/max 本身就表示不支持；默认等级则需显式 null 禁用。
      if ((level !== 'xhigh' && level !== 'max') || previous.has(level)) map[level] = null
    } else {
      const value = selected.get(level)!
      if (value === null) delete map[level]
      else map[level] = value
    }
  }
  setRecord(target, 'thinkingLevelMap', map)
}

function applyModelHeaders(
  target: JsonRecord,
  override: JsonRecord | undefined,
  headers: Record<string, string>,
  previous: Record<string, string>
): void {
  const rawHeaders = stringRecord(target.headers)
  const overrideHeaders = stringRecord(override?.headers)
  for (const key of new Set([...Object.keys(previous), ...Object.keys(headers)])) {
    if (headers[key] === previous[key]) continue
    if (!Object.hasOwn(headers, key)) {
      delete rawHeaders[key]
      delete overrideHeaders[key]
      continue
    }
    // Pi 的 raw model 请求头优先于同名 modelOverrides 请求头。
    const owner =
      Object.hasOwn(rawHeaders, key) || !Object.hasOwn(overrideHeaders, key)
        ? rawHeaders
        : overrideHeaders
    owner[key] = headers[key]
  }
  setRecord(target, 'headers', rawHeaders)
  if (override) setRecord(override, 'headers', overrideHeaders)
}

function applyModel(
  existing: unknown,
  model: L4ModelConfig,
  baseline: L4ModelConfig | undefined,
  override: JsonRecord | undefined
): JsonRecord {
  const next = isRecord(existing) ? { ...existing } : {}
  next.id = model.modelId
  const owner = (key: string): JsonRecord =>
    override && Object.hasOwn(override, key) ? override : next
  const changed = (key: keyof L4ModelConfig): boolean =>
    !baseline || !isDeepStrictEqual(model[key], baseline[key])

  for (const key of ['name', 'api', 'baseUrl'] as const) {
    if (changed(key)) setNullable(owner(key), key, model[key])
  }
  for (const key of ['reasoning', 'input', 'contextWindow', 'maxTokens'] as const) {
    if (changed(key)) owner(key)[key] = model[key]
  }
  if (changed('thinkingLevels')) {
    applyThinkingLevels(owner('thinkingLevelMap'), model, baseline)
  }
  if (changed('cost')) {
    const target = owner('cost')
    if (model.cost) {
      const cost = isRecord(target.cost) ? { ...target.cost } : { ...model.cost }
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        if (!baseline || model.cost[key] !== baseline.cost?.[key]) cost[key] = model.cost[key]
      }
      target.cost = cost
    } else {
      delete next.cost
      if (override) delete override.cost
    }
  }
  if (changed('headers')) applyModelHeaders(next, override, model.headers, baseline?.headers ?? {})
  if (changed('compat')) {
    const target = owner('compat')
    const compat = isRecord(target.compat) ? { ...target.compat } : {}
    for (const key of [
      'supportsDeveloperRole',
      'thinkingFormat',
      'requiresReasoningContentOnAssistantMessages'
    ] as const) {
      const value = model.compat?.[key] ?? null
      if (!baseline || value !== (baseline.compat?.[key] ?? null)) setNullable(compat, key, value)
    }
    setRecord(target, 'compat', compat)
  }
  return next
}

function applyProvider(
  existing: unknown,
  provider: L4ModelProviderConfig,
  baseline: L4ModelProviderConfig | undefined
): JsonRecord {
  const next = isRecord(existing) ? { ...existing } : {}
  for (const key of ['name', 'baseUrl', 'api', 'apiKey', 'authHeader'] as const) {
    if (!baseline || provider[key] !== baseline[key]) setNullable(next, key, provider[key])
  }
  if (!baseline || !isDeepStrictEqual(provider.headers, baseline.headers)) {
    setRecord(next, 'headers', provider.headers)
  }

  const existingModels = Array.isArray(next.models) ? next.models.filter(isRecord) : []
  const existingById = new Map(
    existingModels
      .filter((model) => typeof model.id === 'string')
      .map((model) => [model.id as string, model])
  )
  const baselineById = new Map(baseline?.models.map((model) => [model.modelId, model]))
  const overrides = isRecord(next.modelOverrides) ? { ...next.modelOverrides } : undefined
  const models = provider.models.map((model) => {
    const currentOverride = overrides?.[model.modelId]
    const override = isRecord(currentOverride) ? { ...currentOverride } : undefined
    const result = applyModel(
      existingById.get(model.modelId),
      model,
      baselineById.get(model.modelId),
      override
    )
    if (overrides && override) overrides[model.modelId] = override
    return result
  })
  if (next.models !== undefined || models.length > 0) next.models = models
  if (overrides) next.modelOverrides = overrides
  return next
}

function mergeModelsRoot(
  current: JsonRecord,
  input: L4ModelSettingsReplaceInput,
  runtime: ModelRuntime,
  defaults: ModelRuntime
): JsonRecord {
  if (input.nativeConfig !== undefined) return input.nativeConfig
  const next = { ...current }
  if (input.providers) {
    const currentProviders = isRecord(current.providers) ? current.providers : {}
    const baselineById = new Map(
      normalizeProviders(current, runtime).map((provider) => [provider.provider, provider])
    )
    // 整集合替换只按当前 ID 复用声明；重命名属于删除旧身份并创建新身份。
    next.providers = Object.fromEntries([
      ...Object.entries(currentProviders).filter(([id]) => !baselineById.has(id)),
      ...input.providers.map((provider) => [
        provider.provider,
        applyProvider(
          currentProviders[provider.provider],
          provider,
          baselineById.get(provider.provider)
        )
      ])
    ])
  }
  if (input.accountModels !== undefined) {
    applyAccountModelSelections(current, next, input.accountModels, defaults)
  }
  if (input.presets && !isDeepStrictEqual(input.presets, normalizePresets(current))) {
    next.modelPresets = input.presets
  }
  return next
}

async function validateModelsRoot(candidate: JsonRecord): Promise<ModelRuntime> {
  const agentDir = getAgentDir()
  mkdirSync(agentDir, { recursive: true })
  const temporaryModelsPath = join(agentDir, `models.${process.pid}.${randomUUID()}.tmp.json`)
  const temporaryStorePath = join(agentDir, `models-store.${process.pid}.${randomUUID()}.tmp.json`)
  writeFileSync(temporaryModelsPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
  try {
    const runtime = await ModelRuntime.create({
      modelsPath: temporaryModelsPath,
      modelsStorePath: temporaryStorePath,
      allowModelNetwork: false
    })
    const error = runtime.getError()
    if (error) throw new Error(`模型配置校验失败：${error}`)
    return runtime
  } finally {
    if (existsSync(temporaryModelsPath)) unlinkSync(temporaryModelsPath)
    if (existsSync(temporaryStorePath)) unlinkSync(temporaryStorePath)
  }
}

function assertPresetsValid(
  presets: L4ModelPreset[],
  models: L4ModelOption[],
  previous: L4ModelPreset[] = []
): void {
  const retained = new Set(
    previous.map((item) => `${modelKey(item.provider, item.modelId)}\u0000${item.thinkingLevel}`)
  )
  const options = new Map(models.map((model) => [modelKey(model.provider, model.modelId), model]))
  const seen = new Set<string>()
  for (const preset of presets) {
    const key = `${modelKey(preset.provider, preset.modelId)}\u0000${preset.thinkingLevel}`
    if (seen.has(key)) throw new Error('模型预设存在重复组合')
    seen.add(key)
    const model = options.get(modelKey(preset.provider, preset.modelId))
    if ((!model || !model.thinkingLevels.includes(preset.thinkingLevel)) && !retained.has(key)) {
      throw new Error(
        `模型预设 ${preset.provider}/${preset.modelId}:${preset.thinkingLevel} 不可用`
      )
    }
  }
}

export function filterL4CollectedModels(
  models: readonly Model<Api>[],
  runtime: ModelRuntime
): Model<Api>[] {
  return filterCollectedModels(models, runtime, readJsonRecord(modelsPath()))
}

async function readAccounts(
  defaults: ModelRuntime,
  selections: L4AccountModelSelection[]
): Promise<L4ModelAccount[]> {
  const credentials = await defaults.listCredentials()
  const loggedIn = new Set(
    credentials.filter((item) => item.type === 'oauth').map((item) => item.providerId)
  )
  const providers = new Set([...loggedIn, ...selections.map((item) => item.provider)])
  return [...providers].map((id) => {
    const provider = defaults.getProvider(id)
    return {
      provider: id,
      name: provider?.name ?? id,
      loggedIn: loggedIn.has(id),
      subscription: provider?.auth.oauth?.isSubscription === true,
      models: defaults
        .getModels(id)
        .map((model) => normalizeModelConfig({ id: model.id, cost: model.cost }, model, undefined))
    }
  })
}

async function assertConnectionCredentials(
  current: JsonRecord,
  candidate: JsonRecord,
  runtime: ModelRuntime
): Promise<void> {
  const credentials = await runtime.listCredentials()
  const previous = isRecord(current.providers) ? current.providers : {}
  const next = isRecord(candidate.providers) ? candidate.providers : {}
  const fields = ['baseUrl', 'api', 'apiKey', 'headers', 'authHeader'] as const
  for (const credential of credentials) {
    if (credential.type !== 'oauth') continue
    const previousProvider = previous[credential.providerId]
    const nextProvider = next[credential.providerId]
    const before = isRecord(previousProvider) ? previousProvider : {}
    const after = isRecord(nextProvider) ? nextProvider : {}
    if (
      fields.some(
        (field) => after[field] !== undefined && !isDeepStrictEqual(before[field], after[field])
      )
    ) {
      throw new Error(
        `服务 ${credential.providerId} 已保存账号登录，请为自定义 API 使用独立服务 ID，或先退出账号`
      )
    }
  }
}

async function assertRemovalReferences(current: JsonRecord, candidate: JsonRecord): Promise<void> {
  const nextKeys = collectedModelKeys(candidate)
  const removed = new Set([...collectedModelKeys(current)].filter((key) => !nextKeys.has(key)))
  if (!removed.size) return
  for (const preset of normalizePresets(candidate)) {
    if (removed.has(collectedModelKey(preset.provider, preset.modelId))) {
      throw new Error(
        `模型 ${preset.provider}/${preset.modelId} 仍被常用组合引用，请先移除对应组合`
      )
    }
  }
  // 仅在移除模型时检查已知项目，不扫描文件系统寻找任意项目配置。
  const projects = await listL4PiDirectorySummaries(true)
  for (const { cwd } of projects) {
    const settings = readJsonRecord(join(cwd, CONFIG_DIR_NAME, 'settings.json'))
    if (
      typeof settings.defaultProvider === 'string' &&
      typeof settings.defaultModel === 'string' &&
      removed.has(collectedModelKey(settings.defaultProvider, settings.defaultModel))
    ) {
      throw new Error(
        `项目“${cwd}”仍将 ${settings.defaultProvider}/${settings.defaultModel} 设为默认模型，请先在“项目默认”中调整`
      )
    }
  }
}

export async function readL4ModelSettings(): Promise<{
  providers: L4ModelProviderConfig[]
  presets: L4ModelPreset[]
  models: L4ModelOption[]
  nativeConfig: L4ModelNativeConfig
  accountModels: L4AccountModelSelection[]
  accounts: L4ModelAccount[]
}> {
  const started = performance.now()
  const rawRoot = readJsonRecord(modelsPath())
  const runtime = await ModelRuntime.create({ allowModelNetwork: false })
  const defaults = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
  const accountModels = readAccountModelSelections(rawRoot)
  const runtimeReady = performance.now()
  const result = {
    providers: normalizeProviders(rawRoot, runtime),
    presets: normalizePresets(rawRoot),
    models: await availableModelOptions(runtime, undefined, rawRoot),
    nativeConfig: rawRoot as L4ModelNativeConfig,
    accountModels,
    accounts: await readAccounts(defaults, accountModels)
  }
  const elapsed = performance.now() - started
  if (elapsed > 500) {
    console.warn('[Pi Desk][ModelSettings] 读取模型配置耗时较长', {
      totalMs: Math.round(elapsed),
      runtimeMs: Math.round(runtimeReady - started),
      projectionMs: Math.round(performance.now() - runtimeReady),
      providers: result.providers.length,
      models: result.models.length
    })
  }
  return result
}

export async function replaceL4ModelSettings(input: L4ModelSettingsReplaceInput): Promise<void> {
  await serializeWrite(async () => {
    const path = modelsPath()
    try {
      let current: JsonRecord
      try {
        current = readJsonRecord(path)
      } catch (error) {
        if (input.nativeConfig === undefined) throw error
        // 原生编辑是损坏配置的修复入口，不能要求旧文件先成功解析。
        current = {}
      }
      let candidate: JsonRecord
      if (input.nativeConfig !== undefined) {
        candidate = input.nativeConfig
      } else {
        const currentRuntime = await ModelRuntime.create({ allowModelNetwork: false })
        const error = currentRuntime.getError()
        if (error) throw new Error(`当前模型配置不可用，请先通过原生配置修正：${error}`)
        const defaults =
          input.accountModels === undefined
            ? currentRuntime
            : await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
        candidate = mergeModelsRoot(current, input, currentRuntime, defaults)
      }
      const runtime = await validateModelsRoot(candidate)
      const models = await availableModelOptions(runtime, undefined, candidate)
      await assertConnectionCredentials(current, candidate, runtime)
      await assertRemovalReferences(current, candidate)
      assertPresetsValid(normalizePresets(candidate), models, normalizePresets(current))
      writeJsonRecordAtomic(path, candidate)
    } catch (cause) {
      console.error('[Pi Desk][ModelSettings] 模型配置保存失败', {
        message: cause instanceof Error ? cause.message : String(cause)
      })
      throw new Error(
        `模型配置保存失败：${cause instanceof Error ? cause.message : String(cause)}`,
        {
          cause
        }
      )
    }
  })
}

function resolveProjectCwd(cwd: string): string {
  const resolved = resolve(cwd)
  if (!isAbsolute(resolved) || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error('项目目录不存在')
  }
  return resolved
}

function projectSettingsPath(cwd: string): string {
  return join(resolveProjectCwd(cwd), CONFIG_DIR_NAME, 'settings.json')
}

export async function readL4ProjectModelDefault(cwd: string): Promise<{
  cwd: string
  default: L4ModelSelection | null
  models: L4ModelOption[]
}> {
  const resolvedCwd = resolveProjectCwd(cwd)
  const path = projectSettingsPath(resolvedCwd)
  const projectSettings = readJsonRecord(path)
  const runtime = await ModelRuntime.create({ allowModelNetwork: false })
  const models = await availableModelOptions(runtime, resolvedCwd)
  const hasProjectDefault = ['defaultProvider', 'defaultModel', 'defaultThinkingLevel'].some(
    (key) => Object.hasOwn(projectSettings, key)
  )
  if (!hasProjectDefault) return { cwd: resolvedCwd, default: null, models }

  const mergedSettings = SettingsManager.create(resolvedCwd, getAgentDir())
  const provider = mergedSettings.getDefaultProvider()
  const modelId = mergedSettings.getDefaultModel()
  const thinkingLevel = mergedSettings.getDefaultThinkingLevel()
  const option = models.find((model) => model.provider === provider && model.modelId === modelId)
  const selection =
    provider && modelId && thinkingLevel && option?.thinkingLevels.includes(thinkingLevel)
      ? { provider, modelId, thinkingLevel }
      : null
  return { cwd: resolvedCwd, default: selection, models }
}

export async function replaceL4ProjectModelDefault(
  cwd: string,
  selection: L4ModelSelection | null
): Promise<void> {
  await serializeWrite(async () => {
    const resolvedCwd = resolveProjectCwd(cwd)
    if (selection) {
      const runtime = await ModelRuntime.create({ allowModelNetwork: false })
      const models = await availableModelOptions(runtime, resolvedCwd)
      const option = models.find(
        (model) => model.provider === selection.provider && model.modelId === selection.modelId
      )
      if (!option || !option.thinkingLevels.includes(selection.thinkingLevel)) {
        throw new Error('项目默认模型或思考等级不可用')
      }
    }

    const path = projectSettingsPath(resolvedCwd)
    const settings = readJsonRecord(path)
    if (selection) {
      settings.defaultProvider = selection.provider
      settings.defaultModel = selection.modelId
      settings.defaultThinkingLevel = selection.thinkingLevel
    } else {
      delete settings.defaultProvider
      delete settings.defaultModel
      delete settings.defaultThinkingLevel
    }
    writeJsonRecordAtomic(path, settings)
  })
}
