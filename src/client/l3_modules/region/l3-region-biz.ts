'use client'

import type { L4Locale } from '@common/l4_foundation/locale/l4-locale'
import { L3AppRuntimeSocketContracts } from '@common/l3_modules/app-runtime/l3-app-runtime-websocket-contract'
import type { L4AppSocketClient } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { readL4Region } from '@client/l4_foundation/locale/l4-region-store'

export async function changeL3RegionLanguage(
  locale: L4Locale,
  confirmation: string,
  appSocket: L4AppSocketClient,
  canLeave?: () => boolean | Promise<boolean>
): Promise<'changed' | 'cancelled' | 'blocked' | 'save-failed'> {
  const current = readL4Region()
  if (!current) return 'cancelled'
  const reload = locale !== current.locale
  if (reload && !window.confirm(confirmation)) return 'cancelled'
  if (reload && canLeave && !(await canLeave())) return 'blocked'
  try {
    await appSocket.request(L3AppRuntimeSocketContracts.apply, {
      key: 'settings',
      update: { region: { locale } }
    })
  } catch {
    return 'save-failed'
  }
  if (reload) window.location.reload()
  return 'changed'
}

export async function changeL3RegionTimeZone(
  timeZone: string,
  appSocket: L4AppSocketClient
): Promise<boolean> {
  try {
    await appSocket.request(L3AppRuntimeSocketContracts.apply, {
      key: 'settings',
      update: { region: { timeZone } }
    })
    return true
  } catch {
    return false
  }
}

export function listL3RegionTimeZones(): string[] {
  return ['UTC', ...Intl.supportedValuesOf('timeZone').filter((timeZone) => timeZone !== 'UTC')]
}
