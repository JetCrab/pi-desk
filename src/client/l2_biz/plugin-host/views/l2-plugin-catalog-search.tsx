'use client'

import { useTranslation } from 'react-i18next'
import type {
  L2PluginCatalogItem,
  L2PluginCatalogSearchRequest
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import type { L2PluginManagementSnapshot } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { pluginNpmSpec, pluginRequestKey } from '../l2-use-plugin-management'

interface CatalogSearchProps {
  query: string
  kind: L2PluginCatalogSearchRequest['kind']
  searchSource: 'public' | 'custom'
  registry: string
  items: readonly L2PluginCatalogItem[]
  loading: boolean
  error: string | null
  searched: boolean
  hasMore: boolean
  disabled: boolean
  snapshot: L2PluginManagementSnapshot | null
  requests: ReadonlySet<string>
  preparing: ReadonlySet<string>
  errors: Readonly<Record<string, string>>
  installErrors: Readonly<Record<string, string>>
  onQuery: (query: string) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onKind: (kind: L2PluginCatalogSearchRequest['kind']) => void
  onSearchSource: (source: 'public' | 'custom') => void
  onRegistry: (registry: string) => void
  onDetail: (item: L2PluginCatalogItem) => void
  onInstall: (item: L2PluginCatalogItem) => void
  onUpdate: (source: string) => void
  onMore: () => void
  onRetry: () => void
}

export function L2PluginCatalogSearch(props: CatalogSearchProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const installed = new Map(
    props.snapshot?.plugins
      .filter((plugin) => plugin.source.startsWith('npm:'))
      .map((plugin) => [pluginNpmSpec(plugin.source)?.name, plugin])
  )
  return (
    <section className="min-w-0 space-y-4" aria-label={t('searchPlugins')}>
      <div className="space-y-3">
        <label htmlFor="plugin-catalog-query" className="sr-only">
          {t('searchPlugins')}
        </label>
        <Input
          id="plugin-catalog-query"
          value={props.query}
          placeholder={t('searchPlaceholder')}
          maxLength={200}
          onChange={(event) => props.onQuery(event.target.value)}
          onCompositionStart={props.onCompositionStart}
          onCompositionEnd={props.onCompositionEnd}
        />
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-2 text-sm">
            {t('searchSource')}
            <select
              value={props.searchSource}
              onChange={(event) => props.onSearchSource(event.target.value as 'public' | 'custom')}
              className="min-h-8 rounded-lg border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="public">{t('publicNpm')}</option>
              <option value="custom">{t('customSearchSource')}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            {t('pluginKind')}
            <select
              value={props.kind}
              onChange={(event) => props.onKind(event.target.value as CatalogSearchProps['kind'])}
              className="min-h-8 rounded-lg border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {(['all', 'desk', 'pi'] as const).map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind_${kind}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {props.searchSource === 'custom' ? (
          <div className="space-y-1">
            <label htmlFor="plugin-search-registry" className="block text-sm">
              {t('searchRegistryUrl')}
            </label>
            <Input
              id="plugin-search-registry"
              type="url"
              value={props.registry}
              onChange={(event) => props.onRegistry(event.target.value)}
              placeholder="https://registry.example.com"
            />
          </div>
        ) : null}
      </div>
      {props.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span className="min-w-0 [overflow-wrap:anywhere]">{props.error}</span>
          <Button size="sm" variant="outline" onClick={props.onRetry}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {props.items.length ? (
        <div className="divide-y rounded-lg border bg-card">
          {props.items.map((item) => {
            const plugin = installed.get(item.name)
            const key = pluginRequestKey(`npm:${item.name}`)
            const description = plugin?.description ?? item.description
            const unfinished = Boolean(plugin?.operation && plugin.operation.phase !== 'failed')
            const pending = props.requests.has(key) || unfinished || props.preparing.has(item.name)
            const healthy =
              plugin && !(plugin.operation?.action === 'add' && plugin.operation.phase === 'failed')
            const error =
              props.installErrors[item.name] ??
              props.errors[key] ??
              (plugin?.error ? selectL4LocalizedText(plugin.error.message, locale) : null)
            return (
              <article key={item.name} className="min-w-0 space-y-2 p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Button
                    variant="link"
                    className="h-auto min-w-0 max-w-full p-0 text-left text-sm font-semibold whitespace-normal [overflow-wrap:anywhere]"
                    onClick={() => props.onDetail(item)}
                  >
                    {item.name}
                  </Button>
                  <span className="text-xs text-muted-foreground">v{item.version}</span>
                  {item.official ? (
                    <span className="rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                      {t('official')}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{t(`kind_${item.kind}`)}</span>
                </div>
                <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {description
                    ? selectL4LocalizedText(description, locale)
                    : t('noPluginDescription')}
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {item.publisher ?? t('unknownPublisher')}
                  </span>
                  {pending ? (
                    <span role="status" className="text-sm text-muted-foreground">
                      {unfinished
                        ? t(`phase_${plugin?.operation?.phase}`)
                        : props.preparing.has(item.name)
                          ? t('loadingPackage')
                          : t('submitting')}
                    </span>
                  ) : healthy ? (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">{t('alreadyInstalled')}</span>
                      {plugin.updateAvailable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={props.disabled}
                          onClick={() => props.onUpdate(plugin.source)}
                        >
                          {t('update')}
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={props.disabled}
                      onClick={() => props.onInstall(item)}
                    >
                      {t('install')}
                    </Button>
                  )}
                </div>
                {error ? (
                  <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                    {error}
                  </p>
                ) : null}
                {plugin?.operation?.phase === 'failed' && plugin.operation.message ? (
                  <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                    {plugin.operation.message}
                  </p>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : null}
      {props.loading ? (
        <p role="status" className="py-4 text-sm text-muted-foreground">
          {t('searching')}
        </p>
      ) : !props.error && props.searched && !props.items.length ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('noSearchResults')}</p>
      ) : null}
      {props.hasMore ? (
        <Button size="sm" variant="outline" disabled={props.loading} onClick={props.onMore}>
          {t('loadMore')}
        </Button>
      ) : null}
    </section>
  )
}
