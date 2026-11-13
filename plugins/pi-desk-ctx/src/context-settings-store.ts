import type { PluginConfig, PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import {
  defaultContextIgnoreSettings,
  parseContextIgnoreSettings,
  type ContextIgnoreSettings
} from './context-settings.js'

export async function readContextIgnoreSettings(
  config: PluginConfig,
  cwd?: string
): Promise<ContextIgnoreSettings> {
  return parseContextIgnoreSettings(
    await config.get({
      ...(cwd ? { cwd } : {}),
      defaults: JSON.parse(JSON.stringify(defaultContextIgnoreSettings())) as PluginJsonObject
    })
  )
}

export async function writeContextIgnoreSettings(
  value: unknown,
  config: PluginConfig
): Promise<ContextIgnoreSettings> {
  const settings = parseContextIgnoreSettings(value)
  await config.set(JSON.parse(JSON.stringify(settings)) as PluginJsonObject)
  return settings
}
