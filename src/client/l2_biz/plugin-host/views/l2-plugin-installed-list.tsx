'use client'

import { useTranslation } from 'react-i18next'
import { MinusIcon } from 'lucide-react'
import type {
  L2PluginManagementItem,
  L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Checkbox } from '@client/l4_foundation/ui/shadcn/checkbox'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import {
  L2PluginManagementControls,
  L2PluginManagementFeedback,
  type L2PluginManagementControlAction
} from '../l2-plugin-management-controls'
import { pluginDisplayName, pluginRequestKey } from '../l2-use-plugin-management'

export type L2PluginStatusFilter = 'all' | 'updates' | 'disabled' | 'failed'

interface InstalledListProps {
  snapshot: L2PluginManagementSnapshot | null
  loading: boolean
  filter: string
  statusFilter: L2PluginStatusFilter
  batchMode: boolean
  disabled: boolean
  requests: ReadonlySet<string>
  errors: Readonly<Record<string, string>>
  browserErrors: ReadonlyMap<string, string>
  selected: ReadonlySet<string>
  onStatusFilter: (filter: L2PluginStatusFilter) => void
  onBatchMode: (value: boolean) => void
  onSelect: (keys: string[], selected: boolean) => void
  onUpdateAll: () => void
  onUpdateSelected: () => void
  onRemoveSelected: () => void
  onFilter: (filter: string) => void
  onDetail: (source: string) => void
  onAction: (plugin: L2PluginManagementItem, action: L2PluginManagementControlAction) => void
  onRefresh: () => void
}

