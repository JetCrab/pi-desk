'use client'

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  L3PiSessionSearchQuery,
  L3PiSessionSearchScope
} from '@common/l3_modules/pi/l3-pi-session-search-contract'

export const L2_WORKBENCH_DEFAULT_SEARCH_IN: readonly L3PiSessionSearchScope[] = ['title', 'user']

export interface L2WorkbenchSessionSearchResult<T> {
  data: T | null
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useL2WorkbenchSessionSearch<T>({
  active,
  scope,
  query,
  searchIn,
  request,
  failureMessage
}: {
  active: boolean
  scope: unknown
  query: string
  searchIn: readonly L3PiSessionSearchScope[]
  request: (input: L3PiSessionSearchQuery, signal: AbortSignal, forceRefresh: boolean) => Promise<T>
  failureMessage: string
}): L2WorkbenchSessionSearchResult<T> {
  const [attempt, setAttempt] = useState(0)
  const forceRefreshRef = useRef(false)
  const normalizedQuery = query.trim()
  const key = useMemo(
    () => ({ active, scope, query: normalizedQuery, searchIn, request, attempt, failureMessage }),
    [active, scope, normalizedQuery, searchIn, request, attempt, failureMessage]
  )
  const [state, setState] = useState<{
    key: typeof key
    data: T | null
    loading: boolean
    error: string | null
  } | null>(null)
  if (state?.key !== key) {
    setState({ key, data: null, loading: key.active, error: null })
  }

  useLayoutEffect(() => {
    const forceRefresh = forceRefreshRef.current
    forceRefreshRef.current = false
    if (!key.active) return

    const controller = new AbortController()
    const timer = window.setTimeout(
      () => {
        void request(
          { query: key.query, searchIn: [...key.searchIn] },
          controller.signal,
          forceRefresh
        ).then(
          (data) => {
            if (!controller.signal.aborted) setState({ key, data, loading: false, error: null })
          },
          (cause: unknown) => {
            if (controller.signal.aborted) return
            setState({
              key,
              data: null,
              loading: false,
              error: cause instanceof Error ? cause.message : key.failureMessage
            })
          }
        )
      },
      key.query && !forceRefresh ? 300 : 0
    )

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [key, request])

  const refresh = useCallback((): void => {
    forceRefreshRef.current = true
    setAttempt((current) => current + 1)
  }, [])
  const current = state?.key === key ? state : null
  return {
    data: current?.data ?? null,
    loading: active && (current?.loading ?? true),
    error: current?.error ?? null,
    refresh
  }
}
