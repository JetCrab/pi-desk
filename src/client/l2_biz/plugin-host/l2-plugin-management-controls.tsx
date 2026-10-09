'use client'

import { LoaderCircleIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { L2PluginManagementItem } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'

export type L2PluginManagementControlAction =
  'reload' | 'update' | 'remove' | 'retry' | 'retry-browser' | 'enable' | 'disable'

interface L2PluginManagementControlsProps {
  plugin: L2PluginManagementItem
  displayName: string
  browserError: string | null
  requestError?: string | null
  disabled: boolean
  pending: boolean
  browserRetryPending: boolean
  onAction: (action: L2PluginManagementControlAction) => void
}

export function L2PluginManagementControls({
  plugin,
  displayName,
  browserError,
  requestError,
  disabled,
  pending,
  browserRetryPending,
  onAction
}: L2PluginManagementControlsProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const phase = plugin.operation?.phase
  const unfinished = Boolean(plugin.operation && phase !== 'failed')
  const enabled = plugin.status !== 'disabled'
  const failed = plugin.status === 'failed' || browserError !== null
  const sourceError = plugin.error ? selectL4LocalizedText(plugin.error.message, locale) : null
  const status = unfinished
    ? t(`phase_${phase}`)
    : failed
      ? t('notLoaded')
      : enabled
        ? t('enabled')
        : t('disabled')
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {unfinished || pending || failed ? (
          <span
            role="status"
            className={`inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs ${failed && !unfinished ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {unfinished && phase !== 'waiting' ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : null}
            {pending && !unfinished ? t('submitting') : status}
          </span>
        ) : null}
        {plugin.kind === 'extension' ? (
          <span className="text-xs text-muted-foreground">{t('localExtension')}</span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          role="switch"
          aria-checked={enabled}
          aria-label={t('togglePlugin', { name: displayName })}
          disabled={disabled || pending}
          onClick={() => onAction(enabled ? 'disable' : 'enable')}
        >
          <span
            aria-hidden="true"
            className={`flex h-4 w-7 items-center rounded-full p-0.5 ${enabled ? 'bg-primary' : 'bg-muted-foreground'}`}
          >
            <span
              className={`size-3 rounded-full bg-primary-foreground transition-transform ${enabled ? 'translate-x-3' : ''}`}
            />
          </span>
          {t(enabled ? 'enabled' : 'disabled')}
        </Button>
        {plugin.updateAvailable && plugin.kind !== 'extension' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || pending}
            onClick={() => onAction('update')}
          >
            {t('update')}
          </Button>
        ) : null}
        {plugin.kind !== 'extension' ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={disabled || pending}
            onClick={() => onAction('remove')}
          >
            <Trash2Icon data-icon="inline-start" />
            {t('remove')}
          </Button>
        ) : null}
        {phase === 'failed' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || pending}
            onClick={() => onAction('retry')}
          >
            {t('retry')}
          </Button>
        ) : null}
        {browserError && plugin.pluginName ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || browserRetryPending}
            onClick={() => onAction('retry-browser')}
          >
            {t('retryView')}
          </Button>
        ) : null}
        <details className="text-sm">
          <summary className="cursor-pointer rounded-lg px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            {t('more')}
          </summary>
          <Button
            size="sm"
            variant="ghost"
            className="mt-1"
            disabled={disabled || (pending && phase !== 'waiting')}
            aria-label={t('reloadSource', { name: displayName })}
            onClick={() => onAction('reload')}
          >
            {t('reloadOne')}
          </Button>
        </details>
      </div>
      {plugin.operation?.message ? (
        <p
          className={`whitespace-pre-wrap text-sm [overflow-wrap:anywhere] ${phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {plugin.operation.message}
        </p>
      ) : null}
      {[requestError, sourceError, browserError]
        .filter(
          (message, index, all) =>
            message && all.indexOf(message) === index && message !== plugin.operation?.message
        )
        .map((message) => (
          <p
            key={message}
            role="alert"
            className="whitespace-pre-wrap text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {message}
          </p>
        ))}
    </div>
  )
}
