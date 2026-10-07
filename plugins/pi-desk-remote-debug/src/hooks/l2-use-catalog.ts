import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import type { RemoteDebugProject } from '../runtime.js'
import type { RemoteDebugBrowserEvents } from '../l4-browser-events.js'
import { errorMessage, getCatalog } from '../l2-browser-biz.js'

export function useCatalog(
  host: BrowserPluginHost,
  signal: AbortSignal,
  events: RemoteDebugBrowserEvents
): {
  projects: RemoteDebugProject[]
  loading: boolean
  error: string | null
  refresh(): Promise<RemoteDebugProject[] | null>
} {
  const [projects, setProjects] = useState<RemoteDebugProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const refresh = useCallback(async (): Promise<RemoteDebugProject[] | null> => {
    const current = ++epoch.current
    setLoading(true)
    try {
      const next = await getCatalog(host)
      if (signal.aborted || current !== epoch.current) return null
      setProjects(next)
      setError(null)
      return next
    } catch (cause) {
      if (!signal.aborted && current === epoch.current) setError(errorMessage(cause))
      return null
    } finally {
      if (!signal.aborted && current === epoch.current) setLoading(false)
    }
  }, [host, signal])
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void refresh()
    })
    const disposeConnection = host.connection.subscribe(() => {
      if (host.connection.getSnapshot().status === 'ready') void refresh()
    })
    const disposeSessions = host.workSessions.subscribe(() => {
      void refresh()
    })
    const disposeEvents = events.subscribe(() => {
      void refresh()
    })
    return (): void => {
      active = false
      epoch.current += 1
      disposeConnection()
      disposeSessions()
      disposeEvents()
    }
  }, [host, events, refresh])
  return { projects, loading, error, refresh }
}
