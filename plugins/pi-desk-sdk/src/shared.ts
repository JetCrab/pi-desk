export type PluginJsonValue =
  null | boolean | number | string | PluginJsonValue[] | { [key: string]: PluginJsonValue }

export type PluginJsonObject = { [key: string]: PluginJsonValue }

export type PluginDisposer = () => void | Promise<void>

export type PluginNotificationLevel = 'info' | 'success' | 'warning' | 'error'

export interface PluginSource {
  readonly workId: string
  readonly sessionId: string
  readonly branchId: string
}

export interface PluginWorkSession {
  readonly source: PluginSource
  readonly cwd: string
  readonly status: 'main_running' | 'background_running' | 'completed' | 'idle'
}

export interface BrowserApplicationContext {
  source: PluginSource
  cwd: string
}

export type BrowserBuiltinIconName =
  | 'plugin'
  | 'server'
  | 'rocket'
  | 'settings'
  | 'panel'
  | 'message'
  | 'terminal'
  | 'file'
  | 'folder'
  | 'bot'
  | 'wrench'
  | 'database'
  | 'globe'

export type BrowserContributionIcon =
  | {
      type: 'builtin'
      name: BrowserBuiltinIconName
    }
  | {
      type: 'svg'
      content: string
    }

const PLUGIN_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PLUGIN_IDENTIFIER_MAX_LENGTH = 64

export function normalizePluginIdentifier(
  value: string,
  field: 'pluginName' | 'method' | 'contributionName' | 'declarationName' | 'event'
): string {
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > PLUGIN_IDENTIFIER_MAX_LENGTH ||
    !PLUGIN_IDENTIFIER_PATTERN.test(normalized)
  ) {
    throw new Error(`${field} must use lowercase kebab-case and contain 1-64 characters`)
  }
  return normalized
}
