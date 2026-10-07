'use client'

import { HostSettingsSchema, type HostSettingsSnapshot } from '@jetcrab/pi-desk-sdk/settings'
import type { L4Locale } from '@common/l4_foundation/locale/l4-locale'

export interface L4RegionSnapshot {
  locale: L4Locale
  timeZone: string
  localePreference: L4Locale
  timeZonePreference: string
  pendingLocale: L4Locale | null
}

const listeners = new Set<() => void>()
const settingsListeners = new Set<() => void>()
let settings = HostSettingsSchema.parse({ region: { locale: 'en', timeZone: 'UTC' } })
let snapshot: L4RegionSnapshot | null = null
let initialized = false
let owners = 0

function regionSnapshot(locale: L4Locale): L4RegionSnapshot {
  return {
    locale,
    timeZone: settings.region.timeZone,
    localePreference: settings.region.locale,
    timeZonePreference: settings.region.timeZone,
    pendingLocale: locale === settings.region.locale ? null : settings.region.locale
  }
}

export function readL4HostSettings(): HostSettingsSnapshot {
  return settings
}

export function subscribeL4HostSettings(listener: () => void): () => void {
  settingsListeners.add(listener)
  return () => settingsListeners.delete(listener)
}

export function replaceL4HostSettings(value: HostSettingsSnapshot): void {
  const next = HostSettingsSchema.parse(value)
  const changed = JSON.stringify(settings) !== JSON.stringify(next)
  if (initialized && !changed) return
  const locale = initialized && snapshot ? snapshot.locale : next.region.locale
  settings = next
  initialized = true
  snapshot = regionSnapshot(locale)
  for (const listener of listeners) listener()
  if (changed) {
    for (const listener of settingsListeners) listener()
  }
}

export function setL4RegionDisplayLocale(locale: L4Locale): void {
  snapshot = { ...regionSnapshot(locale), pendingLocale: null }
  for (const listener of listeners) listener()
}

export function readL4Region(): L4RegionSnapshot | null {
  return snapshot
}

export function subscribeL4Region(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function startL4Region(): () => void {
  owners += 1
  if (!snapshot) {
    snapshot = regionSnapshot(settings.region.locale)
    for (const listener of listeners) listener()
  }
  return () => {
    owners -= 1
    if (owners === 0) {
      snapshot = null
      initialized = false
      settings = HostSettingsSchema.parse({ region: { locale: 'en', timeZone: 'UTC' } })
      listeners.clear()
      settingsListeners.clear()
    }
  }
}
