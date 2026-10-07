import { randomUUID } from 'node:crypto'
import type { PiDeskPluginFacade, PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import { z } from 'zod'
import { QuotaHttpError } from './adapters/http.js'
import { quotaAdapters } from './adapters/registry.js'
import { errorMessage, normalizedLineText } from './adapters/resources.js'
import type { QuotaAdapter } from './adapters/types.js'
import { QuotaDisplaySettingsSchema } from './l2-quota-display-schema.js'
import type {
  QuotaResource,
  QuotaSettingsSnapshot,
  QuotaSnapshot,
  QuotaSourceSnapshot
} from './protocol.js'

import {
  defaultQuotaViewerConfigPath,
  MAX_SOURCES,
  normalizeHiddenItems,
  PLUGIN_IDENTIFIER_PATTERN,
  readStoredConfig,
  storedConfigSchema,
  writeStoredConfig,
  type StoredConfig,
  type StoredSource
} from './l2-quota-config.js'

export { defaultQuotaViewerConfigPath } from './l2-quota-config.js'

const saveSourceSchema = z
  .object({
    sourceId: z.string().uuid().optional(),
    adapter: z.string().regex(PLUGIN_IDENTIFIER_PATTERN),
    name: z.string().trim().min(1, '来源名称不能为空').max(100),
    enabled: z.boolean(),
    values: z.record(z.string(), z.string())
  })
  .strict()

const saveInputSchema = z
  .object({
    sources: z
      .array(saveSourceSchema)
      .max(MAX_SOURCES, `额度来源不能超过 ${MAX_SOURCES} 个`)
      .optional(),
    display: z
      .object({
        resetTimeFormat: QuotaDisplaySettingsSchema.shape.resetTimeFormat
          .removeDefault()
          .optional(),
        hiddenItemKeys: QuotaDisplaySettingsSchema.shape.hiddenItemKeys.removeDefault().optional()
      })
      .strict()
      .refine(
        (value) => value.resetTimeFormat !== undefined || value.hiddenItemKeys !== undefined,
        '至少需要提供一项显示设置'
      )
      .optional()
  })
  .strict()
  .refine(
    (value) => value.sources !== undefined || value.display !== undefined,
    '至少需要提供一项设置'
  )

interface SourceRuntimeState {
  source: StoredSource
  readonly adapter: QuotaAdapter
  readonly snapshot: QuotaSourceSnapshot
  generation: number
  controller: AbortController | null
  inFlight: Promise<void> | null
  lastAttemptAt: number | null
  blockedUntil: number
}

interface RuntimeLogger {
  info(message: string): void
  warn(message: string): void
}

export interface QuotaViewerRuntimeOptions {
  adapters?: readonly QuotaAdapter[]
  fetch?: typeof fetch
  configPath?: string
  logger?: RuntimeLogger
}

function jsonObject(value: unknown): PluginJsonObject {
  return JSON.parse(JSON.stringify(value)) as PluginJsonObject
}

function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return '配置格式无效'
  const path = issue.path.length > 0 ? `${issue.path.join('.')}：` : ''
  return `${path}${issue.message}`
}

function inputError(error: unknown): PluginMethodError {
  if (error instanceof PluginMethodError) return error
  if (error instanceof z.ZodError) return new PluginMethodError(400, zodMessage(error))
  return new PluginMethodError(400, errorMessage(error))
}

function validateResources(resources: readonly QuotaResource[]): void {
  const keys = new Set<string>()
  for (const resource of resources) {
    if (!resource.key.trim()) throw new Error('Adapter 返回了空 resource key')
    if (keys.has(resource.key)) throw new Error(`Adapter 返回了重复 resource key：${resource.key}`)
    keys.add(resource.key)
    const values =
      resource.kind === 'balance'
        ? [resource.available]
        : [resource.values.limit, resource.values.used, resource.values.remaining]
    for (const value of values) {
      if (value.state === 'known' && !Number.isFinite(value.value)) {
        throw new Error(`Adapter 返回了无效数值：${resource.key}`)
      }
    }
  }
}

