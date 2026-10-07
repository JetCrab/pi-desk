import type { CapabilityDeclarations } from './capabilities.js'
import type { HostSettings } from './settings.js'
export type { HostRegion, HostSettings, HostSettingsSnapshot } from './settings.js'
import {
  normalizePluginIdentifier,
  type PluginDisposer,
  type PluginJsonObject,
  type PluginJsonValue,
  type PluginNotificationLevel,
  type PluginSource,
  type PluginWorkSession
} from './shared.ts'

export type {
  BrowserBuiltinIconName,
  BrowserContributionIcon,
  PluginDisposer,
  PluginJsonObject,
  PluginJsonValue,
  PluginNotificationLevel,
  PluginSource,
  PluginWorkSession
} from './shared.js'

export interface GlobalPluginMethodContext {
  readonly signal: AbortSignal
}

export type PluginCapabilityLoader = (
  context: GlobalPluginMethodContext
) => CapabilityDeclarations | Promise<CapabilityDeclarations>

export type GlobalPluginMethodHandler = (
  input: PluginJsonObject,
  context: GlobalPluginMethodContext
) => Promise<PluginJsonObject>

export interface GlobalPluginFacade {
  readonly name: string
  registerMethod(method: string, execute: GlobalPluginMethodHandler): () => void
}

export interface GlobalPluginAPI {
  bindPlugin(pluginName: string): GlobalPluginFacade
}

export type GlobalPluginDisposer = PluginDisposer

export type GlobalPluginFactory = (
  api: GlobalPluginAPI
) => void | GlobalPluginDisposer | Promise<void | GlobalPluginDisposer>

export type PluginPushTarget =
  | { scope: 'global' }
  | {
      scope: 'session'
      source: PluginSource
    }

export interface PluginPushMessage {
  pluginName: string
  target: PluginPushTarget
  event: string
  data: PluginJsonObject
}

export interface PiDeskWorkSessionCapability {
  listWorkSessions(): Promise<readonly PluginWorkSession[]>
}

export interface PiDeskPluginHost {
  readonly settings: HostSettings
  readonly workSessions: PiDeskWorkSessionCapability
}

export interface PluginNotificationEventInput {
  name: string
  data: PluginJsonObject
}

export interface PluginNotificationPublishInput {
  level: PluginNotificationLevel
  title: string
  description?: string
  event?: PluginNotificationEventInput
}

export interface PluginNotificationChanges {
  level?: PluginNotificationLevel
  title?: string
  description?: string | null
}

export interface PiDeskPluginNotifications {
  publish(input: PluginNotificationPublishInput): string
  update(notificationId: string, changes: PluginNotificationChanges): void
  delete(notificationId: string): void
}

export type PluginMessageProjectionStage = 'temporary' | 'update' | 'final' | 'durable'

export interface PluginNativeImageMetadata {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
  width: number
  height: number
}

export type PluginNativePiMessage =
  | {
      kind: 'user'
      text: string
      images: readonly PluginNativeImageMetadata[]
    }
  | {
      kind: 'assistant'
      text: string
      thinking: string
      stopReason: string | null
    }
  | {
      kind: 'tool'
      toolName: string
      toolCallId: string
      arguments: PluginJsonObject
      partialResult: PluginJsonValue
      result: PluginJsonValue
      isError: boolean
    }
  | {
      kind: 'bash'
      command: string
      output: string
      exitCode: number | null
      cancelled: boolean
      truncated: boolean
    }
  | {
      kind: 'custom'
      customType: string
      content: string
      details: PluginJsonValue
    }

export interface PluginMessageProjectionResult {
  viewKey: string
  summary: PluginJsonObject
  detail: PluginJsonObject | null
}

export interface PluginMessageDeclarationInput {
  source: PluginSource
  stage: PluginMessageProjectionStage
  message: PluginNativePiMessage
  raw: unknown
  defaultProjection: PluginMessageProjectionResult
}

export interface PluginMessageDeclaration {
  priority: number
  match(input: PluginMessageDeclarationInput): boolean
  project(input: PluginMessageDeclarationInput): PluginMessageProjectionResult
}

export interface PiDeskPluginFacade {
  readonly name: string
  readonly host: PiDeskPluginHost
  readonly notifications: PiDeskPluginNotifications
  setState(state: PluginJsonObject | null): void
  registerMethod(method: string, execute: GlobalPluginMethodHandler): PluginDisposer
  registerBrowserEntry(relativePath: string): PluginDisposer
  declareCapabilities(load: PluginCapabilityLoader): PluginDisposer
  declareMessage(declarationName: string, declaration: PluginMessageDeclaration): PluginDisposer
  pushGlobal(event: string, data: PluginJsonObject): void
  pushSession(source: PluginSource, event: string, data: PluginJsonObject): void
}

export interface PiDeskPluginReloadContext {
  readonly signal: AbortSignal
}

export interface PiDeskPluginLifecycle {
  beforeReload?(context: PiDeskPluginReloadContext): void | Promise<void>
  dispose?: PluginDisposer
}

export type PiDeskPluginSetupResult = void | PluginDisposer | PiDeskPluginLifecycle

export interface PiDeskPluginDefinition {
  readonly name: string
  setup(plugin: PiDeskPluginFacade): PiDeskPluginSetupResult | Promise<PiDeskPluginSetupResult>
}

export type PiDeskPluginFactory = PiDeskPluginDefinition

export function definePiDeskPlugin(definition: PiDeskPluginDefinition): PiDeskPluginDefinition {
  if (!definition || typeof definition !== 'object') {
    throw new Error('Pi Desk Plugin definition must be an object')
  }
  const name = normalizePluginIdentifier(definition.name, 'pluginName')
  if (typeof definition.setup !== 'function') {
    throw new Error('Pi Desk Plugin setup must be a function')
  }
  return Object.freeze({ name, setup: definition.setup })
}
