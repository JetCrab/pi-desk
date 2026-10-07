'use client'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
  RefreshCwIcon,
  XIcon
} from 'lucide-react'
import {
  L4AppDialogRoot,
  L4AppDialogContent,
  L4AppDialogTitle,
  L4AppDialogDescription
} from '@client/l4_foundation/ui/l4-app-dialog'
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
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { createL2ProjectPreviewOwner } from './l2-project-preview-biz'
import { L2ProjectHistoryView } from './views/l2-project-history-view'
import {
  loadL2ProjectPreviewGlobal,
  openL2ProjectPreviewProject,
  saveL2ProjectPreviewGlobal,
  saveL2ProjectPreviewProject,
  type L2ProjectPreviewGlobal,
  type L2ProjectPreviewProject
} from './l2-project-preview-storage'

export function L2ProjectPreviewDialog({
  clientId,
  cwd,
  onClose
}: {
  clientId: string
  cwd: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('projectHistory')
  const toast = useL4AppToast()
  const [initialGlobal] = useState(loadL2ProjectPreviewGlobal)
  const [global, setGlobal] = useState(initialGlobal)
  const updateGlobal = useCallback((change: Partial<L2ProjectPreviewGlobal>): void => {
    setGlobal((current) => ({ ...current, ...change }))
    saveL2ProjectPreviewGlobal({ ...loadL2ProjectPreviewGlobal(), ...change })
  }, [])
  const [saved] = useState(() => openL2ProjectPreviewProject(cwd))
  const [owner] = useState(() =>
    createL2ProjectPreviewOwner(
      clientId,
      cwd,
      (text) => toast.show({ level: 'info', title: text }),
      saved,
      initialGlobal
    )
  )
  const { files, git, history } = owner
  useSyncExternalStore(files.subscribe, files.getRevision, files.getRevision)
  const gitRevision = useSyncExternalStore(git.subscribe, git.getRevision, git.getRevision)
  useSyncExternalStore(history.subscribe, history.getRevision, history.getRevision)
  const { directoryOpen, gitOpen, gitMaximized, maximized } = global
  const [page, setPage] = useState<'files' | 'code' | 'git'>(saved?.page ?? 'files')
  const [size, setSize] = useState({ width: 1200, height: 800 })
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [historyPane, setHistoryPane] = useState<'log' | 'files'>(saved?.historyPane ?? 'log')
  const live = useRef<object | null>(null)
  const saveCurrent = useRef<() => void>(() => undefined)
  const narrow = size.width < 900
  const stacked = narrow || size.height < 680
  const projectName = cwd.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? cwd
  const gitState = git.getWorkspace(cwd)!
  const repositories = gitState.snapshot.repositories
  const state = files.state
  const diffPath = state.activeDiff
    ? [state.activeDiff.repositoryRoot, state.activeDiff.path].filter(Boolean).join('/')
    : null
  useEffect(() => {
    saveCurrent.current = (): void => {
      const currentGit = git.getWorkspace(cwd)!
      const currentHistory = history.state
      const snapshot: L2ProjectPreviewProject = {
        page,
        historyPane,
        tabs: [...files.state.tabs],
        activePath: files.state.activePath,
        ...files.getBrowsingDocumentSettings(),
        expandedPaths: [...files.state.expandedPaths].slice(0, 500),
        treeScrollTop: files.state.treeScrollTop,
        searchQuery: files.state.search.query.slice(0, 200),
        changesOnly: currentGit.changesOnly,
        expandedRepositories: [...currentGit.expandedRepositories].slice(0, 100),
        history: {
          repositoryRoot: currentHistory.repositoryRoot,
          mode: currentHistory.mode,
          tip: currentHistory.tip,
          base: currentHistory.base,
          target: currentHistory.target,
          strategy: currentHistory.strategy,
          query: currentHistory.query.slice(0, 200),
          author: currentHistory.author.slice(0, 200),
          selectedCommit: currentHistory.selectedCommit,
          selectedChangePath: currentHistory.selectedChangePath,
          logScroll: history.scroll.log,
          changesScroll: history.scroll.changes
        },
        activeDiff: files.state.activeDiff
          ? {
              repositoryRoot: files.state.activeDiff.repositoryRoot,
              path: files.state.activeDiff.path,
              ...(files.state.activeDiff.comparison
                ? { comparison: files.state.activeDiff.comparison }
                : {})
            }
          : null
      }
      saveL2ProjectPreviewProject(cwd, snapshot)
    }
  }, [cwd, files, git, history, historyPane, page])

  useEffect(() => {
    const token = {}
    live.current = token
    owner.restore()
    void files.ensureRoot()
    void git.ensureSnapshot(cwd)
    let lastFocus = Date.now()
    const focus = (): void => {
      if (Date.now() - lastFocus < 5000) return
      lastFocus = Date.now()
      void git.refreshSnapshot(cwd)
    }
    window.addEventListener('focus', focus)
    const saveOnLeave = (): void => saveCurrent.current()
    window.addEventListener('pagehide', saveOnLeave)
    return () => {
      live.current = null
      window.removeEventListener('focus', focus)
      window.removeEventListener('pagehide', saveOnLeave)
      queueMicrotask(() => {
        if (live.current === null) {
          saveCurrent.current()
          owner.dispose()
        }
      })
    }
  }, [cwd, files, git, owner])
  useEffect(() => {
    if (!container) return
    // Portal 的 DOM 可能晚于外层 effect；跟随实际节点绑定与释放。
    const observer = new ResizeObserver(() =>
      setSize({ width: container.clientWidth, height: container.clientHeight })
    )
    observer.observe(container)
    return () => observer.disconnect()
  }, [container])
  useEffect(() => {
    if (!gitOpen || !repositories.length) return
    if (repositories.some((repository) => repository.root === history.state.repositoryRoot)) return
    const active = state.activeDiff
      ? [state.activeDiff.repositoryRoot, state.activeDiff.path].filter(Boolean).join('/')
      : state.activePath
    const belonging = active
      ? [...repositories]
          .sort((left, right) => right.root.length - left.root.length)
          .find((repository) => !repository.root || active.startsWith(`${repository.root}/`))
      : null
    history.setRepository(
      belonging?.root ??
        repositories.find((item) => item.root === '')?.root ??
        repositories[0]!.root
    )
  }, [gitOpen, gitRevision, history, repositories, state.activeDiff, state.activePath])

  useEffect(
    () =>
      git.subscribe(() => {
        const treeLayout = git.getWorkspace(cwd)?.layout
        if (treeLayout && treeLayout !== global.treeLayout) updateGlobal({ treeLayout })
      }),
    [cwd, git, global.treeLayout, updateGlobal]
  )

  const openGit = (root?: string): void => {
    updateGlobal({ gitOpen: true })
    setPage('git')
    if (root !== undefined) history.setRepository(root)
  }
  const refresh = (): void => {
    files.refreshTree()
    void git.refreshSnapshot(cwd)
    if (state.activeDiff) files.reloadDiff()
    else if (state.activePath) files.reloadFile(state.activePath)
    if (gitOpen) history.refresh()
  }
  const fileTree = (
    <L3ProjectFileBrowser
      cwd={cwd}
      projectName={projectName}
      runtime={files}
      gitRuntime={git}
      onOpenGitBranches={openGit}
      onFileOpened={() => setPage('code')}
    />
  )
  const code = (
    <div className="flex size-full min-h-0 min-w-0 flex-col">
      <L3ProjectFileTabs
        paths={state.tabs}
        activePath={state.activePath}
        diffPath={diffPath}
        mobile={narrow}
        onActivate={(path) => files.openFile(path)}
        onClose={(path, scope) => files.closeTabs(path, scope)}
      />
      <L3ProjectDocumentView
        runtime={files}
        compact={size.width < 1100 || narrow}
        onEscape={onClose}
      />
    </div>
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
    <L4AppDialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <L4AppDialogContent
        ref={setContainer}
        showCloseButton={false}
        data-testid="project-preview-dialog"
        className={cn(
          'h-[min(94dvh,1080px)] w-[min(96dvw,1600px)] max-w-none gap-0 p-0',
          maximized && 'h-dvh max-h-none w-dvw rounded-none',
          'max-sm:h-dvh max-sm:max-h-none max-sm:w-dvw max-sm:rounded-none'
        )}
      >
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-3 py-2 pt-[max(8px,env(safe-area-inset-top))]">
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
          <div className="min-w-0 flex-1">
            <L4AppDialogTitle className="truncate" title={cwd}>
              {projectName}
            </L4AppDialogTitle>
            <p className="truncate text-xs text-muted-foreground" title={cwd}>
              {cwd}
            </p>
          </div>
          <L4AppDialogDescription className="sr-only">
            {t('previewDescription')}
          </L4AppDialogDescription>
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
          {!narrow ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t(maximized ? 'restoreWindow' : 'maximizeWindow')}
              onClick={() => updateGlobal({ maximized: !maximized })}
            >
              {maximized ? (
                <Minimize2Icon className="size-4" />
              ) : (
                <Maximize2Icon className="size-4" />
              )}
            </Button>
          ) : null}
          <Button size="icon-sm" variant="ghost" aria-label={t('closePreview')} onClick={onClose}>
            <XIcon className="size-4" />
          </Button>
        </header>
        {gitState.snapshot.error ? (
          <p role="alert" className="shrink-0 border-b px-3 py-2 text-sm text-destructive">
            {gitState.snapshot.error}
          </p>
        ) : null}
        {stacked ? (
          <>
            <div
              className="flex shrink-0 gap-1 border-b px-2 py-1"
              role="group"
              aria-label={t('previewArea')}
            >
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
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
