import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { HostSettings } from '@jetcrab/pi-desk-sdk/settings'
import { readFile, stat } from 'node:fs/promises'
import { basename, join, isAbsolute, relative, resolve } from 'node:path'
import type {
  GlobalPluginAPI,
  GlobalPluginFacade,
  GlobalPluginFactory,
  GlobalPluginMethodHandler,
  PiDeskPluginDefinition,
  PiDeskPluginFacade,
  PiDeskPluginHost,
  PluginNotificationChanges,
  PluginNotificationPublishInput,
  PluginCapabilityLoader,
  PiDeskPluginLifecycle,
  PiDeskPluginSetupResult,
  PluginDisposer,
  PluginJsonObject,
  PluginMessageDeclaration,
  PluginPushMessage,
  PluginSource,
  PluginWorkSession
} from '@jetcrab/pi-desk-sdk/entry'
import { z } from 'zod'
import {
  CapabilityDeclarationsSchema,
  type CapabilityDeclarations
} from '@jetcrab/pi-desk-sdk/capabilities'
import { clearL4PiPluginCodeCache, loadL4PiDeskPluginEntry } from './l4-pi-plugin-module-loader'
import {
  captureL4PiBrowserModules,
  type L4PiBrowserModuleSnapshot
} from './l4-pi-plugin-browser-snapshot'
import {
  L4PiPluginMethodConflictError,
  L4PiPluginMethodNotFoundError,
  l4PiPluginMethodKey,
  parseL4PiPluginMethodData,
  parseL4PiPluginMethodName,
  parseL4PiPluginName
} from './l4-pi-plugin-method-runtime-core'

const L4_PLUGIN_PUSH_MAX_JSON_BYTES = 64 * 1024
const L4_PLUGIN_LIFECYCLE_TIMEOUT_MS = 1_500
const L4_PLUGIN_LOAD_TIMEOUT_MS = 15_000
const L4_PLUGIN_BROWSER_TOTAL_BYTES = 128 * 1024 * 1024
const L4PiPluginPushDataSchema = z.record(z.string(), z.json())
const L4PiSourceSchema = z
  .object({
    workId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    branchId: z.string().trim().min(1)
  })
  .strict()
const L4PiWorkSessionSchema = z
  .object({
    source: L4PiSourceSchema,
    cwd: z.string().trim().min(1),
    status: z.enum(['main_running', 'background_running', 'completed', 'idle'])
  })
  .strict()
const L4PiDeclarationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const L4PiPrioritySchema = z.number().int().safe()

export interface L4PiResolvedBrowserEntry {
  pluginName: string
  entryPath: string
  resourceKey: string
  snapshot: L4PiBrowserModuleSnapshot
}

export interface L4PiMessageDeclarationRegistration {
  pluginName: string
  declarationName: string
  declaration: PluginMessageDeclaration
}

export type L4PiPluginPushSender = (message: PluginPushMessage) => void
export type L4PiWorkSessionProvider = () => Promise<readonly PluginWorkSession[]>

export interface L4PiPluginAppRuntimeSink {
  setState(pluginName: string, state: PluginJsonObject | null): void
  publishNotification(pluginName: string, input: PluginNotificationPublishInput): string
  updateNotification(
    pluginName: string,
    notificationId: string,
    changes: PluginNotificationChanges
  ): void
  deleteNotification(pluginName: string, notificationId: string): void
  releasePlugin(pluginName: string): void
}

export interface L4PiPluginPackageSource {
  source: string
  installedPath: string
}

export type L4PiPluginPackageProvider = () => Promise<readonly L4PiPluginPackageSource[]>

export type L4PiPluginDiagnosticPhase = 'package' | 'entry' | 'setup' | 'resources'

export interface L4PiPluginDiagnosticError {
  phase: L4PiPluginDiagnosticPhase
  message: string
}

export interface L4PiPluginPackageDiagnostic {
  source: string
  packageName: string | null
  version: string | null
  pluginName: string | null
  status: 'ready' | 'failed'
  error: L4PiPluginDiagnosticError | null
}

export interface L4PiPluginRuntimeDiagnostics {
  packages: readonly L4PiPluginPackageDiagnostic[]
  loadError: string | null
}

export interface L4PiPluginCapabilityRegistration {
  source: string
  methods: ReadonlyArray<{ pluginName: string; method: string }>
  browserEntries: ReadonlyArray<{ pluginName: string }>
  messageDeclarations: ReadonlyArray<{
    pluginName: string
    declarationName: string
    priority: number
  }>
}

export class L4PiPluginRuntimeBusyError extends Error {
  constructor() {
    super('插件运行时仍有调用正在执行')
    this.name = 'L4PiPluginRuntimeBusyError'
  }
}

class L4PiPluginPhaseError extends Error {
  constructor(
    readonly phase: L4PiPluginDiagnosticPhase,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'L4PiPluginPhaseError'
  }
}

