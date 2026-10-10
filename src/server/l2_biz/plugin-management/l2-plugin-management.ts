import 'server-only'

import { isL4PiDeskSafeMode } from '@server/l4_foundation/pi/l4-pi-desk-mode'
import { getL4PiDeskDataDir } from '@server/l4_foundation/pi/l4-pi-desk-data-dir'

import {
  createL4BilingualText,
  type L4LocalizedText
} from '@common/l4_foundation/locale/l4-localized-text'

import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import {
  L2PluginManagementDetailSchema,
  L2PluginManagementSnapshotSchema,
  type L2PluginManagementCapabilities,
  type L2PluginManagementDetail,
  type L2PluginManagementError,
  type L2PluginManagementItem,
  type L2PluginManagementOperation,
  type L2PluginManagementSnapshot,
  type L2PluginManagementInstallRequest,
  type L2PluginManagementListRequest,
  type L2PluginManagementBatchRequest,
  type L2PluginManagementBatchResponse
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import {
  l4PluginSourceIdentity as l2PluginSourceIdentity,
  l4PluginNpmName as l2PluginNpmName,
  isL4PluginNewerVersion as isL2PluginNewerVersion,
  L4PluginUpdateTagSchema
} from '@common/l4_foundation/plugin/l4-plugin-package'
import { readL4PluginReadme } from '@server/l4_foundation/pi/l4-pi-plugin-registry'
import {
  readL4PiPluginPreferences,
  readL4PiPluginUpdateTag,
  setL4PiPluginUpdateTag,
  setL4PiPluginEnabled
} from '@server/l4_foundation/pi/l4-pi-plugin-preferences'
import { getL4PiGlobalPluginRuntime } from '@server/l4_foundation/pi/l4-pi-global-plugin-runtime'
import {
  L4PiPackageMaintenanceError,
  runL4PiPackageMaintenance
} from '@server/l4_foundation/pi/l4-pi-package-maintenance'
import {
  readL4PiPackageRootConsistencyError,
  type L4PiPackageRootConsistencyError
} from '@server/l4_foundation/pi/l4-pi-package-root-consistency'
import { runL4PiPackageRootExclusive } from '@server/l4_foundation/pi/l4-pi-package-root-gate'
import {
  discoverL4PiPluginSources,
  l4PiPluginSourceRoot,
  type L4PiPluginSourceSnapshot
} from '@server/l4_foundation/pi/l4-pi-plugin-sources'
import type { L4PiPluginSourceChange } from '@server/l4_foundation/pi/l4-pi-plugin-source-changes'
import {
  clearL4PiPluginNativeDiagnostics,
  readL4PiPluginNativeDiagnostics
} from '@server/l4_foundation/pi/l4-pi-plugin-native-diagnostic'
import {
  runL4PiPluginCapabilityProbe,
  type L4PiPluginCapabilitySnapshot,
  type L4PiPluginPackageCapabilities
} from '@server/l4_foundation/pi/l4-pi-plugin-capability-probe'
import { runL4PiPluginProbe } from '@server/l4_foundation/pi/l4-pi-plugin-probe'
import {
  canRestartL4PiDesk,
  scheduleL4PiDeskRestart,
  type L4PiDeskPackageMaintenanceRequest
} from '@server/l4_foundation/pi/l4-pi-desk-process-control'

import { L2PluginUpdates } from './l2-plugin-updates'

const L2_PLUGIN_RESOURCE_DETAIL_MAX_BYTES = 64 * 1024

interface L2PluginPackageManifest {
  version?: unknown
  pi?: {
    extensions?: unknown
  }
  piDesk?: {
    entry?: unknown
    global?: unknown
  }
}

interface L2PluginPackageMetadata {
  version: string | null
  error: L2PluginManagementError | null
}

type L2PluginMutation = 'add' | 'update' | 'del' | 'enable' | 'disable'

export interface L2PluginManagementWorkSessions {
  refreshPluginMessages: () => void
  runPluginRestart: <T>(operation: () => Promise<T>) => Promise<T>
}

export class L2PluginManagementNotFoundError extends Error {
  constructor(readonly source: string) {
    super(`插件不存在：${source}`)
    this.name = 'L2PluginManagementNotFoundError'
  }
}

export class L2PluginManagementOperationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L2PluginManagementOperationConflictError'
  }
}

export class L2PluginManagementInvalidPackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L2PluginManagementInvalidPackageError'
  }
}

export class L2PluginManagementPackageRootError extends Error {
  constructor(readonly rootError: L4PiPackageRootConsistencyError) {
    super(rootError.message)
    this.name = 'L2PluginManagementPackageRootError'
  }
}

export class L2PluginManagementRestartPendingError extends Error {
  constructor() {
    super('已有插件操作需要重启完成')
    this.name = 'L2PluginManagementRestartPendingError'
  }
}

export class L2PluginManagementRestartUnavailableError extends Error {
  constructor() {
    super('当前启动方式不支持自动重启 Pi Desk')
    this.name = 'L2PluginManagementRestartUnavailableError'
  }
}

function pathInside(packageRoot: string, input: string, field: string): string {
  const path = resolve(packageRoot, input)
  const relativePath = relative(packageRoot, path)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`${field} 必须位于插件包目录内`)
  }
  return path
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function hasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value)
}

