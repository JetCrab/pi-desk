import type {
  BrowserApplicationContext,
  PluginDisposer,
  PluginJsonObject,
  PluginNotificationLevel,
  PluginSource,
  PluginWorkSession
} from './shared.js'
import type { PluginPushMessage } from './entry.js'
import type { HostSettings } from './settings.js'
export type { HostRegion, HostSettings, HostSettingsSnapshot } from './settings.js'

export type {
  BrowserApplicationContext,
  BrowserBuiltinIconName,
  BrowserContributionIcon,
  PluginDisposer,
  PluginJsonObject,
  PluginJsonValue,
  PluginNotificationLevel,
  PluginSource,
  PluginWorkSession
} from './shared.js'
export type { PluginPushMessage, PluginPushTarget } from './entry.js'

export type BrowserContributionKind =
  'application' | 'composer-panel' | 'settings-page' | 'message-view' | 'session-sidebar-tab'

export type BrowserEntryStatus = 'unloaded' | 'loading' | 'ready' | 'failed'
export type BrowserContributionLoadStatus = 'unloaded' | 'loading' | 'ready' | 'failed'

export interface BrowserEntryRuntime {
  readonly pluginName: string
  dispose(): void | Promise<void>
}

export type BrowserEntryState =
  | { status: 'unloaded' }
  | { status: 'loading'; promise: Promise<BrowserEntryRuntime> }
  | { status: 'ready'; runtime: BrowserEntryRuntime }
  | { status: 'failed'; error: Error }

export type BrowserContributionLoadState =
  | { status: 'unloaded' }
  | { status: 'loading'; promise: Promise<BrowserContributionImplementation> }
  | { status: 'ready'; implementation: BrowserContributionImplementation }
  | { status: 'failed'; error: Error }

export interface BrowserConnectionSnapshot {
  status: 'connecting' | 'ready' | 'disconnected'
  error: string | null
}

export interface BrowserConnectionHost {
  getSnapshot(): BrowserConnectionSnapshot
  subscribe(listener: () => void): PluginDisposer
}

export interface BrowserWorkSessionCreateInput {
  cwd: string
}

export type BrowserWorkSessionGoToInput =
  | {
      workId: string
      sessionId?: never
      cwd?: never
    }
  | {
      sessionId: string
      cwd?: string
      workId?: never
    }

export interface BrowserWorkSessionHost {
  getSnapshot(): readonly PluginWorkSession[]
  subscribe(listener: () => void): PluginDisposer
  create(input: BrowserWorkSessionCreateInput): Promise<PluginWorkSession>
  goTo(input: BrowserWorkSessionGoToInput): Promise<PluginWorkSession>
}

export interface BrowserThemeSnapshot {
  readonly mode: 'light' | 'dark'
}

export interface BrowserLocaleHost {
  getSnapshot(): { readonly locale: 'zh-CN' | 'en'; readonly timeZone?: string }
}

export interface BrowserThemeHost {
  getSnapshot(): BrowserThemeSnapshot
  subscribe(listener: () => void): PluginDisposer
}

export interface BrowserPluginLogSnapshot {
  text: string
  truncated: boolean
  loading: boolean
  error: string | null
}

export interface BrowserPluginLogHandle {
  getSnapshot(): BrowserPluginLogSnapshot
  subscribe(listener: () => void): PluginDisposer
  retry(): void
  dispose(): void
}

export interface BrowserPluginLogHost {
  open(path: string): BrowserPluginLogHandle
}

export interface PiDeskBrowserChannel {
  invokeGlobal(method: string, input: PluginJsonObject): Promise<PluginJsonObject>
  invokeSession(
    source: PluginSource,
    method: string,
    input: PluginJsonObject
  ): Promise<PluginJsonObject>
}

export type PiPromptImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

export interface PiPromptImage {
  mimeType: PiPromptImageMimeType
  data: string
  width: number
  height: number
}

export interface PiPromptInput {
  mode: 'auto' | 'follow_up'
  text: string
  images?: readonly PiPromptImage[]
}

export interface PiPromptResult {
  tempId: string
}

export interface PiCommandInfo {
  name: string
  description: string | null
}

export interface PiNativeCommandChannel {
  list(source: PluginSource): Promise<readonly PiCommandInfo[]>
  execute(source: PluginSource, command: string, args?: string): Promise<void>
}

export interface PiToolInfo {
  name: string
  description: string
  parameters: PluginJsonObject
  active: boolean
  exposure?: 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden'
  source?: string | null
  blockedByMode?: boolean
}

export interface PiNativeToolMetadataChannel {
  list(source: PluginSource): Promise<readonly PiToolInfo[]>
}

export interface PiBashExecuteInput {
  command: string
  excludeFromContext: boolean
}

export interface PiBashResult {
  output: string
  exitCode: number | null
  cancelled: boolean
  truncated: boolean
  fullOutputPath: string | null
}

export interface PiNativeBashChannel {
  execute(source: PluginSource, input: PiBashExecuteInput): Promise<PiBashResult>
  abort(source: PluginSource): Promise<void>
}

