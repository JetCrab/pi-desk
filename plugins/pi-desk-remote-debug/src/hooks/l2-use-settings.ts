import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import type { RemoteDebugBrowserEvents } from '../l4-browser-events.js'
import type { RemoteDebugRegistration, RemoteDebugSettings } from '../l4-remote-debug-contract.js'
import {
  deleteRegistration,
  editRanges,
  errorMessage,
  getCatalog,
  getSettings,
  saveRanges,
  type RangeEditor
} from '../l2-browser-biz.js'

export function useSettings(
  host: BrowserPluginHost,
  signal: AbortSignal,
  events: RemoteDebugBrowserEvents
): {
  settings: RemoteDebugSettings | null
  ranges: RangeEditor | null
  loading: boolean
  busy: boolean
  dirtyRanges: boolean
  error: string | null
  rangeError: string | null
  setRanges(value: RangeEditor): void
  saveRangeDraft(): Promise<void>
  removeRegistration(value: RemoteDebugRegistration): Promise<boolean>
  refresh(discover?: boolean): Promise<void>
} {
  const [settings, setSettings] = useState<RemoteDebugSettings | null>(null)
  const [ranges, setRanges] = useState<RangeEditor | null>(null)
  const [savedRanges, setSavedRanges] = useState('null')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [rangeError, setRangeError] = useState<string | null>(null)
  const dirtyRanges = JSON.stringify(ranges) !== savedRanges
  const rangesDirtyRef = useRef(dirtyRanges)
  useEffect(() => {
    rangesDirtyRef.current = dirtyRanges
  }, [dirtyRanges])
  const epoch = useRef(0)
  const discovering = useRef(false)
  const acceptSettings = useCallback(
    (next: RemoteDebugSettings, overwriteRanges: boolean): void => {
      setSettings(next)
      if (overwriteRanges) {
        const editor = editRanges(next)
        setRanges(editor)
        setSavedRanges(JSON.stringify(editor))
      }
    },
    []
  )
  const refresh = useCallback(
    async (discover = true): Promise<void> => {
      const current = ++epoch.current
      setLoading(true)
      try {
        if (discover) discovering.current = true
        if (discover) await getCatalog(host)
        if (discover) discovering.current = false
        if (signal.aborted || current !== epoch.current) return
        const next = await getSettings(host)
        if (signal.aborted || current !== epoch.current) return
        acceptSettings(next, !rangesDirtyRef.current)
        setError(null)
      } catch (cause) {
        if (!signal.aborted && current === epoch.current) setError(errorMessage(cause))
      } finally {
        if (discover) discovering.current = false
        if (!signal.aborted && current === epoch.current) setLoading(false)
      }
    },
    [host, signal, acceptSettings]
  )
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void refresh()
    })
    const disposeConnection = host.connection.subscribe(() => {
      if (host.connection.getSnapshot().status === 'ready') void refresh()
    })
    const disposeEvents = events.subscribe(() => {
      if (!busyRef.current && !discovering.current) void refresh(false)
    })
    return (): void => {
      active = false
      epoch.current += 1
      disposeConnection()
      disposeEvents()
    }
  }, [host, events, refresh])
  function begin(): boolean {
    if (busyRef.current) return false
    busyRef.current = true
    epoch.current += 1
    setLoading(false)
    setBusy(true)
    return true
  }
  function end(): void {
    busyRef.current = false
    if (!signal.aborted) setBusy(false)
  }
  async function saveRangeDraft(): Promise<void> {
    if (!ranges || !begin()) return
    setRangeError(null)
    try {
      const next = await saveRanges(host, ranges)
      if (signal.aborted) return
      acceptSettings(next, true)
      setError(null)
      host.notify({ level: 'success', title: '端口范围已保存' })
    } catch (cause) {
      if (!signal.aborted) setRangeError(errorMessage(cause))
    } finally {
      end()
    }
  }
  async function removeRegistration(value: RemoteDebugRegistration): Promise<boolean> {
    if (!begin()) return false
    try {
      const next = await deleteRegistration(host, value)
      if (signal.aborted) return false
      acceptSettings(next, !rangesDirtyRef.current)
      setError(null)
      host.notify({ level: 'success', title: '登记已移除' })
      return true
    } catch (cause) {
      if (!signal.aborted) setError(errorMessage(cause))
      return false
    } finally {
      end()
    }
  }
  return {
    settings,
    ranges,
    loading,
    busy,
    dirtyRanges,
    error,
    rangeError,
    setRanges,
    saveRangeDraft,
    removeRegistration,
    refresh
  }
}
