import type { PluginConfig, PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import {
  defaultContextIgnoreSettings,
  parseContextIgnoreSettings,
  type ContextIgnoreSettings
} from './context-settings.js'

export async function readContextIgnoreSettings(
  config: PluginConfig
): Promise<ContextIgnoreSettings> {
  const value = await config.get()
  return Object.keys(value).length
    ? parseContextIgnoreSettings(value)
    : defaultContextIgnoreSettings()
}

export async function writeContextIgnoreSettings(
  value: unknown,
  config: PluginConfig
): Promise<ContextIgnoreSettings> {
  const settings = parseContextIgnoreSettings(value)
  await config.set(JSON.parse(JSON.stringify(settings)) as PluginJsonObject)
  return settings
}
