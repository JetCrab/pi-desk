'use client'

import { useTranslation } from 'react-i18next'
import type {
  L2PluginCatalogDetail,
  L2PluginDownloadSource
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L2PluginReadme } from './l2-plugin-readme'
import { L2PluginDownloadSourceSelector } from './l2-plugin-download-source'

interface CatalogDetailProps {
  detail: L2PluginCatalogDetail
  disabled: boolean
  pending: boolean
  installed: boolean
  installedVersion: string | null
  updateAvailable: boolean
  error: string | null
  operationMessage?: string | null
  downloadMode: L2PluginDownloadSource['mode'] | 'default'
  downloadRegistry: string
  onDownloadMode: (mode: CatalogDetailProps['downloadMode']) => void
  onDownloadRegistry: (registry: string) => void
  onVersion: (version: string) => void
  onInstall: () => void
  onUpdate: () => void
}

function safeLink(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

export function L2PluginCatalogDetailView(props: CatalogDetailProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const detail = props.detail
  const selectedVersionInstalled = props.installed && props.installedVersion === detail.version
  const homepage = safeLink(detail.homepage)
  const repository = safeLink(detail.repository)
  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {detail.official ? (
            <span className="rounded-md bg-secondary px-2 py-1 text-secondary-foreground">
              {t('official')}
            </span>
          ) : null}
          <span>{t(`kind_${detail.kind}`)}</span>
          <span className="[overflow-wrap:anywhere]">
            {detail.publisher ?? t('unknownPublisher')}
          </span>
        </div>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {detail.description
            ? selectL4LocalizedText(detail.description, locale)
            : t('noPluginDescription')}
        </p>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          {t('version')}
          <select
            value={detail.version}
            onChange={(event) => props.onVersion(event.target.value)}
            className="min-h-8 min-w-0 max-w-full rounded-lg border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {[...new Set([detail.version, ...detail.versions])].map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-muted-foreground">
          {t(
            detail.compatible === true
              ? 'compatible'
              : detail.compatible === false
                ? 'incompatible'
                : 'compatibilityUnknown'
          )}
        </p>
        {detail.compatibilityNote ? (
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {detail.compatibilityNote}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3 text-sm">
          {homepage ? (
            <a
              href={homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              {t('homepage')}
            </a>
          ) : null}
          {repository ? (
            <a
              href={repository}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              {t('repository')}
            </a>
          ) : null}
        </div>
        {!selectedVersionInstalled ? (
          <L2PluginDownloadSourceSelector
            id="plugin-detail-download"
            mode={props.downloadMode}
            registry={props.downloadRegistry}
            override
            onMode={props.onDownloadMode}
            onRegistry={props.onDownloadRegistry}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {props.pending ? (
            <span role="status" className="text-sm text-muted-foreground">
              {props.operationMessage ?? t('submitting')}
            </span>
          ) : selectedVersionInstalled ? (
            <>
              <span className="text-sm text-muted-foreground">{t('alreadyInstalled')}</span>
              {props.updateAvailable ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={props.disabled}
                  onClick={props.onUpdate}
                >
                  {t('update')}
                </Button>
              ) : null}
            </>
          ) : (
            <Button size="sm" disabled={props.disabled} onClick={props.onInstall}>
              {t(props.installed ? 'installVersion' : 'install')}
            </Button>
          )}
        </div>
        {props.error ? (
          <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
            {props.error}
          </p>
        ) : null}
      </div>
      <div className="border-t pt-4">
        <L2PluginReadme key={`${detail.name}@${detail.version}`} readme={detail.readme} />
      </div>
    </div>
  )
}
