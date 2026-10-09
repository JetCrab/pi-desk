'use client'

import { useTranslation } from 'react-i18next'
import type {
  L2PluginCatalogDetail,
  L2PluginDownloadSource
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { L2PluginDownloadSourceSelector } from './l2-plugin-download-source'

interface DirectInstallProps {
  source: string
  isNpm: boolean
  detail: L2PluginCatalogDetail | null
  loading: boolean
  pending: boolean
  disabled: boolean
  error: string | null
  operationMessage?: string | null
  override: L2PluginDownloadSource['mode'] | 'default'
  registry: string
  onSource: (source: string) => void
  onMode: (mode: DirectInstallProps['override']) => void
  onRegistry: (registry: string) => void
  onRead: () => void
  onVersion: (version: string) => void
  onInstall: () => void
  onClose: () => void
}

export function L2PluginDirectInstall(props: DirectInstallProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  return (
    <section
      aria-label={t('directInstall')}
      className="min-w-0 space-y-3 rounded-lg border bg-card p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('directInstall')}</h3>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          {t('close')}
        </Button>
      </div>
      <label htmlFor="plugin-direct-source" className="block text-sm font-medium">
        {t('source')}
      </label>
      <Input
        id="plugin-direct-source"
        value={props.source}
        placeholder={t('sourcePlaceholder')}
        onChange={(event) => props.onSource(event.target.value)}
      />
      {props.isNpm ? (
        <>
          <Button size="sm" variant="outline" disabled={props.loading} onClick={props.onRead}>
            {t(props.loading ? 'loadingPackage' : 'readPackage')}
          </Button>
          {props.detail ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                {props.detail.name}
              </span>
              <label className="flex min-w-0 flex-wrap items-center gap-2">
                {t('version')}
                <select
                  value={props.detail.version}
                  disabled={props.loading}
                  onChange={(event) => props.onVersion(event.target.value)}
                  className="min-h-8 min-w-0 max-w-full rounded-lg border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {[...new Set([props.detail.version, ...props.detail.versions])].map((version) => (
                    <option key={version} value={version}>
                      {version}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          <L2PluginDownloadSourceSelector
            id="plugin-direct-download"
            mode={props.override}
            registry={props.registry}
            override
            onMode={props.onMode}
            onRegistry={props.onRegistry}
          />
        </>
      ) : null}
      {props.error ? (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {props.error}
        </p>
      ) : null}
      {props.operationMessage ? (
        <p role="status" className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {props.operationMessage}
        </p>
      ) : null}
      <Button
        size="sm"
        disabled={props.disabled || props.loading || props.pending || !props.source.trim()}
        onClick={props.onInstall}
      >
        {t(props.pending ? 'installing' : 'install')}
      </Button>
    </section>
  )
}
