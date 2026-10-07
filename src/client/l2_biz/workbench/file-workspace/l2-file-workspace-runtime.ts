import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L4CodePreviewState } from '@client/l4_foundation/ui/code/l4-code-preview'
import { readL3ImagePreviewMode } from '@client/l3_modules/preferences/l3-work-session-file-preferences'
import {
  L3ProjectFileRuntime,
  type L3ProjectFileState,
  type L3FileTabCloseScope
} from '@client/l3_modules/project-files/l3-project-file-runtime'
import type { L2WorkSessionGitBiz } from '../git-workspace/l2-work-session-git-biz'
import type { L2WorkSessionFilesBiz } from './l2-work-session-files-biz'
import { l2WorkbenchText } from '../l2-workbench-text'
import { L2StandaloneImageCache } from './l2-standalone-image-cache'

export type {
  L3DirectoryState as L2DirectoryLoadState,
  L3FileDocument as L2FileDocumentState,
  L3FileSearch as L2FileSearchState,
  L3FileDiff as L2FileDiffState,
  L3FileTabCloseScope as L2FileTabCloseScope
} from '@client/l3_modules/project-files/l3-project-file-runtime'

export interface L2SessionFileWorkspace extends L3ProjectFileState {
  readonly cwd: string
  readonly windowOpen: boolean
  readonly chatWidthPercent: number
  readonly activePane: 'chat' | 'files'
}
type SourceRef = Pick<L2WorkSessionListItem, 'workId' | 'cwd' | 'sessionId' | 'branchId'>
interface SessionLayout {
  files: L3ProjectFileRuntime
  windowOpen: boolean
  chatWidthPercent: number
  activePane: 'chat' | 'files'
  unsubscribe: () => void
}