function normalizedSearchPath(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

async function readPackageMetadata(packageRoot: string): Promise<L2PluginPackageMetadata> {
  if ((await stat(packageRoot)).isFile()) return { version: null, error: null }
  let manifest: L2PluginPackageManifest
  try {
    manifest = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8')
    ) as L2PluginPackageManifest
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { version: null, error: null }
    }
    return {
      version: null,
      error: { phase: 'package', message: errorMessage(error) }
    }
  }

  const version =
    typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : null
  try {
    const piDeskEntry = manifest.piDesk?.entry ?? manifest.piDesk?.global
    if (piDeskEntry !== undefined) {
      if (typeof piDeskEntry !== 'string' || !piDeskEntry.trim()) {
        throw new Error('piDesk.entry 必须是非空字符串')
      }
      const entryPath = pathInside(packageRoot, piDeskEntry, 'piDesk.entry')
      if (!(await fileExists(entryPath))) throw new Error('Pi Desk Entry 文件不存在')
    }

    const extensions = manifest.pi?.extensions
    if (extensions !== undefined && !Array.isArray(extensions)) {
      throw new Error('pi.extensions 必须是数组')
    }
    for (const extension of extensions ?? []) {
      if (typeof extension !== 'string' || !extension.trim()) {
        throw new Error('pi.extensions 只允许非空字符串')
      }
      if (hasGlob(extension)) continue
      const extensionPath = pathInside(packageRoot, extension, 'pi.extensions')
      if (!(await fileExists(extensionPath))) {
        throw new Error(`Native Extension 文件不存在：${extension}`)
      }
    }
    return { version, error: null }
  } catch (error) {
    return {
      version,
      error: { phase: 'entry', message: errorMessage(error) }
    }
  }
}

function combineLoadErrors(
  errors: readonly (string | L4PiPackageRootConsistencyError)[]
): L4LocalizedText | null {
  const values = [
    ...new Map(
      errors.flatMap((item) => {
        const defaultText = (typeof item === 'string' ? item : item.message).trim()
        if (!defaultText) return []
        return [
          [
            defaultText,
            {
              defaultText,
              englishText: typeof item === 'string' ? defaultText : item.englishMessage.trim()
            }
          ] as const
        ]
      })
    ).values()
  ]
  if (values.length === 0) return null
  const chinese = values.map((item) => item.defaultText).join('; ')
  if (values.every((item) => item.defaultText === item.englishText)) return chinese
  return createL4BilingualText(chinese, values.map((item) => item.englishText).join('; '))
}

function capabilityError(error: string | null): L4LocalizedText | null {
  if (!error) return null
  if (error.length <= 32 * 1024) return error
  const original = error.slice(0, 32 * 1024 - 16)
  return createL4BilingualText(`${original}\n…（已截断）`, `${original}\n… (truncated)`)
}

async function readPluginResource(
  packageRoot: string,
  filePath: string
): Promise<{ content: string; truncated: boolean }> {
  const [resolvedRoot, resolvedFile] = await Promise.all([
    realpath(packageRoot),
    realpath(filePath)
  ])
  const relativePath = relative(resolvedRoot, resolvedFile)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('插件能力资源必须位于 Package 目录内')
  }

  const handle = await open(resolvedFile, 'r')
  try {
    const buffer = Buffer.alloc(L2_PLUGIN_RESOURCE_DETAIL_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const truncated = bytesRead > L2_PLUGIN_RESOURCE_DETAIL_MAX_BYTES
    return {
      content: buffer
        .subarray(0, Math.min(bytesRead, L2_PLUGIN_RESOURCE_DETAIL_MAX_BYTES))
        .toString('utf8'),
      truncated
    }
  } finally {
    await handle.close()
  }
}

function pluginCapabilities(
  native: L4PiPluginPackageCapabilities | undefined,
  piDesk:
    | {
        methods: ReadonlyArray<{ pluginName: string; method: string }>
        browserEntries: ReadonlyArray<{ pluginName: string }>
        messageDeclarations: ReadonlyArray<{
          pluginName: string
          declarationName: string
          priority: number
        }>
      }
    | undefined,
  loadError: string | null
): L2PluginManagementCapabilities {
  return {
    error: capabilityError(native?.error ?? loadError),
    extensions: native?.extensions ?? [],
    tools:
      native?.tools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        state: tool.state,
        description: tool.description,
        promptSnippet: tool.promptSnippet,
        promptGuidelineCount: tool.promptGuidelineCount,
        promptGuidelinePreview: tool.promptGuidelinePreview
      })) ?? [],
    skills:
      native?.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        modelVisible: skill.modelVisible
      })) ?? [],
    prompts:
      native?.prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        path: prompt.path
      })) ?? [],
    themes: native?.themes ?? [],
    providers: native?.providers ?? [],
    piDesk: {
      methods: piDesk ? [...piDesk.methods] : [],
      browserEntries: piDesk ? [...piDesk.browserEntries] : [],
      messageDeclarations: piDesk ? [...piDesk.messageDeclarations] : []
    }
  }
}

function maintenanceRequest(
  mutation: 'add' | 'update' | 'del',
  source: string
): L4PiDeskPackageMaintenanceRequest {
  return {
    action: mutation === 'add' ? 'install' : mutation === 'update' ? 'update' : 'remove',
    source
  }
}

export class L2PluginManagement {
  private operationTail: Promise<void> = Promise.resolve()
  private readonly operations = new Map<string, L2PluginManagementOperation>()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private readonly unsubscribeRuntime: () => void
  private disposed = false
  private activeSource: string | null = null
  private sourceCache: L4PiPluginSourceSnapshot | null = null
  private readonly stagingRoot: string
  private readonly packageManagerCwd: string
  private readonly staleStagingCleanup: Promise<void>
  private readonly maintenanceError: string | null
  private readonly updates: L2PluginUpdates
  private capabilityCache: L4PiPluginCapabilitySnapshot | null = null
  private readonly deferredMaintenance = new Map<string, L4PiDeskPackageMaintenanceRequest>()

  private get restartRequired(): boolean {
    return this.deferredMaintenance.size > 0
  }

