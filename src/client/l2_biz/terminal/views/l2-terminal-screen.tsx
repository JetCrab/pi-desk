'use client'

import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  LoaderCircleIcon
} from 'lucide-react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import type { L2TerminalBiz } from '../l2-terminal-biz'
import { useL2TerminalScreen } from '../hooks/l2-terminal-screen'
import styles from '../l2-terminal-workspace.module.css'

export function L2TerminalScreen({
  biz,
  mobile,
  terminalId,
  visible
}: {
  biz: L2TerminalBiz
  mobile: boolean
  terminalId: string
  visible: boolean
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const state = useSyncExternalStore(biz.subscribe, biz.getSnapshot, biz.getSnapshot)
  const screen = useL2TerminalScreen(biz, terminalId, visible)
  const { container, loadError, loading, control } = screen
  const tab = state.tabs[terminalId]
  const terminal = state.terminals.find((item) => item.terminalId === terminalId)
  const disabled = terminal?.status !== 'running' || !state.ready || tab?.syncing || loading
  const error = loadError ?? tab?.error
  const status = error
    ? null
    : !state.ready
      ? t('terminalReconnecting')
      : loading
        ? t('terminalOpening')
        : tab?.syncing
          ? t('terminalSyncing')
          : null

  return (
    <div
      role="tabpanel"
      id={`terminal-screen-${terminalId}`}
      aria-labelledby={`terminal-tab-${terminalId}`}
      aria-hidden={!visible || undefined}
      hidden={!visible}
      data-testid="terminal-tabpanel"
      data-terminal-id={terminalId}
      className={cn('relative min-h-0 min-w-0 flex-1 flex-col', visible ? 'flex' : 'hidden')}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={cn(
            styles.viewport,
            'min-h-0 min-w-0 flex-1 overflow-auto p-2',
            loading && 'invisible'
          )}
          data-testid="terminal-viewport"
          aria-busy={Boolean(status)}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div ref={container} className={styles.canvas} aria-label={t('terminalScreen')} />
        </div>
        {status ? (
          <div
            role="status"
            className={cn(
              'pointer-events-none absolute flex items-center gap-2 text-muted-foreground',
              loading
                ? 'inset-0 justify-center text-sm'
                : 'right-3 top-2 rounded-md bg-background/95 px-2 py-1 text-xs'
            )}
          >
            <LoaderCircleIcon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
            <span>{status}</span>
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="absolute inset-x-2 top-2 flex items-center gap-2 rounded border bg-background px-3 py-2 text-sm text-destructive"
          >
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={!loadError && !state.ready}
              onClick={loadError ? screen.retry : biz.retry}
            >
              {t('retry', { ns: 'common' })}
            </Button>
          </div>
        ) : null}
      </div>
      {mobile ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t px-2 py-1 pb-[max(.25rem,env(safe-area-inset-bottom))]">
          <Button size="sm" variant="ghost" disabled={disabled} onClick={screen.focus}>
            {t('terminalInput')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => screen.key('escape')}
          >
            Esc
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => screen.key('tab')}
          >
            Tab
          </Button>
          <Button
            size="sm"
            variant={control ? 'secondary' : 'ghost'}
            aria-pressed={control}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={screen.toggleControl}
          >
            Ctrl
          </Button>
          {(
            [
              { key: 'left', Icon: ArrowLeftIcon },
              { key: 'up', Icon: ArrowUpIcon },
              { key: 'down', Icon: ArrowDownIcon },
              { key: 'right', Icon: ArrowRightIcon }
            ] as const
          ).map(({ key, Icon }) => (
            <Button
              key={key}
              variant="ghost"
              size="icon-sm"
              aria-label={t(`terminalKey${key}`)}
              disabled={disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => screen.key(key)}
            >
              <Icon className="size-4" />
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
