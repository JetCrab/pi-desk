'use client'

import { useTranslation } from 'react-i18next'
import { ChevronDownIcon } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@client/l4_foundation/ui/shadcn/collapsible'
import type {
  L2PluginCatalogDetail,
  L2PluginDownloadSource
} from '@common/l2_biz/plugin/l2-plugin-catalog-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Textarea } from '@client/l4_foundation/ui/shadcn/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import { L2PluginManagementChannel } from './l2-plugin-management-channel'
import { L2PluginDownloadSourceSelector } from './l2-plugin-download-source'

interface DirectInstallProps {
  source: string
  isNpm: boolean
  multiple: boolean
  tag: string
  selectedVersion: string
  onTag: (tag: string) => void
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
      <Textarea
        id="plugin-direct-source"
        value={props.source}
        placeholder={t('batchSourcePlaceholder')}
        rows={2}
        disabled={props.pending}
        onChange={(event) => props.onSource(event.target.value)}
      />
      {props.isNpm || props.multiple ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex min-h-8 items-center gap-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('advancedOptions')}
            <ChevronDownIcon className="size-4 transition-transform group-aria-expanded:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted className="hidden data-open:block">
            <div className="space-y-3 pt-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t('installChannel')}</span>
                <L2PluginManagementChannel
                  value={props.tag}
                  label={t('installChannel')}
                  placeholder={t('defaultChannel')}
                  disabled={props.pending}
                  onChange={props.onTag}
                />
              </div>
              {props.isNpm ? (
                <Button size="sm" variant="outline" disabled={props.loading} onClick={props.onRead}>
                  {t(props.loading ? 'loadingPackage' : 'readPackage')}
                </Button>
              ) : null}
              {props.detail ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                    {props.detail.name}
                  </span>
                  <Select
                    value={props.selectedVersion}
                    onOpenChange={(open, details) => {
                      if (open && (props.loading || props.pending)) details.cancel()
                    }}
                    items={[
                      { value: '', label: t('automaticVersion') },
                      ...[...new Set([props.detail.version, ...props.detail.versions])].map(
                        (version) => ({ value: version, label: version })
                      )
                    ]}
                    onValueChange={(version) => {
                      if (version !== null && !props.loading && !props.pending)
                        props.onVersion(version)
                    }}
                  >
                    <SelectTrigger
                      aria-label={t('version')}
                      aria-disabled={props.loading || props.pending}
                      className="max-w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent positionerClassName="z-[160]">
                      <SelectItem value="" disabled={props.loading || props.pending}>
                        {t('automaticVersion')}
                      </SelectItem>
                      {[...new Set([props.detail.version, ...props.detail.versions])].map(
                        (version) => (
                          <SelectItem
                            key={version}
                            value={version}
                            disabled={props.loading || props.pending}
                          >
                            {version}
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {t('targetVersion', { version: props.detail.version })}
                  </span>
                </div>
              ) : null}
              <L2PluginDownloadSourceSelector
                id="plugin-direct-download"
                mode={props.override}
                registry={props.registry}
                override
                saving={props.pending}
                onMode={props.onMode}
                onRegistry={props.onRegistry}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {props.error ? (
        <p
          role="alert"
          className="text-sm whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]"
        >
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
        {t(props.pending ? 'installing' : props.multiple ? 'batchInstall' : 'install')}
      </Button>
    </section>
  )
}