  constructor(
    private readonly workSessions: L2PluginManagementWorkSessions,
    private readonly cwd = process.cwd(),
    private readonly agentDir = getAgentDir()
  ) {
    const scope = createHash('sha256').update(this.agentDir).digest('hex').slice(0, 16)
    this.stagingRoot = join(this.cwd, 'temp', 'pi', `plugin-management-${scope}`)
    this.packageManagerCwd = join(getL4PiDeskDataDir(), 'plugin-package-manager')
    this.updates = new L2PluginUpdates(this.agentDir, this.packageManagerCwd, this.lifetime.signal)
    this.maintenanceError = process.env.PI_DESK_PLUGIN_MAINTENANCE_ERROR?.trim() || null
    this.unsubscribeRuntime = getL4PiGlobalPluginRuntime().subscribeChanges(() => this.publish())
    this.staleStagingCleanup = rm(this.stagingRoot, { recursive: true, force: true }).catch(
      (error: unknown) => {
        console.warn('[Pi Desk][PluginManagement] 清理上次中断的候选目录失败', {
          path: this.stagingRoot,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    )
  }

  list(
    input: boolean | L2PluginManagementListRequest = false
  ): Promise<L2PluginManagementSnapshot> {
    this.assertOpen()
    return this.readSnapshot(input)
  }

  async batch(input: L2PluginManagementBatchRequest): Promise<L2PluginManagementBatchResponse> {
    this.assertOpen()
    const results: L2PluginManagementBatchResponse['results'] = []
    const seen = new Set<string>()
    const items = input.action === 'add' ? input.items : input.sources.map((source) => ({ source }))
    for (const item of items) {
      try {
        const source = input.action === 'add' ? this.normalizeAddedSource(item.source) : item.source
        const identity = l2PluginSourceIdentity(source)
        if (seen.has(identity)) {
          throw new L2PluginManagementOperationConflictError('批量请求中包含重复来源')
        }
        seen.add(identity)
        if (input.action === 'add') {
          const { source: _source, ...options } = item
          await this.reinstall(source, undefined, options)
        } else if (input.action === 'update') {
          await this.update(source)
        } else if (input.action === 'del') {
          await this.del(source)
        } else {
          await this.setUpdateTag(source, input.tag)
        }
        results.push({ source: item.source, error: null })
      } catch (error) {
        results.push({ source: item.source, error: errorMessage(error).slice(0, 4000) })
      }
    }
    return { snapshot: await this.readSnapshot(false), results }
  }

  subscribe(listener: () => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(source: string): Promise<L2PluginManagementDetail> {
    this.assertOpen()
    return this.readDetail(source)
  }

  add(
    source: string,
    options: Omit<L2PluginManagementInstallRequest, 'source'> = {}
  ): Promise<L2PluginManagementSnapshot> {
    return this.mutate('add', this.normalizeAddedSource(source), false, undefined, options)
  }

  setEnabled(source: string, enabled: boolean): Promise<L2PluginManagementSnapshot> {
    return this.mutate(enabled ? 'enable' : 'disable', source)
  }

  async update(source: string): Promise<L2PluginManagementSnapshot> {
    this.assertOpen()
    if (isL4PiDeskSafeMode()) {
      throw new L2PluginManagementOperationConflictError('基础模式不执行插件维护')
    }
    this.assertSourceIdle(source)
    const target = (await this.readSources()).sources.find(
      (item) => l2PluginSourceIdentity(item.source) === l2PluginSourceIdentity(source)
    )
    if (!target) throw new L2PluginManagementNotFoundError(source)
    if (l2PluginNpmName(target.source)) {
      const snapshot = await this.readSnapshot({ checkUpdates: true, sources: [target.source] })
      const item = snapshot.plugins.find((item) => item.source === target.source)!
      if (item.updateError) throw new L2PluginManagementInvalidPackageError(item.updateError)
      if (item.updateAvailable !== true) return snapshot
    }
    return this.mutate('update', target.source)
  }

  reinstall(
    source: string,
    previousSource?: string,
    options: Omit<L2PluginManagementInstallRequest, 'source'> = {}
  ): Promise<L2PluginManagementSnapshot> {
    return this.mutate('add', this.normalizeAddedSource(source), true, previousSource, options)
  }

  private async setUpdateTag(source: string, tag: string): Promise<void> {
    this.assertOpen()
    if (isL4PiDeskSafeMode()) {
      throw new L2PluginManagementOperationConflictError('基础模式不执行插件维护')
    }
    const target = (await this.readSources()).sources.find(
      (item) => l2PluginSourceIdentity(item.source) === l2PluginSourceIdentity(source)
    )
    if (!target) throw new L2PluginManagementNotFoundError(source)
    if (target.kind !== 'package' || !l2PluginNpmName(target.source)) {
      throw new L2PluginManagementInvalidPackageError('只有 npm 插件包支持更新渠道')
    }
    this.assertSourceIdle(target.source)
    setL4PiPluginUpdateTag(target.source, L4PluginUpdateTagSchema.parse(tag), this.agentDir)
    this.updates.clear(target.source)
    this.publish()
  }

  private assertSourceIdle(source: string): void {
    const identity = l2PluginSourceIdentity(source)
    if (
      (this.activeSource && l2PluginSourceIdentity(this.activeSource) === identity) ||
      [...this.operations].some(
        ([key, operation]) =>
          l2PluginSourceIdentity(key) === identity && operation.phase !== 'failed'
      )
    ) {
      throw new L2PluginManagementOperationConflictError('该来源已有未完成的维护操作')
    }
  }

  waitForOperations(sources: readonly string[], signal: AbortSignal): Promise<void> {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    return new Promise<void>((resolveWait, rejectWait) => {
      let unsubscribe = (): void => undefined
      const finish = (error?: Error): void => {
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
        if (error) rejectWait(error)
        else resolveWait()
      }
      const onAbort = (): void =>
        finish(new Error(this.disposed ? '插件管理已关闭' : '发起命令的会话已关闭'))
      const check = (): void => {
        if (this.disposed) return finish(new Error('插件管理已关闭'))
        for (const source of sources) {
          const operation = this.operations.get(source)
          if (operation?.phase === 'failed') {
            return finish(new Error(operation.message ?? '插件操作失败'))
          }
          if (
            operation?.phase === 'waiting' &&
            this.activeSource !== source &&
            this.restartRequired
          ) {
            return finish(
              new Error(
                `插件尚未生效，需要在设置的插件管理中重启 Pi Desk。${operation.message ?? ''}`
              )
            )
          }
        }
        if (sources.some((source) => this.operations.has(source) || this.activeSource === source))
          return
        finish()
      }
      if (signal.aborted) return onAbort()
      unsubscribe = this.subscribe(check)
      signal.addEventListener('abort', onAbort, { once: true })
      check()
    })
  }

  del(source: string): Promise<L2PluginManagementSnapshot> {
    return this.mutate('del', source)
  }

  async apply(sources?: readonly string[]): Promise<L2PluginManagementSnapshot> {
    this.assertOpen()
    if (isL4PiDeskSafeMode())
      throw new L2PluginManagementOperationConflictError('基础模式不加载外部插件')
    if (sources?.some((source) => this.deferredMaintenance.has(source)))
      throw new L2PluginManagementRestartPendingError()
    const changes = await getL4PiGlobalPluginRuntime().scanSourceChanges(sources)
    this.assertOpen()
    const accepted = changes.filter((change) => {
      if (this.deferredMaintenance.has(change.source)) return false
      const operation = this.operations.get(change.source)
      if (!operation || operation.phase === 'failed') return true
      if (sources) throw new L2PluginManagementOperationConflictError('该来源已有未完成操作')
      return false
    })
    const pendingSources = new Set(
      [...this.operations]
        .filter(([, operation]) => operation.phase !== 'failed')
        .map(([source]) => source)
    )
    for (const change of accepted) pendingSources.add(change.source)
    if (pendingSources.size > 32) {
      throw new L2PluginManagementOperationConflictError('加载变更超过队列上限，请选择部分来源')
    }
    for (const change of accepted) {
      if (!this.operations.has(change.source) && this.operations.size >= 64) {
        const stale = [...this.operations].find(([, operation]) => operation.phase === 'failed')
        if (stale) this.operations.delete(stale[0])
      }
      this.operations.set(change.source, { action: 'apply', phase: 'queued', message: null })
      this.enqueueApply(change)
    }
    this.publish()
    return this.readSnapshot(false)
  }

  private enqueueApply(change: L4PiPluginSourceChange): void {
    void this.runExclusive(async () => {
      this.activeSource = change.source
      try {
        this.setOperation(change.source, 'checking', null)
        await this.probeSourceChange(change)
        this.assertOpen()
        this.setOperation(change.source, 'applying', null)
        await getL4PiGlobalPluginRuntime().applySourceChange(change)
        if (change.current?.path) clearL4PiPluginNativeDiagnostics(change.current.path)
        if (change.previous?.path) clearL4PiPluginNativeDiagnostics(change.previous.path)
        this.capabilityCache = null
        this.workSessions.refreshPluginMessages()
        this.operations.delete(change.source)
      } catch (error) {
        this.setOperation(change.source, 'failed', errorMessage(error))
      } finally {
        this.activeSource = null
        this.sourceCache = null
        this.publish()
      }
    }).catch((error: unknown) => {
      if (!this.disposed) this.setOperation(change.source, 'failed', errorMessage(error))
    })
  }

  private async probeSourceChange(change: L4PiPluginSourceChange): Promise<void> {
    const source = change.current
    if (!source || !source.enabled) return
    if (source.error) throw new L2PluginManagementInvalidPackageError(source.error)
    if (!source.path) throw new L2PluginManagementInvalidPackageError('插件来源目录不存在')
    const startedAt = performance.now()
    console.info('[Pi Desk][PluginManagement] 源码候选预检开始', { source: change.source })
    const root = join(this.stagingRoot, randomUUID())
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'workspace')
    await mkdir(agentDir, { recursive: true })
    await mkdir(cwd, { recursive: true })
    try {
      // 直接指向本地源码作预检，不安装包、不复制依赖、不执行正式维护。
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({ extensions: [source.path] }),
        'utf8'
      )
      if (source.piDeskRoot || source.nativePaths.length > 0) {
        const diagnostic = await runL4PiPluginProbe(cwd, agentDir, source.nativePaths.length > 0)
        const error =
          diagnostic.loadError ??
          diagnostic.packages.find((item) => item.status === 'failed')?.error?.message
        if (error) throw new L2PluginManagementInvalidPackageError(error)
        if (source.piDeskRoot && !diagnostic.packages.some((item) => item.status === 'ready')) {
          throw new L2PluginManagementInvalidPackageError(
            '预检未加载到候选 Node Entry，放弃本次变更'
          )
        }
        for (const candidate of diagnostic.packages) {
          if (
            candidate.pluginName &&
            getL4PiGlobalPluginRuntime()
              .readDiagnostics()
              .packages.some(
                (item) =>
                  item.source !== change.source &&
                  item.status === 'ready' &&
                  item.pluginName === candidate.pluginName
              )
          )
            throw new L2PluginManagementInvalidPackageError(`插件名冲突：${candidate.pluginName}`)
        }
      }
      this.assertOpen()
    } finally {
      await rm(root, { recursive: true, force: true })
      console.info('[Pi Desk][PluginManagement] 源码候选预检结束', {
        source: change.source,
        durationMs: Math.round(performance.now() - startedAt)
      })
    }
  }

  reload(mode?: 'normal' | 'basic'): Promise<L2PluginManagementSnapshot> {
    if (this.activeSource) {
      return Promise.reject(
        new L2PluginManagementOperationConflictError('维护仍在执行或等待，请先完成当前操作')
      )
    }
    return this.runExclusive(async () => {
      this.assertRestartAvailable()
      return this.restartWhenQuiet(mode)
    })
  }

  private async mutate(
    mutation: L2PluginMutation,
    source: string,
    reinstall = false,
    previousSource?: string,
    options: Omit<L2PluginManagementInstallRequest, 'source'> = {}
  ): Promise<L2PluginManagementSnapshot> {
    this.assertOpen()
    if (isL4PiDeskSafeMode()) {
      throw new L2PluginManagementOperationConflictError(
        '基础模式不执行插件维护，请通过基础聊天修复或正常启动后维护'
      )
    }
    const snapshot = await this.readSources()
    this.assertOpen()
    const existing = snapshot.sources.find(
      (item) => l2PluginSourceIdentity(item.source) === l2PluginSourceIdentity(source)
    )
    if (mutation !== 'add') {
      if (!existing) throw new L2PluginManagementNotFoundError(source)
      if (existing.kind !== 'package' && mutation !== 'enable' && mutation !== 'disable') {
        throw new L2PluginManagementInvalidPackageError(
          '裸扩展不是已安装包，请编辑源码后加载变更；此操作不会删除源码'
        )
      }
    }
    previousSource ??= existing?.source
    const operationSource = previousSource ?? source
    if (options.tag && !l2PluginNpmName(source)) {
      throw new L2PluginManagementInvalidPackageError('只有 npm 插件包支持更新渠道')
    }
    for (const candidate of [source, operationSource]) this.assertSourceIdle(candidate)
    if ([...this.operations.values()].filter((item) => item.phase !== 'failed').length >= 32) {
      throw new L2PluginManagementOperationConflictError('插件维护队列已满，请等待当前操作完成')
    }
    if (this.operations.size >= 64) {
      const stale = [...this.operations].find(([, item]) => item.phase === 'failed')
      if (stale) this.operations.delete(stale[0])
    }
    if (
      previousSource &&
      previousSource !== source &&
      this.operations.get(previousSource)?.phase === 'failed'
    ) {
      this.operations.delete(previousSource)
    }
    this.operations.set(operationSource, { action: mutation, phase: 'queued', message: null })
    this.updates.clear(operationSource)
    this.updates.clear(source)
    this.publish()
    void this.runExclusive(async () => {
      this.activeSource = operationSource
      try {
        await this.executeMutation(mutation, source, operationSource, reinstall, options)
        if (!this.deferredMaintenance.has(operationSource)) this.operations.delete(operationSource)
      } catch (error) {
        this.setOperation(operationSource, 'failed', errorMessage(error))
      } finally {
        this.updates.clear(operationSource)
        this.updates.clear(source)
        this.sourceCache = null
        this.activeSource = null
        this.publish()
      }
    }).catch((error: unknown) => {
      if (!this.disposed) this.setOperation(operationSource, 'failed', errorMessage(error))
    })
    return this.readSnapshot(false)
  }

  private async executeMutation(
    mutation: L2PluginMutation,
    source: string,
    operationSource: string,
    reinstall: boolean,
    options: Omit<L2PluginManagementInstallRequest, 'source'>
  ): Promise<void> {
    const runtime = getL4PiGlobalPluginRuntime()
    const waiting = (reason: string): void => this.setOperation(operationSource, 'waiting', reason)
    const current = this.createPackageManager()
    this.throwSettingsErrors(current.settingsManager)
    const configured = current.packageManager
      .listConfiguredPackages()
      .filter((item) => item.scope === 'user')
    const target = configured.find((item) => item.source === operationSource)
    let request: L4PiDeskPackageMaintenanceRequest | null = null
    let updateTag: string | null = null
    if (mutation !== 'enable' && mutation !== 'disable') {
      const packageRootError = await readL4PiPackageRootConsistencyError({
        agentDir: this.agentDir,
        configured
      })
      if (packageRootError) throw new L2PluginManagementPackageRootError(packageRootError)
      if (mutation !== 'add' && !target) throw new L2PluginManagementNotFoundError(source)
      this.setOperation(operationSource, 'checking', '正在确认插件版本和下载源')
      const candidate = this.candidateSource(source, target?.installedPath)
      const npmName = l2PluginNpmName(candidate)
      const resolved =
        mutation === 'del'
          ? { source: candidate, updateTag: null }
          : await this.updates.resolveInstall(
              candidate,
              operationSource,
              options,
              mutation === 'update'
            )
      updateTag = resolved.updateTag
      if (mutation === 'update' && npmName && target?.installedPath) {
        const installed = await readPackageMetadata(target.installedPath)
        const version = resolved.source.slice(resolved.source.lastIndexOf('@') + 1)
        if (!installed.version)
          throw new L2PluginManagementInvalidPackageError('无法读取插件已安装版本')
        if (!isL2PluginNewerVersion(version, installed.version)) return
      }
      request = {
        ...(npmName && mutation !== 'del' && (reinstall || target || mutation === 'update')
          ? { action: 'reinstall' as const, source: resolved.source }
          : maintenanceRequest(mutation, resolved.source)),
        ...('registry' in resolved && resolved.registry ? { registry: resolved.registry } : {})
      }
      if (mutation !== 'del')
        await this.probeCandidate(resolved.source, operationSource, request.registry)
      if (updateTag) {
        setL4PiPluginUpdateTag(operationSource, updateTag, this.agentDir)
        this.updates.clear(operationSource)
      }
      if (this.deferredMaintenance.size > 0) {
        this.deferredMaintenance.set(operationSource, request)
        waiting('等待重启后完成安装维护')
        return
      }
    }
    this.assertOpen()
    await runtime.withSourceIdle(
      operationSource,
      async () => {
        this.setOperation(
          operationSource,
          'applying',
          request?.registry ? `下载源：${request.registry}` : null
        )
        if (mutation === 'enable' || mutation === 'disable') {
          const previouslyDisabled = readL4PiPluginPreferences(this.agentDir).disabled.includes(
            l2PluginSourceIdentity(source)
          )
          setL4PiPluginEnabled(source, mutation === 'enable', this.agentDir)
          this.sourceCache = null
          try {
            await this.applyMutationSources([source], true)
            if (mutation === 'enable') {
              const enabled = (await this.readSources()).sources.find(
                (item) => item.source === source
              )?.enabled
              if (!enabled)
                throw new L2PluginManagementInvalidPackageError(
                  '此插件仍被 Pi 配置排除，请先调整原有资源配置'
                )
            }
          } catch (error) {
            setL4PiPluginEnabled(source, !previouslyDisabled, this.agentDir)
            this.sourceCache = null
            throw error
          }
        } else if (request) {
          try {
            await runtime.replaceSource(operationSource, null)
            await runL4PiPackageRootExclusive(async () => {
              await runL4PiPackageMaintenance({
                maintenance: request!,
                agentDir: this.agentDir,
                cwd: this.packageManagerCwd
              })
              if (mutation !== 'del') await this.verifyInstalledPackage(request!.source)
            })
            this.sourceCache = null
            await this.applyMutationSources([operationSource, request.source], false)
          } catch (error) {
            if (
              error instanceof L4PiPackageMaintenanceError &&
              error.kind === 'locked' &&
              canRestartL4PiDesk()
            ) {
              this.deferredMaintenance.set(operationSource, request)
              waiting('文件正在被使用，需要重启后完成操作')
            } else {
              throw error
            }
          }
        }
        this.updates.clear(operationSource)
        this.updates.clear(source)
        this.capabilityCache = null
        this.workSessions.refreshPluginMessages()
      },
      this.lifetime.signal,
      waiting
    )
  }

  private async verifyInstalledPackage(source: string): Promise<void> {
    const current = this.createPackageManager()
    this.throwSettingsErrors(current.settingsManager)
    const identity = l2PluginSourceIdentity(source)
    const installed = current.packageManager
      .listConfiguredPackages()
      .find((item) => item.scope === 'user' && l2PluginSourceIdentity(item.source) === identity)
    if (!installed?.installedPath) {
      throw new L2PluginManagementInvalidPackageError('插件安装后没有有效目录')
    }
    await this.verifyPackageVersion(source, installed.installedPath)
  }

  private async verifyPackageVersion(source: string, path: string): Promise<void> {
    const metadata = await readPackageMetadata(path)
    if (metadata.error) {
      throw new L2PluginManagementInvalidPackageError(
        typeof metadata.error.message === 'string'
          ? metadata.error.message
          : metadata.error.message.default
      )
    }
    if (l2PluginNpmName(source)) {
      const expected = source.slice(source.lastIndexOf('@') + 1)
      if (metadata.version !== expected) {
        throw new L2PluginManagementInvalidPackageError(
          `插件实际安装版本与目标不一致：${metadata.version ?? '未知'}，目标 ${expected}`
        )
      }
    }
  }

  private async applyMutationSources(
    sources: readonly string[],
    preflight: boolean
  ): Promise<void> {
    const identities = new Set(sources.map(l2PluginSourceIdentity))
    const runtime = getL4PiGlobalPluginRuntime()
    const changed = await runtime.scanSourceChanges()
    const current = await this.readSources()
    const selected = [
      ...new Set([
        ...changed
          .filter((item) => identities.has(l2PluginSourceIdentity(item.source)))
          .map((item) => item.source),
        ...current.sources
          .filter((item) => identities.has(l2PluginSourceIdentity(item.source)))
          .map((item) => item.source)
      ])
    ]
    const changes = selected.length ? await runtime.scanSourceChanges(selected) : []
    for (const change of changes) {
      if (preflight) await this.probeSourceChange(change)
      await runtime.applySourceChange(change)
      if (change.current?.path) clearL4PiPluginNativeDiagnostics(change.current.path)
      if (change.previous?.path) clearL4PiPluginNativeDiagnostics(change.previous.path)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    this.unsubscribeRuntime()
    this.listeners.clear()
  }

  private assertOpen(): void {
    if (this.disposed) throw new L2PluginManagementOperationConflictError('插件管理已关闭')
  }

  private setOperation(
    source: string,
    phase: L2PluginManagementOperation['phase'],
    message: string | null
  ): void {
    const operation = this.operations.get(source)
    if (!operation) return
    const text = message?.slice(0, 4000) ?? null
    if (operation.phase === phase && operation.message === text) return
    this.operations.set(source, { ...operation, phase, message: text })
    if (phase === 'failed') {
      console.warn('[Pi Desk][PluginManagement] 插件操作失败', {
        source,
        action: operation.action,
        message: text
      })
    }
    this.publish()
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.warn('[Pi Desk][PluginManagement] 状态监听失败', { message: errorMessage(error) })
      }
    }
  }

  private async readSources(): Promise<L4PiPluginSourceSnapshot> {
    const writing = (): boolean =>
      this.activeSource !== null && this.operations.get(this.activeSource)?.phase === 'applying'
    if (writing() && this.sourceCache) return this.sourceCache
    const snapshot = await discoverL4PiPluginSources(this.packageManagerCwd, this.agentDir, {
      DefaultPackageManager,
      SettingsManager
    })
    if (!writing() || !this.sourceCache) this.sourceCache = snapshot
    return writing() && this.sourceCache ? this.sourceCache : snapshot
  }

  private async probeCandidate(
    source: string,
    activeSource: string,
    registry?: string
  ): Promise<void> {
    const root = join(this.stagingRoot, randomUUID())
    const stagingAgentDir = join(root, 'agent')
    const stagingCwd = join(root, 'workspace')
    await mkdir(stagingCwd, { recursive: true })

    console.info('[Pi Desk][PluginManagement] 开始在隔离 AgentDir 预检候选插件', { source })
    try {
      // npm 解析结果没有 registry 表示本机模式，预检需保留完整项目配置而非单个源地址。
      if (!registry && l2PluginNpmName(source)) {
        for (const configPath of ['.npmrc', join('etc', 'npmrc')]) {
          const target = join(stagingAgentDir, 'npm', configPath)
          await mkdir(dirname(target), { recursive: true })
          try {
            await copyFile(join(this.agentDir, 'npm', configPath), target)
            console.info('[Pi Desk][PluginManagement] 已为隔离预检继承本机 npm 配置', {
              source,
              configPath
            })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
              throw new L2PluginManagementInvalidPackageError(
                `无法继承本机 npm 配置（${configPath}）：${errorMessage(error)}`
              )
          }
        }
      }
      await runL4PiPackageMaintenance({
        maintenance: { action: 'install', source, ...(registry ? { registry } : {}) },
        agentDir: stagingAgentDir,
        cwd: stagingCwd
      })

      this.assertOpen()
      const staging = this.createPackageManager(stagingAgentDir, stagingCwd)
      this.throwSettingsErrors(staging.settingsManager)
      const configured = staging.packageManager
        .listConfiguredPackages()
        .filter((item) => item.scope === 'user')
      const candidate = configured[0]
      if (!candidate?.installedPath) {
        throw new L2PluginManagementInvalidPackageError('候选插件安装后没有有效目录')
      }

      await this.verifyPackageVersion(source, candidate.installedPath)

      const diagnostics = await runL4PiPluginProbe(stagingCwd, stagingAgentDir, true)
      if (diagnostics.loadError) {
        throw new L2PluginManagementInvalidPackageError(diagnostics.loadError)
      }
      const failed = diagnostics.packages.find((item) => item.status === 'failed')
      if (failed?.error) {
        throw new L2PluginManagementInvalidPackageError(failed.error.message)
      }

      const candidatePluginName = diagnostics.packages[0]?.pluginName
      if (candidatePluginName) {
        const conflict = getL4PiGlobalPluginRuntime()
          .readDiagnostics()
          .packages.find(
            (item) => item.source !== activeSource && item.pluginName === candidatePluginName
          )
        if (conflict) {
          throw new L2PluginManagementInvalidPackageError(
            `pluginName 已由其他 Package 注册：${candidatePluginName}`
          )
        }
      }
      this.assertOpen()
      console.info('[Pi Desk][PluginManagement] 候选插件隔离预检通过', { source })
    } catch (error) {
      if (error instanceof L2PluginManagementInvalidPackageError) throw error
      throw new L2PluginManagementInvalidPackageError(errorMessage(error))
    } finally {
      await rm(root, { recursive: true, force: true }).catch((error: unknown) => {
        console.warn('[Pi Desk][PluginManagement] 清理候选插件目录失败', {
          path: root,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      })
    }
  }

  private restartWhenQuiet(mode?: 'normal' | 'basic'): Promise<L2PluginManagementSnapshot> {
    return this.workSessions.runPluginRestart(async () => {
      const runtime = getL4PiGlobalPluginRuntime()
      const snapshot = await this.readSnapshot(false)
      await runtime.prepareReload()
      console.info('[Pi Desk][PluginManagement] 插件 Runtime 已通过静默检查，准备重启', {
        deferredCount: this.deferredMaintenance.size
      })
      scheduleL4PiDeskRestart(
        mode === 'basic' || this.deferredMaintenance.size === 0
          ? undefined
          : [...this.deferredMaintenance.values()],
        mode
      )
      return snapshot
    })
  }

  private async readDetail(source: string): Promise<L2PluginManagementDetail> {
    if (isL4PiDeskSafeMode()) {
      throw new L2PluginManagementOperationConflictError('基础模式不执行插件能力盘点')
    }
    const target = (await this.readSources()).sources.find((item) => item.source === source)
    const packageRoot = target ? await l4PiPluginSourceRoot(target) : null
    if (!packageRoot) throw new L2PluginManagementNotFoundError(source)

    const snapshot = await this.readCapabilities(false)
    const capabilities = snapshot.packages.find((item) => item.source === source)
    if (!capabilities) {
      throw new Error(snapshot.loadError ?? `插件能力详情不可用：${source}`)
    }

    const [skills, prompts] = await Promise.all([
      Promise.all(
        capabilities.skills.map(async (skill) => ({
          name: skill.name,
          description: skill.description,
          path: skill.path,
          modelVisible: skill.modelVisible,
          ...(await readPluginResource(packageRoot, skill.filePath))
        }))
      ),
      Promise.all(
        capabilities.prompts.map(async (prompt) => ({
          name: prompt.name,
          description: prompt.description,
          path: prompt.path,
          ...(await readPluginResource(packageRoot, prompt.filePath))
        }))
      )
    ])

    return L2PluginManagementDetailSchema.parse({
      source,
      readme: await readL4PluginReadme(packageRoot),
      tools: capabilities.tools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        state: tool.state,
        description: tool.description,
        parameters: tool.parameters,
        promptSnippet: tool.promptSnippetDetail,
        promptGuidelines: tool.promptGuidelines
      })),
      skills,
      prompts
    })
  }

