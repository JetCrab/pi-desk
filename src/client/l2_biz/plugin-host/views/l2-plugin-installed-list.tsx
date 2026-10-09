'use client'

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
import { pluginDisplayName, pluginRequestKey } from '../l2-use-plugin-management'

interface InstalledListProps {
  snapshot: L2PluginManagementSnapshot | null
  loading: boolean
  filter: string
  disabled: boolean
  requests: ReadonlySet<string>
  errors: Readonly<Record<string, string>>
  browserErrors: ReadonlyMap<string, string>
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
  onFilter,
  onDetail,
  onAction,
  onDirectInstall,
  onRefresh
}: InstalledListProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const plugins =
    snapshot?.plugins.filter((plugin) =>
      `${pluginDisplayName(plugin)} ${plugin.description ? selectL4LocalizedText(plugin.description, locale) : ''}`
        .toLocaleLowerCase()
        .includes(filter.toLocaleLowerCase())
    ) ?? []
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
        <Button size="sm" variant="outline" disabled={loading} onClick={onRefresh}>
          {t(loading ? 'checkingUpdates' : 'checkUpdates')}
        </Button>
        <Button size="sm" disabled={disabled} onClick={onDirectInstall}>
          {t('directInstall')}
        </Button>
      </div>
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
              <article key={plugin.source} className="min-w-0 space-y-3 p-4">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
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
          {t(filter ? 'noMatches' : 'empty')}
        </p>
      )}
    </section>
  )
}
