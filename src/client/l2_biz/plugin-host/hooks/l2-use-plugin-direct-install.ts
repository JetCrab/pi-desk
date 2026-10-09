import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  L2PluginDownloadSourceSchema,
  L2PluginRegistrySchema,
  type L2PluginCatalogDetail,
  type L2PluginDownloadSource
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import type { L2PluginManagementInstallRequest } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import type { L2PluginManagementBiz } from '../l2-plugin-management-biz'
import { pluginNpmSpec } from '../l2-use-plugin-management'

interface PluginDirectInstallState {
  open: boolean
  setOpen: (value: boolean) => void
  source: string
  changeSource: (value: string) => void
  spec: ReturnType<typeof pluginNpmSpec>
  detail: L2PluginCatalogDetail | null
  loading: boolean
  error: string | null
  override: L2PluginDownloadSource['mode'] | 'default'
  setOverride: (value: L2PluginDownloadSource['mode'] | 'default') => void
  registry: string
  setRegistry: (value: string) => void
  loadDetail: (version?: string) => Promise<L2PluginCatalogDetail | null>
  install: (
    onReady: (input: L2PluginManagementInstallRequest, detail?: L2PluginCatalogDetail) => void
  ) => Promise<void>
}

export function useL2PluginDirectInstall(biz: L2PluginManagementBiz): PluginDirectInstallState {
  const { t } = useTranslation('pluginManagement')
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState('')
  const [detail, setDetail] = useState<L2PluginCatalogDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [override, setOverrideValue] = useState<L2PluginDownloadSource['mode'] | 'default'>(
    'default'
  )
  const [registry, setRegistryValue] = useState('')
  const epoch = useRef(0)
  const mounted = useRef(true)
  const spec = pluginNpmSpec(source.trim())
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      epoch.current += 1
    }
  }, [])
  const invalidateDetail = (): void => {
    epoch.current += 1
    setDetail(null)
    setLoading(false)
    setError(null)
  }
  const changeSource = (value: string): void => {
    invalidateDetail()
    setSource(value)
  }
  const loadDetail = async (version?: string): Promise<L2PluginCatalogDetail | null> => {
    if (!spec) return null
    let lookupRegistry: string | undefined
    if (override === 'custom') {
      const parsed = L2PluginRegistrySchema.safeParse(registry)
      if (!parsed.success) {
        setError(t('invalidRegistry'))
        return null
      }
      lookupRegistry = parsed.data
    } else if (override === 'official') {
      lookupRegistry = 'https://registry.npmjs.org'
    } else if (override === 'domestic') {
      lookupRegistry = 'https://registry.npmmirror.com'
    }
    const request = ++epoch.current
    setLoading(true)
    setDetail(null)
    setError(null)
    try {
      const next = await biz.getCatalog({
        ...spec,
        ...(version ? { version } : {}),
        ...(lookupRegistry ? { registry: lookupRegistry } : {})
      })
      if (!mounted.current || request !== epoch.current) return null
      setDetail(next)
      return next
    } catch (cause) {
      if (mounted.current && request === epoch.current)
        setError(cause instanceof Error ? cause.message : t('detailFailed'))
      return null
    } finally {
      if (mounted.current && request === epoch.current) setLoading(false)
    }
  }
  const install = async (
    onReady: (input: L2PluginManagementInstallRequest, detail?: L2PluginCatalogDetail) => void
  ): Promise<void> => {
    if (!source.trim() || loading) return
    setError(null)
    if (!spec) {
      onReady({ source: source.trim() })
      return
    }
    const parsed =
      override === 'default'
        ? null
        : L2PluginDownloadSourceSchema.safeParse(
            override === 'custom' ? { mode: override, registry } : { mode: override }
          )
    if (parsed && !parsed.success) {
      setError(t('invalidRegistry'))
      return
    }
    const packageRequest = detail ? Promise.resolve(detail) : loadDetail()
    const request = epoch.current
    const packageDetail = await packageRequest
    if (!packageDetail || !mounted.current || request !== epoch.current) return
    if (packageDetail.compatible === false) {
      setError(t('installIncompatible'))
      return
    }
    onReady(
      {
        source: `npm:${packageDetail.name}@${packageDetail.version}`,
        registry: packageDetail.registry,
        ...(parsed?.success ? { downloadSource: parsed.data } : {})
      },
      packageDetail
    )
  }
  return {
    open,
    setOpen,
    source,
    changeSource,
    spec,
    detail,
    loading,
    error,
    override,
    setOverride: (value: PluginDirectInstallState['override']): void => {
      invalidateDetail()
      setOverrideValue(value)
    },
    registry,
    setRegistry: (value: string): void => {
      invalidateDetail()
      setRegistryValue(value)
    },
    loadDetail,
    install
  }
}
