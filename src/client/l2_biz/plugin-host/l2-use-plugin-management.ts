import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2PluginManagementBatchRequest,
  L2PluginManagementListRequest,
  L2PluginManagementDetail,
  L2PluginManagementItem,
  L2PluginManagementInstallRequest,
  L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import type { L2PluginCatalogItem } from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import {
  useL4PluginHost,
  useL4PluginRegistry
} from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import type { L2PluginManagementControlAction } from './l2-plugin-management-controls'
import type { L2PluginManagementBiz } from './l2-plugin-management-biz'

export type PluginManagementAction =
  | { kind: 'add'; input: L2PluginManagementInstallRequest; package?: L2PluginCatalogItem }
  | { kind: 'batch'; input: L2PluginManagementBatchRequest }
  | { kind: 'update'; source: string }
  | { kind: 'del'; source: string }
  | { kind: 'enable'; source: string }
  | { kind: 'disable'; source: string }
  | { kind: 'reload'; mode?: 'normal' | 'basic' }

interface PluginManagementOptions {
  basicMode?: boolean
  biz: L2PluginManagementBiz
  snapshot: L2PluginManagementSnapshot | null
  onSnapshot: (snapshot: L2PluginManagementSnapshot) => void
  onRestartScheduled: () => void
}

export function pluginNpmSpec(source: string): { name: string; version?: string } | null {
  const spec = source.startsWith('npm:') ? source.slice(4) : source
  const match = /^((?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*)(?:@([^\s/]+))?$/i.exec(spec)
  if (!match) return null
  return { name: match[1]!, ...(match[2] ? { version: match[2] } : {}) }
}

export function pluginDisplayName(plugin: L2PluginManagementItem): string {
  if (plugin.source.startsWith('npm:')) return pluginNpmSpec(plugin.source)?.name ?? plugin.source
  return (
    plugin.pluginName ??
    (plugin.kind === 'extension' ? plugin.source.replaceAll('\\', '/').split('/').at(-1) : null) ??
    plugin.source
  )
}

export function pluginRequestKey(source: string): string {
  return `source:${pluginNpmSpec(source)?.name ?? source}`
}

export function pluginManagementActionLabel(action: PluginManagementAction): string {
  switch (action.kind) {
    case 'batch':
      return action.input.action === 'add'
        ? 'batchInstall'
        : action.input.action === 'update'
          ? 'updateSelected'
          : action.input.action === 'del'
            ? 'removeSelected'
            : 'setChannel'
    case 'add':
      return 'actionAdd'
    case 'update':
      return 'actionUpdate'
    case 'del':
      return 'actionDelete'
    case 'enable':
      return 'enable'
    case 'disable':
      return 'disable'
    case 'reload':
      return action.mode === 'normal' ? 'restartNormal' : 'actionReload'
  }
}

interface PluginManagementState {
  loading: boolean
  requests: ReadonlySet<string>
  confirmation: PluginManagementAction | null
  setConfirmation: (action: PluginManagementAction | null) => void
  errors: Record<string, string>
  detailSource: string | null
  detail: L2PluginManagementDetail | null
  detailLoading: boolean
  detailError: string | null
  pluginHost: ReturnType<typeof useL4PluginHost>
  refresh: (sources?: string[], tag?: string) => Promise<void>
  executeBatch: (input: L2PluginManagementBatchRequest) => Promise<void>
  execute: (action: PluginManagementAction) => Promise<void>
  requestInstall: (input: L2PluginManagementInstallRequest, item?: L2PluginCatalogItem) => void
  applyChanges: (sources?: string[]) => Promise<void>
  loadDetail: (source: string) => Promise<void>
  openDetail: (source: string) => void
  closeDetail: () => void
  handleControlAction: (
    plugin: L2PluginManagementItem,
    action: L2PluginManagementControlAction
  ) => void
  refreshEntries: () => Promise<void>
}

export function useL2PluginManagement({
  basicMode = false,
  biz,
  snapshot,
  onSnapshot,
  onRestartScheduled
}: PluginManagementOptions): PluginManagementState {
  const { t } = useTranslation('pluginManagement')
  const pluginHost = useL4PluginHost()
  useL4PluginRegistry()
  const [loading, setLoading] = useState(false)
  const [requests, setRequests] = useState<ReadonlySet<string>>(() => new Set())
  const inFlight = useRef(new Set<string>())
  const [confirmation, setConfirmation] = useState<PluginManagementAction | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [detailSource, setDetailSource] = useState<string | null>(null)
  const [detail, setDetail] = useState<L2PluginManagementDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const detailRequest = useRef(0)
  const listRequest = useRef(0)
  const mounted = useRef(true)

  const setRequest = (key: string, pending: boolean): void => {
    if (pending) inFlight.current.add(key)
    else inFlight.current.delete(key)
    if (mounted.current) setRequests(new Set(inFlight.current))
  }
  const setError = (key: string, message: string | null): void => {
    if (!mounted.current) return
    setErrors((current) => {
      const next = { ...current }
      if (message) next[key] = message
      else delete next[key]
      return next
    })
  }
  const busySource = (source: string): boolean => {
    const key = pluginRequestKey(source)
    return (
      inFlight.current.has(key) ||
      Boolean(
        snapshot?.plugins.some(
          (plugin) =>
            pluginRequestKey(plugin.source) === key &&
            plugin.operation &&
            plugin.operation.phase !== 'failed'
        )
      )
    )
  }
  const readSnapshot = async (
    input: boolean | L2PluginManagementListRequest = false
  ): Promise<void> => {
    const request = ++listRequest.current
    const next = await biz.list(input)
    if (mounted.current && request === listRequest.current) onSnapshot(next)
  }
  const refresh = async (sources?: string[], tag?: string): Promise<void> => {
    if (inFlight.current.has('check')) return
    const targets =
      sources ??
      snapshot?.plugins
        .filter((plugin) => plugin.kind === 'package' && (!tag || plugin.updateTag === tag))
        .map((plugin) => plugin.source) ??
      []
    const busy = targets.filter(busySource)
    const available = targets.filter((source) => !busySource(source))
    busy.forEach((source) => setError(pluginRequestKey(source), t('sourceBusy')))
    if (!available.length) return
    const keys = available.map(pluginRequestKey)
    setRequest('check', true)
    keys.forEach((key) => setRequest(key, true))
    setLoading(true)
    setError('list', null)
    try {
      if (sources || busy.length) {
        for (let offset = 0; offset < available.length; offset += 32) {
          await readSnapshot({
            checkUpdates: true,
            sources: available.slice(offset, offset + 32),
            ...(tag ? { tag } : {})
          })
          if (!mounted.current) break
        }
      } else {
        await readSnapshot({ checkUpdates: true, ...(tag ? { tag } : {}) })
      }
    } catch (cause) {
      setError('list', cause instanceof Error ? cause.message : t('updateCheckFailed'))
    } finally {
      setRequest('check', false)
      keys.forEach((key) => setRequest(key, false))
      if (mounted.current) setLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    let active = true
    const request = ++listRequest.current
    queueMicrotask(() => {
      if (!active) return
      setLoading(true)
      void biz
        .list(false)
        .then(async (next) => {
          if (!active || request !== listRequest.current) return
          onSnapshot(next)
          const unchecked = next.plugins.some(
            (plugin) =>
              plugin.kind === 'package' &&
              /^(npm:|git:|https?:|git@)/.test(plugin.source) &&
              plugin.updateAvailable === null &&
              !plugin.updateError &&
              !plugin.operation
          )
          if (!basicMode && unchecked) {
            const checked = await biz.list(true)
            if (active && request === listRequest.current) onSnapshot(checked)
          }
        })
        .catch((cause: unknown) => {
          if (active)
            setError('list', cause instanceof Error ? cause.message : t('updateCheckFailed'))
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    })
    return () => {
      active = false
      mounted.current = false
      detailRequest.current += 1
      listRequest.current += 1
    }
  }, [biz, onSnapshot, t, basicMode])

  const executeBatch = async (input: L2PluginManagementBatchRequest): Promise<void> => {
    const sources = input.action === 'add' ? input.items.map((item) => item.source) : input.sources
    const available = sources.filter((source) => !busySource(source))
    sources
      .filter(busySource)
      .forEach((source) => setError(pluginRequestKey(source), t('sourceBusy')))
    if (!available.length) return
    const keys = available.map(pluginRequestKey)
    keys.forEach((key) => {
      setRequest(key, true)
      setError(key, null)
    })
    setConfirmation(null)
    let remaining = [...available]
    try {
      let current = await biz.list()
      const deadline = Date.now() + 15 * 60_000
      while (remaining.length) {
        const pending = current.plugins.filter(
          (plugin) => plugin.operation && plugin.operation.phase !== 'failed'
        )
        const capacity = input.action === 'tag' ? 32 : Math.max(0, 32 - pending.length)
        if (!capacity) {
          if (
            pending.some((plugin) => plugin.operation?.phase === 'waiting') ||
            Date.now() >= deadline
          ) {
            remaining.forEach((source) => setError(pluginRequestKey(source), t('batchWaiting')))
            break
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 750))
          current = await biz.list()
          if (mounted.current) {
            listRequest.current += 1
            onSnapshot(current)
          }
          continue
        }
        const chunk = remaining.slice(0, capacity)
        const request =
          input.action === 'add'
            ? { ...input, items: input.items.filter((item) => chunk.includes(item.source)) }
            : { ...input, sources: chunk }
        const response = await biz.batch(request)
        current = response.snapshot
        if (mounted.current) {
          listRequest.current += 1
          onSnapshot(current)
        }
        response.results.forEach((result) =>
          setError(pluginRequestKey(result.source), result.error)
        )
        chunk.forEach((source) => setRequest(pluginRequestKey(source), false))
        remaining = remaining.slice(chunk.length)
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('batchFailed')
      remaining.forEach((source) => setError(pluginRequestKey(source), message))
    } finally {
      keys.forEach((key) => setRequest(key, false))
    }
  }
  const execute = async (action: PluginManagementAction): Promise<void> => {
    if (action.kind === 'batch') {
      await executeBatch(action.input)
      return
    }
    if (
      action.kind !== 'reload' &&
      busySource(action.kind === 'add' ? action.input.source : action.source)
    )
      return
    const key =
      action.kind === 'reload'
        ? 'reload'
        : pluginRequestKey(action.kind === 'add' ? action.input.source : action.source)
    if (inFlight.current.has(key)) return
    setRequest(key, true)
    setConfirmation(null)
    setError(key, null)
    try {
      const next =
        action.kind === 'add'
          ? await biz.add(action.input)
          : action.kind === 'update'
            ? await biz.update(action.source)
            : action.kind === 'del'
              ? await biz.del(action.source)
              : action.kind === 'enable' || action.kind === 'disable'
                ? await biz.setEnabled(action.source, action.kind === 'enable')
                : await biz.reload(action.mode)
      if (!mounted.current) return
      listRequest.current += 1
      onSnapshot(next)
      if (action.kind === 'reload') onRestartScheduled()
      else await readSnapshot()
    } catch (cause) {
      setError(
        key,
        cause instanceof Error
          ? cause.message
          : t('actionFailed', { action: t(pluginManagementActionLabel(action)) })
      )
    } finally {
      setRequest(key, false)
    }
  }
  const requestInstall = (
    input: L2PluginManagementInstallRequest,
    item?: L2PluginCatalogItem
  ): void => {
    const action: PluginManagementAction = { kind: 'add', input, package: item }
    if (item?.official === true) void execute(action)
    else setConfirmation(action)
  }
  const applyChanges = async (sources?: string[]): Promise<void> => {
    const key = sources?.[0] ? pluginRequestKey(sources[0]) : 'apply'
    if (inFlight.current.has(key)) return
    setRequest(key, true)
    setError(key, null)
    try {
      const next = await biz.apply(sources)
      if (mounted.current) {
        listRequest.current += 1
        onSnapshot(next)
        await readSnapshot()
      }
    } catch (cause) {
      setError(
        key,
        cause instanceof Error ? cause.message : t('actionFailed', { action: t('reloadOne') })
      )
    } finally {
      setRequest(key, false)
    }
  }
  const runBrowserRequest = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    if (inFlight.current.has(key)) return
    setRequest(key, true)
    setError(key, null)
    try {
      await action()
    } catch (cause) {
      setError(key, cause instanceof Error ? cause.message : t('retryFailed'))
    } finally {
      setRequest(key, false)
    }
  }
  const loadDetail = async (source: string): Promise<void> => {
    const request = ++detailRequest.current
    setDetailLoading(true)
    setDetailError(null)
    try {
      const next = await biz.get(source)
      if (mounted.current && request === detailRequest.current) setDetail(next)
    } catch (cause) {
      if (mounted.current && request === detailRequest.current)
        setDetailError(cause instanceof Error ? cause.message : t('detailFailed'))
    } finally {
      if (mounted.current && request === detailRequest.current) setDetailLoading(false)
    }
  }
  const closeDetail = (): void => {
    detailRequest.current += 1
    setDetailSource(null)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
  }
  const openDetail = (source: string): void => {
    setDetailSource(source)
    setDetail(null)
    void loadDetail(source)
  }
  const handleControlAction = (
    plugin: L2PluginManagementItem,
    action: L2PluginManagementControlAction
  ): void => {
    switch (action) {
      case 'reload':
        void applyChanges([plugin.source])
        break
      case 'update':
        void execute({ kind: 'update', source: plugin.source })
        break
      case 'remove':
        setConfirmation({ kind: 'del', source: plugin.source })
        break
      case 'enable':
      case 'disable':
        void execute({ kind: action, source: plugin.source })
        break
      case 'retry-browser':
        if (plugin.pluginName)
          void runBrowserRequest(`entry:${plugin.pluginName}`, () =>
            pluginHost.retryEntry(plugin.pluginName!)
          )
        break
      case 'retry': {
        const action = plugin.operation?.action
        if (action === 'apply') void applyChanges([plugin.source])
        else if (action === 'add') requestInstall({ source: plugin.source })
        else if (action) void execute({ kind: action, source: plugin.source })
        break
      }
    }
  }
  return {
    loading,
    requests,
    confirmation,
    setConfirmation,
    errors,
    detailSource,
    detail,
    detailLoading,
    detailError,
    pluginHost,
    refresh,
    executeBatch,
    execute,
    requestInstall,
    applyChanges,
    loadDetail,
    openDetail,
    closeDetail,
    handleControlAction,
    refreshEntries: (): Promise<void> =>
      runBrowserRequest('entries', () => pluginHost.refreshEntries())
  }
}