interface L4PiPluginOwner {
  source: string
  packageName: string | null
  version: string | null
  packageRoot: string
  active: boolean
  draining: boolean
  pluginNames: Set<string>
  activeCalls: Set<AbortController>
  subscriptions: Set<PluginDisposer>
  beforeReload: PiDeskPluginLifecycle['beforeReload'] | null
  disposer: PluginDisposer | null
}

interface L4PiGlobalPluginRegistration {
  pluginName: string
  method: string
  execute: GlobalPluginMethodHandler
  owner: L4PiPluginOwner
}

interface L4PiCapabilityLoaderRegistration {
  load: PluginCapabilityLoader
  owner: L4PiPluginOwner
}

interface L4PiBrowserEntryRegistration {
  pluginName: string
  entryPath: string
  resourceKey: string
  snapshot: L4PiBrowserModuleSnapshot | null
  owner: L4PiPluginOwner
}

interface L4PiDeclarationRegistration extends L4PiMessageDeclarationRegistration {
  owner: L4PiPluginOwner
}

interface L4PiDeskPackageManifest {
  name?: unknown
  version?: unknown
  piDesk?: {
    entry?: unknown
    global?: unknown
  }
}

function packageEntryPath(packageRoot: string, entryInput: unknown, field: string): string {
  if (typeof entryInput !== 'string' || !entryInput.trim()) {
    throw new Error(`package.json.${field} must be a non-empty string`)
  }
  const entry = resolve(packageRoot, entryInput)
  const relativeEntry = relative(packageRoot, entry)
  if (relativeEntry.startsWith('..') || isAbsolute(relativeEntry)) {
    throw new Error(`package.json.${field} must stay inside the package root`)
  }
  return entry
}

function declarationKey(pluginName: string, declarationName: string): string {
  return `${pluginName}\u0000${declarationName}`
}

function parseContributionName(value: unknown): string {
  return L4PiDeclarationNameSchema.parse(value)
}

function parsePriority(value: unknown): number {
  return L4PiPrioritySchema.parse(value)
}

function parseSource(value: unknown): PluginSource {
  return L4PiSourceSchema.parse(value)
}

function parsePushData(value: unknown): PluginJsonObject {
  const data = L4PiPluginPushDataSchema.parse(value) as PluginJsonObject
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > L4_PLUGIN_PUSH_MAX_JSON_BYTES) {
    throw new Error('Plugin Push data exceeds 64KB')
  }
  return data
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function normalizeSetupResult(result: PiDeskPluginSetupResult): {
  beforeReload: PiDeskPluginLifecycle['beforeReload'] | null
  disposer: PluginDisposer | null
} {
  if (result === undefined) return { beforeReload: null, disposer: null }
  if (typeof result === 'function') return { beforeReload: null, disposer: result }
  if (!result || typeof result !== 'object') {
    throw new Error('Pi Desk Plugin setup must return void, a disposer, or a lifecycle object')
  }
  if (result.beforeReload !== undefined && typeof result.beforeReload !== 'function') {
    throw new Error('Pi Desk Plugin lifecycle.beforeReload must be a function')
  }
  if (result.dispose !== undefined && typeof result.dispose !== 'function') {
    throw new Error('Pi Desk Plugin lifecycle.dispose must be a function')
  }
  return {
    beforeReload: result.beforeReload ?? null,
    disposer: result.dispose ?? null
  }
}

