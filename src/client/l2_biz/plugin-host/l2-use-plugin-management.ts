import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2PluginManagementDetail,
  L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import {
  useL4PluginHost,
  useL4PluginRegistry
} from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import type { L2PluginManagementControlAction } from './l2-plugin-management-controls'
import type { L2PluginManagementBiz } from './l2-plugin-management-biz'

type PluginManagementAction =
  | { kind: 'add'; source: string }
  | { kind: 'update'; source: string }
  | { kind: 'del'; source: string }
  | { kind: 'reload'; mode?: 'normal' | 'basic' }

interface PluginManagementOptions {
  snapshot: L2PluginManagementSnapshot | null
  biz: L2PluginManagementBiz
  onSnapshot: (snapshot: L2PluginManagementSnapshot) => void
  onRestartScheduled: () => void
}

interface PluginManagementState {
  source: string
  setSource: (source: string) => void
  loading: boolean
  requests: ReadonlySet<string>
  operation: string | null
  confirmation: PluginManagementAction | null
  setConfirmation: (action: PluginManagementAction | null) => void
  error: string | null
  detailSource: string | null
  detail: L2PluginManagementDetail | null
  detailLoading: boolean
  detailError: string | null
  selectedPending: boolean
  pluginHost: ReturnType<typeof useL4PluginHost>
  refresh: () => Promise<void>
  execute: (action: PluginManagementAction) => Promise<void>
  applyChanges: (sources?: string[]) => Promise<void>
  refreshEntries: () => Promise<void>
  loadDetail: (source: string) => Promise<void>
  openDetail: (source: string) => void
  closeDetail: () => void
  handleControlAction: (action: L2PluginManagementControlAction) => void
}

export function pluginManagementActionLabel(action: PluginManagementAction): string {
  switch (action.kind) {
    case 'add':
      return 'actionAdd'
    case 'update':
      return 'actionUpdate'
    case 'del':
      return 'actionDelete'
    case 'reload':
      return action.mode === 'normal' ? 'restartNormal' : 'actionReload'
  }
}

