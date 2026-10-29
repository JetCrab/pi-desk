'use client'

import { LoaderCircleIcon, RefreshCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import type { L2NativeUiState } from './l2-native-ui-biz'
import { L2NativeUiNotices } from './l2-native-ui-notices'

export function L2NativeUiMcp({
  available,
  state,
  disabled,
  onExecute,
  onRetryConnection
}: {
  available: boolean
  state: L2NativeUiState
  disabled: boolean
  onExecute: (args: string) => void
  onRetryConnection: () => void
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const commandDisabled =
    !state.ready || state.commandPending !== null || state.snapshot.requests.length > 0
  return (
    <div className="space-y-4">
      {available ? (
        <section aria-label={t('mcpSessionActions')} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={commandDisabled}
              onClick={() => onExecute('')}
            >
              <RefreshCwIcon />
              {t('mcpRefreshStatus')}
            </Button>
            {(['login', 'reconnect', 'logout'] as const).map((action) => (
              <Button
                key={action}
                type="button"
                variant="ghost"
                size="sm"
                disabled={commandDisabled || disabled}
                onClick={() => onExecute(action)}
              >
                {t(
                  action === 'login'
                    ? 'mcpLogin'
                    : action === 'reconnect'
                      ? 'mcpReconnect'
                      : 'mcpLogout'
                )}
              </Button>
            ))}
          </div>
          {state.commandPending ? (
            <p
              role="status"
              className="flex items-center gap-2 wrap-anywhere text-sm text-muted-foreground"
            >
              <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
              {t('mcpExecuting')} {state.commandPending}
            </p>
          ) : disabled ? (
            <p className="text-sm text-muted-foreground">{t('mcpChangesWhenIdle')}</p>
          ) : null}
          {state.error || !state.ready ? (
            <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 wrap-anywhere">
                {state.error ?? t('nativeUiDisconnected')}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={state.refreshing}
                onClick={onRetryConnection}
              >
                {t('nativeUiRetry')}
              </Button>
            </div>
          ) : null}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{t('mcpCommandUnavailable')}</p>
      )}
      <section className="border-t pt-4">
        <h3 className="mb-1 text-sm font-medium">{t('nativeCommandOutput')}</h3>
        <p className="mb-3 text-sm text-muted-foreground">{t('mcpNoticesDescription')}</p>
        <L2NativeUiNotices notices={[...state.notices].reverse()} />
      </section>
    </div>
  )
}
