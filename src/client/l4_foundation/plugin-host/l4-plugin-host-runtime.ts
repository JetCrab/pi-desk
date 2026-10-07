'use client'

import {
  BrowserPluginError,
  type BrowserApplicationContributionDefinition,
  type BrowserApplicationTarget,
  type BrowserComposerPanelContributionDefinition,
  type BrowserComposerPanelTarget,
  type BrowserConnectionHost,
  type BrowserFilePreviewMode,
  type BrowserFilePreviewOptions,
  type BrowserConnectionSnapshot,
  type BrowserContributionDefinitionMap,
  type BrowserContributionDescriptor,
  type BrowserContributionIcon,
  type BrowserContributionImplementation,
  type BrowserContributionKind,
  type BrowserContributionLoadState,
  type BrowserEntryFactory,
  type BrowserEntryRuntime,
  type BrowserEntryState,
  type BrowserMessageViewContributionDefinition,
  type BrowserMount,
  type BrowserMessageViewTarget,
  type BrowserNotificationInput,
  type BrowserPluginFacade,
  type BrowserPluginGlobalStateHost,
  type BrowserPluginHost,
  type BrowserPluginNotificationEventListener,
  type BrowserSessionSidebarTabContributionDefinition,
  type BrowserSessionSidebarTabTarget,
  type BrowserSettingsPageContributionDefinition,
  type BrowserSettingsPageTarget,
  type BrowserThemeHost,
  type BrowserThemeSnapshot,
  type BrowserWorkSessionCreateInput,
  type BrowserWorkSessionGoToInput,
  type BrowserWorkSessionHost,
  type PiNativeBrowserChannel,
  type PiDeskBrowserChannel,
  type PluginDisposer,
  type PluginJsonObject,
  type PluginPushMessage,
  type PluginSource,
  type PluginWorkSession
} from '@jetcrab/pi-desk-sdk/browser'
import { L4ProjectFilePathSchema } from '@common/l4_foundation/file/l4-project-file-contract'
import { readL4Theme, subscribeL4Theme } from '@client/l4_foundation/theme/l4-theme-provider'
import {
  readL4HostSettings,
  subscribeL4HostSettings
} from '@client/l4_foundation/locale/l4-region-store'
import { L4PluginLogHostRuntime, type L4PluginLogChannel } from './l4-plugin-log-runtime'
import {
  disposeL4PluginResource as disposePluginResource,
  runL4PluginCallback as runPluginCallback
} from './l4-plugin-host-lifecycle'

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
  return value
}

const CONTRIBUTION_LABEL_MAX_LENGTH = 100
const CONTRIBUTION_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VIEW_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const BUILTIN_ICON_NAMES = new Set([
  'plugin',
  'server',
  'rocket',
  'settings',
  'panel',
  'message',
  'terminal',
  'file',
  'folder',
  'bot',
  'wrench',
  'database',
  'globe'
])
const CONTRIBUTION_KINDS = new Set<L4PluginContributionKind>([
  'application',
  'composer-panel',
  'settings-page',
  'message-view',
  'session-sidebar-tab'
])

function readBrowserFilePreviewMode(
  options: BrowserFilePreviewOptions | undefined
): BrowserFilePreviewMode {
  if (
    options !== undefined &&
    (options === null || typeof options !== 'object' || Array.isArray(options))
  ) {
    throw new Error('文件预览选项无效')
  }
  const mode = options?.mode
  if (mode === undefined || mode === 'session' || mode === 'expanded' || mode === 'standalone') {
    return mode ?? 'session'
  }
  throw new Error('文件预览模式无效')
}

export type L4PluginBrowserContributionDescriptor = BrowserContributionDescriptor
export type L4PluginGlobalStates = Record<string, PluginJsonObject>

export interface L4PluginNotificationEvent {
  type: 'plugin'
  pluginName: string
  name: string
  data: PluginJsonObject
}

export interface L4PluginBrowserEntryDescriptor {
  pluginName: string
  url: string
}

export interface L4PluginBrowserDescriptor {
  pluginName: string
  contributions: readonly L4PluginBrowserContributionDescriptor[]
}

export interface L4PluginRegistrySnapshot {
  revision: number
  descriptors: readonly L4PluginBrowserDescriptor[]
}

export interface L4PluginHostTransport {
  readonly pi: PiNativeBrowserChannel
  listBrowserEntries(): Promise<readonly L4PluginBrowserEntryDescriptor[]>
  subscribePush(listener: (message: PluginPushMessage) => void): () => void
  createPiDeskChannel(pluginName: string): PiDeskBrowserChannel
  createLogChannel(pluginName: string): L4PluginLogChannel
}

export type L4PluginNotificationSink = (pluginName: string, input: BrowserNotificationInput) => void
export type L4PluginContributionKind = BrowserContributionKind

export interface L4PluginHostWorkSessionInput {
  workId: string
  sessionId: string
  branchId: string
  cwd: string
  status: PluginWorkSession['status']
}

export type L4PluginHostWorkSessionCreate = (cwd: string) => Promise<L4PluginHostWorkSessionInput>
export type L4PluginHostWorkSessionGoTo = (
  input: BrowserWorkSessionGoToInput
) => Promise<L4PluginHostWorkSessionInput>

export interface L4PluginHostWorkSessionFilePreviewInput {
  source: PluginSource
  cwd: string
  path: string
  mode?: BrowserFilePreviewMode
  imagePaths?: readonly string[]
}

export type L4PluginHostWorkSessionFilePreview = (
  input: L4PluginHostWorkSessionFilePreviewInput
) => void

export type L4PluginHostWorkSessionFileReveal = (
  input: L4PluginHostWorkSessionFilePreviewInput
) => Promise<void>

export type L4PluginHostImageReader = (
  input: Pick<L4PluginHostWorkSessionFilePreviewInput, 'source' | 'cwd' | 'path'>,
  signal: AbortSignal
) => Promise<Blob | null>

export type L4PluginMessageViewResolution =
  | {
      status: 'winner'
      pluginName: string
      descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'message-view' }>
    }
  | {
      status: 'conflict'
      viewKey: string
      candidates: ReadonlyArray<{
        pluginName: string
        descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'message-view' }>
      }>
    }
  | null

interface L4PluginContributionRegistration {
  pluginName: string
  kind: L4PluginContributionKind
  contributionName: string
  descriptor: L4PluginBrowserContributionDescriptor
  load: () => Promise<BrowserContributionImplementation>
  resolve?: BrowserApplicationContributionDefinition['resolve']
  owner: L4PluginEntryOwner
}

interface L4PluginEntryOwner {
  descriptor: L4PluginBrowserEntryDescriptor
  host: BrowserPluginHost
  registrations: Map<string, L4PluginContributionRegistration>
  pushListeners: Set<(message: PluginPushMessage) => void>
  notificationEventListeners: Map<string, BrowserPluginNotificationEventListener>
  globalStateListeners: Set<() => void>
  subscriptionDisposers: Set<() => void>
  mounts: Set<PluginDisposer>
  disposer: PluginDisposer | null
  registrationOpen: boolean
  active: boolean
}

