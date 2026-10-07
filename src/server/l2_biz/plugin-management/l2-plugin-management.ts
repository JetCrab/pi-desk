import 'server-only'

import { isL4PiDeskSafeMode } from '@server/l4_foundation/pi/l4-pi-desk-mode'
import { getL4PiDeskDataDir } from '@server/l4_foundation/pi/l4-pi-desk-data-dir'

import {
  createL4BilingualText,
  type L4LocalizedText
} from '@common/l4_foundation/locale/l4-localized-text'

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
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
  type L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
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

const L2_PLUGIN_UPDATE_CACHE_TTL_MS = 5 * 60 * 1000
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

interface L2PluginUpdateCache {
  expiresAt: number
  sources: ReadonlySet<string>
}

type L2PluginMutation = 'add' | 'update' | 'del'

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
  mutation: L2PluginMutation,
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
  private updateCache: L2PluginUpdateCache | null = null
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

  list(checkUpdates = false): Promise<L2PluginManagementSnapshot> {
    this.assertOpen()
    return this.readSnapshot(checkUpdates)
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

  add(source: string): Promise<L2PluginManagementSnapshot> {
    return this.mutate('add', this.normalizeAddedSource(source))
  }

  update(source: string): Promise<L2PluginManagementSnapshot> {
    return this.mutate('update', source)
  }

  reinstall(source: string, previousSource?: string): Promise<L2PluginManagementSnapshot> {
    return this.mutate('add', this.normalizeAddedSource(source), true, previousSource)
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
    previousSource?: string
  ): Promise<L2PluginManagementSnapshot> {
    this.assertOpen()
    if (isL4PiDeskSafeMode()) {
      throw new L2PluginManagementOperationConflictError(
        '基础模式不执行插件维护，请通过基础聊天修复或正常启动后维护'
      )
    }
    this.assertRestartAvailable()
    const snapshot = await this.readSources()
    this.assertOpen()
    if (mutation !== 'add') {
      const target = snapshot.sources.find((item) => item.source === source)
      if (!target) throw new L2PluginManagementNotFoundError(source)
      if (target.kind !== 'package') {
        throw new L2PluginManagementInvalidPackageError(
          '裸扩展不是已安装包，请编辑源码后加载变更；此操作不会删除源码'
        )
      }
    }
    for (const candidate of [source, ...(previousSource ? [previousSource] : [])]) {
      const previous = this.operations.get(candidate)
      if (previous && previous.phase !== 'failed') {
        throw new L2PluginManagementOperationConflictError('该来源已有未完成的维护操作')
      }
    }
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
    this.operations.set(source, { action: mutation, phase: 'queued', message: null })
    this.publish()
    void this.runExclusive(async () => {
      this.activeSource = source
      try {
        await this.executeMutation(mutation, source, reinstall, previousSource)
        if (!this.deferredMaintenance.has(source)) {
          this.operations.delete(source)
          await this.apply(mutation === 'add' ? undefined : [source])
        }
      } catch (error) {
        if (!this.operations.has(source))
          this.operations.set(source, { action: mutation, phase: 'failed', message: null })
        this.setOperation(source, 'failed', errorMessage(error))
      } finally {
        this.sourceCache = null
        this.activeSource = null
        this.publish()
      }
    }).catch((error: unknown) => {
      if (!this.disposed) this.setOperation(source, 'failed', errorMessage(error))
    })
    return this.readSnapshot(false)
  }

  private async executeMutation(
    mutation: L2PluginMutation,
    source: string,
    reinstall = false,
    previousSource?: string
  ): Promise<void> {
    this.assertRestartAvailable()
    const current = this.createPackageManager()
    this.throwSettingsErrors(current.settingsManager)
    const configured = current.packageManager
      .listConfiguredPackages()
      .filter((item) => item.scope === 'user')
    const packageRootError = await readL4PiPackageRootConsistencyError({
      agentDir: this.agentDir,
      configured
    })
    if (packageRootError) throw new L2PluginManagementPackageRootError(packageRootError)

    const target = configured.find((item) => item.source === source)
    if (mutation !== 'add' && !target) {
      throw new L2PluginManagementNotFoundError(source)
    }

    const resolvedSource = this.candidateSource(source, target?.installedPath)
    if (mutation !== 'del') {
      this.setOperation(source, 'checking', null)
      await this.probeCandidate(resolvedSource, previousSource ?? source)
    }
    this.setOperation(source, 'applying', null)

    const request: L4PiDeskPackageMaintenanceRequest = reinstall
      ? { action: 'reinstall', source: resolvedSource }
      : maintenanceRequest(mutation, resolvedSource)
    if (this.deferredMaintenance.size > 0) {
      this.deferredMaintenance.set(source, request)
      this.setOperation(source, 'waiting', '已加入本次重启的顺序维护批次；维护命令尚未执行')
      return
    }
    this.updateCache = null
    this.capabilityCache = null
    try {
      // 先撤销外层入口；原目录被占用时沿用下方的延后重启流程。
      await getL4PiGlobalPluginRuntime().replaceSource(previousSource ?? source, null)
      await runL4PiPackageRootExclusive(() =>
        runL4PiPackageMaintenance({
          maintenance: request,
          agentDir: this.agentDir,
          cwd: this.packageManagerCwd
        })
      )
      console.info('[Pi Desk][PluginManagement] Pi Package 在线操作完成，准备应用', {
        action: request.action,
        source: request.source
      })
    } catch (error) {
      if (error instanceof L4PiPackageMaintenanceError && error.kind === 'locked') {
        this.deferredMaintenance.set(source, request)
        this.setOperation(source, 'waiting', '包文件被占用，维护结果尚未确认；等待手动重启后执行')
        console.warn('[Pi Desk][PluginManagement] Package 文件被占用，操作延后到重启期间', {
          action: request.action,
          source: request.source,
          message: error.message
        })
      } else {
        throw error
      }
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

  private async probeCandidate(source: string, activeSource: string): Promise<void> {
    const root = join(this.stagingRoot, randomUUID())
    const stagingAgentDir = join(root, 'agent')
    const stagingCwd = join(root, 'workspace')
    await mkdir(stagingCwd, { recursive: true })

    console.info('[Pi Desk][PluginManagement] 开始在隔离 AgentDir 预检候选插件', { source })
    try {
      await runL4PiPackageMaintenance({
        maintenance: { action: 'install', source },
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

      const metadata = await readPackageMetadata(candidate.installedPath)
      if (metadata.error) {
        throw new L2PluginManagementInvalidPackageError(
          typeof metadata.error.message === 'string'
            ? metadata.error.message
            : metadata.error.message.default
        )
      }

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

  private async readSnapshot(checkUpdates: boolean): Promise<L2PluginManagementSnapshot> {
    if (isL4PiDeskSafeMode()) {
      return { plugins: [], restartRequired: false, loadError: this.maintenanceError }
    }
    const current = this.createPackageManager()
    const settingsErrors = current.settingsManager.drainErrors().map((item) => item.error.message)
    const configured = current.packageManager
      .listConfiguredPackages()
      .filter((item) => item.scope === 'user')
    const updateSources = await this.readUpdateSources(current.packageManager, checkUpdates)
    const packageRootError = await readL4PiPackageRootConsistencyError({
      agentDir: this.agentDir,
      configured
    })

    const sourceSnapshot = await this.readSources()
    const runtime = getL4PiGlobalPluginRuntime()
    const diagnostics = runtime.readDiagnostics()
    const diagnosticsBySource = new Map(
      diagnostics.packages.map((diagnostic) => [diagnostic.source, diagnostic])
    )
    const nativeDiagnostics = readL4PiPluginNativeDiagnostics()
    const capabilitySnapshot = checkUpdates
      ? await this.readCapabilities(true)
      : (this.capabilityCache ?? { packages: [], loadError: null })
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
          operation: this.operations.get(item.source) ?? null,
          pluginName: globalDiagnostic?.pluginName ?? null,
          description: item.description,
          version: item.version ?? globalDiagnostic?.version ?? null,
          updateAvailable:
            item.kind === 'package' && updateSources ? updateSources.has(item.source) : null,
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
      if (plugins.some((item) => item.source === source)) continue
      plugins.push({
        source,
        kind: 'package',
        operation,
        pluginName: null,
        description: null,
        version: null,
        updateAvailable: null,
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

  private async readUpdateSources(
    packageManager: DefaultPackageManager,
    checkUpdates: boolean
  ): Promise<ReadonlySet<string> | null> {
    const now = Date.now()
    if (this.updateCache && this.updateCache.expiresAt > now) return this.updateCache.sources
    if (!checkUpdates) return null

    const updates = await runL4PiPackageRootExclusive(() =>
      packageManager.checkForAvailableUpdates()
    )
    const sources = new Set(
      updates.filter((item) => item.scope === 'user').map((item) => item.source)
    )
    this.updateCache = {
      expiresAt: now + L2_PLUGIN_UPDATE_CACHE_TTL_MS,
      sources
    }
    return sources
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

  private normalizeAddedSource(source: string): string {
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
