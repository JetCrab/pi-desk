'use client'

import {
  Maximize2Icon,
  MenuIcon,
  Minimize2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  RefreshCwIcon,
  TerminalIcon
} from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import {
  L3ProjectDocumentView,
  type L3ProjectDocumentHandle
} from '@client/l3_modules/project-files/l3-project-document-view'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import type { L2GitWorkspaceRuntime } from '../git-workspace/l2-git-workspace-runtime'
import type { L2GitBranchPickerTarget } from '../git-workspace/l2-git-workspace-model'
import type { L2FileWorkspaceRuntime } from './l2-file-workspace-runtime'
import { L2ProjectFileBrowser } from './l2-project-file-browser'
import { L2FileWorkspaceTabs } from './l2-file-workspace-tabs'

interface L2FileWorkspaceViewProps {
  workSession: L2WorkSessionListItem
  runtime: L2FileWorkspaceRuntime
  gitRuntime: L2GitWorkspaceRuntime
  mobile: boolean
  presentation: 'split' | 'single' | 'expanded'
  onOpenGitBranches: (target: L2GitBranchPickerTarget) => void
  onOpenSidebar: () => void
  onHide: () => void
  onExpand: () => void
  onSwitchPane: () => void
  onOpenTerminal?: (cwd: string) => void
}

export function L2FileWorkspaceView({
  workSession,
  runtime,
  gitRuntime,
  mobile,
  presentation,
  onOpenGitBranches,
  onOpenSidebar,
  onHide,
  onExpand,
  onSwitchPane,
  onOpenTerminal
}: L2FileWorkspaceViewProps): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  useSyncExternalStore(runtime.subscribe, runtime.getRevision, runtime.getRevision)
  const { workId, cwd, projectName } = workSession
  const workspace = runtime.getWorkspace(workId)
  const [directoryOpen, setDirectoryOpen] = useState(true)
  const documentRef = useRef<L3ProjectDocumentHandle>(null)
  const expanded = presentation === 'expanded'
  const showDirectory = expanded && directoryOpen && !mobile
  const compact = mobile || presentation === 'single'
  if (!workspace) return null
  const { activeDiff, activePath } = workspace
  const diffPath = activeDiff
    ? [activeDiff.repositoryRoot, activeDiff.path].filter(Boolean).join('/')
    : null
  const escape = (): void => {
    if (runtime.getExpandedWorkId() === workId) onExpand()
    else onHide()
  }
  const title = (diffPath ?? activePath ?? t('file')).replaceAll('\\', '/').split('/').at(-1)
  return (
    <section
      data-testid="file-workspace"
      data-file-work-id={workId}
      className="relative isolate flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background outline-none"
      aria-label={t('fileViewer', { name: projectName })}
      tabIndex={-1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) documentRef.current?.focus()
      }}
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          event.repeat ||
          event.nativeEvent.isComposing
        )
          return
        const target = event.target instanceof Element ? event.target : null
        if (
          target?.closest('.monaco-editor, [role="menu"]') ||
          event.currentTarget.querySelector('.viewer-fullscreen-exit')
        )
          return
        const dialog = target?.closest('[role="dialog"]')
        if (dialog && dialog !== event.currentTarget.closest('[role="dialog"]')) return
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
        event.preventDefault()
        event.stopPropagation()
        escape()
      }}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b bg-muted px-3 pt-[env(safe-area-inset-top)]">
        {mobile || presentation === 'single' ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('showSessionMenu')}
            onClick={onOpenSidebar}
          >
            <MenuIcon className="size-5" />
          </Button>
        ) : null}
        {expanded && !mobile ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(directoryOpen ? 'collapseProjectTree' : 'expandProjectTree')}
            onClick={() => setDirectoryOpen((value) => !value)}
          >
            {directoryOpen ? (
              <PanelLeftCloseIcon className="size-4" />
            ) : (
              <PanelLeftOpenIcon className="size-4" />
            )}
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <p
            className="truncate text-sm font-semibold"
            title={diffPath ?? activePath ?? projectName}
          >
            {title}
            {activeDiff ? ' · Diff' : ''}
          </p>
          <p
            className="truncate text-xs text-muted-foreground"
            title={`${projectName} · ${diffPath ?? activePath ?? cwd}`}
          >
            {projectName}
            {(diffPath ?? activePath) ? ` · ${diffPath ?? activePath}` : ''}
          </p>
        </div>
        {!mobile ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(expanded ? 'exitExpanded' : 'expandFile')}
            title={t(expanded ? 'exitExpanded' : 'expandFile')}
            data-file-expand-trigger=""
            onClick={onExpand}
          >
            {expanded ? <Minimize2Icon className="size-4" /> : <Maximize2Icon className="size-4" />}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          aria-label={t(compact ? 'returnChat' : 'hideFile')}
          onClick={onHide}
        >
          <PanelRightCloseIcon className="size-4" />
          {t(compact ? 'chat' : 'collapse')}
        </Button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1">
        {showDirectory ? (
          <aside
            className="flex min-h-0 w-[clamp(200px,22%,280px)] shrink-0 flex-col border-r bg-sidebar"
            aria-label={t('browseProject')}
          >
            <div className="flex min-h-9 shrink-0 items-center border-b px-3">
              <span className="flex-1 text-xs font-medium">{t('fileWorkspaceTitle')}</span>
              {onOpenTerminal ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('newTerminal')}
                  title={t('newTerminal')}
                  onClick={() => onOpenTerminal(cwd)}
                >
                  <TerminalIcon className="size-4" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('refreshFiles')}
                onClick={() => {
                  runtime.refreshTree(workId)
                  void gitRuntime.refreshSnapshot(cwd)
                }}
              >
                <RefreshCwIcon className="size-4" />
              </Button>
            </div>
            <L2ProjectFileBrowser
              workId={workId}
              cwd={cwd}
              projectName={projectName}
              runtime={runtime}
              gitRuntime={gitRuntime}
              onOpenGitBranches={onOpenGitBranches}
            />
          </aside>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <L2FileWorkspaceTabs
            paths={workspace.tabs}
            activePath={activePath}
            diffPath={diffPath}
            mobile={mobile}
            onActivate={(path) => runtime.activateFile(workId, path)}
            onClose={(path, scope) => runtime.closeTabs(workId, path, scope)}
          />
          <L3ProjectDocumentView
            ref={documentRef}
            runtime={runtime.getFileRuntime(workId)}
            compact={compact}
            onEscape={escape}
            onSwitchPane={onSwitchPane}
          />
        </div>
      </div>
    </section>
  )
}
