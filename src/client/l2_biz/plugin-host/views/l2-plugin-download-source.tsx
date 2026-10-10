'use client'

import { useTranslation } from 'react-i18next'
import type { L2PluginDownloadSource } from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'

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
          ? 'https://mirrors.cloud.tencent.com/npm'
          : mode === 'custom'
            ? (savedRegistry ?? registry)
            : null
  const options = [
    ...(override ? [{ value: 'default' as const, label: t('useDefaultSource') }] : []),
    ...(['local', 'auto', 'domestic', 'official', 'custom'] as const).map((value) => ({
      value,
      label: t(`download_${value}`)
    }))
  ]
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="font-medium">
          {t(override ? 'installDownloadSource' : 'downloadSource')}
        </label>
        <Select
          value={mode}
          items={options}
          disabled={loading}
          onValueChange={(value) => {
            if (value && !saving) onMode(value)
          }}
        >
          <SelectTrigger id={id} className="max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent positionerClassName="z-[160]">
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} disabled={saving}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
              disabled={saving}
              onChange={(event) => onRegistry(event.target.value)}
            />
            {onSave ? (
              <Button size="sm" variant="outline" disabled={saving} onClick={onSave}>
                {t('save')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : !override && resolved ? (
        <p className="break-all text-xs text-muted-foreground">{resolved}</p>
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