export interface PiNativeBrowserChannel {
  prompt(source: PluginSource, input: PiPromptInput): Promise<PiPromptResult>
  readonly commands: PiNativeCommandChannel
  readonly tools: PiNativeToolMetadataChannel
  readonly bash: PiNativeBashChannel
  interrupt(source: PluginSource): Promise<void>
}

export type BrowserNotificationLevel = PluginNotificationLevel

export interface BrowserNotificationInput {
  level: BrowserNotificationLevel
  title: string
  description?: string
}

export interface BrowserPluginGlobalStateHost {
  getSnapshot(): PluginJsonObject | null
  subscribe(listener: () => void): PluginDisposer
}

export interface BrowserPluginHost {
  readonly settings: HostSettings
  notify(input: BrowserNotificationInput): void
  readonly globalState: BrowserPluginGlobalStateHost
  readonly piDesk: PiDeskBrowserChannel
  readonly pi: PiNativeBrowserChannel
  readonly workSessions: BrowserWorkSessionHost
  readonly workSessionFiles: BrowserWorkSessionFileHost
  readonly projects: {
    preview(directory: string): void
  }
  readonly terminals?: {
    open(input: { cwd: string }): Promise<void>
  }
  readonly logs: BrowserPluginLogHost
  readonly theme: BrowserThemeHost
  readonly connection: BrowserConnectionHost
  readonly locale?: BrowserLocaleHost
}

export type BrowserMount<TTarget> = (context: {
  container: HTMLElement
  target: TTarget
  host: BrowserPluginHost
  signal: AbortSignal
}) => void | PluginDisposer | Promise<void | PluginDisposer>

export interface BrowserApplicationTarget {
  kind: 'application'
  initialContext: BrowserApplicationContext | null
  close(): void
}

export interface BrowserComposerPanelTarget {
  kind: 'composer-panel'
  source: PluginSource
  close(): void
}

export type BrowserBeforeLeaveHandler = () => boolean | Promise<boolean>

export interface BrowserSettingsPageTarget {
  kind: 'settings-page'
  close(): void
  setBeforeLeave(handler: BrowserBeforeLeaveHandler | null): void
}

export type BrowserFilePreviewMode = 'session' | 'expanded' | 'standalone'

export interface BrowserFilePreviewOptions {
  // 省略时兼容此前行为：在来源会话的文件工作区打开。
  mode?: BrowserFilePreviewMode
  // 仅 standalone 使用；按顺序浏览图片，path 指定初始图片，重复路径只保留首次出现。
  imagePaths?: readonly string[]
}

export interface BrowserWorkSessionFileHost {
  preview(source: PluginSource, path: string, options?: BrowserFilePreviewOptions): void
  reveal(source: PluginSource, path: string): Promise<void>
  // 文件缺失返回 null；调用方持有 Blob，负责取消请求和释放自己创建的 URL。
  readImage(source: PluginSource, path: string, signal?: AbortSignal): Promise<Blob | null>
}

export interface BrowserSessionFileHost {
  preview(path: string, options?: BrowserFilePreviewOptions): void
  reveal(path: string): Promise<void>
}

export interface BrowserSessionSidebarTabTarget {
  kind: 'session-sidebar-tab'
  source: PluginSource
  cwd: string
  files: BrowserSessionFileHost
}

export interface TemporaryMessageLocation {
  tempId: string
}

export interface DurableMessageLocation {
  index: number
  entryId: string
}

export interface PublicMessageUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
}

export interface PublicMessageFixed {
  timestampMs: number | null
  viewKey: string
  type: string
  status?: 'running' | 'completed' | 'error' | 'aborted'
  hasDetail: boolean
  usage?: PublicMessageUsage | null
}

export type PublicMessageSnapshot = {
  location: TemporaryMessageLocation | DurableMessageLocation
  fixed: PublicMessageFixed
  summary: PluginJsonObject
  detail?: PluginJsonObject | null
}

export type BrowserMessageHandleListener = () => void

export interface BrowserMessageHandle {
  getSnapshot(): PublicMessageSnapshot
  subscribe(listener: BrowserMessageHandleListener): PluginDisposer
  loadDetail(): Promise<PluginJsonObject | null>
}

export interface BrowserMessageViewTarget {
  kind: 'message-view'
  message: BrowserMessageHandle
  reportError(error: unknown): void
}

export interface BrowserApplicationImplementation {
  mount: BrowserMount<BrowserApplicationTarget>
}

export interface BrowserComposerPanelImplementation {
  mount: BrowserMount<BrowserComposerPanelTarget>
}

export interface BrowserSettingsPageImplementation {
  mount: BrowserMount<BrowserSettingsPageTarget>
}

export interface BrowserMessageViewImplementation {
  mount: BrowserMount<BrowserMessageViewTarget>
}

export interface BrowserSessionSidebarTabImplementation {
  mount: BrowserMount<BrowserSessionSidebarTabTarget>
}

