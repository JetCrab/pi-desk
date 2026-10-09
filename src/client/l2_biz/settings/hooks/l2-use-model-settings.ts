import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserBeforeLeaveHandler } from '@jetcrab/pi-desk-sdk/browser'
import type {
  L2AccountModelSelection,
  L2ModelPreset,
  L2ModelProviderConfig,
  L2ModelSettingsGetResponse,
  L2ModelSettingsReplaceRequest
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { useL4ConfirmDialog } from '@client/l4_foundation/ui/l4-confirm-dialog'
import { createL2ModelSettingsBiz, type L2ModelSettingsBiz } from '../l2-model-settings-biz'
import {
  readL2ModelSettingsTab,
  saveL2ModelSettingsTab,
  type L2ModelSettingsTab
} from '../l2-settings-biz'

export type ModelSettingsTab = L2ModelSettingsTab

interface ModelSettingsState {
  biz: L2ModelSettingsBiz
  tab: ModelSettingsTab
  settings: L2ModelSettingsGetResponse | null
  providers: L2ModelProviderConfig[]
  presets: L2ModelPreset[]
  accountModels: L2AccountModelSelection[]
  changeAccountModels: (models: L2AccountModelSelection[]) => void
  refreshAccounts: () => Promise<L2ModelSettingsGetResponse>
  providersDirty: boolean
  presetsDirty: boolean
  loading: boolean
  saving: boolean
  refreshing: boolean
  catalogUpdatedAt: number | null
  loadError: string | null
  resetVersion: number
  formDirty: boolean
  formInvalid: boolean
  serviceDirty: boolean
  nativeOpen: boolean
  nativeText: string
  nativeError: string | null
  nativeDirty: boolean
  setNativeText: (text: string) => void
  openNative: () => void
  closeNative: () => Promise<void>
  saveNative: () => Promise<void>
  revertConfig: () => Promise<void>
  setInputState: (state: { dirty: boolean; invalid: boolean }) => void
  setServiceDirty: (dirty: boolean) => void
  dialog: React.JSX.Element | null
  setProjectDefaultDirty: (dirty: boolean) => void
  changeProviders: (providers: L2ModelProviderConfig[]) => void
  changePresets: (presets: L2ModelPreset[]) => void
  selectTab: (tab: ModelSettingsTab) => void
  retry: () => void
  refreshCatalog: () => Promise<void>
  saveConfig: () => Promise<void>
}

export function useL2ModelSettings(
  onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void,
  initialTab?: ModelSettingsTab
): ModelSettingsState {
  const { t } = useTranslation('settings')
  const { clientId } = useL4AppSocket()
  const toast = useL4AppToast()
  const { confirm, dialog } = useL4ConfirmDialog()
  const biz = useMemo(() => createL2ModelSettingsBiz(clientId), [clientId])
  const [tab, setTab] = useState<ModelSettingsTab>(() => initialTab ?? readL2ModelSettingsTab())
  useEffect(() => {
    saveL2ModelSettingsTab(tab)
  }, [tab])
  const [settings, setSettings] = useState<L2ModelSettingsGetResponse | null>(null)
  const [providers, setProviders] = useState<L2ModelProviderConfig[]>([])
  const [presets, setPresets] = useState<L2ModelPreset[]>([])
  const [accountModels, setAccountModels] = useState<L2AccountModelSelection[]>([])
  const [accountModelsDirty, setAccountModelsDirty] = useState(false)
  const [providersDirty, setProvidersDirty] = useState(false)
  const [presetsDirty, setPresetsDirty] = useState(false)
  const [projectDefaultDirty, setProjectDefaultDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [resetVersion, setResetVersion] = useState(0)
  const [inputState, setInputState] = useState({ dirty: false, invalid: false })
  const [serviceDirty, setServiceDirty] = useState(false)
  const [nativeOpen, setNativeOpen] = useState(false)
  const [nativeText, setNativeText] = useState('')
  const [nativeError, setNativeError] = useState<string | null>(null)
  const savingRef = useRef(false)
  const nativeBaseline = settings ? JSON.stringify(settings.nativeConfig, null, 2) : ''
  const nativeDirty = nativeOpen && nativeText !== nativeBaseline
  const formDirty = providersDirty || presetsDirty || accountModelsDirty || inputState.dirty
  const dirty = formDirty || projectDefaultDirty || serviceDirty || nativeDirty

  useEffect(() => {
    onBeforeLeaveChange(
      dirty
        ? () =>
            saving
              ? false
              : confirm({
                  title: t('discardModelTitle'),
                  description: t('discardModelDescription'),
                  confirmLabel: t('discardModelConfirm')
                })
        : null
    )
    return () => onBeforeLeaveChange(null)
  }, [onBeforeLeaveChange, dirty, saving, confirm, t])

  useEffect(() => {
    if (!dirty) return
    const preventReload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventReload)
    return () => window.removeEventListener('beforeunload', preventReload)
  }, [dirty])

  const applySettings = useCallback((result: L2ModelSettingsGetResponse): void => {
    setSettings(result)
    setProviders(structuredClone(result.providers))
    setPresets(structuredClone(result.presets))
    setAccountModels(structuredClone(result.accountModels))
    setAccountModelsDirty(false)
    setProvidersDirty(false)
    setPresetsDirty(false)
    setInputState({ dirty: false, invalid: false })
    setResetVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    let disposed = false
    queueMicrotask(() => {
      if (disposed) return
      setLoading(true)
      setLoadError(null)
    })

    void biz
      .getSettings()
      .then((result) => {
        if (!disposed) applySettings(result)
      })
      .catch((error: unknown) => {
        if (disposed) return
        const message = error instanceof Error ? error.message : t('modelsLoadFailed')
        console.warn('[Pi Desk][ModelSettings] 读取模型配置失败', { message })
        setLoadError(message)
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })

    return () => {
      disposed = true
    }
  }, [biz, t, loadAttempt, applySettings])

  async function refreshCatalog(): Promise<void> {
    setRefreshing(true)
    try {
      const result = await biz.listCatalog({
        query: '',
        refresh: true,
        page: { index: 1, size: 1 }
      })
      setCatalogUpdatedAt(result.updatedAt)
      await refreshAccounts()
      toast.success(
        result.refreshResult === 'cached'
          ? t('catalogCached')
          : result.refreshResult === 'partial'
            ? t('catalogPartial')
            : result.refreshResult === 'unchanged'
              ? t('catalogUnchanged')
              : t('catalogUpdated')
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('catalogRefreshFailed'))
    } finally {
      setRefreshing(false)
    }
  }

  async function saveConfig(): Promise<void> {
    if (savingRef.current || inputState.invalid || serviceDirty || nativeOpen) return
    if (!settings || !formDirty) {
      toast.success(t('modelsNoChanges'))
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      const currentModels = new Set([
        ...providers.flatMap((provider) =>
          provider.models.map((model) => `${provider.provider}\u0000${model.modelId}`)
        ),
        ...accountModels.map((model) => `${model.provider}\u0000${model.modelId}`)
      ])
      const originalModels = new Set([
        ...settings.providers.flatMap((provider) =>
          provider.models.map((model) => `${provider.provider}\u0000${model.modelId}`)
        ),
        ...settings.accountModels.map((model) => `${model.provider}\u0000${model.modelId}`)
      ])
      const nextPresets = presets.filter((preset) => {
        const key = `${preset.provider}\u0000${preset.modelId}`
        return !originalModels.has(key) || currentModels.has(key)
      })
      const removedPresetCount = presets.length - nextPresets.length
      if (
        removedPresetCount > 0 &&
        !(await confirm({
          title: t('removeInvalidPresetsTitle'),
          description: t('removeInvalidPresets', { count: removedPresetCount }),
          confirmLabel: t('removeAndSave')
        }))
      ) {
        return
      }

      const input: L2ModelSettingsReplaceRequest = {
        ...(providersDirty || inputState.dirty ? { providers } : {}),
        ...(accountModelsDirty ? { accountModels } : {}),
        ...(presetsDirty || removedPresetCount > 0 ? { presets: nextPresets } : {})
      }
      await biz.replaceSettings(input)
      applySettings(await biz.getSettings())
      setProvidersDirty(false)
      setPresetsDirty(false)
      toast.success(t('modelSaved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('modelSaveFailed'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function refreshAccounts(): Promise<L2ModelSettingsGetResponse> {
    const result = await biz.getSettings()
    // 授权刷新不能覆盖正在编辑的配置或触发编辑器重置。
    setSettings((current) =>
      current
        ? {
            ...current,
            accounts: result.accounts,
            models: result.models,
            nativeConfig: result.nativeConfig
          }
        : result
    )
    return result
  }

  async function revertConfig(): Promise<void> {
    if (!settings || savingRef.current || serviceDirty) return
    if (
      !(await confirm({
        title: t('discardModelTitle'),
        description: t('discardModelDescription'),
        confirmLabel: t('discardModelConfirm')
      }))
    )
      return
    applySettings(settings)
  }

  function openNative(): void {
    if (!settings || savingRef.current) return
    if (formDirty || serviceDirty || projectDefaultDirty) {
      toast.error(t('nativeProtectDraft'))
      return
    }
    setNativeText(nativeBaseline)
    setNativeError(null)
    setNativeOpen(true)
  }

  async function closeNative(): Promise<void> {
    if (savingRef.current) return
    if (
      nativeDirty &&
      !(await confirm({
        title: t('discardNativeTitle'),
        description: t('discardNativeDescription'),
        confirmLabel: t('discardModelConfirm')
      }))
    )
      return
    setNativeOpen(false)
  }

  async function saveNative(): Promise<void> {
    if (savingRef.current || !nativeOpen || !nativeDirty) return
    savingRef.current = true
    setSaving(true)
    setNativeError(null)
    try {
      const nativeConfig = biz.parseNativeConfig(nativeText)
      await biz.replaceSettings({ nativeConfig })
      applySettings(await biz.getSettings())
      setNativeOpen(false)
      toast.success(t('modelSaved'))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('modelSaveFailed')
      console.warn('[Pi Desk][ModelSettings] 保存 Pi 配置失败', { message })
      setNativeError(message)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const selectTab = (nextTab: ModelSettingsTab): void => {
    if (nextTab === tab || savingRef.current) return
    if (tab === 'project-default' && projectDefaultDirty) {
      void confirm({
        title: t('discardModelTitle'),
        description: t('discardModelDescription'),
        confirmLabel: t('discardModelConfirm')
      }).then((discard) => {
        if (!discard) return
        setProjectDefaultDirty(false)
        setTab(nextTab)
      })
      return
    }
    setTab(nextTab)
  }

  return {
    biz,
    tab,
    settings,
    providers,
    presets,
    accountModels,
    changeAccountModels: (nextModels) => {
      setAccountModels(nextModels)
      setAccountModelsDirty(JSON.stringify(nextModels) !== JSON.stringify(settings?.accountModels))
    },
    refreshAccounts,
    providersDirty,
    presetsDirty,
    loading,
    saving,
    refreshing,
    catalogUpdatedAt,
    loadError,
    resetVersion,
    formDirty,
    formInvalid: inputState.invalid,
    serviceDirty,
    nativeOpen,
    nativeText,
    nativeError,
    nativeDirty,
    setNativeText,
    openNative,
    closeNative,
    saveNative,
    revertConfig,
    setInputState,
    setServiceDirty,
    dialog,
    setProjectDefaultDirty,
    changeProviders: (nextProviders) => {
      setProviders(nextProviders)
      setProvidersDirty(JSON.stringify(nextProviders) !== JSON.stringify(settings?.providers))
    },
    changePresets: (nextPresets) => {
      setPresets(nextPresets)
      setPresetsDirty(JSON.stringify(nextPresets) !== JSON.stringify(settings?.presets))
    },
    selectTab,
    retry: () => setLoadAttempt((attempt) => attempt + 1),
    refreshCatalog,
    saveConfig
  }
}
