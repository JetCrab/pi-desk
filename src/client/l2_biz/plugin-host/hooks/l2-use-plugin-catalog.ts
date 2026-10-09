import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  L2PluginRegistrySchema,
  L2PluginDownloadSourceSchema,
  type L2PluginDownloadSource,
  type L2PluginCatalogItem,
  type L2PluginCatalogDetail,
  type L2PluginCatalogSearchRequest
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import type { L2PluginManagementInstallRequest } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import type { L2PluginManagementBiz } from '../l2-plugin-management-biz'

interface PluginCatalogState {
  query: string
  setQuery: (value: string) => void
  composing: boolean
  beginComposition: () => void
  endComposition: () => void
  kind: L2PluginCatalogSearchRequest['kind']
  setKind: (value: L2PluginCatalogSearchRequest['kind']) => void
  searchSource: 'public' | 'custom'
  setSearchSource: (value: 'public' | 'custom') => void
  registry: string
  setRegistry: (value: string) => void
  items: L2PluginCatalogItem[]
  loading: boolean
  error: string | null
  searched: boolean
  hasMore: boolean
  loadMore: () => void
  retry: () => void
  selection: L2PluginCatalogItem | null
  detail: L2PluginCatalogDetail | null
  detailLoading: boolean
  detailError: string | null
  openDetail: (item: L2PluginCatalogItem) => void
  closeDetail: () => void
  loadDetail: (item: L2PluginCatalogItem, version?: string) => Promise<void>
  prepareInstall: (
    item: L2PluginCatalogItem,
    onReady: (detail: L2PluginCatalogDetail) => void
  ) => Promise<void>
  preparing: ReadonlySet<string>
  installErrors: Record<string, string>
  downloadMode: L2PluginDownloadSource['mode'] | 'default'
  setDownloadMode: (value: L2PluginDownloadSource['mode'] | 'default') => void
  downloadRegistry: string
  setDownloadRegistry: (value: string) => void
  installDetail: (
    onReady: (input: L2PluginManagementInstallRequest, item: L2PluginCatalogDetail) => void
  ) => void
}