export class L2FileWorkspaceRuntime {
  readonly standaloneImages = new L2StandaloneImageCache()
  private readonly listeners = new Set<() => void>()
  private readonly workspaces = new Map<string, SessionLayout>()
  private readonly sources = new Map<string, SourceRef>()
  private expandedWorkId: string | null = null
  private revision = 0
  constructor(
    private readonly biz: L2WorkSessionFilesBiz,
    private readonly gitBiz: L2WorkSessionGitBiz,
    private readonly onNotice: (message: string) => void = () => undefined
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getRevision = (): number => this.revision
  getWorkspace(workId: string | null): L2SessionFileWorkspace | null {
    const layout = workId ? this.workspaces.get(workId) : null
    if (!layout) return null
    return {
      ...layout.files.state,
      cwd: layout.files.cwd,
      windowOpen: layout.windowOpen,
      chatWidthPercent: layout.chatWidthPercent,
      activePane: layout.activePane
    }
  }
  getFileRuntime(workId: string): L3ProjectFileRuntime {
    return this.workspaceFor(workId).files
  }
  getExpandedWorkId(): string | null {
    return this.expandedWorkId
  }
  reconcileWorkSessions(sessions: readonly L2WorkSessionListItem[]): void {
    this.standaloneImages.reconcileWorkSessions(sessions)
    const next = new Map(
      sessions.map(({ workId, cwd, sessionId, branchId }) => [
        workId,
        { workId, cwd, sessionId, branchId }
      ])
    )
    let changed = false
    for (const [id, previous] of this.sources) {
      const current = next.get(id)
      if (
        current?.cwd === previous.cwd &&
        current.sessionId === previous.sessionId &&
        current.branchId === previous.branchId
      )
        continue
      const layout = this.workspaces.get(id)
      if (layout) {
        layout.unsubscribe()
        layout.files.dispose()
        this.workspaces.delete(id)
        changed = true
      }
      if (this.expandedWorkId === id) this.expandedWorkId = null
    }
    this.sources.clear()
    for (const [id, source] of next) this.sources.set(id, source)
    if (changed) this.publish()
  }
  ensureRoot(id: string): Promise<void> {
    return this.getFileRuntime(id).ensureRoot()
  }
  ensureDirectory(id: string, path: string): Promise<void> {
    return this.getFileRuntime(id).ensureDirectory(path)
  }
  setExpandedPaths(id: string, paths: Set<string>): void {
    this.getFileRuntime(id).setExpandedPaths(paths)
  }
  setTreeScrollTop(id: string, top: number): void {
    this.workspaces.get(id)?.files.setTreeScrollTop(top)
  }
  refreshTree(id: string): void {
    this.getFileRuntime(id).refreshTree()
  }
  setSearchQuery(id: string, query: string): void {
    this.getFileRuntime(id).setSearchQuery(query)
  }
  search(id: string, query: string): Promise<void> {
    return this.getFileRuntime(id).search(query)
  }
  openFile(id: string, path: string): void {
    const layout = this.workspaceFor(id)
    layout.windowOpen = true
    layout.activePane = 'files'
    layout.files.openFile(path)
  }
  async revealFile(id: string, path: string): Promise<void> {
    await this.getFileRuntime(id).revealFile(path)
  }
  activateFile(id: string, path: string): void {
    if (this.workspaces.get(id)?.files.state.tabs.includes(path)) this.openFile(id, path)
  }
  closeFile(id: string, path: string): void {
    this.closeTabs(id, path, 'current')
  }
  closeTabs(id: string, target: string | null, scope: L3FileTabCloseScope): void {
    this.workspaces.get(id)?.files.closeTabs(target, scope)
  }
  hideWindow(id: string): void {
    const layout = this.workspaces.get(id)
    if (!layout?.windowOpen) return
    layout.windowOpen = false
    layout.activePane = 'chat'
    if (this.expandedWorkId === id) this.expandedWorkId = null
    this.publish()
  }
  showWindow(id: string): void {
    const layout = this.workspaceFor(id)
    const { tabs, activeDiff, activePath } = layout.files.state
    if (!tabs.length && !activeDiff && this.expandedWorkId !== id) return
    layout.windowOpen = true
    layout.activePane = 'files'
    this.publish()
    if (!activeDiff && activePath) void layout.files.ensureDocument(activePath)
  }
  setChatWidthPercent(id: string, value: number): void {
    const layout = this.workspaces.get(id)
    if (
      !layout ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value >= 100 ||
      Math.abs(layout.chatWidthPercent - value) < 0.001
    )
      return
    layout.chatWidthPercent = value
    this.publish()
  }
  setActivePane(id: string, pane: 'chat' | 'files'): void {
    const layout = this.workspaces.get(id)
    if (!layout || layout.activePane === pane) return
    layout.activePane = pane
    this.publish()
  }
  expandWindow(id: string): void {
    this.expandedWorkId = id
    this.showWindow(id)
  }
  collapseExpandedWindow(): void {
    if (!this.expandedWorkId) return
    const layout = this.workspaces.get(this.expandedWorkId)
    this.expandedWorkId = null
    if (layout && !layout.files.state.tabs.length && !layout.files.state.activeDiff) {
      layout.windowOpen = false
      layout.activePane = 'chat'
    }
    this.publish()
  }
  reloadFile(id: string, path: string): void {
    this.workspaces.get(id)?.files.reloadFile(path)
  }
  openDiff(id: string, root: string, path: string): void {
    const layout = this.workspaceFor(id)
    layout.windowOpen = true
    layout.activePane = 'files'
    layout.files.openDiff(root, path)
  }
  closeDiff(id: string): void {
    this.closeTabs(id, null, 'current')
  }
  reloadDiff(id: string): void {
    this.workspaces.get(id)?.files.reloadDiff()
  }
  setDiffViewMode(id: string, mode: 'side-by-side' | 'inline'): void {
    this.workspaces.get(id)?.files.setDiffViewMode(mode)
  }
  setDiffWrapLines(id: string, value: boolean): void {
    this.workspaces.get(id)?.files.setDiffWrapLines(value)
  }
  setDiffCollapseUnchanged(id: string, value: boolean): void {
    this.workspaces.get(id)?.files.setDiffCollapseUnchanged(value)
  }
  handleGitBranchChanged(cwd: string, root: string): void {
    for (const layout of this.workspaces.values()) {
      if (layout.files.cwd === cwd) layout.files.handleGitBranchChanged(root)
    }
  }
  saveEditorState(id: string, path: string, state: L4CodePreviewState | null): void {
    this.workspaces.get(id)?.files.saveEditorState(path, state)
  }
  setWrapLines(id: string, path: string, value: boolean): void {
    this.workspaces.get(id)?.files.setWrapLines(path, value)
  }
  setTextViewMode(id: string, path: string, mode: 'source' | 'preview'): void {
    this.workspaces.get(id)?.files.setTextViewMode(path, mode)
  }
  dispose(): void {
    this.standaloneImages.dispose()
    for (const layout of this.workspaces.values()) {
      layout.unsubscribe()
      layout.files.dispose()
    }
    this.workspaces.clear()
    this.sources.clear()
    this.expandedWorkId = null
    this.listeners.clear()
  }
  private workspaceFor(id: string): SessionLayout {
    const source = this.sources.get(id)
    if (!source) throw new Error(l2WorkbenchText('sourceChanged'))
    const existing = this.workspaces.get(id)
    if (existing) return existing
    const context = { workId: id, cwd: source.cwd }
    const files = new L3ProjectFileRuntime(
      source.cwd,
      {
        list: (path, signal) => this.biz.list({ ...context, path }, signal),
        search: (query, signal) => this.biz.search({ ...context, query }, signal),
        get: (path, imagePreviewMode, signal) =>
          this.biz.get({ ...context, path, imagePreviewMode }, signal),
        diff: (repositoryRoot, path, signal) =>
          this.gitBiz.getDiff({ ...context, repositoryRoot, path }, signal)
      },
      {
        imagePreviewMode: readL3ImagePreviewMode,
        htmlPreview: true,
        onNotice: this.onNotice,
        reveal: async (path, targetType) => {
          await this.biz.reveal({
            ...context,
            path,
            ...(targetType === 'directory' ? { targetType } : {})
          })
        }
      }
    )
    const layout: SessionLayout = {
      files,
      windowOpen: false,
      chatWidthPercent: 50,
      activePane: 'files',
      unsubscribe: () => undefined
    }
    layout.unsubscribe = files.subscribe(() => {
      if (!files.state.activePath && !files.state.activeDiff && this.expandedWorkId !== id) {
        layout.windowOpen = false
        layout.activePane = 'chat'
      }
      this.publish()
    })
    this.workspaces.set(id, layout)
    return layout
  }
  private publish(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}
