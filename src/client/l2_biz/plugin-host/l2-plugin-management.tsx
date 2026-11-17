'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ChevronDownIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import type { L2PluginCatalogItem } from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import type {
  L2PluginManagementItem,
  L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4LoadingSpinner } from '@client/l4_foundation/ui/loading/l4-loading-spinner'
import { L4LoadingState } from '@client/l4_foundation/ui/loading/l4-loading-state'
import { Popover, PopoverContent, PopoverTrigger } from '@client/l4_foundation/ui/shadcn/popover'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@client/l4_foundation/ui/shadcn/tabs'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import { L2PluginCapabilityDetails } from './l2-plugin-capability-details'
import {
  L2PluginManagementControls,
  L2PluginManagementFeedback
} from './l2-plugin-management-controls'
import type { L2PluginManagementBiz } from './l2-plugin-management-biz'
import {
  pluginDisplayName,
  pluginNpmSpec,
  pluginRequestKey,
  useL2PluginManagement
} from './l2-use-plugin-management'
import { useL2PluginCatalog } from './hooks/l2-use-plugin-catalog'
import { useL2PluginDevAvailability } from './hooks/l2-use-plugin-dev-availability'
import { useL2PluginDownloadSource } from './hooks/l2-use-plugin-download-source'
import { useL2PluginDirectInstall } from './hooks/l2-use-plugin-direct-install'
import { L2PluginDownloadSourceSelector } from './views/l2-plugin-download-source'
import { L2PluginInstalledList, type L2PluginStatusFilter } from './views/l2-plugin-installed-list'
import { L2PluginCatalogSearch } from './views/l2-plugin-catalog-search'
import { L2PluginCatalogDetailView } from './views/l2-plugin-catalog-detail'
import { L2PluginManagementChannel } from './views/l2-plugin-management-channel'
import { L2PluginDirectInstall } from './views/l2-plugin-direct-install'
import { L2PluginManagementDialog } from './views/l2-plugin-management-dialog'
import { L2PluginReadme } from './views/l2-plugin-readme'

interface L2PluginManagementProps {
  basicMode?: boolean
  snapshot: L2PluginManagementSnapshot | null
  biz: L2PluginManagementBiz
  onSnapshot: (snapshot: L2PluginManagementSnapshot) => void
  onRestartScheduled: () => void
}

