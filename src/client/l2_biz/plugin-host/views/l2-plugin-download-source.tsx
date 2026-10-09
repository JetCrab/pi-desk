'use client'

import { useTranslation } from 'react-i18next'
import type { L2PluginDownloadSource } from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'

interface DownloadSourceProps {
  id: string
  mode: L2PluginDownloadSource['mode'] | 'default'
  registry: string
  recommendedRegistry?: string
  savedRegistry?: string
  loading?: boolean
  saving?: boolean
  error?: string | null
  override?: boolean
  onMode: (mode: L2PluginDownloadSource['mode'] | 'default') => void
  onRegistry: (registry: string) => void
  onSave?: () => void
  onRetry?: () => void
}

export function L2PluginDownloadSourceSelector({
  id,
  mode,
  registry,
  recommendedRegistry,
  savedRegistry,
  loading,
  saving,
  error,
  override,
  onMode,
  onRegistry,
  onSave,
  onRetry
}: DownloadSourceProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const resolved =
    mode === 'auto'
      ? recommendedRegistry
      : mode === 'official'
        ? 'https://registry.npmjs.org'
        : mode === 'domestic'
          ? 'https://registry.npmmirror.com'
          : mode === 'custom'
            ? (savedRegistry ?? registry)
            : null
  return (
    <div className="min-w-0 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="font-medium">
          {t(override ? 'installDownloadSource' : 'downloadSource')}
        </label>
        <select
          id={id}
          value={mode}
          disabled={saving}
          onChange={(event) => onMode(event.target.value as DownloadSourceProps['mode'])}
          className="min-h-8 max-w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {override ? <option value="default">{t('useDefaultSource')}</option> : null}
          {(['auto', 'domestic', 'official', 'custom'] as const).map((value) => (
            <option key={value} value={value}>
              {t(`download_${value}`)}
            </option>
          ))}
        </select>
        {loading ? (
          <span role="status" className="text-muted-foreground">
            {t('recommending')}
          </span>
        ) : null}
        {saving ? (
          <span role="status" className="text-muted-foreground">
            {t('saving')}
          </span>
        ) : null}
      </div>
      {mode === 'custom' ? (
        <div className="space-y-1">
          <label htmlFor={`${id}-url`} className="block">
            {t('registryUrl')}
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={`${id}-url`}
              type="url"
              value={registry}
              placeholder="https://registry.example.com"
              className="min-w-0 flex-1 basis-48"
              onChange={(event) => onRegistry(event.target.value)}
            />
            {onSave ? (
              <Button size="sm" variant="outline" disabled={saving} onClick={onSave}>
                {t('save')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {!override ? (
        <details>
          <summary className="cursor-pointer py-1 text-muted-foreground">
            {t('sourceDetails')}
          </summary>
          <p className="mt-1 break-all text-muted-foreground">{resolved ?? t('recommending')}</p>
        </details>
      ) : null}
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">
          <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
