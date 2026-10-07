'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CircleAlertIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  Minimize2Icon,
  MoreHorizontalIcon,
  PanelBottomCloseIcon,
  PanelBottomIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PlusIcon,
  TerminalIcon,
  XIcon
} from 'lucide-react'
import type { L2TerminalSummary } from '@common/l2_biz/terminal/l2-terminal-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@client/l4_foundation/ui/shadcn/dropdown-menu'
import { cn } from '@client/l4_foundation/lib/l4-utils'

export function getL2TerminalTitle(terminal: L2TerminalSummary): string {
  if (terminal.title) return terminal.title
  const shell = terminal.shell
    .split(/[\\/]/)
    .pop()!
    .replace(/\.exe$/i, '')
  return /^(powershell|pwsh)$/i.test(shell) ? 'PowerShell' : shell
}

export function L2TerminalToolbar({
  terminals,
  selectedId,
  tabStates,
  ready,
  busy,
  opening,
  mobile,
  right,
  maximized,
  onSelect,
  onClose,
  onCreate,
  onDock,
  onMaximize,
  onCollapse
}: {
  terminals: readonly L2TerminalSummary[]
  selectedId: string | null
  tabStates: Readonly<Record<string, { error: string | null }>>
  ready: boolean
  busy: boolean
  opening: boolean
  mobile: boolean
  right: boolean
  maximized: boolean
  onSelect: (id: string) => void
  onClose: (terminal: L2TerminalSummary) => void
  onCreate: () => void
  onDock: () => void
  onMaximize: () => void
  onCollapse: () => void
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const toolbar = useRef<HTMLElement>(null)
  const [compact, setCompact] = useState(true)
  useEffect(() => {
    const element = toolbar.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setCompact(entry.contentRect.width < 480)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, id: string): void => {
    const index = terminals.findIndex((terminal) => terminal.terminalId === id)
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % terminals.length
        : event.key === 'ArrowLeft'
          ? (index + terminals.length - 1) % terminals.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? terminals.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    const nextId = terminals[next].terminalId
    onSelect(nextId)
    document.getElementById(`terminal-tab-${nextId}`)?.focus({ preventScroll: true })
  }
  const DockIcon = right ? PanelBottomIcon : PanelRightIcon
  const MaximizeIcon = maximized ? Minimize2Icon : Maximize2Icon
  const CollapseIcon = right ? PanelRightCloseIcon : PanelBottomCloseIcon
  const dockLabel = t(right ? 'terminalDockBottom' : 'terminalDockRight')
  const maximizeLabel = t(maximized ? 'terminalRestore' : 'terminalMaximize')

  return (
    <header
      ref={toolbar}
      className="flex min-h-9 shrink-0 items-center gap-1 border-b bg-muted px-2 pt-[env(safe-area-inset-top)] lg:pt-0"
    >
      {!mobile ? <TerminalIcon className="mr-1 size-4 shrink-0 text-muted-foreground" /> : null}
      <div
        role="tablist"
        aria-label={t('terminalTabs')}
        className="flex min-w-0 shrink overflow-x-auto"
      >
        {terminals.map((terminal) => {
          const selected = terminal.terminalId === selectedId
          const title = getL2TerminalTitle(terminal)
          const error = tabStates[terminal.terminalId]?.error
          return (
            <div
              key={terminal.terminalId}
              role="presentation"
              className={cn(
                'flex min-h-8 shrink-0 items-center border-b-2',
                selected
                  ? 'border-foreground bg-accent text-foreground'
                  : 'border-transparent text-muted-foreground'
              )}
            >
              <button
                type="button"
                role="tab"
                id={`terminal-tab-${terminal.terminalId}`}
                aria-controls={`terminal-screen-${terminal.terminalId}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={`${title}\n${terminal.cwd}${terminal.status === 'exited' ? `\n${t('terminalExitCode', { code: terminal.exitCode ?? '—' })}` : ''}${error ? `\n${error}` : ''}`}
                data-testid="terminal-tab"
                data-terminal-id={terminal.terminalId}
                onClick={() => onSelect(terminal.terminalId)}
                onKeyDown={(event) => navigate(event, terminal.terminalId)}
                className="flex min-h-8 min-w-0 cursor-pointer items-center gap-1 px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="max-w-48 truncate">{title}</span>
                {error ? (
                  <CircleAlertIcon
                    className="size-3.5 shrink-0 text-destructive"
                    aria-label={error}
                  />
                ) : null}
                {terminal.status === 'exited' ? (
                  <span className="text-xs text-muted-foreground">· {t('terminalExited')}</span>
                ) : null}
              </button>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!ready || busy}
                aria-label={t('terminalCloseTab', { title })}
                title={t('terminalCloseTab', { title })}
                data-testid="terminal-tab-close"
                data-terminal-id={terminal.terminalId}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(terminal)
                }}
              >
                <XIcon className="size-4" />
              </Button>
            </div>
          )
        })}
        {opening && terminals.length > 0 ? (
          <span
            role="status"
            className="flex min-h-8 shrink-0 items-center px-2 text-sm text-muted-foreground"
          >
            {t('terminalOpening')}
          </span>
        ) : null}
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        className="shrink-0"
        disabled={!ready || busy}
        aria-label={t('newTerminal')}
        title={t('newTerminal')}
        data-testid="terminal-new"
        onClick={onCreate}
      >
        {opening ? (
          <LoaderCircleIcon className="size-4 motion-safe:animate-spin" aria-hidden />
        ) : (
          <PlusIcon className="size-4" />
        )}
      </Button>
      <div className="min-w-0 flex-1" />
      {!mobile && compact ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="shrink-0"
                aria-label={t('terminalActions')}
                data-testid="terminal-actions"
              />
            }
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="terminal-dock" onClick={onDock}>
              <DockIcon />
              {dockLabel}
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="terminal-maximize" onClick={onMaximize}>
              <MaximizeIcon />
              {maximizeLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {!mobile && !compact ? (
        <>
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            aria-label={dockLabel}
            title={dockLabel}
            data-testid="terminal-dock"
            onClick={onDock}
          >
            <DockIcon className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="shrink-0"
            aria-label={maximizeLabel}
            title={maximizeLabel}
            data-testid="terminal-maximize"
            onClick={onMaximize}
          >
            <MaximizeIcon className="size-4" />
          </Button>
        </>
      ) : null}
      <Button
        size="icon-sm"
        variant="ghost"
        className="shrink-0"
        aria-label={t('terminalCollapse')}
        title={t('terminalCollapse')}
        data-testid="terminal-collapse"
        onClick={onCollapse}
      >
        <CollapseIcon className="size-4" />
      </Button>
    </header>
  )
}