export function useL2PluginCatalog(
  biz: L2PluginManagementBiz,
  active: boolean
): PluginCatalogState {
  const { t } = useTranslation('pluginManagement')
  const [query, setQuery] = useState('')
  const [composing, setComposing] = useState(false)
  const [kind, setKind] = useState<L2PluginCatalogSearchRequest['kind']>('all')
  const [searchSource, setSearchSource] = useState<'public' | 'custom'>('public')
  const [registry, setRegistry] = useState('')
  const [items, setItems] = useState<L2PluginCatalogItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [selection, setSelection] = useState<L2PluginCatalogItem | null>(null)
  const [detail, setDetail] = useState<L2PluginCatalogDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState<ReadonlySet<string>>(() => new Set())
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const searchEpoch = useRef(0)
  const detailEpoch = useRef(0)
  const inFlight = useRef(new Set<string>())
  const criteria = useRef<L2PluginCatalogSearchRequest | null>(null)
  const [started, setStarted] = useState(false)
  const [downloadMode, setDownloadMode] = useState<L2PluginDownloadSource['mode'] | 'default'>(
    'default'
  )
  const [downloadRegistry, setDownloadRegistry] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      searchEpoch.current += 1
      detailEpoch.current += 1
    }
  }, [])

  const search = useCallback(
    async (input: L2PluginCatalogSearchRequest, epoch: number): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const result = await biz.searchCatalog(input)
        if (!mounted.current || epoch !== searchEpoch.current) return
        setItems((current) => {
          const combined = input.page === 1 ? result.items : [...current, ...result.items]
          const priority = (item: L2PluginCatalogItem): number =>
            item.official ? 0 : item.kind === 'desk' ? 1 : item.kind === 'pi' ? 2 : 3
          return [...new Map(combined.map((item) => [item.name, item])).values()].sort(
            (left, right) => priority(left) - priority(right)
          )
        })
        setPage(input.page)
        setHasMore(result.hasMore)
        setSearched(true)
      } catch (cause) {
        if (mounted.current && epoch === searchEpoch.current)
          setError(cause instanceof Error ? cause.message : t('searchFailed'))
      } finally {
        if (mounted.current && epoch === searchEpoch.current) setLoading(false)
      }
    },
    [biz, t]
  )

  useEffect(() => {
    if (active) queueMicrotask(() => setStarted(true))
  }, [active])
  useEffect(() => {
    if (!started || composing) return
    const epoch = ++searchEpoch.current
    criteria.current = null
    queueMicrotask(() => {
      if (!mounted.current || epoch !== searchEpoch.current) return
      setLoading(true)
      setError(null)
      setHasMore(false)
    })
    const timer = setTimeout(() => {
      const parsed = searchSource === 'custom' ? L2PluginRegistrySchema.safeParse(registry) : null
      if (parsed && !parsed.success) {
        criteria.current = null
        setItems([])
        setHasMore(false)
        setSearched(false)
        setError(t('invalidRegistry'))
        setLoading(false)
        return
      }
      const input: L2PluginCatalogSearchRequest = {
        query: query.trim(),
        kind,
        page: 1,
        ...(parsed?.success ? { registry: parsed.data } : {})
      }
      criteria.current = input
      setItems([])
      setHasMore(false)
      setSearched(false)
      void search(input, epoch)
    }, 300)
    return () => clearTimeout(timer)
  }, [query, kind, searchSource, registry, composing, search, started, t])

  const loadMore = (): void => {
    if (!criteria.current || loading || !hasMore) return
    void search({ ...criteria.current, page: page + 1 }, searchEpoch.current)
  }
  const retry = (): void => {
    if (composing || loading) return
    const parsed = searchSource === 'custom' ? L2PluginRegistrySchema.safeParse(registry) : null
    if (parsed && !parsed.success) {
      setError(t('invalidRegistry'))
      return
    }
    const input: L2PluginCatalogSearchRequest = {
      query: query.trim(),
      kind,
      page: 1,
      ...(parsed?.success ? { registry: parsed.data } : {})
    }
    criteria.current = input
    setItems([])
    void search(input, ++searchEpoch.current)
  }
  const loadDetail = async (item: L2PluginCatalogItem, version = item.version): Promise<void> => {
    const epoch = ++detailEpoch.current
    setDetailLoading(true)
    setDetailError(null)
    setDetail(null)
    setInstallErrors((current) => {
      const next = { ...current }
      delete next[item.name]
      return next
    })
    try {
      const next = await biz.getCatalog({ name: item.name, registry: item.registry, version })
      if (mounted.current && epoch === detailEpoch.current) setDetail(next)
    } catch (cause) {
      if (mounted.current && epoch === detailEpoch.current)
        setDetailError(cause instanceof Error ? cause.message : t('detailFailed'))
    } finally {
      if (mounted.current && epoch === detailEpoch.current) setDetailLoading(false)
    }
  }
  const openDetail = (item: L2PluginCatalogItem): void => {
    setSelection(item)
    void loadDetail(item)
  }
  const closeDetail = (): void => {
    detailEpoch.current += 1
    setSelection(null)
    setDetail(null)
    setDetailLoading(false)
    setDetailError(null)
  }
  const prepareInstall = async (
    item: L2PluginCatalogItem,
    onReady: (detail: L2PluginCatalogDetail) => void
  ): Promise<void> => {
    if (inFlight.current.has(item.name)) return
    inFlight.current.add(item.name)
    setPreparing(new Set(inFlight.current))
    setInstallErrors((current) => {
      const next = { ...current }
      delete next[item.name]
      return next
    })
    try {
      const next = await biz.getCatalog({
        name: item.name,
        version: item.version,
        registry: item.registry
      })
      if (!mounted.current) return
      if (next.compatible === false) {
        setInstallErrors((current) => ({ ...current, [item.name]: t('installIncompatible') }))
        return
      }
      onReady(next)
    } catch (cause) {
      if (mounted.current)
        setInstallErrors((current) => ({
          ...current,
          [item.name]: cause instanceof Error ? cause.message : t('detailFailed')
        }))
    } finally {
      inFlight.current.delete(item.name)
      if (mounted.current) setPreparing(new Set(inFlight.current))
    }
  }
  const installDetail = (
    onReady: (input: L2PluginManagementInstallRequest, item: L2PluginCatalogDetail) => void
  ): void => {
    if (!detail || detailLoading) return
    if (detail.compatible === false) {
      setInstallErrors((current) => ({ ...current, [detail.name]: t('installIncompatible') }))
      return
    }
    const parsed =
      downloadMode === 'default'
        ? null
        : L2PluginDownloadSourceSchema.safeParse(
            downloadMode === 'custom'
              ? { mode: downloadMode, registry: downloadRegistry }
              : { mode: downloadMode }
          )
    if (parsed && !parsed.success) {
      setInstallErrors((current) => ({ ...current, [detail.name]: t('invalidRegistry') }))
      return
    }
    setInstallErrors((current) => {
      const next = { ...current }
      delete next[detail.name]
      return next
    })
    onReady(
      {
        source: `npm:${detail.name}@${detail.version}`,
        registry: detail.registry,
        ...(parsed?.success ? { downloadSource: parsed.data } : {})
      },
      detail
    )
  }
  const beginComposition = (): void => {
    searchEpoch.current += 1
    criteria.current = null
    setLoading(false)
    setComposing(true)
  }
  return {
    query,
    setQuery,
    composing,
    beginComposition,
    endComposition: (): void => setComposing(false),
    kind,
    setKind,
    searchSource,
    setSearchSource,
    registry,
    setRegistry,
    items,
    loading,
    error,
    searched,
    hasMore,
    loadMore,
    retry,
    selection,
    detail,
    detailLoading,
    detailError,
    openDetail,
    closeDetail,
    loadDetail,
    prepareInstall,
    preparing,
    installErrors,
    downloadMode,
    setDownloadMode,
    downloadRegistry,
    setDownloadRegistry,
    installDetail
  }
}
