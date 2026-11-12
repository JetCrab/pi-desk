import type { BrowserConnectionSnapshot, BrowserThemeSnapshot } from './browser.js'
import type { HostSettingsSnapshot } from './settings.js'
import type {
  BrowserApplicationContext,
  PluginJsonObject,
  PluginSource,
  PluginWorkSession
} from './shared.js'

export type HostEventListener<T> = (data: Readonly<T>) => void | Promise<void>

export interface HostEvents<Events> {
  on<K extends keyof Events & string>(name: K, handler: HostEventListener<Events[K]>): () => void
  onPlugin(
    pluginName: string,
    name: string,
    handler: HostEventListener<PluginJsonObject>
  ): () => void
  emit(name: string, data: PluginJsonObject): void
}

export type WorkbenchContext = BrowserApplicationContext | null

export interface ChatInputAccepted {
  source: PluginSource
  tempId: string
}

export type ChatSubmitResult =
  | (ChatInputAccepted & { status: 'accepted' })
  | {
      source: PluginSource
      status: 'failed' | 'unknown'
      message: string
    }

export interface BrowserHostEventMap {
  'workbench-context': WorkbenchContext
  'work-sessions': readonly PluginWorkSession[]
  connection: BrowserConnectionSnapshot
  settings: HostSettingsSnapshot
  theme: BrowserThemeSnapshot
  'plugin-state': PluginJsonObject | null
  'chat-submit-result': ChatSubmitResult
}

export interface NodeHostEventMap {
  'work-sessions': readonly PluginWorkSession[]
  settings: HostSettingsSnapshot
  'chat-input-accepted': ChatInputAccepted
}
