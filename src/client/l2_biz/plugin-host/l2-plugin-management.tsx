'use client'

import { useEffect, useState } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import type { L2PluginCatalogItem } from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import type { L2PluginManagementSnapshot } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Popover, PopoverContent, PopoverTrigger } from '@client/l4_foundation/ui/shadcn/popover'
import { L2PluginCapabilityDetails } from './l2-plugin-capability-details'
import type { L2PluginManagementBiz } from './l2-plugin-management-biz'
import {
  pluginDisplayName,
  pluginNpmSpec,
  pluginRequestKey,
  useL2PluginManagement
} from './l2-use-plugin-management'
import { useL2PluginCatalog } from './hooks/l2-use-plugin-catalog'
import { useL2PluginDownloadSource } from './hooks/l2-use-plugin-download-source'
import { useL2PluginDirectInstall } from './hooks/l2-use-plugin-direct-install'
import { L2PluginDownloadSourceSelector } from './views/l2-plugin-download-source'
import { L2PluginInstalledList } from './views/l2-plugin-installed-list'
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
  const [tab, setTab] = useState<'installed' | 'search'>('installed')
  const [filter, setFilter] = useState('')
  const [channel, setChannel] = useState('')
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
  const management = useL2PluginManagement({ biz, snapshot, onSnapshot, onRestartScheduled })
  const selectedSources =
    snapshot?.plugins
      .filter((plugin) => selected.has(pluginRequestKey(plugin.source)))
      .map((plugin) => plugin.source) ?? []
  const selectedNpmSources = selectedSources.filter((source) => source.startsWith('npm:'))
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
  const catalog = useL2PluginCatalog(biz, tab === 'search')
  const download = useL2PluginDownloadSource(biz)
  const direct = useL2PluginDirectInstall(biz, snapshot?.plugins)
  const disabled = basicMode || management.requests.has('reload')
  const browserErrors = new Map(
    management.pluginHost.getFailedEntries().map((item) => [item.pluginName, item.error.message])
  )
  const descriptorError = management.pluginHost.getEntryListError()
  const selectedPlugin = snapshot?.plugins.find(
    (plugin) => plugin.source === management.detailSource
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
  const catalogPending =
    management.requests.has(catalogKey) ||
    Boolean(catalogPlugin?.operation && catalogPlugin.operation.phase !== 'failed')
  const directPending =
    direct.sources.length > 0 &&
    direct.sources.every((source) => {
      const key = pluginRequestKey(source)
      const plugin = snapshot?.plugins.find((item) => pluginRequestKey(item.source) === key)
      return (
        management.requests.has(key) ||
        Boolean(plugin?.operation && plugin.operation.phase !== 'failed')
      )
    })
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
  const catalogTarget = (item: L2PluginCatalogItem): L2PluginCatalogItem => {
    const installed = snapshot?.plugins.find(
      (plugin) => pluginNpmSpec(plugin.source)?.name === item.name
    )
    const tag = catalogTag || installed?.updateTag
    return tag ? { ...item, version: tag } : item
  }
  const openCatalog = (item: L2PluginCatalogItem): void => {
    management.closeDetail()
    setCatalogVersionExplicit(false)
    catalog.openDetail(catalogTarget(item))
  }
  const openInstalled = (source: string): void => {
    catalog.closeDetail()
    management.openDetail(source)
  }
  const installCatalogItem = (item: L2PluginCatalogItem): void => {
    void catalog.prepareInstall(catalogTarget(item), (detail) =>
      management.requestInstall(
        {
          source: `npm:${detail.name}`,
          registry: detail.registry,
          ...(catalogTag ? { tag: catalogTag } : {})
        },
        detail
      )
    )
  }
  const closeDialog = (): void => {
    if (management.confirmation) management.setConfirmation(null)
    else {
      management.closeDetail()
      catalog.closeDetail()
    }
  }
  const operationMessage = (phase?: string): string | null => (phase ? t(`phase_${phase}`) : null)
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="shrink-0 space-y-3 border-b p-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">{t('title')}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Popover>
              <PopoverTrigger render={<Button size="sm" variant="outline" />}>
                {t('downloadSource')}：
                {download.loading && !download.settings
                  ? t('loading')
                  : t(`download_${download.settings?.downloadSource.mode ?? download.mode}`)}
                <ChevronDownIcon className="size-4" />
              </PopoverTrigger>
              <PopoverContent align="end" positionerClassName="z-[150]">
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
        {snapshot?.loadError || descriptorError ? (
          <div role="alert" className="max-h-32 space-y-1 overflow-y-auto text-sm text-destructive">
            {snapshot?.loadError ? (
              <p className="[overflow-wrap:anywhere]">
                {selectL4LocalizedText(snapshot.loadError, locale)}
              </p>
            ) : null}
            {descriptorError ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 [overflow-wrap:anywhere]">{descriptorError}</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={management.requests.has('entries')}
                  onClick={() => void management.refreshEntries()}
                >
                  {t('retry')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {management.errors.reload || management.errors.entries ? (
          <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
            {management.errors.reload ?? management.errors.entries}
          </p>
        ) : null}
      </header>
      <div
        role="tablist"
        aria-label={t('title')}
        className="flex shrink-0 gap-1 border-b px-4 pt-2 sm:px-6"
      >
        {(['installed', 'search'] as const).map((value) => (
          <button
            key={value}
            id={`plugin-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`plugin-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            className={`min-h-9 border-b-2 px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${tab === value ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:bg-accent'}`}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 'installed'
                    : event.key === 'End'
                      ? 'search'
                      : tab === 'installed'
                        ? 'search'
                        : 'installed'
                setTab(next)
                document.getElementById(`plugin-tab-${next}`)?.focus()
              }
            }}
          >
            {t(value === 'installed' ? 'installedTab' : 'searchPlugins')}
          </button>
        ))}
      </div>
      <div
        id="plugin-panel-installed"
        role="tabpanel"
        aria-labelledby="plugin-tab-installed"
        tabIndex={0}
        hidden={tab !== 'installed'}
        className={`pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6 ${tab !== 'installed' ? 'hidden' : ''}`}
      >
        <div className="space-y-4">
          {direct.open ? (
            <L2PluginDirectInstall
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
              error={
                direct.error ??
                (directErrors || null) ??
                (directPlugin?.operation?.phase === 'failed'
                  ? directPlugin.operation.message
                  : null)
              }
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
          ) : null}
          <L2PluginInstalledList
            snapshot={snapshot}
            loading={management.loading}
            filter={filter}
            channel={channel}
            selected={selected}
            onChannel={setChannel}
            onSelect={selectSources}
            onCheckSelected={() => void management.refresh(selectedNpmSources)}
            onUpdateSelected={() =>
              void management.executeBatch({ action: 'update', sources: selectedSources })
            }
            onRemoveSelected={() =>
              management.setConfirmation({
                kind: 'batch',
                input: { action: 'del', sources: selectedSources }
              })
            }
            onTagSelected={(tag) =>
              void management.executeBatch({ action: 'tag', sources: selectedNpmSources, tag })
            }
            disabled={disabled}
            requests={management.requests}
            errors={management.errors}
            browserErrors={browserErrors}
            onFilter={setFilter}
            onDetail={openInstalled}
            onAction={management.handleControlAction}
            onDirectInstall={() => direct.setOpen(true)}
            onRefresh={() => void management.refresh(undefined, channel || undefined)}
          />
        </div>
      </div>
      <div
        id="plugin-panel-search"
        role="tabpanel"
        aria-labelledby="plugin-tab-search"
        tabIndex={0}
        hidden={tab !== 'search'}
        className={`pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6 ${tab !== 'search' ? 'hidden' : ''}`}
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
          onSearchSource={catalog.setSearchSource}
          onRegistry={catalog.setRegistry}
          onDetail={openCatalog}
          onInstall={installCatalogItem}
          onUpdate={(source) => void management.execute({ kind: 'update', source })}
          onMore={catalog.loadMore}
          onRetry={catalog.retry}
        />
      </div>
      <L2PluginManagementDialog
        open={Boolean(management.confirmation || management.detailSource || catalog.selection)}
        title={
          selectedPlugin
            ? pluginDisplayName(selectedPlugin)
            : (catalog.selection?.name ?? t('details'))
        }
        confirmation={management.confirmation}
        onClose={closeDialog}
        onConfirm={(action) => void management.execute(action)}
      >
        {selectedPlugin ? (
          <div className="min-w-0 space-y-5">
            {management.detail?.readme ? (
              <L2PluginReadme key={selectedPlugin.source} readme={management.detail.readme} />
            ) : null}
            <L2PluginCapabilityDetails
              plugin={selectedPlugin}
              detail={management.detail}
              detailLoading={management.detailLoading}
              detailError={management.detailError}
              browserContributions={
                selectedPlugin.pluginName
                  ? (management.pluginHost
                      .getRegisteredBrowserDescriptors()
                      .find((descriptor) => descriptor.pluginName === selectedPlugin.pluginName)
                      ?.contributions ?? [])
                  : []
              }
              onRetry={() => void management.loadDetail(selectedPlugin.source)}
            />
          </div>
        ) : catalog.selection ? (
          catalog.detailLoading ? (
            <p role="status" className="py-4 text-sm text-muted-foreground">
              {t('loadingPackage')}
            </p>
          ) : catalog.detailError ? (
            <div role="alert" className="space-y-2 text-sm">
              <p className="text-destructive [overflow-wrap:anywhere]">{catalog.detailError}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void catalog.loadDetail(catalog.selection!)}
              >
                {t('retry')}
              </Button>
            </div>
          ) : catalog.detail ? (
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t('installChannel')}</span>
                <L2PluginManagementChannel
                  value={catalogTag}
                  label={t('installChannel')}
                  placeholder={t('defaultChannel')}
                  disabled={catalogPending}
                  onChange={(tag) => {
                    setCatalogTag(tag)
                    setCatalogVersionExplicit(false)
                    void catalog.loadDetail(
                      catalog.selection!,
                      tag || catalogPlugin?.updateTag || 'latest'
                    )
                  }}
                />
              </div>
              <L2PluginCatalogDetailView
                detail={catalog.detail}
                disabled={disabled}
                pending={catalogPending}
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
                operationMessage={operationMessage(catalogPlugin?.operation?.phase)}
                downloadMode={catalog.downloadMode}
                downloadRegistry={catalog.downloadRegistry}
                onDownloadMode={catalog.setDownloadMode}
                onDownloadRegistry={catalog.setDownloadRegistry}
                onVersion={(version) => {
                  setCatalogVersionExplicit(true)
                  void catalog.loadDetail(catalog.selection!, version)
                }}
                onInstall={() =>
                  catalog.installDetail((input, detail) =>
                    management.requestInstall(
                      {
                        ...input,
                        source: catalogVersionExplicit ? input.source : `npm:${detail.name}`,
                        ...(catalogTag ? { tag: catalogTag } : {})
                      },
                      detail
                    )
                  )
                }
                onUpdate={() => {
                  if (catalogPlugin)
                    void management.execute({ kind: 'update', source: catalogPlugin.source })
                }}
              />
            </div>
          ) : null
        ) : management.detailSource ? (
          <p className="text-sm text-muted-foreground">{t('pluginRemoved')}</p>
        ) : null}
      </L2PluginManagementDialog>
    </div>
  )
}
