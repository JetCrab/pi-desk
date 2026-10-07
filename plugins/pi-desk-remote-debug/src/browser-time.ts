import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'

type TimeZoneReader = () => string

const TIME_OPTIONS: Omit<Intl.DateTimeFormatOptions, 'timeZone'> = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
}

export function resolveRemoteDebugTimeZone(readTimeZone: TimeZoneReader = detectTimeZone): string {
  try {
    return readTimeZone() || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function formatRemoteDebugTime(
  value: number | null,
  locale: string,
  timeZone: string
): string {
  if (value === null) return '—'
  try {
    return new Intl.DateTimeFormat(locale, { ...TIME_OPTIONS, timeZone }).format(value)
  } catch {
    return new Intl.DateTimeFormat(locale, { ...TIME_OPTIONS, timeZone: 'UTC' }).format(value)
  }
}

export function getRemoteDebugRegion(host: BrowserPluginHost): {
  locale: string
  timeZone: string
} {
  if (host.settings) return host.settings.getSnapshot().region
  const legacy = host.locale?.getSnapshot()
  return {
    locale: legacy?.locale ?? 'zh-CN',
    timeZone: legacy?.timeZone ?? resolveRemoteDebugTimeZone()
  }
}

export function subscribeRemoteDebugRegion(
  host: BrowserPluginHost,
  listener: () => void
): () => void {
  return host.settings ? host.settings.subscribe(listener) : (): void => {}
}

function detectTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
