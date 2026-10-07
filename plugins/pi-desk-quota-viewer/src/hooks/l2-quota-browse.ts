import { useMemo, useState } from 'react'
import { filterRecords, QUOTA_PAGE_SIZE, type QuotaRecord } from '../l2-quota-model.js'
import type { QuotaSourceSnapshot } from '../protocol.js'

interface BrowseState {
  adapter: string
  query: string
  page: number
}

export function useQuotaBrowse(
  records: readonly QuotaRecord[],
  sources: readonly QuotaSourceSnapshot[]
): {
  adapter: string
  query: string
  page: number
  pageCount: number
  total: number
  items: QuotaRecord[]
  setAdapter(adapter: string): void
  setQuery(query: string): void
  setPage(page: number): void
} {
  const [state, setState] = useState<BrowseState>({ adapter: '', query: '', page: 1 })
  const adapter = sources.some((source) => source.adapter === state.adapter) ? state.adapter : ''
  const filtered = useMemo(
    () => filterRecords(records, adapter, state.query),
    [adapter, records, state.query]
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / QUOTA_PAGE_SIZE))
  const page = adapter !== state.adapter ? 1 : Math.min(state.page, pageCount)
  if (adapter !== state.adapter || page !== state.page) {
    setState({ ...state, adapter, page })
  }
  return {
    adapter,
    query: state.query,
    page,
    pageCount,
    total: filtered.length,
    items: filtered.slice((page - 1) * QUOTA_PAGE_SIZE, page * QUOTA_PAGE_SIZE),
    setAdapter: (value): void => {
      setState((current) => ({ ...current, adapter: value, page: 1 }))
    },
    setQuery: (query): void => {
      setState((current) => ({ ...current, query, page: 1 }))
    },
    setPage: (page): void => {
      setState((current) => ({ ...current, page }))
    }
  }
}
