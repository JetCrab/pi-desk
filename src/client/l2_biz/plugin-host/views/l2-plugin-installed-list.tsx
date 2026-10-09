'use client'

import { Checkbox } from '@base-ui/react/checkbox'
import { CheckIcon, MinusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  L2PluginManagementItem,
  L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import {
  L2PluginManagementControls,
  type L2PluginManagementControlAction
} from '../l2-plugin-management-controls'
import { L2PluginManagementChannel } from './l2-plugin-management-channel'
import { pluginDisplayName, pluginRequestKey } from '../l2-use-plugin-management'

interface InstalledListProps {
  snapshot: L2PluginManagementSnapshot | null
  loading: boolean
  filter: string
  disabled: boolean
  requests: ReadonlySet<string>
  errors: Readonly<Record<string, string>>
  browserErrors: ReadonlyMap<string, string>
  channel: string
  selected: ReadonlySet<string>
  onChannel: (channel: string) => void
  onSelect: (keys: string[], selected: boolean) => void
  onCheckSelected: () => void
  onUpdateSelected: () => void
  onRemoveSelected: () => void
  onTagSelected: (tag: string) => void
  onFilter: (filter: string) => void
  onDetail: (source: string) => void
  onAction: (plugin: L2PluginManagementItem, action: L2PluginManagementControlAction) => void
  onDirectInstall: () => void
  onRefresh: () => void
}

export function L2PluginInstalledList({
  snapshot,
  loading,
  filter,
  disabled,
  requests,
  errors,
  browserErrors,
  channel,
  selected,
  onChannel,
  onSelect,
  onCheckSelected,
  onUpdateSelected,
  onRemoveSelected,
  onTagSelected,
  onFilter,
  onDetail,
  onAction,
  onDirectInstall,
  onRefresh
}: InstalledListProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const plugins =
    snapshot?.plugins.filter(
      (plugin) =>
        (!channel ||
          (plugin.source.startsWith('npm:') && (plugin.updateTag ?? 'latest') === channel)) &&
        `${pluginDisplayName(plugin)} ${plugin.description ? selectL4LocalizedText(plugin.description, locale) : ''}`
          .toLocaleLowerCase()
          .includes(filter.toLocaleLowerCase())
    ) ?? []
  const selectable = plugins.filter((plugin) => plugin.kind !== 'extension')
  const selectedPlugins =
    snapshot?.plugins.filter((plugin) => selected.has(pluginRequestKey(plugin.source))) ?? []
  const selectedNpm = selectedPlugins.filter((plugin) => plugin.source.startsWith('npm:'))
  const selectedReady = selectedPlugins.filter(
    (plugin) =>
      !requests.has(pluginRequestKey(plugin.source)) &&
      (!plugin.operation || plugin.operation.phase === 'failed')
  )
  const allSelected =
    selectable.length > 0 &&
    selectable.every((plugin) => selected.has(pluginRequestKey(plugin.source)))
  const someSelected = selectable.some((plugin) => selected.has(pluginRequestKey(plugin.source)))
  const selectedNpmReady = selectedReady.filter((plugin) => plugin.source.startsWith('npm:'))
  const tooMany = selectedPlugins.length > 32
  return (
    <section aria-label={t('installed')} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="plugin-installed-filter" className="sr-only">
          {t('filterInstalled')}
        </label>
        <Input
          id="plugin-installed-filter"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          placeholder={t('filterInstalled')}
          className="min-w-0 flex-1 basis-48"
        />
        <L2PluginManagementChannel
          value={channel}
          label={t('filterChannel')}
          placeholder={t('allChannels')}
          onChange={onChannel}
        />
        <Button size="sm" variant="outline" disabled={loading} onClick={onRefresh}>
          {t(loading ? 'checkingUpdates' : 'checkUpdates')}
        </Button>
        <Button size="sm" disabled={disabled} onClick={onDirectInstall}>
          {t('directInstall')}
        </Button>
      </div>
      {selectable.length || selectedPlugins.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted p-2">
          <label className="flex min-h-8 cursor-pointer items-center gap-2 px-1 text-sm">
            <Checkbox.Root
              checked={allSelected}
              indeterminate={someSelected && !allSelected}
              disabled={!selectable.length}
              onCheckedChange={(checked) =>
                onSelect(
                  selectable.map((plugin) => pluginRequestKey(plugin.source)),
                  checked
                )
              }
              className="flex size-5 shrink-0 items-center justify-center rounded border border-input bg-background outline-none data-checked:bg-primary data-checked:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Checkbox.Indicator>
                {someSelected && !allSelected ? (
                  <MinusIcon className="size-4" />
                ) : (
                  <CheckIcon className="size-4" />
                )}
              </Checkbox.Indicator>
            </Checkbox.Root>
            {t('selectFiltered')}
          </label>
          {selectedPlugins.length ? (
            <>
              <span className="text-sm text-muted-foreground">
                {t('selectedCount', { count: selectedPlugins.length })}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={loading || !selectedNpm.length || tooMany}
                onClick={onCheckSelected}
              >
                {t('checkSelected')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !selectedReady.length || tooMany}
                onClick={onUpdateSelected}
              >
                {t('updateSelected')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !selectedReady.length || tooMany}
                onClick={onRemoveSelected}
              >
                {t('removeSelected')}
              </Button>
              <L2PluginManagementChannel
                value=""
                label={t('setChannel')}
                placeholder={t('setChannel')}
                disabled={disabled || !selectedNpmReady.length || tooMany}
                onChange={(tag) => {
                  if (tag) onTagSelected(tag)
                }}
              />
              <Button size="sm" variant="ghost" onClick={() => onSelect([...selected], false)}>
                {t('clearSelection')}
              </Button>
            </>
          ) : null}
          {tooMany ? (
            <p role="status" className="w-full text-sm text-muted-foreground">
              {t('batchLimit')}
            </p>
          ) : null}
        </div>
      ) : null}
      {errors.list ? (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {errors.list}
        </p>
      ) : null}
      {loading && !snapshot ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">
          {t('loading')}
        </p>
      ) : plugins.length ? (
        <div className="divide-y rounded-lg border bg-card">
          {plugins.map((plugin) => {
            const name = pluginDisplayName(plugin)
            const key = pluginRequestKey(plugin.source)
            return (
              <article
                key={key}
                className={`min-w-0 space-y-3 p-4 ${selected.has(key) ? 'bg-accent/40' : ''}`}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {plugin.kind !== 'extension' ? (
                    <Checkbox.Root
                      checked={selected.has(key)}
                      aria-label={t('selectPlugin', { name })}
                      onCheckedChange={(checked) => onSelect([key], checked)}
                      className="flex size-6 shrink-0 items-center justify-center rounded border border-input bg-background outline-none data-checked:bg-primary data-checked:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Checkbox.Indicator>
                        <CheckIcon className="size-4" />
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                  ) : null}
                  <Button
                    variant="link"
                    className="h-auto min-w-0 max-w-full justify-start p-0 text-left text-sm font-semibold whitespace-normal [overflow-wrap:anywhere]"
                    aria-label={t('viewDetails', { name })}
                    onClick={() => onDetail(plugin.source)}
                  >
                    {name}
                  </Button>
                  {plugin.version ? (
                    <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                  ) : null}
                </div>
                {plugin.source.startsWith('npm:') ? (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    <span>{t('followingChannel', { tag: plugin.updateTag ?? 'latest' })}</span>
                    {plugin.availableVersion ? (
                      <span>{t('targetVersion', { version: plugin.availableVersion })}</span>
                    ) : null}
                    {plugin.updateError ? (
                      <p role="alert" className="w-full text-sm text-destructive">
                        {t('itemCheckFailed', { error: plugin.updateError })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {plugin.description
                    ? selectL4LocalizedText(plugin.description, locale)
                    : t('noPluginDescription')}
                </p>
                <L2PluginManagementControls
                  plugin={plugin}
                  displayName={name}
                  browserError={
                    plugin.pluginName ? (browserErrors.get(plugin.pluginName) ?? null) : null
                  }
                  requestError={errors[key] ?? errors[`entry:${plugin.pluginName}`]}
                  disabled={disabled}
                  pending={
                    requests.has(key) ||
                    Boolean(plugin.operation && plugin.operation.phase !== 'failed')
                  }
                  browserRetryPending={requests.has(`entry:${plugin.pluginName}`)}
                  onAction={(action) => onAction(plugin, action)}
                />
              </article>
            )
          })}
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t(filter || channel ? 'noMatches' : 'empty')}
        </p>
      )}
    </section>
  )
}