  private async readSnapshot(
    input: boolean | L2PluginManagementListRequest
  ): Promise<L2PluginManagementSnapshot> {
    const request = typeof input === 'boolean' ? { checkUpdates: input } : input
    if (isL4PiDeskSafeMode()) {
      return { plugins: [], restartRequired: false, loadError: this.maintenanceError }
    }
    const current = this.createPackageManager()
    const settingsErrors = current.settingsManager.drainErrors().map((item) => item.error.message)
    const configured = current.packageManager
      .listConfiguredPackages()
      .filter((item) => item.scope === 'user')
    const packageRootError = await readL4PiPackageRootConsistencyError({
      agentDir: this.agentDir,
      configured
    })

    const sourceSnapshot = await this.readSources()
    const updates = await this.updates.read(sourceSnapshot.sources, request)
    const runtime = getL4PiGlobalPluginRuntime()
    const diagnostics = runtime.readDiagnostics()
    const diagnosticsBySource = new Map(
      diagnostics.packages.map((diagnostic) => [diagnostic.source, diagnostic])
    )
    const nativeDiagnostics = readL4PiPluginNativeDiagnostics()
    const capabilitySnapshot = this.capabilityCache ?? { packages: [], loadError: null }
    const capabilitiesBySource = new Map(
      capabilitySnapshot.packages.map((capabilities) => [capabilities.source, capabilities])
    )
    const piDeskCapabilitiesBySource = new Map(
      runtime
        .readCapabilityRegistrations()
        .map((capabilities) => [capabilities.source, capabilities])
    )

    const plugins = await Promise.all(
      sourceSnapshot.sources.map(async (item): Promise<L2PluginManagementItem> => {
        const globalDiagnostic = diagnosticsBySource.get(item.source)
        const nativeDiagnostic = item.path
          ? this.findNativeDiagnostic(item.path, nativeDiagnostics)
          : null
        const error: L2PluginManagementError | null =
          (item.error
            ? { phase: item.kind === 'package' ? 'package' : 'entry', message: item.error }
            : null) ??
          (globalDiagnostic?.status === 'failed' ? globalDiagnostic.error : null) ??
          (nativeDiagnostic ? { phase: 'native', message: nativeDiagnostic } : null)
        return {
          source: item.source,
          kind: item.kind,
          operation: this.operationFor(item.source),
          pluginName: globalDiagnostic?.pluginName ?? null,
          description: item.description,
          version: item.version ?? globalDiagnostic?.version ?? null,
          updateAvailable: updates.get(item.source)?.updateAvailable ?? null,
          updateTag: updates.get(item.source)?.updateTag ?? null,
          availableVersion: updates.get(item.source)?.availableVersion ?? null,
          updateError: updates.get(item.source)?.updateError ?? null,
          status: !item.enabled
            ? 'disabled'
            : error
              ? 'failed'
              : globalDiagnostic?.status === 'ready'
                ? 'ready'
                : 'available',
          error,
          capabilities: pluginCapabilities(
            capabilitiesBySource.get(item.source),
            piDeskCapabilitiesBySource.get(item.source),
            capabilitySnapshot.loadError
          )
        }
      })
    )

    for (const [source, operation] of this.operations) {
      if (
        plugins.some(
          (item) => l2PluginSourceIdentity(item.source) === l2PluginSourceIdentity(source)
        )
      )
        continue
      plugins.push({
        source,
        kind: 'package',
        operation,
        pluginName: null,
        description: null,
        version: null,
        updateAvailable: null,
        updateTag: l2PluginNpmName(source) ? readL4PiPluginUpdateTag(source, this.agentDir) : null,
        availableVersion: null,
        updateError: null,
        status: operation.phase === 'failed' ? 'failed' : 'available',
        error: null,
        capabilities: pluginCapabilities(undefined, undefined, null)
      })
    }
    return L2PluginManagementSnapshotSchema.parse({
      plugins: plugins.sort((left, right) => left.source.localeCompare(right.source)),
      restartRequired: this.restartRequired,
      loadError: combineLoadErrors([
        ...settingsErrors,
        ...sourceSnapshot.errors,
        ...(diagnostics.loadError ? [diagnostics.loadError] : []),
        ...(this.maintenanceError ? [this.maintenanceError] : []),
        ...(packageRootError ? [packageRootError] : [])
      ])
    })
  }