export function useL2PluginManagement({
  snapshot,
  biz,
  onSnapshot,
  onRestartScheduled
}: PluginManagementOptions): PluginManagementState {
  const { t } = useTranslation('pluginManagement')
  const pluginHost = useL4PluginHost()
  useL4PluginRegistry()
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [requests, setRequests] = useState<ReadonlySet<string>>(() => new Set())
  const operation = requests.has('reload') ? t('actionReload') : null
  const setRequest = (key: string, pending: boolean): void => {
    setRequests((current) => {
      const next = new Set(current)
      if (pending) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const [confirmation, setConfirmation] = useState<PluginManagementAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detailSource, setDetailSource] = useState<string | null>(null)
  const [detail, setDetail] = useState<L2PluginManagementDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const detailRequestRef = useRef(0)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      onSnapshot(await biz.list(true))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('updateCheckFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setLoading(true)
      setError(null)
      void biz
        .list(false)
        .then((next) => {
          if (active) onSnapshot(next)
        })
        .catch((cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : t('updateCheckFailed'))
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    })
    return () => {
      active = false
      detailRequestRef.current += 1
    }
  }, [biz, onSnapshot, t])

  const execute = async (action: PluginManagementAction): Promise<void> => {
    const label = t(pluginManagementActionLabel(action))
    const key =
      action.kind === 'reload' || action.kind === 'add' ? action.kind : `source:${action.source}`
    if (requests.has(key)) return
    setRequest(key, true)
    setConfirmation(null)
    setError(null)
    try {
      const next =
        action.kind === 'add'
          ? await biz.add(action.source)
          : action.kind === 'update'
            ? await biz.update(action.source)
            : action.kind === 'del'
              ? await biz.del(action.source)
              : await biz.reload(action.mode)
      onSnapshot(next)
      if (action.kind === 'add') setSource('')
      if (action.kind === 'reload') {
        onRestartScheduled()
      } else {
        onSnapshot(await biz.list(false))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('actionFailed', { action: label }))
    } finally {
      setRequest(key, false)
    }
  }

  const applyChanges = async (sources?: string[]): Promise<void> => {
    const key = sources ? `source:${sources[0]}` : 'apply'
    if (requests.has(key)) return
    setRequest(key, true)
    setError(null)
    try {
      onSnapshot(await biz.apply(sources))
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('actionFailed', { action: t('applyChanges') })
      )
    } finally {
      setRequest(key, false)
    }
  }

  const runBrowserRequest = async (
    key: string,
    fallback: string,
    action: () => Promise<unknown>
  ): Promise<void> => {
    setRequest(key, true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback)
    } finally {
      setRequest(key, false)
    }
  }

  const retryBrowserEntry = (pluginName: string): Promise<void> =>
    runBrowserRequest(`entry:${pluginName}`, t('retryFailed'), () =>
      pluginHost.retryEntry(pluginName)
    )

  const refreshEntries = (): Promise<void> =>
    runBrowserRequest('entries', t('refreshEntriesFailed'), () => pluginHost.refreshEntries())

  const loadDetail = async (pluginSource: string): Promise<void> => {
    const request = ++detailRequestRef.current
    setDetailLoading(true)
    setDetailError(null)
    try {
      const next = await biz.get(pluginSource)
      if (detailRequestRef.current === request) setDetail(next)
    } catch (cause) {
      if (detailRequestRef.current === request) {
        setDetailError(cause instanceof Error ? cause.message : t('detailFailed'))
      }
    } finally {
      if (detailRequestRef.current === request) setDetailLoading(false)
    }
  }

  const resetDetail = (pluginSource: string | null): void => {
    detailRequestRef.current += 1
    setDetailSource(pluginSource)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
  }

  const openDetail = (pluginSource: string): void => {
    resetDetail(pluginSource)
    const plugin = snapshot?.plugins.find((item) => item.source === pluginSource)
    if (
      plugin &&
      (plugin.capabilities.tools.length > 0 ||
        plugin.capabilities.skills.length > 0 ||
        plugin.capabilities.prompts.length > 0)
    ) {
      void loadDetail(pluginSource)
    }
  }

  const closeDetail = (): void => resetDetail(null)
  const selectedPlugin = detailSource
    ? (snapshot?.plugins.find((plugin) => plugin.source === detailSource) ?? null)
    : null
  const selectedPending = Boolean(
    selectedPlugin &&
    (requests.has(`source:${selectedPlugin.source}`) ||
      (selectedPlugin.operation && selectedPlugin.operation.phase !== 'failed'))
  )
  const handleControlAction = (action: L2PluginManagementControlAction): void => {
    if (!selectedPlugin) return
    switch (action) {
      case 'reload':
        void applyChanges([selectedPlugin.source])
        break
      case 'update':
        setConfirmation({ kind: 'update', source: selectedPlugin.source })
        break
      case 'remove':
        setConfirmation({ kind: 'del', source: selectedPlugin.source })
        break
      case 'retry-browser':
        if (selectedPlugin.pluginName) void retryBrowserEntry(selectedPlugin.pluginName)
        break
      case 'retry': {
        const retryAction = selectedPlugin.operation?.action
        if (retryAction === 'apply') void applyChanges([selectedPlugin.source])
        else if (retryAction) void execute({ kind: retryAction, source: selectedPlugin.source })
        break
      }
    }
  }

  return {
    source,
    setSource,
    loading,
    requests,
    operation,
    confirmation,
    setConfirmation,
    error,
    detailSource,
    detail,
    detailLoading,
    detailError,
    selectedPending,
    pluginHost,
    refresh,
    execute,
    applyChanges,
    refreshEntries,
    loadDetail,
    openDetail,
    closeDetail,
    handleControlAction
  }
}