function cloneResources(resources: readonly QuotaResource[]): QuotaResource[] {
  return structuredClone(resources) as QuotaResource[]
}

function sameSourceConfig(left: StoredSource, right: StoredSource): boolean {
  const keys = Object.keys(left.config)
  return (
    left.adapter === right.adapter &&
    keys.length === Object.keys(right.config).length &&
    keys.every((key) => left.config[key] === right.config[key])
  )
}

export class QuotaViewerRuntime {
  private readonly adapters: readonly QuotaAdapter[]
  private readonly registry: ReadonlyMap<string, QuotaAdapter>
  private readonly fetchImpl: typeof fetch
  private readonly configPath: string
  private readonly logger: RuntimeLogger
  private readonly states = new Map<string, SourceRuntimeState>()
  private readonly tasks = new Set<Promise<void>>()
  private config: StoredConfig = { sources: [], display: QuotaDisplaySettingsSchema.parse({}) }
  private saveQueue: Promise<unknown> = Promise.resolve()
  private configLoaded = false
  private configError: string | null = null
  private disposed = false

  constructor(
    private readonly plugin: Pick<PiDeskPluginFacade, 'pushGlobal'>,
    options: QuotaViewerRuntimeOptions = {}
  ) {
    this.adapters = options.adapters ?? quotaAdapters
    this.registry = new Map(
      this.adapters.map((adapter) => [adapter.descriptor.adapter, adapter] as const)
    )
    if (this.registry.size !== this.adapters.length) {
      throw new Error('额度 Adapter 名称重复')
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.configPath = options.configPath ?? defaultQuotaViewerConfigPath()
    this.logger = options.logger ?? console
  }

  async query(force: boolean): Promise<QuotaSnapshot> {
    this.assertActive()
    await this.ensureConfig()
    this.reconcileStates()
    if (!this.configError) {
      for (const source of this.enabledSources()) this.startRefresh(source.sourceId, force)
    }
    return this.snapshot()
  }

  async settings(): Promise<QuotaSettingsSnapshot> {
    this.assertActive()
    await this.ensureConfig()
    return this.settingsSnapshot()
  }

  async saveSettings(input: PluginJsonObject): Promise<QuotaSettingsSnapshot> {
    const task = this.saveQueue.then(() => this.saveConfiguration(input))
    this.saveQueue = task.catch(() => undefined)
    return task
  }

  private async saveConfiguration(input: PluginJsonObject): Promise<QuotaSettingsSnapshot> {
    this.assertActive()
    await this.ensureConfig()
    let parsed: z.infer<typeof saveInputSchema>
    try {
      parsed = saveInputSchema.parse(input)
    } catch (error) {
      throw inputError(error)
    }

    const sourcesChanged = parsed.sources !== undefined
    let nextSources = this.config.sources
    if (parsed.sources !== undefined) {
      const existingById = new Map(this.config.sources.map((source) => [source.sourceId, source]))
      const seenIds = new Set<string>()
      nextSources = []
      for (const source of parsed.sources) {
        const adapter = this.registry.get(source.adapter)
        if (!adapter) throw new PluginMethodError(400, `额度 Adapter 不存在：${source.adapter}`)
        const existing = source.sourceId ? existingById.get(source.sourceId) : undefined
        if (source.sourceId && !existing) {
          throw new PluginMethodError(400, `额度来源不存在：${source.sourceId}`)
        }
        if (existing && existing.adapter !== source.adapter) {
          throw new PluginMethodError(400, '已有额度来源不能切换 Adapter，请删除后重新添加')
        }
        if (source.sourceId && seenIds.has(source.sourceId)) {
          throw new PluginMethodError(400, `额度来源 sourceId 重复：${source.sourceId}`)
        }
        if (source.sourceId) seenIds.add(source.sourceId)

        const fields = new Map(adapter.descriptor.fields.map((field) => [field.key, field]))
        for (const key of Object.keys(source.values)) {
          if (!fields.has(key)) throw new PluginMethodError(400, `未知设置字段：${key}`)
        }
        const candidate: Record<string, string> = {}
        for (const field of adapter.descriptor.fields) {
          const supplied = Object.hasOwn(source.values, field.key)
            ? source.values[field.key]
            : field.defaultValue
          let value = supplied ?? ''
          if (field.kind === 'textarea') value = normalizedLineText(value)
          candidate[field.key] = value
        }

        let config: Record<string, string>
        try {
          config = adapter.validateConfig(candidate)
        } catch (error) {
          throw inputError(error)
        }
        nextSources.push({
          sourceId: existing?.sourceId ?? randomUUID(),
          adapter: source.adapter,
          name: source.name,
          enabled: source.enabled,
          config
        })
      }
    }

    const nextConfig = storedConfigSchema.parse({
      sources: nextSources,
      display: {
        resetTimeFormat: parsed.display?.resetTimeFormat ?? this.config.display.resetTimeFormat,
        hiddenItemKeys: normalizeHiddenItems(
          parsed.display?.hiddenItemKeys ?? this.config.display.hiddenItemKeys,
          this.registry
        )
      }
    })
    await writeStoredConfig(this.configPath, nextConfig)
    this.config = nextConfig
    this.configLoaded = true
    this.configError = null
    const refreshSourceIds = sourcesChanged ? this.reconcileStates() : []
    this.publishState()
    for (const sourceId of refreshSourceIds) this.startRefresh(sourceId, true)
    return this.settingsSnapshot()
  }

  snapshot(): QuotaSnapshot {
    const sources = this.enabledSources().flatMap((source) => {
      const state = this.states.get(source.sourceId)
      return state ? [structuredClone(state.snapshot) as QuotaSourceSnapshot] : []
    })
    return {
      error: this.configError,
      sources,
      display: structuredClone(this.config.display)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const state of this.states.values()) {
      state.generation += 1
      state.controller?.abort('plugin-disposed')
    }
    await Promise.allSettled([...this.tasks])
    this.states.clear()
    this.tasks.clear()
  }

  private assertActive(): void {
    if (this.disposed) throw new PluginMethodError(409, '额度查看器 Runtime 已关闭')
  }

  private async ensureConfig(): Promise<void> {
    if (this.configLoaded) return
    try {
      this.config = await readStoredConfig(this.configPath, this.registry)
      this.configError = null
    } catch (error) {
      this.config = { sources: [], display: QuotaDisplaySettingsSchema.parse({}) }
      this.configError = errorMessage(error)
    }
    this.configLoaded = true
  }

  private enabledSources(): StoredSource[] {
    return this.config.sources.filter((source) => source.enabled)
  }

  private settingsSnapshot(): QuotaSettingsSnapshot {
    return {
      error: this.configError,
      adapters: structuredClone(this.adapters.map((adapter) => adapter.descriptor)),
      sources: this.config.sources.flatMap((source) => {
        const adapter = this.registry.get(source.adapter)
        if (!adapter) return []
        const values = Object.fromEntries(
          adapter.descriptor.fields.map((field) => [
            field.key,
            source.config[field.key] ?? field.defaultValue ?? ''
          ])
        )
        return [
          {
            sourceId: source.sourceId,
            adapter: source.adapter,
            name: source.name,
            enabled: source.enabled,
            values
          }
        ]
      }),
      display: structuredClone(this.config.display)
    }
  }

  private reconcileStates(): string[] {
    const enabledById = new Map(this.enabledSources().map((source) => [source.sourceId, source]))
    const replaced = new Map<string, SourceRuntimeState>()
    for (const [sourceId, state] of this.states) {
      const source = enabledById.get(sourceId)
      if (!source || !sameSourceConfig(state.source, source)) {
        state.generation += 1
        state.controller?.abort(source ? 'configuration-changed' : 'source-disabled-or-removed')
        this.states.delete(sourceId)
        if (source) replaced.set(sourceId, state)
        continue
      }
      state.source = source
      state.snapshot.name = source.name
    }
    const refreshSourceIds: string[] = []
    for (const source of enabledById.values()) {
      if (this.states.has(source.sourceId)) continue
      const adapter = this.registry.get(source.adapter)
      if (!adapter) continue
      const previous = replaced.get(source.sourceId)
      this.states.set(source.sourceId, {
        source,
        adapter,
        generation: 0,
        controller: null,
        inFlight: null,
        lastAttemptAt: previous?.lastAttemptAt ?? null,
        blockedUntil: previous?.blockedUntil ?? 0,
        snapshot: {
          sourceId: source.sourceId,
          adapter: source.adapter,
          adapterLabel: adapter.descriptor.label,
          name: source.name,
          dataSource: adapter.descriptor.dataSource,
          refreshing: false,
          observedAt: null,
          staleAt: null,
          error: null,
          resources: []
        }
      })
      refreshSourceIds.push(source.sourceId)
    }
    return refreshSourceIds
  }

  private startRefresh(sourceId: string, force: boolean): void {
    const state = this.states.get(sourceId)
    if (!state || this.disposed || state.inFlight) return
    const now = Date.now()
    if (!force && state.snapshot.staleAt !== null && now < state.snapshot.staleAt) return
    if (
      state.lastAttemptAt !== null &&
      now - state.lastAttemptAt < state.adapter.minRefreshIntervalMs
    ) {
      return
    }
    if (now < state.blockedUntil) return

    state.lastAttemptAt = now
    state.generation += 1
    const generation = state.generation
    const controller = new AbortController()
    state.controller = controller
    state.snapshot.refreshing = true
    state.snapshot.error = null
    this.publishState()

    const task = this.refreshSource(state, generation, controller, now)
    state.inFlight = task
    this.tasks.add(task)
    void task.finally(() => {
      this.tasks.delete(task)
      if (state.inFlight === task) state.inFlight = null
    })
  }

  private async refreshSource(
    state: SourceRuntimeState,
    generation: number,
    controller: AbortController,
    startedAt: number
  ): Promise<void> {
    const timeout = setTimeout(() => {
      controller.abort(new Error(`请求超时（${Math.ceil(state.adapter.timeoutMs / 1000)} 秒）`))
    }, state.adapter.timeoutMs)
    this.logger.info(
      `[quota-viewer] source=${state.source.sourceId} adapter=${state.source.adapter} stage=start`
    )
    try {
      const result = await state.adapter.load({
        config: state.source.config,
        signal: controller.signal,
        fetch: this.fetchImpl,
        now: startedAt
      })
      validateResources(result.resources)
      if (!this.isCurrent(state, generation)) return
      const observedAt = Date.now()
      state.snapshot.resources = cloneResources(result.resources)
      state.snapshot.observedAt = observedAt
      state.snapshot.staleAt = observedAt + state.adapter.cacheTtlMs
      state.snapshot.error = result.warning
      state.blockedUntil = result.retryAt ?? 0
      const stage = result.warning ? 'warning' : 'success'
      this.logger.info(
        `[quota-viewer] source=${state.source.sourceId} adapter=${state.source.adapter} stage=${stage} elapsedMs=${observedAt - startedAt} resources=${result.resources.length}`
      )
    } catch (error) {
      if (!this.isCurrent(state, generation)) return
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof Error) state.snapshot.error = reason.message
      } else {
        state.snapshot.error = errorMessage(error)
        if (error instanceof QuotaHttpError && error.status === 429) {
          state.blockedUntil = error.retryAt ?? Date.now() + state.adapter.minRefreshIntervalMs
        }
      }
      this.logger.warn(
        `[quota-viewer] source=${state.source.sourceId} adapter=${state.source.adapter} stage=error elapsedMs=${Date.now() - startedAt} resources=${state.snapshot.resources.length}`
      )
    } finally {
      clearTimeout(timeout)
      if (this.isCurrent(state, generation)) {
        state.controller = null
        state.snapshot.refreshing = false
        this.publishState()
      }
    }
  }

  private isCurrent(state: SourceRuntimeState, generation: number): boolean {
    return (
      !this.disposed &&
      this.states.get(state.source.sourceId) === state &&
      state.generation === generation
    )
  }

  private publishState(): void {
    if (!this.disposed) this.plugin.pushGlobal('state', jsonObject(this.snapshot()))
  }
}
