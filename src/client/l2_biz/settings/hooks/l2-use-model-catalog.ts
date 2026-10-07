import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2ModelCatalogItem,
  L2ModelCatalogSource
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import type { L2ModelSettingsBiz } from '../l2-model-settings-biz'

export interface ModelCatalogCandidate {
  key: string
  item: L2ModelCatalogItem
  source: L2ModelCatalogSource
  equivalentSourceCount: number
  recommended: boolean
}

function defaultsKey(item: L2ModelCatalogItem, source: L2ModelCatalogSource): string {
  return JSON.stringify([item.referenceId, source.modelId, source.defaults])
}

function priority(source: L2ModelCatalogSource): number {
  return (source.official ? 100 : 0) + (source.defaults.cost ? 10 : 0)
}

export function useL2ModelCatalog(
  biz: L2ModelSettingsBiz,
  modelId: string
): {
  searchText: string
  setSearchText: (text: string) => void
  catalogOpen: boolean
  setCatalogOpen: (open: boolean) => void
  loadingCatalog: boolean
  candidates: ModelCatalogCandidate[]
  visibleCandidates: ModelCatalogCandidate[]
  showAllCandidates: boolean
  setShowAllCandidates: (show: boolean) => void
  selectedCandidateKey: string | null
  setSelectedCandidateKey: (key: string | null) => void
} {
  const { t } = useTranslation('settings')
  const toast = useL4AppToast()
  const searchVersion = useRef(0)
  const [searchText, setSearchText] = useState(modelId)
  const [catalog, setCatalog] = useState<L2ModelCatalogItem[]>([])
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string | null>(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [showAllCandidates, setShowAllCandidates] = useState(false)

  const candidates = useMemo<ModelCatalogCandidate[]>(() => {
    const groups = new Map<string, { item: L2ModelCatalogItem; sources: L2ModelCatalogSource[] }>()
    const exactMatches = catalog.filter((item) => item.match === 'exact')
    for (const item of exactMatches.length ? exactMatches : catalog) {
      for (const source of item.sources) {
        const key = defaultsKey(item, source)
        const group = groups.get(key)
        if (group) group.sources.push(source)
        else groups.set(key, { item, sources: [source] })
      }
    }
    const query = searchText.trim().toLocaleLowerCase()
    return [...groups.entries()]
      .map(([key, group]) => {
        const sources = [...group.sources].sort(
          (left, right) =>
            priority(right) - priority(left) || left.providerName.localeCompare(right.providerName)
        )
        const source = sources[0]
        return {
          key,
          item: group.item,
          source,
          equivalentSourceCount: sources.length,
          recommended: source.official
        }
      })
      .sort((left, right) => {
        const leftMatch = left.item.match === 'exact' ? 0 : left.item.match === 'similar' ? 1 : 2
        const rightMatch = right.item.match === 'exact' ? 0 : right.item.match === 'similar' ? 1 : 2
        return (
          leftMatch - rightMatch ||
          Number(right.recommended) - Number(left.recommended) ||
          Number(right.source.modelId.toLocaleLowerCase() === query) -
            Number(left.source.modelId.toLocaleLowerCase() === query) ||
          left.source.providerName.localeCompare(right.source.providerName)
        )
      })
  }, [catalog, searchText])

  useEffect(() => {
    const version = ++searchVersion.current
    if (!catalogOpen) return
    const timeout = window.setTimeout(() => {
      setLoadingCatalog(true)
      void biz
        .listCatalog({ query: searchText.trim(), refresh: false, page: { index: 1, size: 10 } })
        .then((result) => {
          if (searchVersion.current === version) setCatalog(result.models)
        })
        .catch((error: unknown) => {
          if (searchVersion.current !== version) return
          setCatalog([])
          toast.error(error instanceof Error ? error.message : t('catalogSearchFailed'))
        })
        .finally(() => {
          if (searchVersion.current === version) setLoadingCatalog(false)
        })
    }, 250)
    return () => {
      window.clearTimeout(timeout)
      if (searchVersion.current === version) searchVersion.current += 1
    }
  }, [biz, catalogOpen, searchText, toast, t])

  return {
    searchText,
    setSearchText,
    catalogOpen,
    setCatalogOpen: (open) => {
      setCatalogOpen(open)
      if (!open) setLoadingCatalog(false)
    },
    loadingCatalog,
    candidates,
    visibleCandidates: showAllCandidates ? candidates : candidates.slice(0, 6),
    showAllCandidates,
    setShowAllCandidates,
    selectedCandidateKey,
    setSelectedCandidateKey
  }
}
