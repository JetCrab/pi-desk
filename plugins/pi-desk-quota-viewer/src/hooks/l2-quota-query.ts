import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import {
  readQuotaSnapshot,
  replaceQuotaSnapshot,
  subscribeQuotaSnapshot
} from '../browser-runtime.js'
import { quotaBiz } from '../l2-quota-biz.js'
import type { QuotaSnapshot } from '../protocol.js'

export function useQuotaSnapshot(): QuotaSnapshot {
  return useSyncExternalStore(subscribeQuotaSnapshot, readQuotaSnapshot, readQuotaSnapshot)
}

export function useCurrentTime(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

export function useQuotaQuery(
  host: BrowserPluginHost,
  signal: AbortSignal
): {
  snapshot: QuotaSnapshot
  loading: boolean
  requesting: boolean
  error: string | null
  refresh(): void
} {
  const snapshot = useQuotaSnapshot()
  const [loading, setLoading] = useState(true)
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const query = useCallback(
    async (force: boolean): Promise<void> => {
      if (pending.current || signal.aborted) return
      pending.current = true
      setRequesting(true)
      setError(null)
      const baseline = readQuotaSnapshot()
      try {
        const next = await quotaBiz.query(host, force)
        // 查询期间已有新 Push 时，不用更早的查询快照倒退页面。
        if (!signal.aborted && readQuotaSnapshot() === baseline) replaceQuotaSnapshot(next)
      } catch (cause) {
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        pending.current = false
        if (!signal.aborted) {
          setLoading(false)
          setRequesting(false)
        }
      }
    },
    [host, signal]
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void query(true)
    })
    const dispose = host.connection.subscribe(() => {
      if (host.connection.getSnapshot().status === 'ready') void query(false)
    })
    return () => {
      active = false
      void dispose()
    }
  }, [host, query])

  return {
    snapshot,
    loading,
    requesting,
    error,
    refresh: () => {
      void query(true)
    }
  }
}
