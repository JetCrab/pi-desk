import type { HostRegion } from '@jetcrab/pi-desk-sdk/settings'

export const DEFAULT_REGION: HostRegion = { locale: 'en', timeZone: 'UTC' }
export const LEGACY_ANALYSIS_REGION: HostRegion = { locale: 'zh-CN', timeZone: 'Asia/Shanghai' }

export function sameRegion(left: HostRegion, right: HostRegion): boolean {
  return left.locale === right.locale && left.timeZone === right.timeZone
}

export function tiboText(region: HostRegion, chinese: string, english: string): string {
  return region.locale === 'zh-CN' ? chinese : english
}

export function regionTime(timestamp: number | null, region: HostRegion): string {
  if (timestamp === null) return tiboText(region, '尚未执行', 'Not yet checked')
  return new Intl.DateTimeFormat(region.locale, {
    timeZone: region.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(timestamp)
}
