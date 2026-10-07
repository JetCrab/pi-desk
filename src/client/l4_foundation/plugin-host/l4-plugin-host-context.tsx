'use client'

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { L4PluginBrowserDescriptor, L4PluginHostRuntime } from './l4-plugin-host-runtime'

export const L4PluginHostContext = createContext<L4PluginHostRuntime | null>(null)

export function useL4PluginHost(): L4PluginHostRuntime {
  const runtime = useContext(L4PluginHostContext)
  if (!runtime) throw new Error('Plugin Host Provider is missing')
  return runtime
}

export function useL4PluginRegistry(): readonly L4PluginBrowserDescriptor[] {
  const runtime = useL4PluginHost()
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribeRegistry(listener),
    [runtime]
  )
  const getSnapshot = useCallback(() => runtime.getRegistrySnapshot(), [runtime])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).descriptors
}