export type BrowserContributionImplementation =
  | BrowserApplicationImplementation
  | BrowserComposerPanelImplementation
  | BrowserSettingsPageImplementation
  | BrowserMessageViewImplementation
  | BrowserSessionSidebarTabImplementation

export interface BrowserApplicationResolveContext {
  readonly workSessions: readonly PluginWorkSession[]
  readonly host: BrowserPluginHost
  readonly signal: AbortSignal
}

export interface BrowserApplicationContributionDefinition {
  label: string
  title?: string
  icon?: import('./shared.js').BrowserContributionIcon
  chrome?: 'host' | 'none'
  resolve?(context: BrowserApplicationResolveContext): boolean | Promise<boolean>
  load(): Promise<BrowserApplicationImplementation>
}

export interface BrowserComposerPanelContributionDefinition {
  label: string
  icon?: import('./shared.js').BrowserContributionIcon
  load(): Promise<BrowserComposerPanelImplementation>
}

export interface BrowserSettingsPageContributionDefinition {
  label: string
  icon?: import('./shared.js').BrowserContributionIcon
  load(): Promise<BrowserSettingsPageImplementation>
}

export interface BrowserMessageViewContributionDefinition {
  viewKey: string
  priority: number
  load(): Promise<BrowserMessageViewImplementation>
}

export interface BrowserSessionSidebarTabContributionDefinition {
  label: string
  icon?: import('./shared.js').BrowserContributionIcon
  load(): Promise<BrowserSessionSidebarTabImplementation>
}

export interface BrowserContributionDefinitionMap {
  application: BrowserApplicationContributionDefinition
  'composer-panel': BrowserComposerPanelContributionDefinition
  'settings-page': BrowserSettingsPageContributionDefinition
  'message-view': BrowserMessageViewContributionDefinition
  'session-sidebar-tab': BrowserSessionSidebarTabContributionDefinition
}

export interface BrowserContributionImplementationMap {
  application: BrowserApplicationImplementation
  'composer-panel': BrowserComposerPanelImplementation
  'settings-page': BrowserSettingsPageImplementation
  'message-view': BrowserMessageViewImplementation
  'session-sidebar-tab': BrowserSessionSidebarTabImplementation
}

export type BrowserContributionDescriptor =
  | {
      kind: 'application'
      contributionName: string
      label: string
      title: string
      icon?: import('./shared.js').BrowserContributionIcon
      chrome: 'host' | 'none'
    }
  | {
      kind: 'composer-panel'
      contributionName: string
      label: string
      icon?: import('./shared.js').BrowserContributionIcon
    }
  | {
      kind: 'settings-page'
      contributionName: string
      label: string
      icon?: import('./shared.js').BrowserContributionIcon
    }
  | {
      kind: 'message-view'
      contributionName: string
      viewKey: string
      priority: number
    }
  | {
      kind: 'session-sidebar-tab'
      contributionName: string
      label: string
      icon?: import('./shared.js').BrowserContributionIcon
    }

export interface BrowserPluginNotificationEvent {
  notificationId: string
  data: PluginJsonObject
}

export type BrowserPluginNotificationEventListener = (
  event: BrowserPluginNotificationEvent
) => void | Promise<void>

export interface BrowserPluginNotifications {
  onEvent(name: string, listener: BrowserPluginNotificationEventListener): PluginDisposer
}

export interface BrowserPluginFacade {
  readonly name: string
  readonly host: BrowserPluginHost
  readonly notifications: BrowserPluginNotifications
  notify(input: BrowserNotificationInput): void
  registerContribution<K extends BrowserContributionKind>(
    kind: K,
    contributionName: string,
    definition: BrowserContributionDefinitionMap[K]
  ): void
  onPush(listener: (message: PluginPushMessage) => void): PluginDisposer
}

function copyWithLegacyCommand(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false

  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.left = '-9999px'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.opacity = '0'

  try {
    document.body.append(textarea)
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    try {
      activeElement?.focus()
    } catch {
      // 焦点恢复失败不影响已完成的复制。
    }
  }
}

/**
 * 在用户操作中复制文本，优先使用 Clipboard API，并兼容不安全上下文和旧 WebView。
 */
export async function copyBrowserText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Clipboard API 被权限或运行环境拒绝时，继续尝试旧版浏览器能力。
    }
  }

  return copyWithLegacyCommand(text)
}

export type BrowserEntryFactory = (plugin: BrowserPluginFacade) => void | PluginDisposer

export function defineBrowserEntry(factory: BrowserEntryFactory): BrowserEntryFactory {
  if (typeof factory !== 'function') throw new Error('Browser Entry factory must be a function')
  return factory
}

export class BrowserPluginError extends Error {
  readonly pluginName: string
  readonly contributionName: string | null
  readonly phase: string

  constructor(input: {
    pluginName: string
    contributionName?: string | null
    phase: string
    message: string
    cause?: unknown
  }) {
    super(input.message, { cause: input.cause })
    this.name = 'PiDeskBrowserPluginError'
    this.pluginName = input.pluginName
    this.contributionName = input.contributionName ?? null
    this.phase = input.phase
  }
}