interface L4PluginReadyEntryRuntime extends BrowserEntryRuntime {
  owner: L4PluginEntryOwner
}

interface L4PluginEntryNamespace {
  default?: unknown
}

export type L4PluginEntryImporter = (url: string) => Promise<L4PluginEntryNamespace>

export type L4PluginContributionTarget =
  | BrowserApplicationTarget
  | BrowserComposerPanelTarget
  | BrowserSettingsPageTarget
  | BrowserMessageViewTarget
  | BrowserSessionSidebarTabTarget

export interface L4PluginContributionMountInput {
  pluginName: string
  kind: L4PluginContributionKind
  contributionName: string
  container: HTMLElement
  target: L4PluginContributionTarget
  signal?: AbortSignal
}

function contributionKey(kind: L4PluginContributionKind, contributionName: string): string {
  return `${kind}\u0000${contributionName}`
}

function pluginContributionKey(
  pluginName: string,
  kind: L4PluginContributionKind,
  contributionName: string
): string {
  return `${pluginName}\u0000${contributionKey(kind, contributionName)}`
}

function defaultEntryImporter(url: string): Promise<L4PluginEntryNamespace> {
  return import(/* webpackIgnore: true */ url) as Promise<L4PluginEntryNamespace>
}

function resolvedTheme(): BrowserThemeSnapshot {
  if (typeof document === 'undefined') return { mode: 'light' }
  readL4Theme()
  return Object.freeze({
    mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  })
}

function sameSource(left: PluginSource, right: PluginSource): boolean {
  return (
    left.workId === right.workId &&
    left.sessionId === right.sessionId &&
    left.branchId === right.branchId
  )
}

function toPluginWorkSession(workSession: L4PluginHostWorkSessionInput): PluginWorkSession {
  return {
    source: {
      workId: workSession.workId,
      sessionId: workSession.sessionId,
      branchId: workSession.branchId
    },
    cwd: workSession.cwd,
    status: workSession.status
  }
}

function toPluginWorkSessions(
  workSessions: readonly L4PluginHostWorkSessionInput[]
): readonly PluginWorkSession[] {
  return workSessions.map(toPluginWorkSession)
}

function sameWorkSessions(
  left: readonly PluginWorkSession[],
  right: readonly PluginWorkSession[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        right[index] !== undefined &&
        sameSource(item.source, right[index].source) &&
        item.cwd === right[index].cwd &&
        item.status === right[index].status
    )
  )
}

function parseLabel(value: string, field: string): string {
  const label = value.trim()
  if (!label || label.length > CONTRIBUTION_LABEL_MAX_LENGTH) {
    throw new Error(`${field} must contain 1-${CONTRIBUTION_LABEL_MAX_LENGTH} characters`)
  }
  return label
}

function parsePriority(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Message View priority must be a safe integer')
  return value
}

function parseContributionName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Contribution name 必须是字符串')
  const name = value.trim()
  if (!name || name.length > 64 || !CONTRIBUTION_NAME_PATTERN.test(name)) {
    throw new Error('Contribution name 必须是 1-64 字符的小写 kebab-case')
  }
  return name
}

function parseViewKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Message View viewKey 必须是字符串')
  const viewKey = value.trim()
  if (viewKey.length < 3 || viewKey.length > 129 || !VIEW_KEY_PATTERN.test(viewKey)) {
    throw new Error('Message View viewKey 必须是 plugin-name/view-name')
  }
  return viewKey
}

function cloneIcon(value: unknown): BrowserContributionIcon | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Contribution icon 无效')
  }
  const icon = value as Record<string, unknown>
  if (icon.type === 'builtin') {
    if (
      Object.keys(icon).length !== 2 ||
      typeof icon.name !== 'string' ||
      !BUILTIN_ICON_NAMES.has(icon.name)
    ) {
      throw new Error('Contribution builtin icon 无效')
    }
    return {
      type: 'builtin',
      name: icon.name as Extract<BrowserContributionIcon, { type: 'builtin' }>['name']
    }
  }
  if (icon.type === 'svg') {
    const content = typeof icon.content === 'string' ? icon.content.trim() : ''
    if (Object.keys(icon).length !== 2 || !content || content.length > 16 * 1024) {
      throw new Error('Contribution SVG icon 无效')
    }
    return { type: 'svg', content }
  }
  throw new Error('Contribution icon type 无效')
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'then') === 'function'
  )
}

