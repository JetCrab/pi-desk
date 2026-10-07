import { z } from 'zod'

export const L4LocaleSchema = z.enum(['zh-CN', 'en'])
export type L4Locale = z.infer<typeof L4LocaleSchema>
export const L4_DEFAULT_LOCALE: L4Locale = 'en'
export const L4_LOCALE_STORAGE_KEY = 'pi-super:locale'
export const L4_TIME_ZONE_STORAGE_KEY = 'pi-super:time-zone'

export type L4LocalePreference = 'system' | L4Locale
export type L4TimeZonePreference = 'system' | string

export function resolveL4Locale(languages: readonly string[]): L4Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0]
    if (base === 'zh') return 'zh-CN'
    if (base === 'en') return 'en'
  }
  return L4_DEFAULT_LOCALE
}

export function isL4TimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function resolveL4TimeZone(value: string | undefined): string {
  return value && isL4TimeZone(value) ? value : 'UTC'
}

export function l4FormatLocale(locale: L4Locale): string {
  return locale === 'en' ? 'en-US' : 'zh-CN'
}
