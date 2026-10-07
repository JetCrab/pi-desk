import { useCallback, useSyncExternalStore } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'

export function useUsageTimeZone(host: BrowserPluginHost): string {
  const subscribe = useCallback((listener: () => void) => host.settings.subscribe(listener), [host])
  const getSnapshot = useCallback(() => host.settings.getSnapshot(), [host])
  return useSyncExternalStore(subscribe, getSnapshot).region.timeZone
}
