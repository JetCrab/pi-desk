import type { PluginJsonObject } from '@jetcrab/pi-desk-sdk/browser'
import {
  MAX_HIDDEN_ITEMS,
  type QuotaDisplaySettings,
  type QuotaSnapshot,
  type QuotaSourceSnapshot
} from './protocol.js'

const EMPTY_SNAPSHOT: QuotaSnapshot = {
  error: null,
  sources: [],
  display: { resetTimeFormat: 'countdown', hiddenItemKeys: [] }
}
const listeners = new Set<() => void>()
let snapshot: QuotaSnapshot = EMPTY_SNAPSHOT

export function parseQuotaDisplay(value: unknown): QuotaDisplaySettings {
  const display =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return {
    resetTimeFormat: display.resetTimeFormat === 'absolute' ? 'absolute' : 'countdown',
    hiddenItemKeys: Array.isArray(display.hiddenItemKeys)
      ? display.hiddenItemKeys
          .filter((item): item is string => typeof item === 'string')
          .slice(0, MAX_HIDDEN_ITEMS)
      : []
  }
}

export function parseQuotaSnapshot(value: PluginJsonObject): QuotaSnapshot {
  return {
    error: typeof value.error === 'string' ? value.error : null,
    sources: Array.isArray(value.sources)
      ? (JSON.parse(JSON.stringify(value.sources)) as QuotaSourceSnapshot[])
      : [],
    display: parseQuotaDisplay(value.display)
  }
}

export function replaceQuotaSnapshot(next: QuotaSnapshot): void {
  snapshot = next
  for (const listener of [...listeners]) listener()
}

export function subscribeQuotaSnapshot(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readQuotaSnapshot(): QuotaSnapshot {
  return snapshot
}

export function resetQuotaBrowserRuntime(): void {
  listeners.clear()
  snapshot = EMPTY_SNAPSHOT
}
