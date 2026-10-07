'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2PiSessionHistoryResponse,
  L2PiSessionHistorySearchScope
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import type { L2WorkbenchBiz } from '../l2-workbench-biz'

const DEFAULT_SEARCH_IN: readonly L2PiSessionHistorySearchScope[] = ['title', 'user']
const CACHE_CWD_LIMIT = 8

type HistorySessions = L2PiSessionHistoryResponse['sessions']

interface HistorySessionCache {
  base: HistorySessions | null
  recent: {
    query: string
    searchIn: readonly L2PiSessionHistorySearchScope[]
    sessions: HistorySessions
  } | null
}

interface SessionHistoryResult {
  sessions: HistorySessions
  loading: boolean
  load: (
    cwd: string,
    query?: string,
    searchIn?: readonly L2PiSessionHistorySearchScope[],
    forceRefresh?: boolean
  ) => Promise<void>
  cancel: () => void
  showCached: (cwd: string) => void
}

function isDefaultSearchIn(searchIn: readonly L2PiSessionHistorySearchScope[]): boolean {
  return (
    searchIn.length === DEFAULT_SEARCH_IN.length &&
    DEFAULT_SEARCH_IN.every((scope) => searchIn.includes(scope))
  )
}

export function useL2WorkbenchSessionHistory(
  workbenchBiz: L2WorkbenchBiz,
  setError: (error: string | null) => void
): SessionHistoryResult {
  const { t } = useTranslation('workbench')
  const [sessions, setSessions] = useState<HistorySessions>([])
  const [loading, setLoading] = useState(false)
  const requestIdRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const cacheRef = useRef(new Map<string, HistorySessionCache>())

  useEffect(
    () => () => {
      requestIdRef.current += 1
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
    },
    []
  )

  const cancel = useCallback((): void => {
    requestIdRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setLoading(false)
  }, [])

  const showCached = useCallback((cwd: string): void => {
    setSessions(cacheRef.current.get(cwd)?.base ?? [])
  }, [])

  const load = useCallback(
    async (
      cwd: string,
      query = '',
      searchIn: readonly L2PiSessionHistorySearchScope[] = DEFAULT_SEARCH_IN,
      forceRefresh = false
    ): Promise<void> => {
      const requestId = ++requestIdRef.current
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      const normalizedQuery = query.trim()
      const cached = cacheRef.current.get(cwd)
      const cachedSessions =
        isDefaultSearchIn(searchIn) && !normalizedQuery
          ? cached?.base
          : cached?.recent?.query === normalizedQuery &&
              cached.recent.searchIn.length === searchIn.length &&
              cached.recent.searchIn.every((scope) => searchIn.includes(scope))
            ? cached.recent.sessions
            : null
      if (cachedSessions && !forceRefresh) {
        setSessions(cachedSessions)
        setLoading(false)
        setError(null)
        return
      }
      if (cachedSessions) setSessions(cachedSessions)

      const controller = new AbortController()
      abortControllerRef.current = controller
      setLoading(true)
      setError(null)
      try {
        const response = await workbenchBiz.listSessionHistory(
          { cwd, query: normalizedQuery, forceRefresh, searchIn: [...searchIn] },
          controller.signal
        )
        if (requestIdRef.current !== requestId) return
        const current = cacheRef.current.get(cwd) ?? { base: null, recent: null }
        if (isDefaultSearchIn(searchIn) && !normalizedQuery) {
          current.base = response.sessions
        } else {
          current.recent = {
            query: normalizedQuery,
            searchIn: [...searchIn],
            sessions: response.sessions
          }
        }
        cacheRef.current.delete(cwd)
        cacheRef.current.set(cwd, current)
        while (cacheRef.current.size > CACHE_CWD_LIMIT) {
          const oldestCwd = cacheRef.current.keys().next().value
          if (!oldestCwd) break
          cacheRef.current.delete(oldestCwd)
        }
        setSessions(response.sessions)
      } catch (cause) {
        if (
          requestIdRef.current !== requestId ||
          (cause instanceof Error && cause.name === 'AbortError')
        ) {
          return
        }
        setError(cause instanceof Error ? cause.message : t('historyFailed'))
      } finally {
        if (requestIdRef.current === requestId) {
          if (abortControllerRef.current === controller) {
            abortControllerRef.current = null
          }
          setLoading(false)
        }
      }
    },
    [setError, workbenchBiz, t]
  )

  return { sessions, loading, load, cancel, showCached }
}
