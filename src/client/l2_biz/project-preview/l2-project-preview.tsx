'use client'

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Columns2Icon,
  FileCode2Icon,
  FolderTreeIcon,
  GitBranchIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelBottomCloseIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RefreshCwIcon
} from 'lucide-react'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle
} from '@client/l4_foundation/ui/shadcn/resizable'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L3ProjectFileBrowser } from '@client/l3_modules/project-files/l3-project-file-browser'
import { L3ProjectFileTabs } from '@client/l3_modules/project-files/l3-project-file-tabs'
import { L3ProjectDocumentView } from '@client/l3_modules/project-files/l3-project-document-view'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import { useL2ProjectPreview } from './hooks/l2-use-project-preview'
import { L2ProjectHistoryView } from './views/l2-project-history-view'

const ignoreEscape = (): void => {}

export function L2ProjectPreview({
  clientId,
  cwd,
  title,
  actions,
  onEscape = ignoreEscape,
  onUnauthorized
}: {
  clientId: string
  cwd: string
  title?: ReactNode
  actions?: ReactNode
  onEscape?: () => void
  onUnauthorized?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('projectHistory')
  const toast = useL4AppToast()
  const {
    files,
    git,
    history,
    global,
    updateGlobal,
    page,
    setPage,
    historyPane,
    setHistoryPane,
    setContainer,
    narrow,
    stacked,
    width,
    changeRowHeight,
    openGit,
    refresh
  } = useL2ProjectPreview(clientId, cwd, onUnauthorized)
  const { directoryOpen, gitOpen, gitMaximized } = global
  const projectName = cwd.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? cwd
  const gitState = git.getWorkspace(cwd)!
  const repositories = gitState.snapshot.repositories
  const state = files.state
  const fileTree = (
    <L3ProjectFileBrowser
      cwd={cwd}
      projectName={projectName}
      showRootTitle={false}
      runtime={files}
      gitRuntime={git}
      onOpenGitBranches={openGit}
      onFileOpened={() => setPage('code')}
    />
  )
  const code = (
    <L3ProjectDocumentView
      runtime={files}
      gitRuntime={git}
      compact={width < 1100}
      onEscape={onEscape}
      renderHeader={(actions) => (
        <L3ProjectFileTabs
          cwd={cwd}
          gitRuntime={git}
          paths={state.tabs}
          activePath={state.activePath}
          diffs={state.diffs}
          activeDiff={state.activeDiff}
          mobile={narrow}
          actions={actions}
          onActivate={(target) => {
            if (typeof target === 'string') files.openFile(target)
            else files.openDiff(target.repositoryRoot, target.path, target.comparison)
          }}
          onClose={(path, scope) => files.closeTabs(path, scope)}
        />
      )}
    />
  )
  const gitView = (
    <div className="flex size-full min-h-0 min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted px-3">
        <GitBranchIcon className="size-4" />
        <span className="flex-1 text-sm font-medium">Git</span>
        {!stacked ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t(gitMaximized ? 'restoreGit' : 'maximizeGit')}
            onClick={() => updateGlobal({ gitMaximized: !gitMaximized })}
          >
            {gitMaximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('collapseGit')}
          onClick={() => {
            updateGlobal({ gitOpen: false, gitMaximized: false })
            setPage('code')
          }}
        >
          <PanelBottomCloseIcon className="size-4" />
        </Button>
      </div>
      {repositories.length ? (
        <L2ProjectHistoryView
          state={history.state}
          cwd={cwd}
          changeRows={history.getChangeRows()}
          changeRowHeight={changeRowHeight}
          onSelectChange={(path) => history.selectChange(path)}
          onToggleDirectory={(path) => history.toggleChangeDirectory(path)}
          onReveal={(path, type) => files.revealFile(path, type)}
          repositories={repositories}
          projectName={projectName}
          narrow={narrow}
          mobilePane={historyPane}
          onMobilePane={setHistoryPane}
          scroll={history.scroll}
          onScroll={(pane, value) => history.setScroll(pane, value)}
          panelSizes={{ log: global.logSize, changes: global.changeSize }}
          onPanelSize={(panel, value) =>
            updateGlobal(panel === 'log' ? { logSize: value } : { changeSize: value })
          }
          onRepository={(root) => {
            history.setRepository(root)
            setHistoryPane('log')
          }}
          onMode={(mode) => history.setMode(mode)}
          onRevision={(field, value) => history.setRevision(field, value)}
          onStrategy={(strategy) => history.setStrategy(strategy)}
          onQuery={(query) => history.setQuery(query)}
          onAuthor={(author) => history.setAuthor(author)}
          onCommit={(oid, parent) => history.selectCommit(oid, parent)}
          onAggregate={() => history.showAggregate()}
          onMoreLog={() => history.loadMoreLog()}
          onMoreChanges={() => history.loadMoreChanges()}
          onOpenFile={(path) => {
            history.openChange(path)
            setPage('code')
            updateGlobal({ gitMaximized: false })
          }}
          onRefresh={() => history.refresh()}
          onCopy={(text) => {
            void copyL4BrowserText(text).then((ok) => {
              if (!ok) toast.error(t('copyFailed'))
            })
          }}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {gitState.snapshot.status === 'loading' || gitState.snapshot.status === 'idle'
            ? t('findingGit')
            : (gitState.snapshot.error ?? t('noGit'))}
        </p>
      )}
    </div>
  )
  const upper = (
    <ResizablePanelGroup
      key={directoryOpen ? 'tree-visible' : 'tree-hidden'}
      orientation="horizontal"
      defaultLayout={
        directoryOpen
          ? { 'project-tree': global.directorySize, 'project-code': 100 - global.directorySize }
          : undefined
      }
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction && layout['project-tree'] !== undefined)
          updateGlobal({ directorySize: layout['project-tree'] })
      }}
    >
      {directoryOpen ? (
        <ResizablePanel
          id="project-tree"
          defaultSize={`${global.directorySize}%`}
          minSize="180px"
          maxSize="40%"
        >
          {fileTree}
        </ResizablePanel>
      ) : null}
      {directoryOpen ? <ResizableHandle /> : null}
      <ResizablePanel id="project-code" minSize="40%">
        {code}
      </ResizablePanel>
    </ResizablePanelGroup>
  )

  return (
    <div
      ref={setContainer}
      className="flex size-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="project-preview"
    >
      <header className="flex min-h-9 shrink-0 items-center gap-1 bg-muted px-2 py-1 pt-[max(4px,env(safe-area-inset-top))]">
        {!stacked ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t(directoryOpen ? 'collapseDirectory' : 'expandDirectory')}
            onClick={() => updateGlobal({ directoryOpen: !directoryOpen })}
          >
            {directoryOpen ? (
              <PanelLeftCloseIcon className="size-4" />
            ) : (
              <PanelLeftOpenIcon className="size-4" />
            )}
          </Button>
        ) : null}
        <div className="flex min-w-0 flex-1 items-baseline gap-3" title={cwd}>
          <div className="min-w-0 shrink-0 max-w-[50%] max-sm:max-w-full max-sm:shrink">
            {title ?? <h1 className="truncate text-sm font-semibold">{projectName}</h1>}
          </div>
          <p className="min-w-0 truncate text-xs text-muted-foreground max-sm:hidden">{cwd}</p>
        </div>
        <Button
          size="sm"
          variant={gitOpen ? 'secondary' : 'ghost'}
          aria-pressed={gitOpen}
          onClick={() => openGit()}
        >
          <GitBranchIcon className="size-4" />
          <span className="max-sm:hidden">{t('gitRecords')}</span>
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={t('refreshPreview')} onClick={refresh}>
          <RefreshCwIcon className="size-4" />
        </Button>
        {actions}
      </header>
      {gitState.snapshot.error ? (
        <p role="alert" className="shrink-0 border-b px-3 py-2 text-sm text-destructive">
          {gitState.snapshot.error}
        </p>
      ) : null}
      {stacked ? (
        <>
          <div className="flex shrink-0 gap-1 px-2 py-1" role="group" aria-label={t('previewArea')}>
            <Button
              size="sm"
              variant={page === 'files' ? 'secondary' : 'ghost'}
              onClick={() => setPage('files')}
            >
              <FolderTreeIcon className="size-4" />
              {t('files')}
            </Button>
            <Button
              size="sm"
              variant={page === 'code' ? 'secondary' : 'ghost'}
              onClick={() => setPage('code')}
            >
              <FileCode2Icon className="size-4" />
              {t('code')}
            </Button>
            <Button
              size="sm"
              variant={page === 'git' ? 'secondary' : 'ghost'}
              onClick={() => openGit()}
            >
              <Columns2Icon className="size-4" />
              Git
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            {page === 'files' ? fileTree : page === 'git' ? gitView : code}
          </div>
        </>
      ) : gitMaximized && gitOpen ? (
        gitView
      ) : (
        <ResizablePanelGroup
          key={gitOpen ? 'git-visible' : 'git-hidden'}
          orientation="vertical"
          defaultLayout={
            gitOpen
              ? { 'project-main': 100 - global.gitSize, 'project-git': global.gitSize }
              : undefined
          }
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction && layout['project-git'] !== undefined)
              updateGlobal({ gitSize: layout['project-git'] })
          }}
        >
          <ResizablePanel
            id="project-main"
            defaultSize={gitOpen ? `${100 - global.gitSize}%` : '100%'}
            minSize="35%"
          >
            {upper}
          </ResizablePanel>
          {gitOpen ? <ResizableHandle /> : null}
          {gitOpen ? (
            <ResizablePanel id="project-git" defaultSize={`${global.gitSize}%`} minSize="300px">
              {gitView}
            </ResizablePanel>
          ) : null}
        </ResizablePanelGroup>
      )}
    </div>
  )
}
