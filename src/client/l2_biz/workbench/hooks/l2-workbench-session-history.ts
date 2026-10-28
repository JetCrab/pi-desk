'use client'

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2PiSessionHistoryResponse,
  L2PiSessionUserMessageListResponse
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import type {
  L3PiSessionSearchQuery,
  L3PiSessionSearchScope
} from '@common/l3_modules/pi/l3-pi-session-search-contract'
import type { L2WorkbenchBiz } from '../l2-workbench-biz'
import { useL2WorkbenchSessionSearch } from './l2-workbench-session-search'

interface L2ExpandedHistoryMessages {
  sessionId: string
  query: string
  messages: L2PiSessionUserMessageListResponse['messages']
  page: L2PiSessionUserMessageListResponse['page'] | null
  loading: boolean
  error: string | null
}

interface L2WorkbenchSessionHistoryResult {
  sessions: L2PiSessionHistoryResponse['sessions']
  loading: boolean
  error: string | null
  refresh: () => void
  expandedHistory: L2ExpandedHistoryMessages | null
  toggleUserMessages: (session: L2PiSessionHistoryResponse['sessions'][number]) => void
  loadUserMessages: (
    sessionId: string,
    query: string,
    pageIndex: number,
    append: boolean
  ) => Promise<void>
}

export function useL2WorkbenchSessionHistory({
  active,
  cwd,
  query,
  searchIn,
  listSessionHistory,
  listSessionUserMessages
}: {
  active: boolean
  cwd: string | null
  query: string
  searchIn: readonly L3PiSessionSearchScope[]
  listSessionHistory: L2WorkbenchBiz['listSessionHistory']
  listSessionUserMessages: L2WorkbenchBiz['listSessionUserMessages']
}): L2WorkbenchSessionHistoryResult {
  const { t } = useTranslation('workbenchPicker')
  const request = useCallback(
    (input: L3PiSessionSearchQuery, signal: AbortSignal, forceRefresh: boolean) =>
      listSessionHistory({ ...input, cwd: cwd!, forceRefresh }, signal),
    [cwd, listSessionHistory]
  )
  const search = useL2WorkbenchSessionSearch({
    active: active && cwd !== null,
    scope: cwd,
    query,
    searchIn,
    request,
    failureMessage: t('loadHistoryFailed')
  })
  const [expandedHistory, setExpandedHistory] = useState<L2ExpandedHistoryMessages | null>(null)
  const messageContext = useMemo(
    () => ({ active, cwd, query, searchIn }),
    [active, cwd, query, searchIn]
  )
  const [previousMessageContext, setPreviousMessageContext] = useState(messageContext)
  if (previousMessageContext !== messageContext) {
    setPreviousMessageContext(messageContext)
    setExpandedHistory(null)
  }
  const messageControllerRef = useRef<AbortController | null>(null)
  const clearUserMessages = useCallback((): void => {
    messageControllerRef.current?.abort()
    messageControllerRef.current = null
    setExpandedHistory(null)
  }, [])

  useLayoutEffect(
    () => () => {
      messageControllerRef.current?.abort()
      messageControllerRef.current = null
    },
    [active, cwd, query, searchIn]
  )

  const loadUserMessages = async (
    sessionId: string,
    messageQuery: string,
    pageIndex: number,
    append: boolean
  ): Promise<void> => {
    if (!active || !cwd) return
    messageControllerRef.current?.abort()
    const controller = new AbortController()
    messageControllerRef.current = controller
    setExpandedHistory((current) => ({
      sessionId,
      query: messageQuery,
      messages: append && current?.sessionId === sessionId ? current.messages : [],
      page: append && current?.sessionId === sessionId ? current.page : null,
      loading: true,
      error: null
    }))
    try {
      const response = await listSessionUserMessages(
        { cwd, sessionId, query: messageQuery, page: { index: pageIndex, size: 20 } },
        controller.signal
      )
      if (controller.signal.aborted) return
      setExpandedHistory((current) => ({
        sessionId,
        query: messageQuery,
        messages:
          append && current?.sessionId === sessionId
            ? [...current.messages, ...response.messages]
            : response.messages,
        page: response.page,
        loading: false,
        error: null
      }))
    } catch (cause) {
      if (controller.signal.aborted) return
      setExpandedHistory((current) => ({
        sessionId,
        query: messageQuery,
        messages: current?.sessionId === sessionId ? current.messages : [],
        page: current?.sessionId === sessionId ? current.page : null,
        loading: false,
        error: cause instanceof Error ? cause.message : t('loadUserFailed')
      }))
    } finally {
      if (messageControllerRef.current === controller) messageControllerRef.current = null
    }
  }

  const toggleUserMessages = (session: L2PiSessionHistoryResponse['sessions'][number]): void => {
    if (expandedHistory?.sessionId === session.sessionId) {
      clearUserMessages()
      return
    }
    const messageQuery = session.matches?.some((match) => match.scope === 'user') ? query : ''
    void loadUserMessages(session.sessionId, messageQuery, 1, false)
  }
  const refresh = (): void => {
    clearUserMessages()
    search.refresh()
  }
  return {
    sessions: search.data?.sessions ?? [],
    loading: search.loading,
    error: search.error,
    refresh,
    expandedHistory: active ? expandedHistory : null,
    toggleUserMessages,
    loadUserMessages
  }
}