function sameEntryDescriptors(
  left: readonly L4PluginBrowserEntryDescriptor[],
  right: readonly L4PluginBrowserEntryDescriptor[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class L4PluginHostRuntime {
  private entryDescriptors: readonly L4PluginBrowserEntryDescriptor[] = []
  private readonly entryDescriptorsByPlugin = new Map<string, L4PluginBrowserEntryDescriptor>()
  private readonly entryStates = new Map<string, BrowserEntryState>()
  private readonly ownersByPlugin = new Map<string, L4PluginEntryOwner>()
  private readonly registrations = new Map<string, L4PluginContributionRegistration>()
  private readonly contributionLoadStates = new Map<string, BrowserContributionLoadState>()
  private browserDescriptors: readonly L4PluginBrowserDescriptor[] = []
  private registrySnapshot: L4PluginRegistrySnapshot = {
    revision: 0,
    descriptors: this.browserDescriptors
  }
  private readonly messageViewResolutions = new Map<string, L4PluginMessageViewResolution>()
  private readonly logHosts = new Map<string, L4PluginLogHostRuntime>()
  private readonly registryListeners = new Set<() => void>()
  private readonly workSessionListeners = new Set<() => void>()
  private readonly connectionListeners = new Set<() => void>()
  private readonly themeListeners = new Set<() => void>()
  private globalPluginStates: L4PluginGlobalStates = {}
  private workSessions: readonly PluginWorkSession[] = []
  private workSessionCreate: L4PluginHostWorkSessionCreate | null = null
  private workSessionGoTo: L4PluginHostWorkSessionGoTo | null = null
  private projectPreview: ((directory: string) => void) | null = null
  private terminalOpen: ((cwd: string, signal: AbortSignal) => Promise<void>) | null = null
  private workSessionFilePreview: L4PluginHostWorkSessionFilePreview | null = null
  private workSessionFileReveal: L4PluginHostWorkSessionFileReveal | null = null
  private imageReader: L4PluginHostImageReader | null = null
  private connectionSnapshot: BrowserConnectionSnapshot = {
    status: 'disconnected',
    error: null
  }
  private themeSnapshot: BrowserThemeSnapshot = { mode: 'light' }
  private refreshPromise: Promise<void> | null = null
  private refreshPending = false
  private entriesMaintaining = false
  private entriesInitialized = false
  private entryListError: string | null = null
  private applicationResolveController: AbortController | null = null
  private applicationResolveEpoch = 0
  private readonly applicationVisibility = new Map<string, boolean>()
  private disposed = false
  private readonly unsubscribePush: () => void
  private readonly unsubscribeTheme: () => void
  private readonly removeSystemThemeListener: () => void

  constructor(
    private readonly transport: L4PluginHostTransport,
    private readonly entryImporter: L4PluginEntryImporter = defaultEntryImporter,
    private readonly notifyPlugin: L4PluginNotificationSink = () => undefined
  ) {
    this.unsubscribePush = transport.subscribePush((message) => this.dispatchPush(message))
    const updateTheme = (): void => {
      const next = resolvedTheme()
      if (next.mode === this.themeSnapshot.mode) return
      this.themeSnapshot = next
      this.notify(this.themeListeners)
    }
    this.themeSnapshot = resolvedTheme()
    if (typeof window === 'undefined') {
      this.unsubscribeTheme = () => undefined
      this.removeSystemThemeListener = () => undefined
      return
    }
    this.unsubscribeTheme = subscribeL4Theme(updateTheme)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', updateTheme)
    this.removeSystemThemeListener = () => media.removeEventListener('change', updateTheme)
  }

  subscribeRegistry(listener: () => void): () => void {
    this.registryListeners.add(listener)
    return () => this.registryListeners.delete(listener)
  }

  getBrowserDescriptors(): readonly L4PluginBrowserDescriptor[] {
    return this.browserDescriptors
  }

  getRegisteredBrowserDescriptors(): readonly L4PluginBrowserDescriptor[] {
    return [...this.ownersByPlugin.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pluginName, owner]) => ({
        pluginName,
        contributions: [...owner.registrations.values()]
          .sort((left, right) => {
            const kind = left.kind.localeCompare(right.kind)
            return kind === 0 ? left.contributionName.localeCompare(right.contributionName) : kind
          })
          .map((registration) => structuredClone(registration.descriptor))
      }))
  }

  getRegistrySnapshot(): L4PluginRegistrySnapshot {
    return this.registrySnapshot
  }

  areEntriesInitialized(): boolean {
    return this.entriesInitialized
  }

  isRefreshingEntries(): boolean {
    return this.entriesMaintaining || this.refreshPromise !== null
  }

  setEntriesMaintaining(maintaining: boolean): void {
    if (this.disposed || this.entriesMaintaining === maintaining) return
    this.entriesMaintaining = maintaining
    this.publishRegistryChange()
  }

  getEntryListError(): string | null {
    return this.entryListError
  }

  getEntryState(pluginName: string): BrowserEntryState {
    return this.entryStates.get(pluginName) ?? { status: 'unloaded' }
  }

  getFailedEntries(): ReadonlyArray<{ pluginName: string; error: Error }> {
    return [...this.entryStates.entries()].flatMap(([pluginName, state]) =>
      state.status === 'failed' ? [{ pluginName, error: state.error }] : []
    )
  }

  getContributionLoadState(
    pluginName: string,
    kind: L4PluginContributionKind,
    contributionName: string
  ): BrowserContributionLoadState {
    return (
      this.contributionLoadStates.get(
        pluginContributionKey(pluginName, kind, contributionName)
      ) ?? { status: 'unloaded' }
    )
  }

  getMessageViewResolution(viewKey: string): L4PluginMessageViewResolution {
    return this.messageViewResolutions.get(viewKey) ?? null
  }

  bindWorkSessionCreate(create: L4PluginHostWorkSessionCreate): () => void {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if (this.workSessionCreate) throw new Error('Workbench WorkSession 创建能力已经绑定')
    this.workSessionCreate = create

    let bound = true
    return (): void => {
      if (!bound) return
      bound = false
      if (this.workSessionCreate === create) this.workSessionCreate = null
    }
  }

  bindWorkSessionGoTo(goTo: L4PluginHostWorkSessionGoTo): () => void {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if (this.workSessionGoTo) throw new Error('Workbench WorkSession 前往能力已经绑定')
    this.workSessionGoTo = goTo

    let bound = true
    return (): void => {
      if (!bound) return
      bound = false
      if (this.workSessionGoTo === goTo) this.workSessionGoTo = null
    }
  }

  bindTerminalOpen(open: (cwd: string, signal: AbortSignal) => Promise<void>): () => void {
    if (this.disposed) throw new Error('Plugin Host Runtime 已释放')
    if (this.terminalOpen) throw new Error('终端创建能力已经绑定')
    this.terminalOpen = open
    return (): void => {
      if (this.terminalOpen === open) this.terminalOpen = null
    }
  }

  bindProjectPreview(preview: (directory: string) => void): () => void {
    if (this.disposed) throw new Error('Plugin Host Runtime 已释放')
    if (this.projectPreview) throw new Error('项目预览能力已经绑定')
    this.projectPreview = preview
    return (): void => {
      if (this.projectPreview === preview) this.projectPreview = null
    }
  }

  previewProject(directory: string): void {
    if (this.disposed) throw new Error('Plugin Host Runtime 已释放')
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('项目预览需要有效目录')
    if (!this.projectPreview) throw new Error('项目预览尚未准备好')
    this.projectPreview(directory.trim())
  }

  bindWorkSessionFilePreview(preview: L4PluginHostWorkSessionFilePreview): () => void {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if (this.workSessionFilePreview) throw new Error('Workbench 文件预览能力已经绑定')
    this.workSessionFilePreview = preview

    let bound = true
    return (): void => {
      if (!bound) return
      bound = false
      if (this.workSessionFilePreview === preview) this.workSessionFilePreview = null
    }
  }

  bindImageReader(read: L4PluginHostImageReader): () => void {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if (this.imageReader) throw new Error('Workbench 图片读取能力已经绑定')
    this.imageReader = read
    return () => {
      if (this.imageReader === read) this.imageReader = null
    }
  }

  bindWorkSessionFileReveal(reveal: L4PluginHostWorkSessionFileReveal): () => void {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if (this.workSessionFileReveal) throw new Error('Workbench 文件定位能力已经绑定')
    this.workSessionFileReveal = reveal

    let bound = true
    return (): void => {
      if (!bound) return
      bound = false
      if (this.workSessionFileReveal === reveal) this.workSessionFileReveal = null
    }
  }

  replaceGlobalPluginStates(states: L4PluginGlobalStates): void {
    const next = freezeSnapshot(structuredClone(states))
    const pluginNames = new Set([...Object.keys(this.globalPluginStates), ...Object.keys(next)])
    const changedPluginNames = [...pluginNames].filter(
      (pluginName) =>
        JSON.stringify(this.globalPluginStates[pluginName] ?? null) !==
        JSON.stringify(next[pluginName] ?? null)
    )
    if (changedPluginNames.length === 0) return

    this.globalPluginStates = next
    for (const pluginName of changedPluginNames) {
      const owner = this.ownersByPlugin.get(pluginName)
      if (owner) this.notify(owner.globalStateListeners)
    }
    if (
      this.entriesInitialized &&
      changedPluginNames.some((pluginName) =>
        [...(this.ownersByPlugin.get(pluginName)?.registrations.values() ?? [])].some(
          (registration) => registration.kind === 'application' && registration.resolve
        )
      )
    ) {
      this.scheduleApplicationResolution()
    }
  }

  async dispatchNotificationEvent(
    notificationId: string,
    event: L4PluginNotificationEvent
  ): Promise<void> {
    const state = this.entryStates.get(event.pluginName)
    if (state?.status !== 'ready') {
      throw new Error(`插件 Browser Entry 尚未就绪：${event.pluginName}`)
    }
    const owner = (state.runtime as L4PluginReadyEntryRuntime).owner
    const listener = owner.notificationEventListeners.get(event.name)
    if (!listener) {
      throw new Error(`插件未注册通知事件：${event.pluginName}/${event.name}`)
    }
    await listener({
      notificationId,
      data: structuredClone(event.data)
    })
    if (!owner.active) throw new Error('Browser Entry 已失效')
  }

  replaceWorkSessions(workSessions: readonly L4PluginHostWorkSessionInput[]): void {
    const next = freezeSnapshot(toPluginWorkSessions(workSessions))
    if (sameWorkSessions(this.workSessions, next)) return
    this.workSessions = next
    this.notify(this.workSessionListeners)
    if (this.entriesInitialized) this.scheduleApplicationResolution()
  }

  markConnecting(): void {
    this.replaceConnection({ status: 'connecting', error: null })
  }

  markReady(): void {
    this.replaceConnection({ status: 'ready', error: null })
  }

  markDisconnected(error: string | null = null): void {
    this.setEntriesMaintaining(false)
    this.replaceConnection({ status: 'disconnected', error })
  }

  async refreshEntries(): Promise<void> {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if (this.refreshPromise) {
      this.refreshPending = true
      return this.refreshPromise
    }

    if (!this.entriesInitialized) this.replaceEntriesInitialized(false)

    this.refreshPromise = (async () => {
      try {
        do {
          this.refreshPending = false
          const entries = await this.transport.listBrowserEntries()
          if (this.disposed || this.entriesMaintaining) return
          await this.replaceEntries(entries)
          if (this.disposed) return
          this.replaceEntriesInitialized(true)
          this.replaceEntryListError(null)
        } while (this.refreshPending && !this.disposed)
      } catch (error) {
        this.replaceEntriesInitialized(true)
        this.replaceEntryListError(error instanceof Error ? error.message : String(error))
        this.rebuildRegistry()
        throw error
      }
    })().finally(() => {
      this.refreshPromise = null
      if (!this.disposed) this.publishRegistryChange()
    })
    this.publishRegistryChange()
    return this.refreshPromise
  }

  retryEntry(pluginName: string): Promise<BrowserEntryRuntime> {
    if (this.entryStates.get(pluginName)?.status === 'failed') {
      this.entryStates.delete(pluginName)
      this.publishRegistryChange()
    }
    return this.loadEntry(pluginName).then(async (runtime) => {
      await this.resolveApplications()
      return runtime
    })
  }

  retryContribution(
    pluginName: string,
    kind: L4PluginContributionKind,
    contributionName: string
  ): Promise<BrowserContributionImplementation> {
    const key = pluginContributionKey(pluginName, kind, contributionName)
    if (this.contributionLoadStates.get(key)?.status === 'failed') {
      this.contributionLoadStates.delete(key)
      this.publishRegistryChange()
    }
    const registration = this.registrations.get(key)
    if (!registration) {
      return Promise.reject(
        new BrowserPluginError({
          pluginName,
          contributionName,
          phase: 'registration',
          message: '插件 Contribution 不存在'
        })
      )
    }
    return this.loadContribution(registration)
  }

  async mountContribution(input: L4PluginContributionMountInput): Promise<PluginDisposer> {
    const key = pluginContributionKey(input.pluginName, input.kind, input.contributionName)
    const registration = this.registrations.get(key)
    if (!registration) {
      throw new BrowserPluginError({
        pluginName: input.pluginName,
        contributionName: input.contributionName,
        phase: 'registration',
        message: '插件 Contribution 不存在'
      })
    }
    const controller = new AbortController()
    const cancelled = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    const mounting = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw new Error('插件视图已关闭')
      const implementation = await this.loadContribution(registration)
      if (controller.signal.aborted || !registration.owner.active) {
        throw new Error('插件视图已失效')
      }
      const mount = implementation.mount as unknown as BrowserMount<L4PluginContributionTarget>
      const result = await mount({
        container: input.container,
        target: input.target,
        host: registration.owner.host,
        signal: controller.signal
      })
      if (result !== undefined && typeof result !== 'function') {
        throw new Error('Contribution mount must return void or a disposer')
      }
      return result ?? null
    })

    let disposal: Promise<void> | null = null
    const dispose = (): Promise<void> => {
      if (disposal) return disposal
      registration.owner.mounts.delete(dispose)
      input.signal?.removeEventListener('abort', cancel)
      controller.abort()
      // 先取消，再有界等待；迟到的 mount 仍由同一次清理释放。
      disposal = disposePluginResource(
        input.pluginName,
        `mount:${input.contributionName}`,
        async () => {
          const disposer = await mounting.catch(() => null)
          await disposer?.()
        }
      )
      return disposal
    }
    const cancel = (): void => {
      void dispose()
    }
    registration.owner.mounts.add(dispose)
    input.signal?.addEventListener('abort', cancel, { once: true })
    if (input.signal?.aborted) cancel()
    try {
      await Promise.race([mounting, cancelled])
      if (controller.signal.aborted || !registration.owner.active) {
        throw new Error('插件视图已失效')
      }
      return dispose
    } catch (cause) {
      await dispose()
      if (cause instanceof BrowserPluginError) throw cause
      throw new BrowserPluginError({
        pluginName: input.pluginName,
        contributionName: input.contributionName,
        phase: 'mount',
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      })
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.applicationResolveController?.abort()
    this.applicationResolveController = null
    this.unsubscribePush()
    this.unsubscribeTheme()
    this.removeSystemThemeListener()

    const owners = [...this.ownersByPlugin.values()].reverse()
    this.ownersByPlugin.clear()
    await Promise.all(owners.map((owner) => this.disposeEntryOwner(owner)))

    // ESM import 不可取消；迟到入口会在执行 factory 前检查是否已失效。
    this.entriesMaintaining = false
    this.entryStates.clear()
    this.entryDescriptorsByPlugin.clear()
    this.entryDescriptors = []
    this.registrations.clear()
    this.contributionLoadStates.clear()
    this.browserDescriptors = []
    this.messageViewResolutions.clear()
    this.applicationVisibility.clear()

    for (const logHost of this.logHosts.values()) logHost.dispose()
    this.logHosts.clear()
    this.globalPluginStates = {}
    this.workSessionCreate = null
    this.workSessionGoTo = null
    this.workSessionFilePreview = null
    this.workSessionFileReveal = null
    this.imageReader = null
    this.projectPreview = null
    this.terminalOpen = null
    this.registryListeners.clear()
    this.workSessionListeners.clear()
    this.connectionListeners.clear()
    this.themeListeners.clear()
  }

  private async replaceEntries(entries: readonly L4PluginBrowserEntryDescriptor[]): Promise<void> {
    const sorted = [...entries].sort((left, right) =>
      left.pluginName.localeCompare(right.pluginName)
    )
    const nextByPlugin = new Map<string, L4PluginBrowserEntryDescriptor>()
    for (const descriptor of sorted) {
      if (nextByPlugin.has(descriptor.pluginName)) {
        throw new Error(`重复 Plugin Browser Entry：${descriptor.pluginName}`)
      }
      nextByPlugin.set(descriptor.pluginName, descriptor)
    }

    for (const [pluginName, previous] of this.entryDescriptorsByPlugin) {
      const next = nextByPlugin.get(pluginName)
      if (next?.url === previous.url) continue
      this.disposeEntry(pluginName)
    }

    if (this.disposed) return
    this.entryDescriptorsByPlugin.clear()
    for (const [pluginName, descriptor] of nextByPlugin) {
      this.entryDescriptorsByPlugin.set(pluginName, descriptor)
    }
    const changed = !sameEntryDescriptors(this.entryDescriptors, sorted)
    this.entryDescriptors = structuredClone(sorted)

    await Promise.allSettled(sorted.map((descriptor) => this.loadEntry(descriptor.pluginName)))
    await this.resolveApplications()
    if (changed) this.publishRegistryChange()
  }

  private loadEntry(pluginName: string): Promise<BrowserEntryRuntime> {
    if (this.disposed) return Promise.reject(new Error('Plugin Host Runtime has been disposed'))
    const descriptor = this.entryDescriptorsByPlugin.get(pluginName)
    if (!descriptor) return Promise.reject(new Error(`Plugin Browser Entry 不存在：${pluginName}`))
    const state = this.entryStates.get(pluginName)
    if (state?.status === 'ready') return Promise.resolve(state.runtime)
    if (state?.status === 'loading') return state.promise
    if (state?.status === 'failed') return Promise.reject(state.error)

    const promise = this.initializeEntry(descriptor).then(
      (runtime) => {
        if (
          !this.disposed &&
          this.entryDescriptorsByPlugin.get(pluginName)?.url === descriptor.url
        ) {
          this.entryStates.set(pluginName, { status: 'ready', runtime })
          this.ownersByPlugin.set(pluginName, (runtime as L4PluginReadyEntryRuntime).owner)
          this.commitRegistrations((runtime as L4PluginReadyEntryRuntime).owner)
          this.rebuildRegistry()
        } else {
          void runtime.dispose()
        }
        this.publishRegistryChange()
        return runtime
      },
      (cause: unknown) => {
        const error =
          cause instanceof Error
            ? cause
            : new BrowserPluginError({
                pluginName,
                phase: 'entry-import',
                message: String(cause)
              })
        if (
          !this.disposed &&
          this.entryDescriptorsByPlugin.get(pluginName)?.url === descriptor.url
        ) {
          this.entryStates.set(pluginName, { status: 'failed', error })
          this.rebuildRegistry()
          this.publishRegistryChange()
        }
        throw error
      }
    )
    this.entryStates.set(pluginName, { status: 'loading', promise })
    this.publishRegistryChange()
    return promise
  }

  private async initializeEntry(
    descriptor: L4PluginBrowserEntryDescriptor
  ): Promise<L4PluginReadyEntryRuntime> {
    let namespace: L4PluginEntryNamespace
    try {
      namespace = await this.entryImporter(descriptor.url)
    } catch (cause) {
      throw new BrowserPluginError({
        pluginName: descriptor.pluginName,
        phase: 'entry-import',
        message: cause instanceof Error ? cause.message : 'Browser Entry import 失败',
        cause
      })
    }
    if (
      this.disposed ||
      this.entryDescriptorsByPlugin.get(descriptor.pluginName)?.url !== descriptor.url
    ) {
      throw new Error('Browser Entry 已失效')
    }
    if (typeof namespace.default !== 'function') {
      throw new BrowserPluginError({
        pluginName: descriptor.pluginName,
        phase: 'entry-factory',
        message: 'Browser Entry 必须 default-export defineBrowserEntry(...)'
      })
    }

    const lifecycle: Omit<L4PluginEntryOwner, 'host'> = {
      descriptor,
      registrations: new Map(),
      pushListeners: new Set(),
      notificationEventListeners: new Map(),
      globalStateListeners: new Set(),
      subscriptionDisposers: new Set(),
      mounts: new Set(),
      disposer: null,
      registrationOpen: true,
      active: true
    }
    // Host 构造中的订阅与 factory 共用同一 Owner，失败时一起回收。
    const owner = Object.assign(lifecycle, { host: this.createBrowserHost(lifecycle) })
    try {
      const result = (namespace.default as BrowserEntryFactory)(
        this.createBrowserFacade(descriptor.pluginName, owner)
      )
      owner.registrationOpen = false
      if (isPromiseLike(result)) {
        runPluginCallback(
          async () => {
            const lateDisposer = await result
            if (typeof lateDisposer === 'function') {
              await disposePluginResource(descriptor.pluginName, 'entry-factory', async () => {
                await lateDisposer()
              })
            }
          },
          'entry-factory',
          descriptor.pluginName
        )
        throw new Error('Browser Entry factory must register synchronously')
      }
      if (result !== undefined && typeof result !== 'function') {
        throw new Error('Browser Entry factory must return void or a disposer')
      }
      owner.disposer = result ?? null
    } catch (cause) {
      owner.registrationOpen = false
      await this.disposeEntryOwner(owner)
      throw new BrowserPluginError({
        pluginName: descriptor.pluginName,
        phase: 'entry-factory',
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      })
    }

    return {
      pluginName: descriptor.pluginName,
      owner,
      dispose: () => this.disposeEntryOwner(owner)
    }
  }

  private createBrowserFacade(pluginName: string, owner: L4PluginEntryOwner): BrowserPluginFacade {
    return {
      name: pluginName,
      host: owner.host,
      notifications: {
        onEvent: (nameInput, listener) => {
          if (!owner.active) throw new Error('Browser Entry owner is no longer active')
          const name = parseContributionName(nameInput)
          if (owner.notificationEventListeners.has(name)) {
            throw new Error(`Browser Notification Event 重复：${pluginName}/${name}`)
          }
          owner.notificationEventListeners.set(name, listener)
          return (): void => {
            if (owner.notificationEventListeners.get(name) === listener) {
              owner.notificationEventListeners.delete(name)
            }
          }
        }
      },
      notify: (input) => {
        if (!owner.active) return
        this.notifyPlugin(pluginName, structuredClone(input))
      },
      registerContribution: (kind, contributionName, definition) => {
        if (!owner.active || !owner.registrationOpen) {
          throw new Error('Browser Entry registration phase has ended')
        }
        if (!CONTRIBUTION_KINDS.has(kind)) {
          throw new Error(`Browser Contribution kind 无效：${String(kind)}`)
        }
        const registration = this.createRegistration(
          pluginName,
          kind,
          contributionName,
          definition,
          owner
        )
        const key = contributionKey(kind, registration.contributionName)
        if (owner.registrations.has(key)) {
          throw new Error(
            `Browser Contribution 重复：${pluginName}/${kind}/${registration.contributionName}`
          )
        }
        owner.registrations.set(key, registration)
      },
      onPush: (listener) => {
        if (!owner.active) throw new Error('Browser Entry owner is no longer active')
        owner.pushListeners.add(listener)
        return (): void => {
          owner.pushListeners.delete(listener)
        }
      }
    }
  }

  private createRegistration<K extends L4PluginContributionKind>(
    pluginName: string,
    kind: K,
    contributionNameInput: string,
    definition: BrowserContributionDefinitionMap[K],
    owner: L4PluginEntryOwner
  ): L4PluginContributionRegistration {
    const contributionName = parseContributionName(contributionNameInput)
    if (!definition || typeof definition !== 'object' || typeof definition.load !== 'function') {
      throw new Error(`Browser Contribution 必须提供 load()：${kind}/${contributionName}`)
    }

    if (kind === 'application') {
      const input = definition as BrowserApplicationContributionDefinition
      const label = parseLabel(input.label, 'Application label')
      const icon = cloneIcon(input.icon)
      const chrome = input.chrome ?? 'host'
      if (chrome !== 'host' && chrome !== 'none') {
        throw new Error('Application chrome 必须是 host 或 none')
      }
      if (input.resolve !== undefined && typeof input.resolve !== 'function') {
        throw new Error('Application resolve 必须是函数')
      }
      return {
        pluginName,
        kind,
        contributionName,
        descriptor: {
          kind,
          contributionName,
          label,
          title: parseLabel(input.title ?? label, 'Application title'),
          ...(icon ? { icon } : {}),
          chrome
        },
        load: input.load,
        resolve: input.resolve,
        owner
      }
    }
    if (kind === 'composer-panel') {
      const input = definition as BrowserComposerPanelContributionDefinition
      const icon = cloneIcon(input.icon)
      return {
        pluginName,
        kind,
        contributionName,
        descriptor: {
          kind,
          contributionName,
          label: parseLabel(input.label, 'Composer Panel label'),
          ...(icon ? { icon } : {})
        },
        load: input.load,
        owner
      }
    }
    if (kind === 'settings-page') {
      const input = definition as BrowserSettingsPageContributionDefinition
      const icon = cloneIcon(input.icon)
      return {
        pluginName,
        kind,
        contributionName,
        descriptor: {
          kind,
          contributionName,
          label: parseLabel(input.label, 'Settings Page label'),
          ...(icon ? { icon } : {})
        },
        load: input.load,
        owner
      }
    }
    if (kind === 'message-view') {
      const input = definition as BrowserMessageViewContributionDefinition
      return {
        pluginName,
        kind,
        contributionName,
        descriptor: {
          kind,
          contributionName,
          viewKey: parseViewKey(input.viewKey),
          priority: parsePriority(input.priority)
        },
        load: input.load,
        owner
      }
    }

    const input = definition as BrowserSessionSidebarTabContributionDefinition
    const icon = cloneIcon(input.icon)
    return {
      pluginName,
      kind: 'session-sidebar-tab',
      contributionName,
      descriptor: {
        kind: 'session-sidebar-tab',
        contributionName,
        label: parseLabel(input.label, 'Session Sidebar Tab label'),
        ...(icon ? { icon } : {})
      },
      load: input.load,
      owner
    }
  }

  private commitRegistrations(owner: L4PluginEntryOwner): void {
    for (const registration of owner.registrations.values()) {
      const key = pluginContributionKey(
        registration.pluginName,
        registration.kind,
        registration.contributionName
      )
      if (this.registrations.has(key)) {
        throw new Error(`Browser Contribution Registry 重复：${key}`)
      }
      this.registrations.set(key, registration)
    }
  }

  private loadContribution(
    registration: L4PluginContributionRegistration
  ): Promise<BrowserContributionImplementation> {
    const key = pluginContributionKey(
      registration.pluginName,
      registration.kind,
      registration.contributionName
    )
    const state = this.contributionLoadStates.get(key)
    if (state?.status === 'ready') return Promise.resolve(state.implementation)
    if (state?.status === 'loading') return state.promise
    if (state?.status === 'failed') return Promise.reject(state.error)

    const promise = Promise.resolve()
      .then(registration.load)
      .then(
        (implementation) => {
          if (!implementation || typeof implementation.mount !== 'function') {
            throw new Error('Lazy Contribution Module 必须导出 mount()')
          }
          if (!registration.owner.active || this.registrations.get(key) !== registration) {
            throw new Error('Browser Contribution 已失效')
          }
          this.contributionLoadStates.set(key, { status: 'ready', implementation })
          this.publishRegistryChange()
          return implementation
        },
        (cause: unknown) => {
          throw cause
        }
      )
      .catch((cause: unknown) => {
        const error =
          cause instanceof Error
            ? cause
            : new BrowserPluginError({
                pluginName: registration.pluginName,
                contributionName: registration.contributionName,
                phase: 'contribution-load',
                message: String(cause)
              })
        if (registration.owner.active && this.registrations.get(key) === registration) {
          this.contributionLoadStates.set(key, { status: 'failed', error })
          this.publishRegistryChange()
        }
        throw error
      })
    this.contributionLoadStates.set(key, { status: 'loading', promise })
    this.publishRegistryChange()
    return promise
  }

  private async resolveApplications(): Promise<void> {
    if (this.disposed) return
    const controller = new AbortController()
    this.applicationResolveController?.abort()
    this.applicationResolveController = controller
    const epoch = ++this.applicationResolveEpoch
    const applications = [...this.registrations.values()].filter(
      (registration) => registration.kind === 'application'
    )
    const resolved = new Map<string, boolean>()

    await Promise.all(
      applications.map(async (registration) => {
        const key = pluginContributionKey(
          registration.pluginName,
          registration.kind,
          registration.contributionName
        )
        if (!registration.resolve) {
          resolved.set(key, true)
          return
        }
        try {
          const visible = await registration.resolve({
            workSessions: this.workSessions,
            host: registration.owner.host,
            signal: controller.signal
          })
          if (!controller.signal.aborted) resolved.set(key, visible !== false)
        } catch (error) {
          if (controller.signal.aborted) return
          resolved.set(key, false)
          console.warn('[Pi Desk][PluginHost] Application resolve 失败', {
            pluginName: registration.pluginName,
            contributionName: registration.contributionName,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
    )

    if (
      this.disposed ||
      controller.signal.aborted ||
      this.applicationResolveController !== controller ||
      this.applicationResolveEpoch !== epoch
    ) {
      return
    }
    this.applicationVisibility.clear()
    for (const [key, visible] of resolved) this.applicationVisibility.set(key, visible)
    this.rebuildRegistry()
  }

  private scheduleApplicationResolution(): void {
    queueMicrotask(() => {
      if (this.disposed) return
      void this.resolveApplications().catch((error: unknown) => {
        console.error('[Pi Desk][PluginHost] 刷新 Application 可见性失败', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error)
        })
      })
    })
  }

  private rebuildRegistry(): void {
    const next = [...this.ownersByPlugin.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pluginName, owner]) => {
        const contributions = [...owner.registrations.values()]
          .filter((registration) => {
            if (registration.kind !== 'application') return true
            return (
              this.applicationVisibility.get(
                pluginContributionKey(
                  registration.pluginName,
                  registration.kind,
                  registration.contributionName
                )
              ) ?? false
            )
          })
          .sort((left, right) => {
            const kind = left.kind.localeCompare(right.kind)
            return kind === 0 ? left.contributionName.localeCompare(right.contributionName) : kind
          })
          .map((registration) => structuredClone(registration.descriptor))
        return { pluginName, contributions }
      })
    if (JSON.stringify(this.browserDescriptors) === JSON.stringify(next)) return
    this.browserDescriptors = next
    this.rebuildMessageViewResolutions()
    this.publishRegistryChange()
  }

  private rebuildMessageViewResolutions(): void {
    this.messageViewResolutions.clear()
    const byViewKey = new Map<
      string,
      Array<{
        pluginName: string
        descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'message-view' }>
      }>
    >()
    for (const plugin of this.browserDescriptors) {
      for (const descriptor of plugin.contributions) {
        if (descriptor.kind !== 'message-view') continue
        const candidates = byViewKey.get(descriptor.viewKey) ?? []
        candidates.push({ pluginName: plugin.pluginName, descriptor })
        byViewKey.set(descriptor.viewKey, candidates)
      }
    }

    for (const [viewKey, candidates] of byViewKey) {
      const highestPriority = Math.max(
        ...candidates.map((candidate) => candidate.descriptor.priority)
      )
      const winners = candidates.filter(
        (candidate) => candidate.descriptor.priority === highestPriority
      )
      this.messageViewResolutions.set(
        viewKey,
        winners.length === 1
          ? { status: 'winner', ...winners[0] }
          : { status: 'conflict', viewKey, candidates: winners }
      )
    }
  }

  private disposeEntry(pluginName: string): void {
    this.entryDescriptorsByPlugin.delete(pluginName)
    this.entryStates.delete(pluginName)
    const owner = this.ownersByPlugin.get(pluginName)
    this.ownersByPlugin.delete(pluginName)
    if (owner) void this.disposeEntryOwner(owner)
    this.rebuildRegistry()
  }

  private async disposeEntryOwner(owner: L4PluginEntryOwner): Promise<void> {
    if (!owner.active) return
    owner.active = false
    owner.registrationOpen = false
    owner.pushListeners.clear()
    owner.notificationEventListeners.clear()
    owner.globalStateListeners.clear()
    for (const unsubscribe of owner.subscriptionDisposers) {
      runPluginCallback(unsubscribe, 'entry-subscription-dispose', owner.descriptor.pluginName)
    }
    owner.subscriptionDisposers.clear()
    const logs = this.logHosts.get(owner.descriptor.pluginName)
    if (logs === owner.host.logs) {
      this.logHosts.delete(owner.descriptor.pluginName)
      runPluginCallback(() => logs.dispose(), 'logs-dispose', owner.descriptor.pluginName)
    }

    for (const registration of owner.registrations.values()) {
      const key = pluginContributionKey(
        registration.pluginName,
        registration.kind,
        registration.contributionName
      )
      if (this.registrations.get(key) !== registration) continue
      this.registrations.delete(key)
      this.contributionLoadStates.delete(key)
      this.applicationVisibility.delete(key)
    }

    const mounts = [...owner.mounts].reverse()
    owner.mounts.clear()
    const disposer = owner.disposer
    owner.disposer = null
    owner.registrations.clear()
    await Promise.all(mounts.map((dispose) => dispose()))
    if (disposer)
      await disposePluginResource(owner.descriptor.pluginName, 'entry-dispose', disposer)
  }

  private previewWorkSessionFile(
    source: PluginSource,
    path: string,
    options?: BrowserFilePreviewOptions
  ): void {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if (typeof path !== 'string' || !path.trim()) throw new Error('文件预览需要有效路径')
    const mode = readBrowserFilePreviewMode(options)
    const workSession = this.workSessions.find((item) => sameSource(item.source, source))
    if (!workSession) throw new Error('工作会话来源已变化')
    const preview = this.workSessionFilePreview
    if (!preview) throw new Error('Workbench 尚未准备好预览文件')
    preview({
      source: structuredClone(workSession.source),
      cwd: workSession.cwd,
      path: path.trim(),
      mode,
      ...(options?.imagePaths === undefined ? {} : { imagePaths: options.imagePaths })
    })
  }

  private async revealWorkSessionFile(source: PluginSource, path: string): Promise<void> {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if (typeof path !== 'string' || !path.trim()) throw new Error('文件定位需要有效路径')
    const workSession = this.workSessions.find((item) => sameSource(item.source, source))
    if (!workSession) throw new Error('工作会话来源已变化')
    const reveal = this.workSessionFileReveal
    if (!reveal) throw new Error('Workbench 尚未准备好定位文件')
    await reveal({
      source: structuredClone(workSession.source),
      cwd: workSession.cwd,
      path: path.trim()
    })
  }

  private async readImage(
    source: PluginSource,
    path: string,
    signal: AbortSignal
  ): Promise<Blob | null> {
    signal.throwIfAborted()
    const parsedPath = L4ProjectFilePathSchema.parse(path)
    const workSession = this.workSessions.find((item) => sameSource(item.source, source))
    if (!workSession) throw new Error('工作会话来源已变化')
    const read = this.imageReader
    if (!read) throw new Error('Workbench 尚未准备好读取图片')
    const image = await read(
      { source: structuredClone(workSession.source), cwd: workSession.cwd, path: parsedPath },
      signal
    )
    signal.throwIfAborted()
    if (!this.workSessions.some((item) => sameSource(item.source, source))) {
      throw new Error('工作会话来源已变化')
    }
    return image
  }

  private async createWorkSession(
    input: BrowserWorkSessionCreateInput
  ): Promise<PluginWorkSession> {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if (!input || typeof input.cwd !== 'string' || !input.cwd.trim()) {
      throw new Error('创建工作会话需要有效 cwd')
    }
    const create = this.workSessionCreate
    if (!create) throw new Error('Workbench 尚未准备好创建工作会话')
    return toPluginWorkSession(await create(input.cwd.trim()))
  }

  private async goToWorkSession(input: BrowserWorkSessionGoToInput): Promise<PluginWorkSession> {
    if (this.disposed) throw new Error('Plugin Host Runtime has been disposed')
    if ('workId' in input) {
      if (typeof input.workId !== 'string' || !input.workId.trim()) {
        throw new Error('前往工作会话需要有效 workId')
      }
    } else {
      if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) {
        throw new Error('前往工作会话需要有效 sessionId')
      }
      if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) {
        throw new Error('cwd 必须是非空字符串')
      }
    }
    const goTo = this.workSessionGoTo
    if (!goTo) throw new Error('Workbench 尚未准备好前往工作会话')
    return toPluginWorkSession(await goTo(input))
  }

  private createBrowserHost(owner: Omit<L4PluginEntryOwner, 'host'>): BrowserPluginHost {
    const pluginName = owner.descriptor.pluginName
    const assertActive = (): void => {
      if (!owner.active || this.disposed) throw new Error('Browser Entry 已失效')
    }
    const invoke = async <T>(action: () => Promise<T>): Promise<T> => {
      assertActive()
      const result = await action()
      assertActive()
      return result
    }
    const piDesk = this.transport.createPiDeskChannel(pluginName)
    const pi = this.transport.pi
    const subscribe = (
      listeners: Set<() => void>,
      listener: () => void,
      phase: string
    ): (() => void) => {
      assertActive()
      const wrapped = (): void => {
        if (owner.active) runPluginCallback(listener, phase, pluginName)
      }
      const unsubscribe = (): void => {
        listeners.delete(wrapped)
        owner.subscriptionDisposers.delete(unsubscribe)
      }
      listeners.add(wrapped)
      owner.subscriptionDisposers.add(unsubscribe)
      return unsubscribe
    }
    const workSessions: BrowserWorkSessionHost = {
      getSnapshot: () => {
        assertActive()
        return this.workSessions
      },
      subscribe: (listener) => subscribe(this.workSessionListeners, listener, 'work-sessions'),
      create: (input) => invoke(() => this.createWorkSession(input)),
      goTo: (input) => invoke(() => this.goToWorkSession(input))
    }
    const globalState: BrowserPluginGlobalStateHost = {
      getSnapshot: (): PluginJsonObject | null => {
        assertActive()
        return this.globalPluginStates[pluginName] ?? null
      },
      subscribe: (listener) => subscribe(owner.globalStateListeners, listener, 'global-state')
    }
    const connection: BrowserConnectionHost = {
      getSnapshot: () => {
        assertActive()
        return this.connectionSnapshot
      },
      subscribe: (listener) => subscribe(this.connectionListeners, listener, 'connection')
    }
    const theme: BrowserThemeHost = {
      getSnapshot: () => {
        assertActive()
        return this.themeSnapshot
      },
      subscribe: (listener) => subscribe(this.themeListeners, listener, 'theme')
    }
    let logs = this.logHosts.get(pluginName)
    if (!logs) {
      logs = new L4PluginLogHostRuntime(this.transport.createLogChannel(pluginName), {
        getSnapshot: () => this.connectionSnapshot,
        subscribe: connection.subscribe
      })
      this.logHosts.set(pluginName, logs)
    }

    return {
      settings: {
        getSnapshot: () => {
          assertActive()
          return readL4HostSettings()
        },
        subscribe: (listener) => {
          assertActive()
          const unsubscribe = subscribeL4HostSettings(() => {
            if (owner.active) runPluginCallback(listener, 'settings', pluginName)
          })
          owner.subscriptionDisposers.add(unsubscribe)
          return () => {
            owner.subscriptionDisposers.delete(unsubscribe)
            unsubscribe()
          }
        }
      },
      notify: (input) => {
        assertActive()
        this.notifyPlugin(pluginName, structuredClone(input))
      },
      locale: {
        getSnapshot: () => {
          assertActive()
          return readL4HostSettings().region
        }
      },
      globalState,
      piDesk: {
        invokeGlobal: (method, input) => invoke(() => piDesk.invokeGlobal(method, input)),
        invokeSession: (source, method, input) =>
          invoke(() => piDesk.invokeSession(source, method, input))
      },
      pi: {
        prompt: (source, input) => invoke(() => pi.prompt(source, input)),
        commands: {
          list: (source) => invoke(() => pi.commands.list(source)),
          execute: (source, command, args) =>
            invoke(() => pi.commands.execute(source, command, args))
        },
        tools: { list: (source) => invoke(() => pi.tools.list(source)) },
        bash: {
          execute: (source, input) => invoke(() => pi.bash.execute(source, input)),
          abort: (source) => invoke(() => pi.bash.abort(source))
        },
        interrupt: (source) => invoke(() => pi.interrupt(source))
      },
      workSessions,
      workSessionFiles: {
        preview: (source, path, options) => {
          assertActive()
          this.previewWorkSessionFile(source, path, options)
        },
        reveal: (source, path) => invoke(() => this.revealWorkSessionFile(source, path)),
        readImage: (source, path, signal) =>
          invoke(async () => {
            const controller = new AbortController()
            const abort = (): void => controller.abort()
            owner.subscriptionDisposers.add(abort)
            try {
              return await this.readImage(
                source,
                path,
                signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
              )
            } finally {
              owner.subscriptionDisposers.delete(abort)
            }
          })
      },
      projects: {
        preview: (directory) => {
          assertActive()
          this.previewProject(directory)
        }
      },
      terminals: {
        open: (input) =>
          invoke(async () => {
            if (!input || typeof input.cwd !== 'string' || !input.cwd.trim()) {
              throw new Error('新建终端需要有效 cwd')
            }
            const open = this.terminalOpen
            if (!open) throw new Error('终端创建能力尚未准备好')
            const controller = new AbortController()
            const abort = (): void => controller.abort()
            owner.subscriptionDisposers.add(abort)
            try {
              await open(input.cwd, controller.signal)
            } finally {
              owner.subscriptionDisposers.delete(abort)
            }
          })
      },
      logs,
      connection,
      theme
    }
  }

  private dispatchPush(message: PluginPushMessage): void {
    const state = this.entryStates.get(message.pluginName)
    if (state?.status !== 'ready') return
    const owner = (state.runtime as L4PluginReadyEntryRuntime).owner
    for (const listener of [...owner.pushListeners]) {
      if (!owner.active) break
      runPluginCallback(() => listener(message), `push:${message.event}`, message.pluginName)
    }
  }

  private replaceEntriesInitialized(initialized: boolean): void {
    if (this.entriesInitialized === initialized) return
    this.entriesInitialized = initialized
    this.publishRegistryChange()
  }

  private replaceEntryListError(error: string | null): void {
    if (this.entryListError === error) return
    this.entryListError = error
    this.publishRegistryChange()
  }

  private replaceConnection(next: BrowserConnectionSnapshot): void {
    if (
      next.status === this.connectionSnapshot.status &&
      next.error === this.connectionSnapshot.error
    ) {
      return
    }
    this.connectionSnapshot = Object.freeze({ ...next })
    this.notify(this.connectionListeners)
  }

  private publishRegistryChange(): void {
    this.registrySnapshot = {
      revision: this.registrySnapshot.revision + 1,
      descriptors: this.browserDescriptors
    }
    this.notify(this.registryListeners)
  }

  private notify(listeners: ReadonlySet<() => void>): void {
    for (const listener of [...listeners]) runPluginCallback(listener, 'notify')
  }
}

export function createL4PluginHostRuntime(
  transport: L4PluginHostTransport,
  entryImporter?: L4PluginEntryImporter,
  notifyPlugin?: L4PluginNotificationSink
): L4PluginHostRuntime {
  return new L4PluginHostRuntime(transport, entryImporter, notifyPlugin)
}
