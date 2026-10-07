import type { BrowserPluginHost, PluginJsonObject } from '@jetcrab/pi-desk-sdk/browser'
import { parseQuotaDisplay, parseQuotaSnapshot } from './browser-runtime.js'
import {
  type QuotaDisplaySettings,
  type QuotaAdapterDescriptor,
  type QuotaSettingsSaveSource,
  type QuotaSettingsSnapshot,
  type QuotaSettingsSource,
  type QuotaSnapshot
} from './protocol.js'

function parseSettings(value: PluginJsonObject): QuotaSettingsSnapshot {
  return {
    error: typeof value.error === 'string' ? value.error : null,
    adapters: Array.isArray(value.adapters)
      ? (JSON.parse(JSON.stringify(value.adapters)) as QuotaAdapterDescriptor[])
      : [],
    sources: Array.isArray(value.sources)
      ? (JSON.parse(JSON.stringify(value.sources)) as QuotaSettingsSource[])
      : [],
    display: parseQuotaDisplay(value.display)
  }
}

async function invoke(
  host: BrowserPluginHost,
  method: 'state-get' | 'settings-get' | 'settings-save',
  input: object = {}
): Promise<PluginJsonObject> {
  try {
    return await host.piDesk.invokeGlobal(
      method,
      JSON.parse(JSON.stringify(input)) as PluginJsonObject
    )
  } catch (cause) {
    // 不记录配置参数，错误只关联操作，避免将凭据写入浏览器日志。
    console.error('[额度查看器] 操作失败', {
      method,
      message: cause instanceof Error ? cause.message : String(cause)
    })
    throw cause
  }
}

export const quotaBiz = {
  async query(host: BrowserPluginHost, force: boolean): Promise<QuotaSnapshot> {
    return parseQuotaSnapshot(await invoke(host, 'state-get', { force }))
  },
  async loadSettings(host: BrowserPluginHost): Promise<QuotaSettingsSnapshot> {
    return parseSettings(await invoke(host, 'settings-get'))
  },
  async saveSources(
    host: BrowserPluginHost,
    sources: readonly QuotaSettingsSaveSource[],
    resetTimeFormat?: QuotaDisplaySettings['resetTimeFormat']
  ): Promise<QuotaSettingsSnapshot> {
    return parseSettings(
      await invoke(host, 'settings-save', {
        sources,
        ...(resetTimeFormat ? { display: { resetTimeFormat } } : {})
      })
    )
  },
  async saveVisibility(
    host: BrowserPluginHost,
    hiddenItemKeys: readonly string[]
  ): Promise<QuotaSettingsSnapshot> {
    return parseSettings(await invoke(host, 'settings-save', { display: { hiddenItemKeys } }))
  }
}
