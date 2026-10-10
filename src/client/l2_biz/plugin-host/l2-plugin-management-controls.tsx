'use client'

import { LoaderCircleIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { L2PluginManagementItem } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Switch } from '@client/l4_foundation/ui/shadcn/switch'

export type L2PluginManagementControlAction =
  'reload' | 'update' | 'remove' | 'retry' | 'retry-browser' | 'enable' | 'disable'

interface L2PluginManagementControlsProps {
  plugin: L2PluginManagementItem
  displayName: string
  browserError: string | null
  disabled: boolean
  pending: boolean
  browserRetryPending: boolean
  onAction: (action: L2PluginManagementControlAction) => void
}

export function L2PluginManagementControls({
  plugin,
  displayName,
  browserError,
  disabled,
  pending,
  browserRetryPending,
  onAction
}: L2PluginManagementControlsProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const phase = plugin.operation?.phase
  const enabled = plugin.status !== 'disabled'
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3">
      {pending ? (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          {phase !== 'waiting' ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
          {t(phase && phase !== 'failed' ? `phase_${phase}` : 'submitting')}
        </span>
      ) : plugin.updateAvailable && plugin.kind !== 'extension' && phase !== 'failed' ? (
        <Button size="sm" disabled={disabled} onClick={() => onAction('update')}>
          {t('update')}
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
      ) : browserError && plugin.pluginName ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || browserRetryPending}
          onClick={() => onAction('retry-browser')}
        >
          {t('retryView')}
        </Button>
      ) : null}
      <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-muted-foreground">
        <Switch
          checked={enabled}
          aria-label={t('togglePlugin', { name: displayName })}
          disabled={disabled || pending}
          onCheckedChange={(checked) => onAction(checked ? 'enable' : 'disable')}
        />
        {t(enabled ? 'enabled' : 'disabled')}
      </label>
      {plugin.kind !== 'extension' ? (
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          aria-label={t('removeNamed', { name: displayName })}
          title={t('remove')}
          disabled={disabled || pending}
          onClick={() => onAction('remove')}
        >
          <Trash2Icon />
        </Button>
      ) : null}
    </div>
  )
}

export function L2PluginManagementFeedback({
  plugin,
  requestError,
  browserError
}: {
  plugin: L2PluginManagementItem
  requestError?: string
  browserError: string | null
}): React.JSX.Element | null {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const phase = plugin.operation?.phase
  const messages = [
    requestError,
    phase === 'failed' ? plugin.operation?.message : null,
    plugin.error ? selectL4LocalizedText(plugin.error.message, locale) : null,
    browserError,
    plugin.updateError ? t('itemCheckFailed', { error: plugin.updateError }) : null
  ].filter(
    (message, index, all): message is string => Boolean(message) && all.indexOf(message) === index
  )
  if (!messages.length && phase !== 'waiting' && plugin.status !== 'failed') return null
  return (
    <div className="space-y-1">
      {messages.map((message) => (
        <p
          key={message}
          role="alert"
          className="whitespace-pre-wrap text-sm text-destructive [overflow-wrap:anywhere]"
        >
          {message}
        </p>
      ))}
      {!messages.length && plugin.status === 'failed' ? (
        <p className="text-sm text-destructive">{t('notLoaded')}</p>
      ) : null}
      {phase === 'waiting' && plugin.operation?.message ? (
        <p role="status" className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {plugin.operation.message}
        </p>
      ) : null}
    </div>
  )
}
