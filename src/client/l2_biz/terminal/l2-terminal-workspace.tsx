'use client'

import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircleIcon, TerminalIcon } from 'lucide-react'
import { preloadL4TerminalRenderer } from '@client/l4_foundation/terminal/l4-terminal-renderer'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup
} from '@client/l4_foundation/ui/shadcn/resizable'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import type { L2TerminalBiz } from './l2-terminal-biz'
import { useL2TerminalLayout } from './hooks/l2-terminal-layout'
import { L2TerminalScreen } from './views/l2-terminal-screen'
import { L2TerminalToolbar } from './views/l2-terminal-toolbar'
import styles from './l2-terminal-workspace.module.css'

export function L2TerminalWorkspace({
  biz,
  mobile,
  children
}: {
  biz: L2TerminalBiz
  mobile: boolean
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const state = useSyncExternalStore(biz.subscribe, biz.getSnapshot, biz.getSnapshot)
  const hasTerminals = state.terminals.length > 0
  const expanded = state.expanded
  useEffect(() => {
    if (!state.opening) return
    void preloadL4TerminalRenderer().catch((cause: unknown) => {
      console.warn('[Pi Desk][Terminal] 终端依赖预加载失败，将在画面加载时重试', { cause })
    })
  }, [state.opening])
  const {
    root,
    terminalPanel,
    preferences,
    right,
    maximized,
    pageVisible,
    setDock,
    toggleMaximized,
    saveSize,
    collapse,
    expand
  } = useL2TerminalLayout(biz, mobile, expanded)
  const selected = state.terminals.find((item) => item.terminalId === state.selectedId)
  const chatHidden = expanded && (mobile || maximized)

  return (
    <div
      ref={root}
      className={cn('relative flex size-full min-h-0 min-w-0', right ? 'flex-row' : 'flex-col')}
      data-terminal-dock={mobile ? 'mobile' : preferences.dock}
    >
      <ResizablePanelGroup
        orientation={right ? 'horizontal' : 'vertical'}
        disabled={mobile || !expanded || maximized}
        className="min-h-0 min-w-0 flex-1"
        onLayoutChanged={(_layout, meta) => {
          if (meta.isUserInteraction) saveSize()
        }}
      >
        <ResizablePanel
          id="terminal-workspace-chat"
          minSize={chatHidden || mobile ? 0 : 120}
          defaultSize="100%"
          aria-hidden={chatHidden || undefined}
          inert={chatHidden || undefined}
          className="flex min-h-0 min-w-0 !overflow-hidden"
        >
          {children}
        </ResizablePanel>
        <ResizableHandle
          disabled={mobile || !expanded || maximized}
          aria-label={t('terminalResize')}
          aria-hidden={!expanded || maximized || mobile || undefined}
          className={cn(
            mobile || !expanded || maximized
              ? 'hidden'
              : right
                ? 'cursor-col-resize'
                : 'cursor-row-resize'
          )}
        />
        <ResizablePanel
          id="terminal-workspace-panel"
          panelRef={terminalPanel}
          defaultSize={0}
          minSize={expanded ? (mobile || maximized ? '100%' : right ? 240 : 160) : 0}
          maxSize={!expanded ? 0 : mobile || maximized ? '100%' : '85%'}
          className="flex min-h-0 min-w-0 !overflow-hidden"
          aria-hidden={!expanded || undefined}
          inert={!expanded || undefined}
        >
          <section
            className={cn(
              'flex size-full min-h-0 min-w-0 flex-col bg-background',
              mobile && styles.mobile,
              !expanded && 'invisible'
            )}
            aria-label={t('terminal')}
            data-testid="terminal-panel"
          >
            <L2TerminalToolbar
              terminals={state.terminals}
              selectedId={state.selectedId}
              tabStates={state.tabs}
              ready={state.ready}
              busy={state.busy}
              opening={state.opening}
              mobile={mobile}
              right={right}
              maximized={maximized}
              onSelect={biz.select}
              onClose={(terminal) => {
                void biz.remove(terminal.terminalId)
              }}
              onCreate={() => {
                void biz.open(selected?.cwd).catch(() => undefined)
              }}
              onDock={setDock}
              onMaximize={toggleMaximized}
              onCollapse={collapse}
            />
            {state.error ? (
              <div
                role="alert"
                className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-sm text-destructive"
              >
                <span className="min-w-0 flex-1 break-words">{state.error}</span>
                {hasTerminals ? (
                  <Button size="sm" variant="ghost" disabled={!state.ready} onClick={biz.retry}>
                    {t('retry', { ns: 'common' })}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {state.opening && !hasTerminals && !state.error ? (
              <div
                role="status"
                className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
              >
                <LoaderCircleIcon
                  className="size-4 shrink-0 motion-safe:animate-spin"
                  aria-hidden
                />
                <span>{t('terminalOpening')}</span>
              </div>
            ) : null}
            {state.terminals.map((terminal) =>
              state.tabs[terminal.terminalId]?.retained ? (
                <L2TerminalScreen
                  key={terminal.terminalId}
                  terminalId={terminal.terminalId}
                  biz={biz}
                  mobile={mobile}
                  visible={expanded && pageVisible && terminal.terminalId === state.selectedId}
                />
              ) : (
                <div
                  key={terminal.terminalId}
                  role="tabpanel"
                  id={`terminal-screen-${terminal.terminalId}`}
                  aria-labelledby={`terminal-tab-${terminal.terminalId}`}
                  hidden
                />
              )
            )}
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
      {hasTerminals && !expanded ? (
        <button
          type="button"
          data-testid="terminal-collapsed-bar"
          onClick={expand}
          aria-label={t('terminalExpand', { count: state.terminals.length })}
          className={cn(
            'flex shrink-0 cursor-pointer items-center justify-center gap-2 border-t bg-muted text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            right
              ? 'w-9 flex-col border-l border-t-0'
              : 'min-h-8 px-3 pb-[env(safe-area-inset-bottom)] lg:pb-0'
          )}
        >
          <TerminalIcon className="size-4" />
          <span>{state.terminals.length}</span>
        </button>
      ) : null}
    </div>
  )
}
