'use client'

import {
  AlertCircleIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  PackagePlusIcon,
  RefreshCwIcon,
  RotateCcwIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import type {
  L2PluginManagementItem,
  L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import {
  L4AppDialogRoot,
  L4AppDialogContent,
  L4AppDialogHeader,
  L4AppDialogTitle,
  L4AppDialogDescription,
  L4AppDialogFooter
} from '@client/l4_foundation/ui/l4-app-dialog'
import { L2PluginCapabilityDetails } from './l2-plugin-capability-details'
import { L2PluginManagementControls } from './l2-plugin-management-controls'
import type { L2PluginManagementBiz } from './l2-plugin-management-biz'
import {
  pluginManagementActionLabel as actionLabel,
  useL2PluginManagement
} from './l2-use-plugin-management'

interface L2PluginManagementProps {
  basicMode?: boolean
  snapshot: L2PluginManagementSnapshot | null
  biz: L2PluginManagementBiz
  onSnapshot: (snapshot: L2PluginManagementSnapshot) => void
  onRestartScheduled: () => void
}

function pluginDisplayName(plugin: L2PluginManagementItem): string {
  if (!plugin.source.startsWith('npm:')) {
    if (plugin.pluginName) return plugin.pluginName
    if (plugin.kind === 'extension') {
      return plugin.source.replaceAll('\\', '/').split('/').at(-1) || plugin.source
    }
    return plugin.source
  }
  const spec = plugin.source.slice('npm:'.length)
  const versionSeparator = spec.lastIndexOf('@')
  if (spec.startsWith('@')) {
    return versionSeparator > spec.indexOf('/') ? spec.slice(0, versionSeparator) : spec
  }
  return versionSeparator > 0 ? spec.slice(0, versionSeparator) : spec
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
  const {
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
  } = useL2PluginManagement({ snapshot, biz, onSnapshot, onRestartScheduled })

  const browserErrors = new Map(
    pluginHost.getFailedEntries().map((item) => [item.pluginName, item.error.message])
  )
  const descriptorError = pluginHost.getEntryListError()
  const browserContributionsByPlugin = new Map(
    pluginHost
      .getRegisteredBrowserDescriptors()
      .map((descriptor) => [descriptor.pluginName, descriptor.contributions] as const)
  )

  const confirmationDialog = confirmation ? (
    <L4AppDialogRoot
      open
      onOpenChange={(open) => {
        if (!open) setConfirmation(null)
      }}
    >
      <L4AppDialogContent className="z-[130]">
        <L4AppDialogHeader className="p-4 pr-12">
          <L4AppDialogTitle>
            {t('confirmAction', { action: t(actionLabel(confirmation)) })}
          </L4AppDialogTitle>
          <L4AppDialogDescription className="break-words">
            {confirmation.kind === 'reload'
              ? t(
                  confirmation.mode === 'normal' ? 'restartNormalDescription' : 'restartDescription'
                )
              : confirmation.source}
          </L4AppDialogDescription>
        </L4AppDialogHeader>
        <L4AppDialogFooter>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={operation !== null}
            onClick={() => setConfirmation(null)}
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={confirmation.kind === 'del' ? 'destructive' : 'default'}
            disabled={operation !== null}
            onClick={() => void execute(confirmation)}
          >
            {t(actionLabel(confirmation))}
          </Button>
        </L4AppDialogFooter>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  ) : null
  const actionError = error ? (
    <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
      {error}
    </div>
  ) : null

  return (
    <div className="pi-desk-chat-scrollbar h-full overflow-y-auto">
      <div className="space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{t('title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={basicMode || operation !== null || requests.has('apply')}
              title={t('applyDescription')}
              onClick={() => void applyChanges()}
            >
              {requests.has('apply') ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-4" />
              )}
              {t('applyChanges')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t('checkUpdates')}
              title={t('checkingUpdates')}
              disabled={loading || operation !== null}
              onClick={() => void refresh()}
            >
              {loading ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-4" />
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={operation !== null}
              onClick={() =>
                setConfirmation({ kind: 'reload', mode: basicMode ? 'normal' : undefined })
              }
            >
              <RotateCcwIcon data-icon="inline-start" />
              {basicMode
                ? t('restartNormal')
                : snapshot?.restartRequired
                  ? t('restartApply')
                  : t('actionReload')}
            </Button>
          </div>
        </div>

        {basicMode ? (
          <p className="rounded-lg border bg-muted px-3 py-2 text-sm" role="status">
            {t('basicModeNotice')}
          </p>
        ) : null}
        <details className="border-b pb-4">
          <summary className="cursor-pointer text-sm font-medium">{t('installPlugin')}</summary>
          <label htmlFor="plugin-source" className="mt-3 block text-sm font-medium">
            {t('source')}
          </label>
          <div className="mt-1 flex flex-wrap items-end gap-2">
            <Input
              id="plugin-source"
              className="min-w-[12rem] flex-1"
              value={source}
              disabled={basicMode || operation !== null || requests.has('add')}
              aria-label={t('source')}
              placeholder={t('sourcePlaceholder')}
              onChange={(event) => setSource(event.target.value)}
            />
            <Button
              type="button"
              className="sm:shrink-0"
              disabled={basicMode || operation !== null || requests.has('add') || !source.trim()}
              onClick={() => setConfirmation({ kind: 'add', source: source.trim() })}
            >
              <PackagePlusIcon data-icon="inline-start" />
              {t('install')}
            </Button>
          </div>
        </details>

        {snapshot?.restartRequired ? (
          <div className="rounded-lg border bg-muted px-3 py-2 text-sm font-medium">
            {t('pendingRestart')}
          </div>
        ) : null}

        {snapshot?.loadError || descriptorError ? (
          <div className="rounded-lg border border-destructive/30 bg-muted p-3 text-sm text-destructive">
            <div className="flex items-start gap-2">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                {snapshot?.loadError ? (
                  <p>{selectL4LocalizedText(snapshot.loadError, locale)}</p>
                ) : null}
                {descriptorError ? <p>{descriptorError}</p> : null}
              </div>
              {descriptorError ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={operation !== null}
                  onClick={() => void refreshEntries()}
                >
                  {t('retry')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {actionError}
        {confirmationDialog}
        {!confirmation && operation ? (
          <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            {operation}
          </div>
        ) : null}

        <section aria-label={t('installed')}>
          {loading && !snapshot ? (
            <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {t('loading')}
            </div>
          ) : snapshot?.plugins.length ? (
            <div className="space-y-2">
              {snapshot.plugins.map((plugin) => {
                const displayName = pluginDisplayName(plugin)
                const expanded = plugin.source === detailSource
                const browserError = plugin.pluginName
                  ? (browserErrors.get(plugin.pluginName) ?? null)
                  : null
                const failed =
                  plugin.status === 'failed' ||
                  plugin.operation?.phase === 'failed' ||
                  browserError !== null
                const errorMessage =
                  (plugin.operation?.phase === 'failed' ? plugin.operation.message : null) ||
                  (plugin.error ? selectL4LocalizedText(plugin.error.message, locale) : null) ||
                  browserError ||
                  (failed ? t('notLoaded') : null)
                return (
                  <Collapsible
                    key={plugin.source}
                    open={expanded}
                    onOpenChange={(open) => {
                      if (open) openDetail(plugin.source)
                      else closeDetail()
                    }}
                    className={cn(
                      'overflow-hidden rounded-lg border bg-card',
                      failed && 'border-destructive'
                    )}
                  >
                    <CollapsibleTrigger
                      type="button"
                      className="flex min-h-14 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent/80 disabled:pointer-events-none disabled:opacity-50"
                      aria-label={t('viewDetails', { name: displayName })}
                      disabled={operation !== null}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
                            {displayName}
                          </span>
                          {plugin.version ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              v{plugin.version}
                            </span>
                          ) : null}
                        </span>
                        <span
                          className={cn(
                            'mt-1 block break-words text-sm leading-5 text-muted-foreground',
                            expanded ? 'whitespace-pre-line' : 'line-clamp-1'
                          )}
                        >
                          {plugin.description ?? t('noPluginDescription')}
                        </span>
                        {errorMessage ? (
                          <span className="mt-1 block truncate text-sm text-destructive">
                            {errorMessage}
                          </span>
                        ) : null}
                      </span>
                      <ChevronDownIcon
                        aria-hidden="true"
                        className={cn(
                          'size-4 shrink-0 text-muted-foreground transition-transform',
                          expanded && 'rotate-180'
                        )}
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      {expanded ? (
                        <div className="space-y-4 border-t p-4">
                          <L2PluginManagementControls
                            plugin={plugin}
                            displayName={displayName}
                            browserError={browserError}
                            disabled={operation !== null}
                            pending={selectedPending}
                            browserRetryPending={requests.has(`entry:${plugin.pluginName}`)}
                            reloadDisabled={
                              basicMode ||
                              operation !== null ||
                              requests.has(`source:${plugin.source}`) ||
                              (selectedPending &&
                                !(
                                  plugin.operation?.phase === 'waiting' &&
                                  plugin.operation.action !== 'apply'
                                ))
                            }
                            onAction={handleControlAction}
                          />
                          <L2PluginCapabilityDetails
                            plugin={plugin}
                            detail={detail}
                            detailLoading={detailLoading}
                            detailError={detailError}
                            browserContributions={
                              plugin.pluginName
                                ? (browserContributionsByPlugin.get(plugin.pluginName) ?? [])
                                : []
                            }
                            onRetry={() => void loadDetail(plugin.source)}
                          />
                        </div>
                      ) : null}
                    </CollapsibleContent>
                  </Collapsible>
                )
              })}
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</div>
          )}
        </section>
      </div>
    </div>
  )
}
