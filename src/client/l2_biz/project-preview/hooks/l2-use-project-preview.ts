'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { createL2ProjectPreviewOwner, type L2ProjectPreviewOwner } from '../l2-project-preview-biz'
import {
  loadL2ProjectPreviewGlobal,
  openL2ProjectPreviewProject,
  saveL2ProjectPreviewGlobal,
  saveL2ProjectPreviewProject,
  type L2ProjectPreviewGlobal,
  type L2ProjectPreviewProject
} from '../l2-project-preview-storage'

function subscribePointer(listener: () => void): () => void {
  const media = window.matchMedia('(pointer: fine)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
function readFinePointer(): boolean {
  return window.matchMedia('(pointer: fine)').matches
}
function readServerPointer(): boolean {
  return false
}

type Page = 'files' | 'code' | 'git'
type HistoryPane = 'log' | 'files'
interface PreviewState extends Pick<L2ProjectPreviewOwner, 'files' | 'git' | 'history'> {
  global: L2ProjectPreviewGlobal
  updateGlobal: (change: Partial<L2ProjectPreviewGlobal>) => void
  page: Page
  setPage: (page: Page) => void
  historyPane: HistoryPane
  setHistoryPane: (pane: HistoryPane) => void
  setContainer: (element: HTMLDivElement | null) => void
  narrow: boolean
  stacked: boolean
  width: number
  changeRowHeight: number
  openGit: (root?: string) => void
  refresh: () => void
}

export function useL2ProjectPreview(
  clientId: string,
  cwd: string,
  refreshOnFocus: boolean,
  onUnauthorized?: () => void
): PreviewState {
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
      initialGlobal,
      { lazyHistory: !refreshOnFocus, onUnauthorized }
    )
  )
  const { files, git, history } = owner
  useSyncExternalStore(files.subscribe, files.getRevision, files.getRevision)
  const gitRevision = useSyncExternalStore(git.subscribe, git.getRevision, git.getRevision)
  useSyncExternalStore(history.subscribe, history.getRevision, history.getRevision)
  const [page, setPage] = useState<Page>(saved?.page ?? 'files')
  const [historyPane, setHistoryPane] = useState<HistoryPane>(saved?.historyPane ?? 'log')
  const [size, setSize] = useState({ width: 1200, height: 800 })
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const live = useRef(false)
  const saveCurrent = useRef<() => void>(() => undefined)
  const narrow = size.width < 900
  const stacked = narrow || size.height < 680
  const repositories = git.getWorkspace(cwd)!.snapshot.repositories
  const state = files.state
  const finePointer = useSyncExternalStore(subscribePointer, readFinePointer, readServerPointer)
  const changeRowHeight = finePointer ? 24 : 36

  useEffect(() => {
    history.setChangeRowHeight(changeRowHeight)
  }, [history, changeRowHeight])

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
        diffs: files.state.diffs.map(({ repositoryRoot, path, comparison }) => ({
          repositoryRoot,
          path,
          ...(comparison ? { comparison } : {})
        })),
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
    live.current = true
    owner.restore()
    void files.ensureRoot()
    void git.ensureSnapshot(cwd)
    const saveOnLeave = (): void => saveCurrent.current()
    window.addEventListener('pagehide', saveOnLeave)
    return () => {
      live.current = false
      window.removeEventListener('pagehide', saveOnLeave)
      // StrictMode 的同一实例重挂载不能释放仍被使用的 reader。
      queueMicrotask(() => {
        if (!live.current) {
          saveCurrent.current()
          owner.dispose()
        }
      })
    }
  }, [cwd, files, git, owner])

  useEffect(() => {
    if (!refreshOnFocus) return
    let lastFocus = Date.now()
    const focus = (): void => {
      if (Date.now() - lastFocus < 5000) return
      lastFocus = Date.now()
      void git.refreshSnapshot(cwd)
    }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [cwd, git, refreshOnFocus])

  useEffect(() => {
    if (!container) return
    const measure = (): void =>
      setSize({ width: container.clientWidth, height: container.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [container])

  const historyVisible = global.gitOpen && (!stacked || page === 'git')
  useEffect(() => {
    if (!historyVisible || !repositories.length) return
    if (repositories.some((repository) => repository.root === history.state.repositoryRoot)) {
      history.setRepository(history.state.repositoryRoot!)
      return
    }
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
  }, [historyVisible, gitRevision, history, repositories, state.activeDiff, state.activePath])

  useEffect(
    () =>
      git.subscribe(() => {
        const treeLayout = git.getWorkspace(cwd)?.layout
        if (treeLayout && treeLayout !== global.treeLayout) updateGlobal({ treeLayout })
      }),
    [cwd, git, global.treeLayout, updateGlobal]
  )

  return {
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
    width: size.width,
    changeRowHeight,
    openGit(root): void {
      updateGlobal({ gitOpen: true })
      setPage('git')
      if (root !== undefined) history.setRepository(root)
    },
    refresh(): void {
      files.refreshTree()
      void git.refreshSnapshot(cwd)
      if (state.activeDiff) files.reloadDiff()
      else if (state.activePath) files.reloadFile(state.activePath)
      if (historyVisible) history.refresh()
    }
  }
}