async function runLifecycleWithTimeout(input: {
  owner: L4PiPluginOwner
  phase: 'beforeReload' | 'dispose'
  execute: () => void | Promise<void>
  onTimeout?: () => void
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutMs = L4_PLUGIN_LIFECYCLE_TIMEOUT_MS
  try {
    const completed = await Promise.race([
      Promise.resolve()
        .then(input.execute)
        .then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      })
    ])
    if (completed) return
    input.onTimeout?.()
    throw new Error(`插件 ${input.phase} 超时，关闭结果未确认`)
  } catch (error) {
    console.warn('[Pi Desk][GlobalPluginRuntime] Pi Desk Plugin 生命周期执行失败', {
      source: input.owner.source,
      packageName: input.owner.packageName,
      phase: input.phase,
      timeoutMs,
      message: errorMessage(error)
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class L4PiPluginOwnerRuntime {
  private readonly methods = new Map<string, L4PiGlobalPluginRegistration>()
  private readonly pluginOwners = new Map<string, L4PiPluginOwner>()
  private readonly browserEntries = new Map<string, L4PiBrowserEntryRegistration>()
  private readonly declarations = new Map<string, L4PiDeclarationRegistration>()
  private readonly capabilityLoaders = new Map<string, L4PiCapabilityLoaderRegistration>()
  private readonly owners: L4PiPluginOwner[] = []
  private readonly loadingOwners = new Set<L4PiPluginOwner>()
  private readonly changeListeners = new Set<() => void>()
  private readonly changingSources = new Set<string>()
  private readonly maintainingSources = new Set<string>()
  private readonly lifetime = new AbortController()
  private readonly packageDiagnostics = new Map<string, L4PiPluginPackageDiagnostic>()
  private initializePromise: Promise<void> | null = null
  private initialized = false
  private disposed = false
  private acceptingCalls = true
  private loadError: string | null = null
  private workSessionProvider: L4PiWorkSessionProvider | null = null
  private pushSender: L4PiPluginPushSender | null = null
  private appRuntimeSink: L4PiPluginAppRuntimeSink | null = null

  constructor(
    private readonly packageProvider: L4PiPluginPackageProvider,
    private readonly hostSettings?: HostSettings
  ) {}

  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Global plugin runtime has been disposed'))
    if (this.initialized) return Promise.resolve()
    if (this.initializePromise) return this.initializePromise

    this.initializePromise = this.loadConfiguredPackages()
      .catch((error: unknown) => {
        this.loadError = errorMessage(error)
        console.error('[Pi Desk][GlobalPluginRuntime] 读取插件配置失败，核心应用继续启动', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          message: this.loadError
        })
      })
      .finally(() => {
        this.initializePromise = null
        this.initialized = true
        this.publishChanges()
      })
    return this.initializePromise
  }

  subscribeChanges(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private publishChanges(): void {
    if (this.disposed) return
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch (error) {
        console.warn('[Pi Desk][GlobalPluginRuntime] 状态监听失败', {
          message: errorMessage(error)
        })
      }
    }
  }

  async withSourceIdle<T>(
    source: string,
    operation: () => Promise<T>,
    signal: AbortSignal,
    onWaiting: (reason: string) => void
  ): Promise<T> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    lifetime.throwIfAborted()
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = (): void => reject(lifetime.reason)
      lifetime.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([this.initialize(), aborted])
    } finally {
      lifetime.removeEventListener('abort', onAbort)
    }
    lifetime.throwIfAborted()
    if (
      !this.acceptingCalls ||
      this.changingSources.has(source) ||
      this.maintainingSources.has(source)
    ) {
      throw new L4PiPluginRuntimeBusyError()
    }
    this.maintainingSources.add(source)
    try {
      while (this.owners.some((owner) => owner.source === source && owner.activeCalls.size > 0)) {
        onWaiting(`插件 ${source} 仍有调用正在执行`)
        await delay(250, undefined, { signal: lifetime })
      }
      lifetime.throwIfAborted()
      return await operation()
    } finally {
      this.maintainingSources.delete(source)
    }
  }

  async replaceSource(source: string, installedPath: string | null): Promise<void> {
    await this.initialize()
    if (this.disposed || !this.acceptingCalls || this.changingSources.has(source)) {
      throw new L4PiPluginRuntimeBusyError()
    }
    const owner = this.owners.find((item) => item.source === source)

    this.changingSources.add(source)
    try {
      if (owner) void this.releaseOwner(owner)
      if (this.disposed) throw new Error('Global plugin runtime has been disposed')
      clearL4PiPluginCodeCache()
      this.packageDiagnostics.delete(source)
      if (installedPath !== null) {
        await this.loadPackage(source, installedPath)
        if (this.disposed) throw new Error('Global plugin runtime has been disposed')
        const diagnostic = this.packageDiagnostics.get(source)
        if (diagnostic?.status === 'failed')
          throw new Error(diagnostic.error?.message ?? '插件加载失败')
      }
    } finally {
      this.changingSources.delete(source)
      this.publishChanges()
    }
  }

  private ownerPublished(owner: L4PiPluginOwner): boolean {
    return (
      owner.active &&
      !owner.draining &&
      !this.changingSources.has(owner.source) &&
      this.owners.includes(owner)
    )
  }

  readDiagnostics(): L4PiPluginRuntimeDiagnostics {
    return {
      packages: [...this.packageDiagnostics.values()]
        .sort((left, right) => left.source.localeCompare(right.source))
        .map((diagnostic) => structuredClone(diagnostic)),
      loadError: this.loadError
    }
  }

  readCapabilityRegistrations(): readonly L4PiPluginCapabilityRegistration[] {
    return [...this.owners]
      .filter((owner) => this.ownerPublished(owner))
      .sort((left, right) => left.source.localeCompare(right.source))
      .map((owner) => ({
        source: owner.source,
        methods: [...this.methods.values()]
          .filter((registration) => registration.owner === owner)
          .sort((left, right) => {
            const plugin = left.pluginName.localeCompare(right.pluginName)
            return plugin === 0 ? left.method.localeCompare(right.method) : plugin
          })
          .map(({ pluginName, method }) => ({ pluginName, method })),
        browserEntries: [...this.browserEntries.values()]
          .filter((registration) => registration.owner === owner)
          .sort((left, right) => left.pluginName.localeCompare(right.pluginName))
          .map(({ pluginName }) => ({ pluginName })),
        messageDeclarations: [...this.declarations.values()]
          .filter((registration) => registration.owner === owner)
          .sort((left, right) => {
            const plugin = left.pluginName.localeCompare(right.pluginName)
            return plugin === 0 ? left.declarationName.localeCompare(right.declarationName) : plugin
          })
          .map(({ pluginName, declarationName, declaration }) => ({
            pluginName,
            declarationName,
            priority: declaration.priority
          }))
      }))
  }

  async prepareReload(): Promise<void> {
    await this.initialize()
    if (this.disposed) throw new Error('Global plugin runtime has been disposed')
    if (
      !this.acceptingCalls ||
      this.changingSources.size > 0 ||
      this.maintainingSources.size > 0 ||
      this.owners.some((owner) => owner.activeCalls.size > 0)
    ) {
      throw new L4PiPluginRuntimeBusyError()
    }

    this.acceptingCalls = false
    for (const owner of this.owners) owner.draining = true
    await Promise.all(
      [...this.owners].reverse().map(async (owner) => {
        const beforeReload = owner.beforeReload
        if (!beforeReload) return
        owner.beforeReload = null
        const controller = new AbortController()
        await runLifecycleWithTimeout({
          owner,
          phase: 'beforeReload',
          execute: () => beforeReload({ signal: controller.signal }),
          onTimeout: () => controller.abort()
        })
      })
    )
  }

  bindWorkSessionProvider(provider: L4PiWorkSessionProvider): () => void {
    if (this.disposed) throw new Error('Global plugin runtime has been disposed')
    this.workSessionProvider = provider
    return (): void => {
      if (this.workSessionProvider === provider) this.workSessionProvider = null
    }
  }

  bindPushSender(sender: L4PiPluginPushSender): () => void {
    if (this.disposed) throw new Error('Global plugin runtime has been disposed')
    this.pushSender = sender
    return (): void => {
      if (this.pushSender === sender) this.pushSender = null
    }
  }

  bindAppRuntimeSink(sink: L4PiPluginAppRuntimeSink): () => void {
    if (this.disposed) throw new Error('Global plugin runtime has been disposed')
    this.appRuntimeSink = sink
    return (): void => {
      if (this.appRuntimeSink === sink) this.appRuntimeSink = null
    }
  }

  private async runOwnedCall<T>(
    owner: L4PiPluginOwner,
    execute: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    this.ensureOwnerActive(owner)
    if (this.maintainingSources.has(owner.source)) throw new L4PiPluginRuntimeBusyError()
    const controller = new AbortController()
    let rejectCanceled!: (error: Error) => void
    const canceled = new Promise<never>((_, reject) => {
      rejectCanceled = reject
    })
    const onAbort = (): void => {
      // AbortSignal 通知插件自行停止；宿主不能依赖插件响应中止才结束调用。
      rejectCanceled(new Error('Pi Desk Plugin owner is no longer active'))
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    owner.activeCalls.add(controller)
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          this.ensureOwnerActive(owner)
          return execute(controller.signal)
        }),
        canceled
      ])
      this.ensureOwnerActive(owner)
      return result
    } finally {
      owner.activeCalls.delete(controller)
      controller.signal.removeEventListener('abort', onAbort)
    }
  }

  async invoke(
    pluginNameInput: string,
    methodInput: string,
    input: unknown
  ): Promise<PluginJsonObject> {
    await this.initialize()
    if (this.disposed) throw new Error('Global plugin runtime has been disposed')
    if (!this.acceptingCalls) throw new L4PiPluginRuntimeBusyError()

    const pluginName = parseL4PiPluginName(pluginNameInput)
    const method = parseL4PiPluginMethodName(methodInput)
    const registration = this.methods.get(l4PiPluginMethodKey(pluginName, method))
    if (!registration) throw new L4PiPluginMethodNotFoundError(pluginName, method)
    if (
      !this.ownerPublished(registration.owner) ||
      this.changingSources.has(registration.owner.source)
    ) {
      throw new L4PiPluginRuntimeBusyError()
    }

    const parsedInput = parseL4PiPluginMethodData(input, 'input')
    return this.runOwnedCall(registration.owner, async (signal) => {
      const output = await registration.execute(parsedInput, { signal })
      return parseL4PiPluginMethodData(output, 'output')
    })
  }

  async listCapabilityDeclarations(): Promise<Record<string, CapabilityDeclarations>> {
    await this.initialize()
    if (this.disposed || !this.acceptingCalls) throw new L4PiPluginRuntimeBusyError()
    const entries = await Promise.all(
      [...this.capabilityLoaders]
        .filter(
          ([, registration]) =>
            this.ownerPublished(registration.owner) &&
            !this.changingSources.has(registration.owner.source)
        )
        .map(async ([pluginName, registration]) => {
          try {
            return await this.runOwnedCall(registration.owner, async (signal) => {
              const result = await registration.load({ signal })
              if (this.capabilityLoaders.get(pluginName) !== registration) {
                throw new Error(`能力声明已被替换：${pluginName}`)
              }
              return [pluginName, CapabilityDeclarationsSchema.parse(result)] as const
            })
          } catch (cause) {
            throw new Error(`读取 ${pluginName} 能力选项失败：${errorMessage(cause)}`, { cause })
          }
        })
    )
    return Object.fromEntries(entries)
  }

  async listBrowserEntries(): Promise<readonly L4PiResolvedBrowserEntry[]> {
    await this.initialize()
    return [...this.browserEntries.values()]
      .filter((entry) => this.ownerPublished(entry.owner))
      .sort((left, right) => left.pluginName.localeCompare(right.pluginName))
      .flatMap(({ pluginName, entryPath, resourceKey, snapshot }) =>
        snapshot ? [{ pluginName, entryPath, resourceKey, snapshot }] : []
      )
  }

  async listMessageDeclarations(): Promise<readonly L4PiMessageDeclarationRegistration[]> {
    await this.initialize()
    return this.readMessageDeclarations()
  }

  readMessageDeclarations(): readonly L4PiMessageDeclarationRegistration[] {
    return [...this.declarations.values()]
      .filter((registration) => this.ownerPublished(registration.owner))
      .sort((left, right) => {
        const plugin = left.pluginName.localeCompare(right.pluginName)
        return plugin === 0 ? left.declarationName.localeCompare(right.declarationName) : plugin
      })
      .map(({ pluginName, declarationName, declaration }) => ({
        pluginName,
        declarationName,
        declaration
      }))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    this.acceptingCalls = false
    this.changeListeners.clear()
    this.workSessionProvider = null
    this.pushSender = null

    const owners = [...new Set([...this.owners, ...this.loadingOwners])].reverse()
    this.owners.length = 0
    this.loadingOwners.clear()
    await Promise.all(owners.map((owner) => this.releaseOwner(owner)))

    this.methods.clear()
    this.pluginOwners.clear()
    this.browserEntries.clear()
    this.declarations.clear()
    this.capabilityLoaders.clear()
    this.appRuntimeSink = null
  }

  private async loadConfiguredPackages(): Promise<void> {
    this.loadError = null
    this.packageDiagnostics.clear()
    for (const item of await this.packageProvider()) {
      if (this.disposed) return
      await this.loadPackage(item.source, item.installedPath)
    }
  }

  private async loadOwnerWithinDeadline(
    owner: L4PiPluginOwner,
    entryInput: unknown,
    globalInput: unknown
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const execution = (async (): Promise<void> => {
      if (entryInput !== undefined) await this.loadEntryOwner(owner, entryInput)
      else await this.loadLegacyOwner(owner, globalInput)
      try {
        await this.validateOwnerResources(owner)
      } catch (error) {
        throw new L4PiPluginPhaseError('resources', error)
      }
      this.ensureOwnerActive(owner)
    })()
    try {
      await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new L4PiPluginPhaseError('setup', new Error('插件初始化超时，已放弃加载')))
          }, L4_PLUGIN_LOAD_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async loadPackage(source: string, installedPath: string): Promise<void> {
    const startedAt = performance.now()
    const packageRoot = resolve(installedPath)
    let manifest: L4PiDeskPackageManifest
    try {
      const packageJsonPath = join(packageRoot, 'package.json')
      manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as L4PiDeskPackageManifest
    } catch (error) {
      this.packageDiagnostics.set(source, {
        source,
        packageName: null,
        version: null,
        pluginName: null,
        status: 'failed',
        error: { phase: 'package', message: errorMessage(error) }
      })
      return
    }

    const entryInput = manifest.piDesk?.entry
    const globalInput = manifest.piDesk?.global
    if (entryInput === undefined && globalInput === undefined) return
    if (this.disposed) return
    const owner: L4PiPluginOwner = {
      source,
      packageName: typeof manifest.name === 'string' ? manifest.name : null,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      packageRoot,
      active: true,
      draining: false,
      pluginNames: new Set(),
      activeCalls: new Set(),
      subscriptions: new Set(),
      beforeReload: null,
      disposer: null
    }

    console.info('[Pi Desk][GlobalPluginRuntime] 开始加载 Pi Desk Plugin', {
      source,
      packageName: owner.packageName
    })
    this.loadingOwners.add(owner)
    try {
      await this.loadOwnerWithinDeadline(owner, entryInput, globalInput)
      this.owners.push(owner)
      this.recordOwnerDiagnostic(owner)
      console.info('[Pi Desk][GlobalPluginRuntime] Pi Desk Plugin 已加载', {
        source,
        packageName: owner.packageName,
        pluginNames: [...owner.pluginNames],
        methodCount: [...this.methods.values()].filter((item) => item.owner === owner).length,
        browserEntryCount: [...this.browserEntries.values()].filter((item) => item.owner === owner)
          .length,
        declarationCount: [...this.declarations.values()].filter((item) => item.owner === owner)
          .length,
        durationMs: Math.round(performance.now() - startedAt)
      })
    } catch (error) {
      const phase = error instanceof L4PiPluginPhaseError ? error.phase : 'entry'
      const pluginName = [...owner.pluginNames][0] ?? null
      await this.releaseOwner(owner)
      const message = errorMessage(error)
      this.packageDiagnostics.set(source, {
        source,
        packageName: owner.packageName,
        version: owner.version,
        pluginName,
        status: 'failed',
        error: { phase, message }
      })
      console.warn('[Pi Desk][GlobalPluginRuntime] Pi Desk Plugin 加载失败', {
        source,
        packageName: owner.packageName,
        phase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        message,
        durationMs: Math.round(performance.now() - startedAt)
      })
    } finally {
      this.loadingOwners.delete(owner)
    }
  }

  private async loadEntryOwner(owner: L4PiPluginOwner, entryInput: unknown): Promise<void> {
    const entryPath = packageEntryPath(owner.packageRoot, entryInput, 'piDesk.entry')
    const entryStat = await stat(entryPath)
    if (!entryStat.isFile()) throw new Error('Pi Desk Plugin entry is not a file')

    const loaded = await loadL4PiDeskPluginEntry(entryPath, owner.packageRoot)
    const definition = loaded.default as Partial<PiDeskPluginDefinition> | undefined
    if (
      !definition ||
      typeof definition !== 'object' ||
      typeof definition.name !== 'string' ||
      typeof definition.setup !== 'function'
    ) {
      throw new Error('Pi Desk Plugin entry must default-export definePiDeskPlugin(...)')
    }

    const pluginName = parseL4PiPluginName(definition.name)
    this.claimPluginName(owner, pluginName)
    try {
      const lifecycle = normalizeSetupResult(
        await definition.setup(this.createPiDeskFacade(owner, pluginName, owner.packageRoot))
      )
      owner.beforeReload = lifecycle.beforeReload
      owner.disposer = lifecycle.disposer
      if (!owner.active || this.disposed) {
        await this.releaseOwner(owner)
        throw new Error('插件初始化完成时 Owner 已失效')
      }
    } catch (error) {
      throw new L4PiPluginPhaseError('setup', error)
    }
  }

  private async loadLegacyOwner(owner: L4PiPluginOwner, entryInput: unknown): Promise<void> {
    const entryPath = packageEntryPath(owner.packageRoot, entryInput, 'piDesk.global')
    const entryStat = await stat(entryPath)
    if (!entryStat.isFile()) throw new Error('Global Plugin entry is not a file')

    const loaded = await loadL4PiDeskPluginEntry(entryPath, owner.packageRoot)
    if (typeof loaded.default !== 'function') {
      throw new Error('Global Plugin entry must default-export a factory function')
    }

    const factory = loaded.default as GlobalPluginFactory
    try {
      const disposer = await factory(this.createLegacyApi(owner))
      if (disposer !== undefined && typeof disposer !== 'function') {
        throw new Error('Global Plugin factory must return void or a disposer function')
      }
      owner.disposer = disposer ?? null
      if (!owner.active || this.disposed) {
        await this.releaseOwner(owner)
        throw new Error('插件初始化完成时 Owner 已失效')
      }
    } catch (error) {
      throw new L4PiPluginPhaseError('setup', error)
    }
  }

  private claimPluginName(owner: L4PiPluginOwner, pluginName: string): void {
    this.ensureOwnerActive(owner)
    const existing = this.pluginOwners.get(pluginName)
    if (existing && existing !== owner) {
      throw new Error(`Pi Desk pluginName is already registered: ${pluginName}`)
    }
    this.pluginOwners.set(pluginName, owner)
    owner.pluginNames.add(pluginName)
  }

  private createLegacyApi(owner: L4PiPluginOwner): GlobalPluginAPI {
    return {
      bindPlugin: (pluginNameInput): GlobalPluginFacade => {
        const pluginName = parseL4PiPluginName(pluginNameInput)
        this.claimPluginName(owner, pluginName)
        return {
          name: pluginName,
          registerMethod: (method, execute) =>
            this.registerMethod(owner, pluginName, method, execute)
        }
      }
    }
  }

  private createPiDeskFacade(
    owner: L4PiPluginOwner,
    pluginName: string,
    packageRoot: string
  ): PiDeskPluginFacade {
    const host: PiDeskPluginHost = {
      settings: {
        getSnapshot: () => {
          this.ensureOwnerActive(owner)
          if (!this.hostSettings) throw new Error('宿主共享设置尚未就绪')
          return this.hostSettings.getSnapshot()
        },
        subscribe: (listener) => {
          this.ensureOwnerActive(owner)
          if (!this.hostSettings) throw new Error('宿主共享设置尚未就绪')
          const unsubscribe = this.hostSettings.subscribe(() => {
            if (owner.active && !owner.draining) listener()
          })
          owner.subscriptions.add(unsubscribe)
          return () => {
            if (!owner.subscriptions.delete(unsubscribe)) return
            return unsubscribe()
          }
        }
      },
      workSessions: {
        listWorkSessions: async () => {
          this.ensureOwnerActive(owner)
          const workSessions = await this.readWorkSessions()
          this.ensureOwnerActive(owner)
          return workSessions
        }
      }
    }
    return {
      name: pluginName,
      host,
      notifications: {
        publish: (input) => {
          this.ensureOwnerActive(owner)
          return this.requireAppRuntimeSink().publishNotification(pluginName, input)
        },
        update: (notificationId, changes) => {
          this.ensureOwnerActive(owner)
          this.requireAppRuntimeSink().updateNotification(pluginName, notificationId, changes)
        },
        delete: (notificationId) => {
          this.ensureOwnerActive(owner)
          this.requireAppRuntimeSink().deleteNotification(pluginName, notificationId)
        }
      },
      setState: (state) => {
        this.ensureOwnerActive(owner)
        this.requireAppRuntimeSink().setState(pluginName, state)
      },
      registerMethod: (method, execute) => this.registerMethod(owner, pluginName, method, execute),
      registerBrowserEntry: (relativePath) => {
        this.ensureOwnerActive(owner)
        if (this.browserEntries.has(pluginName)) {
          throw new Error(`Browser Entry is already registered: ${pluginName}`)
        }
        const entryPath = packageEntryPath(packageRoot, relativePath, 'browserEntry')
        const registration: L4PiBrowserEntryRegistration = {
          pluginName,
          entryPath,
          resourceKey: randomUUID(),
          snapshot: null,
          owner
        }
        this.browserEntries.set(pluginName, registration)
        return this.registrationDisposer(owner, () => {
          if (this.browserEntries.get(pluginName) === registration) {
            this.browserEntries.delete(pluginName)
          }
        })
      },
      declareCapabilities: (load) => {
        this.ensureOwnerActive(owner)
        if (typeof load !== 'function') throw new Error('能力声明必须是按需查询函数')
        if (this.capabilityLoaders.has(pluginName)) {
          throw new Error(`能力声明已注册：${pluginName}`)
        }
        const registration = { load, owner }
        this.capabilityLoaders.set(pluginName, registration)
        return this.registrationDisposer(owner, () => {
          if (this.capabilityLoaders.get(pluginName) === registration) {
            this.capabilityLoaders.delete(pluginName)
          }
        })
      },
      declareMessage: (name, declaration) =>
        this.registerDeclaration(owner, pluginName, name, declaration),
      pushGlobal: (event, data) => {
        if (!owner.active || owner.draining) return
        this.sendPush(pluginName, { scope: 'global' }, event, data)
      },
      pushSession: (source, event, data) => {
        if (!owner.active || owner.draining) return
        this.sendPush(pluginName, { scope: 'session', source: parseSource(source) }, event, data)
      }
    }
  }

  private registerMethod(
    owner: L4PiPluginOwner,
    pluginName: string,
    methodInput: string,
    execute: GlobalPluginMethodHandler
  ): () => void {
    this.ensureOwnerActive(owner)
    const method = parseL4PiPluginMethodName(methodInput)
    const key = l4PiPluginMethodKey(pluginName, method)
    if (this.methods.has(key)) throw new L4PiPluginMethodConflictError(pluginName, method)

    const registration: L4PiGlobalPluginRegistration = {
      pluginName,
      method,
      execute,
      owner
    }
    this.methods.set(key, registration)
    return this.registrationDisposer(owner, () => {
      if (this.methods.get(key) === registration) this.methods.delete(key)
    })
  }

  private registerDeclaration(
    owner: L4PiPluginOwner,
    pluginName: string,
    declarationNameInput: string,
    declaration: PluginMessageDeclaration
  ): PluginDisposer {
    this.ensureOwnerActive(owner)
    const declarationName = parseContributionName(declarationNameInput)
    if (
      !declaration ||
      typeof declaration !== 'object' ||
      typeof declaration.match !== 'function' ||
      typeof declaration.project !== 'function'
    ) {
      throw new Error('Message Declaration must provide match and project functions')
    }
    const normalized: PluginMessageDeclaration = {
      priority: parsePriority(declaration.priority),
      match: declaration.match,
      project: declaration.project
    }
    const key = declarationKey(pluginName, declarationName)
    if (this.declarations.has(key)) {
      throw new Error(`Message Declaration is already registered: ${pluginName}/${declarationName}`)
    }
    const registration: L4PiDeclarationRegistration = {
      pluginName,
      declarationName,
      declaration: normalized,
      owner
    }
    this.declarations.set(key, registration)
    return this.registrationDisposer(owner, () => {
      if (this.declarations.get(key) === registration) this.declarations.delete(key)
    })
  }

  private registrationDisposer(owner: L4PiPluginOwner, dispose: () => void): () => void {
    let registered = true
    return (): void => {
      if (!registered) return
      registered = false
      if (owner.active) dispose()
    }
  }

  private requireAppRuntimeSink(): L4PiPluginAppRuntimeSink {
    if (!this.appRuntimeSink) throw new Error('App Runtime sink has not been bound')
    return this.appRuntimeSink
  }

  private sendPush(
    pluginName: string,
    target: PluginPushMessage['target'],
    eventInput: string,
    dataInput: PluginJsonObject
  ): void {
    if (this.disposed) return
    const event = parseL4PiPluginMethodName(eventInput)
    const data = parsePushData(dataInput)
    this.pushSender?.({
      pluginName,
      target,
      event,
      data: structuredClone(data)
    })
  }

  private async readWorkSessions(): Promise<readonly PluginWorkSession[]> {
    if (!this.workSessionProvider || this.disposed) return []
    const workSessions = await this.workSessionProvider()
    return z
      .array(L4PiWorkSessionSchema)
      .parse(workSessions)
      .map((item) => structuredClone(item))
  }

  private async validateOwnerResources(owner: L4PiPluginOwner): Promise<void> {
    const entries = [...this.browserEntries.values()].filter((item) => item.owner === owner)
    for (const registration of entries) {
      const entryStat = await stat(registration.entryPath)
      if (!entryStat.isFile()) throw new Error('Browser Entry resource is not a file')
      if (basename(registration.entryPath) !== 'entry.js') {
        throw new Error('Browser Entry resource file must be named entry.js')
      }
      const snapshot = await captureL4PiBrowserModules(registration.entryPath)
      this.ensureOwnerActive(owner)
      const used = [...this.browserEntries.values()].reduce(
        (total, entry) => total + (entry.snapshot?.size ?? 0),
        0
      )
      if (used + snapshot.size > L4_PLUGIN_BROWSER_TOTAL_BYTES) {
        throw new Error('Browser 模块快照总量超过128MB，拒绝加载此插件')
      }
      registration.snapshot = snapshot
    }
  }

  private recordOwnerDiagnostic(owner: L4PiPluginOwner): void {
    this.packageDiagnostics.set(owner.source, {
      source: owner.source,
      packageName: owner.packageName,
      version: owner.version,
      pluginName: [...owner.pluginNames][0] ?? null,
      status: 'ready',
      error: null
    })
  }

  private ensureOwnerActive(owner: L4PiPluginOwner): void {
    if (!owner.active || owner.draining || this.disposed) {
      throw new Error('Pi Desk Plugin owner is no longer active')
    }
  }

  private async releaseOwner(owner: L4PiPluginOwner): Promise<void> {
    const subscriptions = [...owner.subscriptions]
    owner.subscriptions.clear()
    if (owner.active) {
      owner.active = false
      for (const controller of owner.activeCalls) controller.abort()
      owner.activeCalls.clear()
      const index = this.owners.indexOf(owner)
      if (index >= 0) this.owners.splice(index, 1)

      for (const [key, registration] of this.methods) {
        if (registration.owner === owner) this.methods.delete(key)
      }
      for (const [key, registration] of this.browserEntries) {
        if (registration.owner === owner) this.browserEntries.delete(key)
      }
      for (const [key, registration] of this.declarations) {
        if (registration.owner === owner) this.declarations.delete(key)
      }
      for (const [key, registration] of this.capabilityLoaders) {
        if (registration.owner === owner) this.capabilityLoaders.delete(key)
      }
      for (const pluginName of owner.pluginNames) {
        if (this.pluginOwners.get(pluginName) !== owner) continue
        this.pluginOwners.delete(pluginName)
        try {
          this.appRuntimeSink?.releasePlugin(pluginName)
        } catch (error) {
          console.warn('[Pi Desk][GlobalPluginRuntime] 清理插件 App Runtime 失败', {
            pluginName,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            message: errorMessage(error)
          })
        }
      }
      owner.pluginNames.clear()
    }

    const beforeReload = owner.beforeReload
    const disposer = owner.disposer
    owner.beforeReload = null
    owner.disposer = null
    const controller = new AbortController()
    await Promise.all([
      ...subscriptions.map((dispose) =>
        runLifecycleWithTimeout({ owner, phase: 'dispose', execute: dispose })
      ),
      beforeReload
        ? runLifecycleWithTimeout({
            owner,
            phase: 'beforeReload',
            execute: () => beforeReload({ signal: controller.signal }),
            onTimeout: () => controller.abort()
          })
        : Promise.resolve(),
      disposer
        ? runLifecycleWithTimeout({ owner, phase: 'dispose', execute: disposer })
        : Promise.resolve()
    ])
  }
}