export function L2PluginManagement({
  basicMode = false,
  snapshot,
  biz,
  onSnapshot,
  onRestartScheduled
}: L2PluginManagementProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const [tab, setTab] = useState('installed')
  const [filter, setFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<L2PluginStatusFilter>('all')
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (!snapshot) return
    const valid = new Set(snapshot.plugins.map((plugin) => pluginRequestKey(plugin.source)))
    if (![...selected].some((key) => !valid.has(key))) return
    queueMicrotask(() =>
      setSelected((current) => new Set([...current].filter((key) => valid.has(key))))
    )
  }, [snapshot, selected])
  const [catalogTag, setCatalogTag] = useState('')
  const [catalogVersionExplicit, setCatalogVersionExplicit] = useState(false)
  const management = useL2PluginManagement({
    biz,
    snapshot,
    onSnapshot,
    onRestartScheduled,
    basicMode
  })
  const download = useL2PluginDownloadSource(biz, () => {
    if (!basicMode) void management.refresh()
  })
  const downloadContext = JSON.stringify(download.settings?.downloadSource ?? null)
  useEffect(() => {
    queueMicrotask(() => {
      setCatalogTag('')
      setCatalogVersionExplicit(false)
    })
  }, [downloadContext])
  const catalog = useL2PluginCatalog(
    biz,
    tab === 'search',
    download.settings?.downloadSource ?? null
  )
  const direct = useL2PluginDirectInstall(
    biz,
    snapshot?.plugins,
    download.settings?.downloadSource ?? null
  )
  const disabled = basicMode || management.requests.has('reload')
  const browserErrors = new Map(
    management.pluginHost.getFailedEntries().map((item) => [item.pluginName, item.error.message])
  )
  const descriptorError = management.pluginHost.getEntryListError()
  const selectedPlugin = snapshot?.plugins.find(
    (plugin) =>
      management.detailSource &&
      pluginRequestKey(plugin.source) === pluginRequestKey(management.detailSource)
  )
  const installedDev = useL2PluginDevAvailability(
    biz,
    selectedPlugin?.source.startsWith('npm:')
      ? (pluginNpmSpec(selectedPlugin.source)?.name ?? null)
      : null,
    undefined,
    JSON.stringify([downloadContext, selectedPlugin?.source])
  )
  const catalogPlugin = catalog.selection
    ? snapshot?.plugins.find(
        (plugin) =>
          plugin.source.startsWith('npm:') &&
          pluginNpmSpec(plugin.source)?.name === catalog.selection?.name
      )
    : undefined
  const catalogKey = catalog.selection ? pluginRequestKey(`npm:${catalog.selection.name}`) : ''
  const directSource = direct.detail
    ? `npm:${direct.detail.name}`
    : direct.spec
      ? `npm:${direct.spec.name}`
      : direct.source.trim()
  const directKey = pluginRequestKey(directSource)
  const directPlugin = snapshot?.plugins.find(
    (plugin) => pluginRequestKey(plugin.source) === directKey
  )
  const busy = (source: string): boolean => {
    const plugin = snapshot?.plugins.find(
      (item) => pluginRequestKey(item.source) === pluginRequestKey(source)
    )
    return (
      management.requests.has(pluginRequestKey(source)) ||
      Boolean(plugin?.operation && plugin.operation.phase !== 'failed')
    )
  }
  const affectedSources =
    snapshot?.plugins
      .filter(
        (plugin) =>
          plugin.status === 'failed' ||
          plugin.error ||
          plugin.operation?.phase === 'failed' ||
          (plugin.pluginName && browserErrors.has(plugin.pluginName))
      )
      .map((plugin) => plugin.source) ?? []
  const recoverySources = affectedSources.length
    ? affectedSources
    : snapshot?.loadError
      ? snapshot.plugins.map((plugin) => plugin.source)
      : []
  const runtimeErrors = [
    snapshot?.loadError ? selectL4LocalizedText(snapshot.loadError, locale) : null,
    descriptorError,
    management.errors.entries
  ].filter((error, index, all): error is string => Boolean(error) && all.indexOf(error) === index)
  const catalogPending = busy(`npm:${catalog.selection?.name ?? ''}`)
  const directPending = direct.sources.some(busy)
  const directErrors = direct.sources
    .map((source) => {
      const key = pluginRequestKey(source)
      const plugin = snapshot?.plugins.find((item) => pluginRequestKey(item.source) === key)
      const error =
        management.errors[key] ??
        (plugin?.operation?.phase === 'failed' ? plugin.operation.message : null)
      return error ? `${source}: ${error}` : null
    })
    .filter(Boolean)
    .join('\n')
  const detailOpen = Boolean(management.detailSource || catalog.selection)
  const backButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (detailOpen) backButton.current?.focus()
    else if (returnFocus.current?.isConnected) {
      returnFocus.current.focus()
      returnFocus.current = null
    }
  }, [detailOpen])
  const rememberFocus = (): void => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  const closeDetail = (): void => {
    management.closeDetail()
    catalog.closeDetail()
  }
  const catalogTarget = (item: L2PluginCatalogItem): L2PluginCatalogItem => {
    const installed = snapshot?.plugins.find(
      (plugin) => pluginNpmSpec(plugin.source)?.name === item.name
    )
    return { ...item, version: installed?.updateTag ?? 'latest' }
  }
  const openCatalog = (item: L2PluginCatalogItem): void => {
    rememberFocus()
    management.closeDetail()
    setCatalogTag('')
    setCatalogVersionExplicit(false)
    catalog.openDetail(catalogTarget(item))
  }
  const openInstalled = (source: string): void => {
    rememberFocus()
    catalog.closeDetail()
    management.openDetail(source)
  }
  const installCatalogItem = (item: L2PluginCatalogItem): void => {
    void catalog.prepareInstall(catalogTarget(item), (detail) =>
      management.requestInstall({ source: `npm:${detail.name}`, registry: detail.registry }, detail)
    )
  }
  const selectSources = (keys: string[], checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current)
      keys.forEach((key) => {
        if (checked) next.add(key)
        else next.delete(key)
      })
      return next
    })
  }
  const updateSources = (onlySelected: boolean): string[] =>
    snapshot?.plugins
      .filter(
        (plugin) =>
          plugin.kind !== 'extension' &&
          plugin.updateAvailable === true &&
          !busy(plugin.source) &&
          (!onlySelected || selected.has(pluginRequestKey(plugin.source)))
      )
      .map((plugin) => plugin.source) ?? []
  const operationMessage = (phase?: string): string | null => (phase ? t(`phase_${phase}`) : null)
  const retryPlugin = (plugin: L2PluginManagementItem): void => {
    if (plugin.operation?.phase === 'failed') {
      const action = plugin.operation.action
      if (action === 'add') {
        closeDetail()
        direct.setOpen(true)
        direct.changeSource(plugin.source)
        setTab('installed')
      } else if (action === 'apply') management.handleControlAction(plugin, 'reload')
      else if (action === 'del') management.handleControlAction(plugin, 'remove')
      else management.handleControlAction(plugin, action)
    } else if (plugin.updateError && !plugin.error && plugin.status !== 'failed') {
      void management.refresh([plugin.source])
    } else management.handleControlAction(plugin, 'reload')
  }
  const reinstall = (): void => {
    if (!selectedPlugin?.version) return
    const spec = pluginNpmSpec(selectedPlugin.source)
    if (!spec) return
    closeDetail()
    setTab('installed')
    direct.changeSource(`npm:${spec.name}@${selectedPlugin.version}`)
    direct.setOverride('default')
    direct.setRegistry('')
    direct.setOpen(true)
  }
  const openDirect = (): void => {
    setTab('installed')
    direct.setOpen(true)
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="shrink-0 space-y-3 border-b p-4 sm:px-6">
        {detailOpen ? (
          <Button
            ref={backButton}
            size="sm"
            variant="ghost"
            className="-ml-2"
            onClick={closeDetail}
          >
            <ArrowLeftIcon />
            {t('backToList')}
          </Button>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            className={`min-w-0 text-xl font-semibold [overflow-wrap:anywhere] ${detailOpen ? '' : 'sm:hidden'}`}
          >
            {detailOpen
              ? selectedPlugin
                ? pluginDisplayName(selectedPlugin)
                : (catalog.selection?.name ?? t('details'))
              : t('title')}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Popover>
              <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
                {t('downloadSource')}：
                {download.loading && !download.settings ? (
                  <>
                    <L4LoadingSpinner aria-hidden="true" />
                    {t('loading')}
                  </>
                ) : (
                  t(`download_${download.settings?.downloadSource.mode ?? download.mode}`)
                )}
                <ChevronDownIcon className="size-4" />
              </PopoverTrigger>
              <PopoverContent
                align="end"
                positionerClassName="z-[150]"
                className="w-80 max-w-[calc(100vw-2rem)]"
              >
                <L2PluginDownloadSourceSelector
                  id="plugin-default-download"
                  mode={download.mode}
                  registry={download.registry}
                  savedRegistry={
                    download.settings?.downloadSource.mode === 'custom'
                      ? download.settings.downloadSource.registry
                      : undefined
                  }
                  recommendedRegistry={download.settings?.recommendedRegistry}
                  loading={download.loading}
                  saving={download.saving}
                  error={download.error}
                  onMode={(mode) => {
                    if (mode !== 'default') download.changeMode(mode)
                  }}
                  onRegistry={download.setRegistry}
                  onSave={() => void download.save()}
                  onRetry={() => void download.retry()}
                />
              </PopoverContent>
            </Popover>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || management.loading}
              onClick={() => void management.refresh()}
            >
              {management.loading && snapshot ? <L4LoadingSpinner aria-hidden="true" /> : null}
              {t(management.loading ? 'checkingUpdates' : 'checkUpdates')}
            </Button>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => {
                closeDetail()
                openDirect()
              }}
            >
              {t('directInstall')}
            </Button>
            {basicMode || snapshot?.restartRequired ? (
              <Button
                size="sm"
                variant="outline"
                disabled={management.requests.has('reload')}
                onClick={() =>
                  management.setConfirmation({
                    kind: 'reload',
                    mode: basicMode ? 'normal' : undefined
                  })
                }
              >
                {t(basicMode ? 'restartNormal' : 'restartApply')}
              </Button>
            ) : null}
          </div>
        </div>
        {basicMode ? (
          <p role="status" className="rounded-lg bg-muted p-3 text-sm">
            {t('basicModeNotice')}
          </p>
        ) : null}
        {snapshot?.restartRequired ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('pendingRestart')}
          </p>
        ) : null}
        {runtimeErrors.length ? (
          <div role="alert" className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-destructive">
                {t(snapshot?.loadError ? 'loadFailedSummary' : 'viewFailed')}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  management.requests.has('entries') ||
                  (recoverySources.length > 0 && (disabled || recoverySources.every(busy)))
                }
                onClick={() => {
                  if (recoverySources.length)
                    void management.executeBatch({ action: 'apply', sources: recoverySources })
                  else void management.refreshEntries()
                }}
              >
                {t(recoverySources.length ? 'reloadAffected' : 'reloadOne')}
              </Button>
            </div>
            <Collapsible>
              <CollapsibleTrigger className="group flex min-h-8 items-center gap-2 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {t('errorDetails')}
                <ChevronDownIcon className="size-4 transition-transform group-aria-expanded:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="pi-desk-chat-scrollbar max-h-40 overflow-y-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {runtimeErrors.join('\n\n')}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          </div>
        ) : null}
        {management.errors.reload ? (
          <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
            {management.errors.reload}
          </p>
        ) : null}
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className={`min-h-0 flex-1 gap-0 ${detailOpen ? 'hidden' : ''}`}
      >
        <div className="shrink-0 border-b px-4 pt-2 sm:px-6">
          <TabsList variant="line" aria-label={t('title')} className="h-9">
            <TabsTrigger value="installed" className="px-3">
              {t('installedTab')}
              {snapshot ? (
                <span className="text-xs text-muted-foreground">{snapshot.plugins.length}</span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="search" className="px-3">
              {t('searchPlugins')}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value="installed"
          keepMounted
          className="flex min-h-0 flex-col overflow-hidden p-4 data-[hidden]:hidden sm:p-6"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            {direct.open ? (
              <div className="pi-desk-chat-scrollbar max-h-1/2 shrink-0 overflow-y-auto">
                <L2PluginDirectInstall
                  dev={direct.dev}
                  source={direct.source}
                  isNpm={Boolean(direct.spec)}
                  multiple={direct.sources.length > 1}
                  tag={direct.tag}
                  selectedVersion={direct.selectedVersion}
                  onTag={direct.setTag}
                  detail={direct.detail}
                  loading={direct.loading}
                  pending={directPending}
                  disabled={disabled}
                  error={direct.error ?? (directErrors || null)}
                  operationMessage={
                    directPending
                      ? (operationMessage(directPlugin?.operation?.phase) ?? t('submitting'))
                      : null
                  }
                  override={direct.override}
                  registry={direct.registry}
                  onSource={direct.changeSource}
                  onMode={direct.setOverride}
                  onRegistry={direct.setRegistry}
                  onRead={() => void direct.loadDetail()}
                  onVersion={(version) => void direct.loadDetail(version)}
                  onInstall={() =>
                    void direct.install(management.requestInstall, (items) =>
                      management.setConfirmation({ kind: 'batch', input: { action: 'add', items } })
                    )
                  }
                  onClose={() => direct.setOpen(false)}
                />
              </div>
            ) : null}
            <L2PluginInstalledList
              snapshot={snapshot}
              loading={management.loading}
              filter={filter}
              statusFilter={statusFilter}
              batchMode={batchMode}
              selected={selected}
              onStatusFilter={setStatusFilter}
              onBatchMode={(value) => {
                setBatchMode(value)
                if (!value) setSelected(new Set())
              }}
              onSelect={selectSources}
              onUpdateAll={() =>
                void management.executeBatch({ action: 'update', sources: updateSources(false) })
              }
              onUpdateSelected={() =>
                void management.executeBatch({ action: 'update', sources: updateSources(true) })
              }
              onReloadSelected={() =>
                void management.executeBatch({
                  action: 'apply',
                  sources:
                    snapshot?.plugins
                      .filter(
                        (plugin) =>
                          selected.has(pluginRequestKey(plugin.source)) && !busy(plugin.source)
                      )
                      .map((plugin) => plugin.source) ?? []
                })
              }
              onRemoveSelected={() =>
                management.setConfirmation({
                  kind: 'batch',
                  input: {
                    action: 'del',
                    sources:
                      snapshot?.plugins
                        .filter(
                          (plugin) =>
                            plugin.kind !== 'extension' &&
                            selected.has(pluginRequestKey(plugin.source)) &&
                            !busy(plugin.source)
                        )
                        .map((plugin) => plugin.source) ?? []
                  }
                })
              }
              disabled={disabled}
              requests={management.requests}
              errors={management.errors}
              browserErrors={browserErrors}
              onFilter={setFilter}
              onDetail={openInstalled}
              onAction={management.handleControlAction}
              onRetry={retryPlugin}
            />
            {!snapshot?.plugins.length && !direct.open ? (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 self-start"
                disabled={disabled}
                onClick={openDirect}
              >
                {t('directInstall')}
              </Button>
            ) : null}
          </div>
        </TabsContent>
        <TabsContent
          value="search"
          keepMounted
          className="pi-desk-chat-scrollbar min-h-0 overflow-y-auto p-4 data-[hidden]:hidden sm:p-6"
        >
          <L2PluginCatalogSearch
            query={catalog.query}
            kind={catalog.kind}
            searchSource={catalog.searchSource}
            registry={catalog.registry}
            items={catalog.items}
            loading={catalog.loading}
            error={catalog.error}
            searched={catalog.searched}
            hasMore={catalog.hasMore}
            disabled={disabled}
            snapshot={snapshot}
            requests={management.requests}
            preparing={catalog.preparing}
            errors={management.errors}
            installErrors={catalog.installErrors}
            onQuery={catalog.setQuery}
            onCompositionStart={catalog.beginComposition}
            onCompositionEnd={catalog.endComposition}
            onKind={catalog.setKind}
            onSearchSource={(source) => {
              catalog.setSearchSource(source)
              if (
                source === 'custom' &&
                !catalog.registry &&
                download.settings?.downloadSource.mode === 'custom'
              ) {
                catalog.setRegistry(download.settings.downloadSource.registry)
              }
            }}
            onRegistry={catalog.setRegistry}
            onDetail={openCatalog}
            onInstall={installCatalogItem}
            onUpdate={(source) => void management.execute({ kind: 'update', source })}
            onMore={catalog.loadMore}
            onRetry={catalog.retry}
            onDirectInstall={openDirect}
          />
        </TabsContent>
      </Tabs>
      {detailOpen ? (
        <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {selectedPlugin ? (
            <div className="min-w-0 space-y-5">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>
                      {t(
                        selectedPlugin.status === 'failed'
                          ? 'abnormal'
                          : selectedPlugin.status === 'disabled'
                            ? 'disabled'
                            : selectedPlugin.status === 'ready'
                              ? 'loaded'
                              : 'notLoaded'
                      )}
                    </span>
                    {selectedPlugin.version ? (
                      <span className="tabular-nums">v{selectedPlugin.version}</span>
                    ) : null}
                    {selectedPlugin.updateAvailable ? (
                      <span className="rounded-md bg-status-success/10 px-2 py-0.5 text-xs font-medium text-status-success">
                        {selectedPlugin.availableVersion
                          ? t('newVersion', { version: selectedPlugin.availableVersion })
                          : t('updateAvailable')}
                      </span>
                    ) : null}
                  </div>
                  <L2PluginManagementControls
                    plugin={selectedPlugin}
                    displayName={pluginDisplayName(selectedPlugin)}
                    disabled={disabled}
                    pending={busy(selectedPlugin.source)}
                    onAction={(action) => management.handleControlAction(selectedPlugin, action)}
                  />
                </div>
                {selectedPlugin.description ? (
                  <p className="text-sm text-muted-foreground">
                    {selectL4LocalizedText(selectedPlugin.description, locale)}
                  </p>
                ) : null}
                <L2PluginManagementFeedback
                  plugin={selectedPlugin}
                  onRetry={() => retryPlugin(selectedPlugin)}
                  requestError={management.errors[pluginRequestKey(selectedPlugin.source)]}
                  browserError={
                    selectedPlugin.pluginName
                      ? (browserErrors.get(selectedPlugin.pluginName) ?? null)
                      : null
                  }
                />
              </div>
              <dl className="grid min-w-0 gap-3 border-y py-4 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('source')}</dt>
                  <dd className="mt-1 font-mono [overflow-wrap:anywhere]">
                    {selectedPlugin.source}
                  </dd>
                </div>
                {selectedPlugin.version ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('installedVersion')}</dt>
                    <dd className="mt-1 tabular-nums">v{selectedPlugin.version}</dd>
                  </div>
                ) : null}
              </dl>
              {selectedPlugin.source.startsWith('npm:') ? (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                      <p className="text-sm font-medium">{t('installChannel')}</p>
                      <L2PluginManagementChannel
                        value={selectedPlugin.updateTag ?? 'latest'}
                        label={t('installChannel')}
                        dev={installedDev}
                        disabled={disabled || busy(selectedPlugin.source)}
                        onChange={(tag) =>
                          void management.executeBatch({
                            action: 'tag',
                            sources: [selectedPlugin.source],
                            tag
                          })
                        }
                      />
                    </div>
                    {selectedPlugin.version ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled || busy(selectedPlugin.source)}
                        onClick={reinstall}
                      >
                        {t('reinstallVersion', { version: selectedPlugin.version })}
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('channelHelp')}</p>
                </section>
              ) : null}
              {management.detailLoading ? (
                <L4LoadingState compact className="justify-start">
                  {t('loadingPackage')}
                </L4LoadingState>
              ) : null}
              {management.detail?.readme ? (
                <L2PluginReadme key={selectedPlugin.source} readme={management.detail.readme} />
              ) : null}
              <Collapsible className="border-t pt-2">
                <CollapsibleTrigger className="group flex min-h-9 w-full items-center justify-between text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t('capabilityDetails')}
                  <ChevronDownIcon className="size-4 transition-transform group-aria-expanded:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent keepMounted className="hidden data-open:block">
                  <L2PluginCapabilityDetails
                    plugin={selectedPlugin}
                    detail={management.detail}
                    detailLoading={management.detailLoading}
                    detailError={management.detailError}
                    browserContributions={
                      selectedPlugin.pluginName
                        ? (management.pluginHost
                            .getRegisteredBrowserDescriptors()
                            .find(
                              (descriptor) => descriptor.pluginName === selectedPlugin.pluginName
                            )?.contributions ?? [])
                        : []
                    }
                  />
                </CollapsibleContent>
              </Collapsible>
              {management.detailError ? (
                <Collapsible className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <p role="alert" className="text-destructive">
                      {t('detailFailed')}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy(selectedPlugin.source)}
                      onClick={() => void management.loadDetail(selectedPlugin.source)}
                    >
                      {t('retry')}
                    </Button>
                  </div>
                  <CollapsibleTrigger className="group flex min-h-8 items-center gap-2 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t('errorDetails')}
                    <ChevronDownIcon className="size-4 transition-transform group-aria-expanded:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="max-h-40 overflow-y-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {management.detailError}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </div>
          ) : catalog.selection ? (
            <>
              {catalog.detailLoading ? (
                <L4LoadingState
                  compact={Boolean(catalog.detail)}
                  className={catalog.detail ? 'mb-3 justify-start' : undefined}
                >
                  {t('loadingPackage')}
                </L4LoadingState>
              ) : null}
              {catalog.detailError ? (
                <div role="alert" className="mb-3 space-y-2 text-sm">
                  <p className="text-destructive [overflow-wrap:anywhere]">{catalog.detailError}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void catalog.loadDetail(catalog.selection!)}
                  >
                    {t('retry')}
                  </Button>
                </div>
              ) : null}
              {catalog.detail ? (
                <L2PluginCatalogDetailView
                  dev={catalog.dev}
                  detail={catalog.detail}
                  disabled={disabled || Boolean(catalog.detailError)}
                  pending={catalogPending || catalog.detailLoading}
                  installed={Boolean(
                    catalogPlugin &&
                    !(
                      catalogPlugin.operation?.action === 'add' &&
                      catalogPlugin.operation.phase === 'failed'
                    )
                  )}
                  installedVersion={catalogPlugin?.version ?? null}
                  updateAvailable={Boolean(catalogPlugin?.updateAvailable)}
                  error={
                    catalog.installErrors[catalog.detail.name] ??
                    management.errors[catalogKey] ??
                    (catalogPlugin?.operation?.phase === 'failed'
                      ? catalogPlugin.operation.message
                      : null)
                  }
                  operationMessage={
                    catalog.detailLoading
                      ? t('loadingPackage')
                      : operationMessage(catalogPlugin?.operation?.phase)
                  }
                  channel={catalogTag}
                  onChannel={(tag) => {
                    if (tag === 'dev' && !catalog.dev.version) return
                    setCatalogTag(tag)
                    setCatalogVersionExplicit(false)
                    void catalog.loadDetail(
                      catalog.selection!,
                      tag || catalogPlugin?.updateTag || 'latest'
                    )
                  }}
                  downloadMode={catalog.downloadMode}
                  downloadRegistry={catalog.downloadRegistry}
                  onDownloadMode={(mode) => {
                    setCatalogTag('')
                    catalog.setDownloadMode(mode)
                  }}
                  onDownloadRegistry={(registry) => {
                    setCatalogTag('')
                    catalog.setDownloadRegistry(registry)
                  }}
                  onVersion={(version) => {
                    setCatalogVersionExplicit(true)
                    void catalog.loadDetail(catalog.selection!, version)
                  }}
                  onInstall={() => {
                    if (catalogTag === 'dev' && !catalog.dev.version) return
                    catalog.installDetail((input, detail) =>
                      management.requestInstall(
                        {
                          ...input,
                          source:
                            catalogVersionExplicit ||
                            catalogPlugin?.version === detail.version ||
                            catalog.downloadMode !== 'default'
                              ? input.source
                              : `npm:${detail.name}`,
                          ...(catalogTag ? { tag: catalogTag } : {})
                        },
                        detail
                      )
                    )
                  }}
                  onUpdate={() => {
                    if (catalogPlugin)
                      void management.execute({ kind: 'update', source: catalogPlugin.source })
                  }}
                />
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('pluginRemoved')}</p>
          )}
        </div>
      ) : null}
      <L2PluginManagementDialog
        confirmation={management.confirmation}
        onClose={() => management.setConfirmation(null)}
        onConfirm={(action) => void management.execute(action)}
      />
    </div>
  )
}
