'use client'

import { ChevronDownIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  L2PluginCatalogDetail,
  L2PluginDownloadSource
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import { L2PluginReadme } from './l2-plugin-readme'
import { L2PluginDownloadSourceSelector } from './l2-plugin-download-source'
import { L2PluginManagementChannel } from './l2-plugin-management-channel'

interface CatalogDetailProps {
  detail: L2PluginCatalogDetail
  disabled: boolean
  pending: boolean
  installed: boolean
  installedVersion: string | null
  updateAvailable: boolean
  error: string | null
  operationMessage?: string | null
  channel: string
  onChannel: (channel: string) => void
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
  const versions = [...new Set([detail.version, ...detail.versions])]
  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>v{detail.version}</span>
          <span>{t(`kind_${detail.kind}`)}</span>
          {detail.publisher ? (
            <span className="[overflow-wrap:anywhere]">{detail.publisher}</span>
          ) : null}
        </div>
        {detail.description ? (
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {selectL4LocalizedText(detail.description, locale)}
          </p>
        ) : null}
        {detail.compatible === false ? (
          <p role="alert" className="text-sm text-destructive">
            {t('incompatible')}
            {detail.compatibilityNote ? ` · ${detail.compatibilityNote}` : ''}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {props.pending ? (
            <span role="status" className="text-sm text-muted-foreground">
              {props.operationMessage ?? t('submitting')}
            </span>
          ) : selectedVersionInstalled ? (
            <>
              <span className="text-sm text-muted-foreground">{t('alreadyInstalled')}</span>
              {props.updateAvailable ? (
                <Button size="sm" disabled={props.disabled} onClick={props.onUpdate}>
                  {t('update')}
                </Button>
              ) : null}
            </>
          ) : (
            <Button
              size="sm"
              disabled={props.disabled || detail.compatible === false}
              onClick={props.onInstall}
            >
              {t(props.installed ? 'installVersion' : 'install')}
            </Button>
          )}
          {homepage ? (
            <a
              href={homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >
              {t('homepage')}
            </a>
          ) : null}
          {repository ? (
            <a
              href={repository}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >
              {t('repository')}
            </a>
          ) : null}
        </div>
        {props.error ? (
          <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
            {props.error}
          </p>
        ) : null}
      </div>
      <Collapsible className="rounded-lg border">
        <CollapsibleTrigger className="group flex min-h-9 w-full items-center justify-between px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('advancedOptions')}
          <ChevronDownIcon className="size-4 transition-transform group-aria-expanded:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted className="hidden data-open:block">
          <div className="space-y-3 px-3 pb-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{t('installChannel')}</span>
              <L2PluginManagementChannel
                value={props.channel}
                label={t('installChannel')}
                placeholder={t('defaultChannel')}
                disabled={props.pending}
                onChange={props.onChannel}
              />
              <Select
                value={detail.version}
                items={versions.map((value) => ({ value, label: value }))}
                onOpenChange={(open, details) => {
                  if (open && props.pending) details.cancel()
                }}
                onValueChange={(value) => {
                  if (value && !props.pending) props.onVersion(value)
                }}
              >
                <SelectTrigger aria-label={t('version')} aria-disabled={props.pending}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent positionerClassName="z-[160]">
                  {versions.map((value) => (
                    <SelectItem key={value} value={value} disabled={props.pending}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <L2PluginDownloadSourceSelector
              id="plugin-detail-download"
              mode={props.downloadMode}
              registry={props.downloadRegistry}
              override
              saving={props.pending}
              onMode={props.onDownloadMode}
              onRegistry={props.onDownloadRegistry}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
      <div className="border-t pt-4">
        <L2PluginReadme key={`${detail.name}@${detail.version}`} readme={detail.readme} />
      </div>
    </div>
  )
}
