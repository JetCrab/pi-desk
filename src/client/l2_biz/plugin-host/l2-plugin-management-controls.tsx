'use client'

import { LoaderCircleIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { L2PluginManagementItem } from '@common/l2_biz/plugin/l2-plugin-management-contract'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { Button } from '@client/l4_foundation/ui/shadcn/button'

export type L2PluginManagementControlAction =
  'reload' | 'update' | 'remove' | 'retry' | 'retry-browser'

interface L2PluginManagementControlsProps {
  plugin: L2PluginManagementItem
  displayName: string
  browserError: string | null
  disabled: boolean
  reloadDisabled: boolean
  pending: boolean
  browserRetryPending: boolean
  onAction: (action: L2PluginManagementControlAction) => void
}

export function L2PluginManagementControls({
  plugin,
  displayName,
  browserError,
  disabled,
  reloadDisabled,
  pending,
  browserRetryPending,
  onAction
}: L2PluginManagementControlsProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const phase = plugin.operation?.phase
  const sourceError = plugin.error ? selectL4LocalizedText(plugin.error.message, locale) : null
  const duplicateError = phase === 'failed' && plugin.operation?.message === sourceError
  const failed = plugin.status === 'failed' || browserError !== null

  return (
    <div className="space-y-3">
      <p className={`text-sm ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
        {plugin.kind === 'extension' ? `${t('localExtension')} · ` : ''}
        {plugin.status === 'disabled'
          ? t('disabledByPi')
          : failed
            ? t('notLoaded')
            : plugin.status === 'available'
              ? t('discovered')
              : t('active')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {browserError && plugin.pluginName ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || browserRetryPending}
            onClick={() => onAction('retry-browser')}
          >
            {t('retry')}
          </Button>
        ) : null}
        {plugin.updateAvailable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || pending}
            onClick={() => onAction('update')}
          >
            {t('update')}
          </Button>
        ) : null}
        {phase === 'failed' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || pending}
            onClick={() => onAction('retry')}
          >
            {t('retry')}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={reloadDisabled}
          aria-label={t('reloadSource', { name: displayName })}
          onClick={() => onAction('reload')}
        >
          {t('reloadOne')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          disabled={disabled || pending || plugin.kind === 'extension'}
          title={plugin.kind === 'extension' ? t('localSourceHelp') : undefined}
          onClick={() => onAction('remove')}
        >
          <Trash2Icon data-icon="inline-start" />
          {t('remove')}
        </Button>
      </div>
      {plugin.operation ? (
        <div
          className={`flex items-start gap-2 text-sm ${phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
          role="status"
        >
          {phase !== 'failed' && phase !== 'waiting' ? (
            <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin" />
          ) : null}
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {t(`phase_${phase}`)}
            {plugin.operation.message ? `：${plugin.operation.message}` : ''}
          </span>
        </div>
      ) : null}
      {sourceError && !duplicateError ? (
        <p className="whitespace-pre-wrap text-sm text-destructive [overflow-wrap:anywhere]">
          {sourceError}
        </p>
      ) : null}
      {browserError ? (
        <p className="whitespace-pre-wrap text-sm text-destructive [overflow-wrap:anywhere]">
          {browserError}
        </p>
      ) : null}
    </div>
  )
}
