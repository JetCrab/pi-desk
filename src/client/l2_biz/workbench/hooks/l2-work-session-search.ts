'use client'

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L2WorkSessionSearchResponse } from '@common/l2_biz/work-session/l2-work-session-search-contract'
import type {
  L3PiSessionSearchQuery,
  L3PiSessionSearchScope
} from '@common/l3_modules/pi/l3-pi-session-search-contract'
import type { L2WorkbenchBiz } from '../l2-workbench-biz'
import {
  L2_WORKBENCH_DEFAULT_SEARCH_IN,
  useL2WorkbenchSessionSearch,
  type L2WorkbenchSessionSearchResult
} from './l2-workbench-session-search'

export interface L2WorkSessionSearch extends L2WorkbenchSessionSearchResult<L2WorkSessionSearchResponse> {
  query: string
  searchIn: readonly L3PiSessionSearchScope[]
  setQuery: (query: string) => void
  setSearchIn: (searchIn: readonly L3PiSessionSearchScope[]) => void
}

export function useL2WorkSessionSearch({
  active,
  workSessions,
  searchWorkSessions
}: {
  active: boolean
  workSessions: readonly L2WorkSessionListItem[]
  searchWorkSessions: L2WorkbenchBiz['searchWorkSessions']
}): L2WorkSessionSearch {
  const { t } = useTranslation('workbench')
  const [query, setQuery] = useState('')
  const [searchIn, setSearchIn] = useState<readonly L3PiSessionSearchScope[]>(
    L2_WORKBENCH_DEFAULT_SEARCH_IN
  )
  const request = useCallback(
    (input: L3PiSessionSearchQuery, signal: AbortSignal) => searchWorkSessions(input, signal),
    [searchWorkSessions]
  )
  const search = useL2WorkbenchSessionSearch({
    active: active && query.trim().length > 0,
    scope: workSessions,
    query,
    searchIn,
    request,
    failureMessage: t('sessionSearchFailed')
  })
  return { ...search, query, searchIn, setQuery, setSearchIn }
}
