import { useEffect, useMemo, useState } from 'react'
import type { L2PluginCatalogGetRequest } from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import type { L2PluginManagementBiz } from '../l2-plugin-management-biz'

export interface L2PluginDevAvailability {
  loading: boolean
  version: string | null
  error: string | null
  retry?: () => void
}

// The catalog Owner resolves package ownership when registry is omitted.
export function queryL2PluginDevAvailability(
  biz: Pick<L2PluginManagementBiz, 'getCatalog'>,
  target: Omit<L2PluginCatalogGetRequest, 'version'>,
  onResult: (result: { version: string | null; error: string | null }) => void
): () => void {
  let active = true
  void biz.getCatalog({ ...target, version: 'dev' }).then(
    (detail) => {
      if (!active) return
      if (
        target.registry &&
        detail.registry.replace(/\/+$/, '') !== target.registry.replace(/\/+$/, '')
      ) {
        onResult({
          version: null,
          error: '查询返回的仓库与所选来源不一致，无法确认此来源的 dev 渠道。'
        })
      } else onResult({ version: detail.version, error: null })
    },
    (cause: unknown) => {
      if (active)
        onResult({ version: null, error: cause instanceof Error ? cause.message : String(cause) })
    }
  )
  return () => {
    active = false
  }
}

export function useL2PluginDevAvailability(
  biz: L2PluginManagementBiz,
  name: string | null,
  registry: string | undefined,
  sourceContext: string
): L2PluginDevAvailability {
  const [attempt, setAttempt] = useState(0)
  const query = useMemo(
    () => ({ biz, name, registry, sourceContext, attempt }),
    [biz, name, registry, sourceContext, attempt]
  )
  const [result, setResult] = useState<{
    query: typeof query
    version: string | null
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!query.name) return
    return queryL2PluginDevAvailability(
      query.biz,
      { name: query.name, ...(query.registry ? { registry: query.registry } : {}) },
      (next) => setResult({ query, ...next })
    )
  }, [query])
  const current = result?.query === query ? result : null
  return {
    loading: Boolean(name && !current),
    version: current?.version ?? null,
    error: current?.error ?? null,
    retry: () => setAttempt((value) => value + 1)
  }
}