  private async readCapabilities(force: boolean): Promise<L4PiPluginCapabilitySnapshot> {
    if (!force && this.capabilityCache) return this.capabilityCache

    try {
      this.capabilityCache = await runL4PiPackageRootExclusive(() => {
        this.assertOpen()
        if (!force && this.capabilityCache) return Promise.resolve(this.capabilityCache)
        return runL4PiPluginCapabilityProbe(this.cwd, this.agentDir)
      })
      this.publish()
      console.info('[Pi Desk][PluginManagement] 插件能力盘点完成', {
        packageCount: this.capabilityCache.packages.length,
        hasLoadError: this.capabilityCache.loadError !== null
      })
      return this.capabilityCache
    } catch (error) {
      const message = errorMessage(error)
      console.warn('[Pi Desk][PluginManagement] 插件能力盘点失败', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        message
      })
      this.capabilityCache = { packages: [], loadError: message }
      this.publish()
      return this.capabilityCache
    }
  }

  private findNativeDiagnostic(
    installedPath: string,
    diagnostics: readonly { message: string }[]
  ): string | null {
    const packagePath = normalizedSearchPath(installedPath)
    const matched = diagnostics.find((diagnostic) => {
      const message =
        process.platform === 'win32'
          ? diagnostic.message.replaceAll('\\', '/').toLowerCase()
          : diagnostic.message.replaceAll('\\', '/')
      return message.includes(packagePath)
    })
    return matched?.message ?? null
  }

  private createPackageManager(
    agentDir = this.agentDir,
    cwd = this.packageManagerCwd
  ): {
    settingsManager: SettingsManager
    packageManager: DefaultPackageManager
  } {
    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: false
    })
    return {
      settingsManager,
      packageManager: new DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager
      })
    }
  }

  private candidateSource(source: string, installedPath: string | undefined): string {
    if (isAbsolute(source) || /^(?:[a-z][a-z0-9+.-]*:|git@)/i.test(source)) {
      return source
    }
    return installedPath ? resolve(installedPath) : resolve(this.agentDir, source)
  }

  private operationFor(source: string): L2PluginManagementOperation | null {
    const identity = l2PluginSourceIdentity(source)
    return (
      [...this.operations].find(([key]) => l2PluginSourceIdentity(key) === identity)?.[1] ?? null
    )
  }

  private normalizeAddedSource(source: string): string {
    if (/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*(?:@[^\s/]+)?$/i.test(source))
      return `npm:${source}`
    if (isAbsolute(source) || /^(?:[a-z][a-z0-9+.-]*:|git@)/i.test(source)) {
      return source
    }
    return resolve(this.cwd, source)
  }

  private throwSettingsErrors(settingsManager: SettingsManager): void {
    const errors = settingsManager.drainErrors()
    if (errors.length === 0) return
    throw new Error(errors.map((item) => item.error.message).join('; '))
  }

  private assertRestartAvailable(): void {
    if (!canRestartL4PiDesk()) throw new L2PluginManagementRestartUnavailableError()
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = (): Promise<T> =>
      this.staleStagingCleanup.then(() => {
        this.assertOpen()
        return operation()
      })
    const result = this.operationTail.then(guarded, guarded)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

declare global {
  var __piDeskPluginManagement: L2PluginManagement | undefined
}

export function disposeL2PluginManagement(): void {
  globalThis.__piDeskPluginManagement?.dispose()
}

export function initializeL2PluginManagement(workSessions: L2PluginManagementWorkSessions): void {
  if (!globalThis.__piDeskPluginManagement) {
    globalThis.__piDeskPluginManagement = new L2PluginManagement(workSessions)
  }
}

export function getL2PluginManagement(): L2PluginManagement {
  if (!globalThis.__piDeskPluginManagement) {
    throw new Error('插件管理尚未完成进程级装配')
  }
  return globalThis.__piDeskPluginManagement
}