export function L2PluginInstalledList(props: InstalledListProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const all = props.snapshot?.plugins ?? []
  const busy = (plugin: L2PluginManagementItem): boolean =>
    props.requests.has(pluginRequestKey(plugin.source)) ||
    Boolean(plugin.operation && plugin.operation.phase !== 'failed')
  const failed = (plugin: L2PluginManagementItem): boolean =>
    plugin.status === 'failed' ||
    plugin.operation?.phase === 'failed' ||
    Boolean(plugin.updateError || (plugin.pluginName && props.browserErrors.has(plugin.pluginName)))
  const plugins = all.filter((plugin) => {
    if (props.statusFilter === 'updates' && !plugin.updateAvailable) return false
    if (props.statusFilter === 'disabled' && plugin.status !== 'disabled') return false
    if (props.statusFilter === 'failed' && !failed(plugin)) return false
    return `${pluginDisplayName(plugin)} ${plugin.description ? selectL4LocalizedText(plugin.description, locale) : ''}`
      .toLocaleLowerCase()
      .includes(props.filter.trim().toLocaleLowerCase())
  })
  const selectable = plugins.filter((plugin) => plugin.kind !== 'extension')
  const selected = all.filter((plugin) => props.selected.has(pluginRequestKey(plugin.source)))
  const updates = all.filter(
    (plugin) => plugin.updateAvailable === true && plugin.kind !== 'extension' && !busy(plugin)
  )
  const selectedUpdates = updates.filter((plugin) =>
    props.selected.has(pluginRequestKey(plugin.source))
  )
  const selectedReady = selected.filter((plugin) => !busy(plugin))
  const allSelected =
    selectable.length > 0 &&
    selectable.every((plugin) => props.selected.has(pluginRequestKey(plugin.source)))
  const someSelected = selectable.some((plugin) =>
    props.selected.has(pluginRequestKey(plugin.source))
  )
  const filters = (['all', 'updates', 'disabled', 'failed'] as const).map((value) => ({
    value,
    label: t(`statusFilter_${value}`)
  }))
  return (
    <section aria-label={t('installed')} className="min-w-0 space-y-3">
      <div className="sticky top-0 z-10 space-y-3 bg-popover pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={t('filterInstalled')}
            value={props.filter}
            onChange={(event) => props.onFilter(event.target.value)}
            placeholder={t('filterInstalled')}
            className="min-w-40 flex-1 basis-52"
          />
          <Select
            value={props.statusFilter}
            items={filters}
            onValueChange={(value) => {
              if (value) props.onStatusFilter(value)
            }}
          >
            <SelectTrigger aria-label={t('filterStatus')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent positionerClassName="z-[160]">
              {filters.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={props.loading || props.disabled}
            onClick={props.onRefresh}
          >
            {t(props.loading ? 'checkingUpdates' : 'checkUpdates')}
          </Button>
          {updates.length > 0 ? (
            <Button
              size="sm"
              disabled={props.disabled || props.loading}
              onClick={props.onUpdateAll}
            >
              {t('updateAll', { count: updates.length })}
            </Button>
          ) : null}
          {all.some((plugin) => plugin.kind !== 'extension') ? (
            <Button size="sm" variant="ghost" onClick={() => props.onBatchMode(!props.batchMode)}>
              {t(props.batchMode ? 'finishSelection' : 'batchManage')}
            </Button>
          ) : null}
        </div>
        {props.batchMode ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted px-3 py-2">
            <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
              <span className="relative flex size-4 items-center justify-center">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  className="data-indeterminate:[&_svg]:hidden"
                  disabled={!selectable.length}
                  onCheckedChange={(checked) =>
                    props.onSelect(
                      selectable.map((plugin) => pluginRequestKey(plugin.source)),
                      checked
                    )
                  }
                />
                {someSelected && !allSelected ? (
                  <MinusIcon aria-hidden className="pointer-events-none absolute size-3.5" />
                ) : null}
              </span>
              {t(props.filter || props.statusFilter !== 'all' ? 'selectFiltered' : 'selectAll')}
            </label>
            <span className="text-sm text-muted-foreground">
              {t('selectedCount', { count: selected.length })}
            </span>
            {selected.length ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={props.disabled || props.loading || !selectedUpdates.length}
                  onClick={props.onUpdateSelected}
                >
                  {t('updateSelected')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={props.disabled || !selectedReady.length}
                  onClick={props.onRemoveSelected}
                >
                  {t('removeSelected')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => props.onSelect([...props.selected], false)}
                >
                  {t('clearSelection')}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {props.errors.list ? (
          <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
            {props.errors.list}
          </p>
        ) : null}
      </div>
      {props.loading && !props.snapshot ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">
          {t('loading')}
        </p>
      ) : plugins.length ? (
        <div className="divide-y rounded-lg border bg-card">
          {plugins.map((plugin) => {
            const name = pluginDisplayName(plugin)
            const key = pluginRequestKey(plugin.source)
            const browserError = plugin.pluginName
              ? (props.browserErrors.get(plugin.pluginName) ?? null)
              : null
            return (
              <article
                key={key}
                aria-label={name}
                className={`min-w-0 px-4 py-3 ${props.selected.has(key) && props.batchMode ? 'bg-accent/40' : ''}`}
              >
                <div className="flex items-start gap-3">
                  {props.batchMode && plugin.kind !== 'extension' ? (
                    <div className="flex min-h-8 shrink-0 items-center">
                      <Checkbox
                        checked={props.selected.has(key)}
                        aria-label={t('selectPlugin', { name })}
                        onCheckedChange={(checked) => props.onSelect([key], checked)}
                      />
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                      <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-x-2 gap-y-1">
                        <Button
                          variant="link"
                          className="h-auto min-h-8 min-w-0 max-w-full justify-start p-0 text-left text-sm font-semibold whitespace-normal no-underline hover:underline [overflow-wrap:anywhere]"
                          aria-label={t('viewDetails', { name })}
                          onClick={() => props.onDetail(plugin.source)}
                        >
                          {name}
                        </Button>
                        {plugin.version ? (
                          <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                        ) : null}
                        {plugin.updateAvailable ? (
                          <span className="inline-flex rounded-md bg-status-success/10 px-2 py-0.5 text-xs font-medium text-status-success">
                            {plugin.availableVersion
                              ? t('newVersion', { version: plugin.availableVersion })
                              : t('updateAvailable')}
                          </span>
                        ) : null}
                        {plugin.updateTag && plugin.updateTag !== 'latest' ? (
                          <span className="text-xs text-muted-foreground">
                            {plugin.updateTag === 'dev' ? t('channelDev') : plugin.updateTag}
                          </span>
                        ) : null}
                      </div>
                      <L2PluginManagementControls
                        plugin={plugin}
                        displayName={name}
                        browserError={browserError}
                        disabled={props.disabled}
                        pending={busy(plugin)}
                        browserRetryPending={props.requests.has(`entry:${plugin.pluginName}`)}
                        onAction={(action) => props.onAction(plugin, action)}
                      />
                    </div>
                    {plugin.description ? (
                      <p className="line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                        {selectL4LocalizedText(plugin.description, locale)}
                      </p>
                    ) : null}
                    <L2PluginManagementFeedback
                      plugin={plugin}
                      browserError={browserError}
                      requestError={props.errors[key] ?? props.errors[`entry:${plugin.pluginName}`]}
                    />
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t(props.filter || props.statusFilter !== 'all' ? 'noMatches' : 'empty')}
        </p>
      )}
    </section>
  )
}
