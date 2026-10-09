import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  L2PluginDownloadSourceSchema,
  type L2PluginCatalogSettings,
  type L2PluginDownloadSource
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import type { L2PluginManagementBiz } from '../l2-plugin-management-biz'

interface PluginDownloadSourceState {
  settings: L2PluginCatalogSettings | null
  mode: L2PluginDownloadSource['mode']
  registry: string
  setRegistry: (value: string) => void
  loading: boolean
  saving: boolean
  error: string | null
  load: () => Promise<void>
  save: (mode?: L2PluginDownloadSource['mode']) => Promise<void>
  changeMode: (mode: L2PluginDownloadSource['mode']) => void
  retry: () => Promise<void>
}

export function useL2PluginDownloadSource(biz: L2PluginManagementBiz): PluginDownloadSourceState {
  const { t } = useTranslation('pluginManagement')
  const [settings, setSettings] = useState<L2PluginCatalogSettings | null>(null)
  const [mode, setMode] = useState<L2PluginDownloadSource['mode']>('auto')
  const [registry, setRegistry] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const pending = useRef(false)
  const draftEpoch = useRef(0)
  const failedRequest = useRef<'load' | 'save'>('load')
  const load = async (): Promise<void> => {
    const epoch = draftEpoch.current
    setLoading(true)
    setError(null)
    try {
      const next = await biz.getCatalogSettings()
      if (!mounted.current) return
      if (epoch === draftEpoch.current) {
        setSettings(next)
        setMode(next.downloadSource.mode)
        if (next.downloadSource.mode === 'custom') setRegistry(next.downloadSource.registry)
      } else {
        setSettings((current) => current ?? next)
      }
    } catch (cause) {
      failedRequest.current = 'load'
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('settingsFailed'))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => {
      active = false
      mounted.current = false
    }
    // Settings are loaded once per management API instance; changing language keeps drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biz])
  const save = async (nextMode = mode): Promise<void> => {
    if (pending.current) return
    const parsed = L2PluginDownloadSourceSchema.safeParse(
      nextMode === 'custom' ? { mode: nextMode, registry } : { mode: nextMode }
    )
    if (!parsed.success) {
      failedRequest.current = 'save'
      setError(t('invalidRegistry'))
      return
    }
    pending.current = true
    setSaving(true)
    setError(null)
    try {
      const next = await biz.saveCatalogSettings(parsed.data)
      if (mounted.current) {
        setSettings(next)
        setMode(next.downloadSource.mode)
      }
    } catch (cause) {
      failedRequest.current = 'save'
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('settingsFailed'))
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const changeMode = (next: L2PluginDownloadSource['mode']): void => {
    draftEpoch.current += 1
    setMode(next)
    if (next !== 'custom') void save(next)
  }
  return {
    settings,
    mode,
    registry,
    setRegistry: (value: string): void => {
      draftEpoch.current += 1
      setRegistry(value)
    },
    loading,
    saving,
    error,
    load,
    save,
    changeMode,
    retry: (): Promise<void> => (failedRequest.current === 'save' ? save() : load())
  }
}
