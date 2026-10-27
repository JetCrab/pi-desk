import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import {
  projectPreviewDirectoryKey,
  type L4ProjectPreviewState
} from '@common/l4_foundation/file/l4-project-preview-contract'
import type { L4CodePreviewState } from '@client/l4_foundation/ui/code/l4-code-preview'
import { readL3ImagePreviewMode } from '@client/l3_modules/preferences/l3-work-session-file-preferences'
import {
  L3ProjectFileRuntime,
  type L3ProjectFileState,
  type L3FileTabTarget,
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
interface FileRoot {
  files: L3ProjectFileRuntime
  unsubscribe: () => void
}
interface SessionDirectories {
  directories: string[]
  defaultDirectory: string | null
  selectedDirectory: string
}
interface SessionLayout {
  files: L3ProjectFileRuntime
  roots: Map<string, FileRoot>
  windowOpen: boolean
  chatWidthPercent: number
  activePane: 'chat' | 'files'
}

export class L2FileWorkspaceRuntime {
  readonly standaloneImages = new L2StandaloneImageCache()
  private readonly listeners = new Set<() => void>()
  private readonly workspaces = new Map<string, SessionLayout>()
  private readonly sources = new Map<string, SourceRef>()
  private readonly previewDirectories = new Map<string, SessionDirectories>()
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
  getDirectories(workId: string): readonly string[] {
    return this.previewDirectories.get(workId)?.directories ?? []
  }
  getDirectory(workId: string): string {
    const selection = this.previewDirectories.get(workId)
    if (!selection) throw new Error(l2WorkbenchText('sourceChanged'))
    return selection.selectedDirectory
  }
  applyPreviewDirectories(source: L2ChatSource, state: L4ProjectPreviewState): void {
    const current = this.sources.get(source.workId)
    if (!current || current.sessionId !== source.sessionId || current.branchId !== source.branchId)
      return
    const previous = this.previewDirectories.get(source.workId)!
    const unique = new Map([[projectPreviewDirectoryKey(current.cwd), current.cwd]])
    for (const directory of state.directories) {
      const key = projectPreviewDirectoryKey(directory)
      if (!unique.has(key)) unique.set(key, directory)
    }
    const defaultDirectory = state.defaultDirectory
      ? (unique.get(projectPreviewDirectoryKey(state.defaultDirectory)) ?? null)
      : null
    const previousDefaultKey = previous.defaultDirectory
      ? projectPreviewDirectoryKey(previous.defaultDirectory)
      : null
    const defaultKey = defaultDirectory ? projectPreviewDirectoryKey(defaultDirectory) : null
    const selectedDirectory =
      previousDefaultKey !== defaultKey
        ? (defaultDirectory ?? current.cwd)
        : (unique.get(projectPreviewDirectoryKey(previous.selectedDirectory)) ?? current.cwd)
    const directories = [...unique.values()]
    if (
      previous.defaultDirectory === defaultDirectory &&
      previous.selectedDirectory === selectedDirectory &&
      previous.directories.length === directories.length &&
      previous.directories.every((directory, index) => directory === directories[index])
    )
      return
    this.previewDirectories.set(source.workId, { directories, defaultDirectory, selectedDirectory })
    const layout = this.workspaces.get(source.workId)
    if (layout) {
      for (const [key, root] of layout.roots) {
        if (unique.has(key)) continue
        root.unsubscribe()
        root.files.dispose()
        layout.roots.delete(key)
      }
      this.switchFiles(source.workId, layout)
    }
    this.publish()
  }
  selectDirectory(workId: string, directory: string): void {
    const selection = this.previewDirectories.get(workId)
    if (!selection) throw new Error(l2WorkbenchText('sourceChanged'))
    const registered = selection.directories.find(
      (candidate) => projectPreviewDirectoryKey(candidate) === projectPreviewDirectoryKey(directory)
    )
    if (!registered) throw new Error(l2WorkbenchText('sourceChanged'))
    if (selection.selectedDirectory === registered) return
    selection.selectedDirectory = registered
    const layout = this.workspaces.get(workId)
    if (layout) this.switchFiles(workId, layout)
    this.publish()
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
        this.disposeLayout(layout)
        this.workspaces.delete(id)
      }
      this.previewDirectories.delete(id)
      changed = true
      if (this.expandedWorkId === id) this.expandedWorkId = null
    }
    this.sources.clear()
    for (const [id, source] of next) {
      this.sources.set(id, source)
      if (!this.previewDirectories.has(id)) {
        this.previewDirectories.set(id, {
          directories: [source.cwd],
          defaultDirectory: null,
          selectedDirectory: source.cwd
        })
      }
    }
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
  closeTabs(id: string, target: L3FileTabTarget | null, scope: L3FileTabCloseScope): void {
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
      for (const entry of layout.roots.values()) {
        if (entry.files.cwd === cwd) entry.files.handleGitBranchChanged(root)
      }
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
    for (const layout of this.workspaces.values()) this.disposeLayout(layout)
    this.workspaces.clear()
    this.sources.clear()
    this.previewDirectories.clear()
    this.expandedWorkId = null
    this.listeners.clear()
  }
  private workspaceFor(id: string): SessionLayout {
    const source = this.sources.get(id)
    if (!source) throw new Error(l2WorkbenchText('sourceChanged'))
    const existing = this.workspaces.get(id)
    if (existing) return existing
    const layout: SessionLayout = {
      files: this.createFiles(id, this.getDirectory(id)),
      roots: new Map(),
      windowOpen: false,
      chatWidthPercent: 50,
      activePane: 'files'
    }
    this.attachRoot(id, layout, layout.files)
    this.workspaces.set(id, layout)
    return layout
  }
  private createFiles(id: string, cwd: string): L3ProjectFileRuntime {
    const context = { workId: id, cwd }
    return new L3ProjectFileRuntime(
      cwd,
      {
        list: (path, signal) => this.biz.list({ ...context, path }, signal),
        search: (input, signal) => this.biz.search({ ...context, ...input }, signal),
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
  }
  private attachRoot(id: string, layout: SessionLayout, files: L3ProjectFileRuntime): void {
    const unsubscribe = files.subscribe(() => {
      if (layout.files !== files) return
      if (!files.state.activePath && !files.state.activeDiff && this.expandedWorkId !== id) {
        layout.windowOpen = false
        layout.activePane = 'chat'
      }
      this.publish()
    })
    layout.roots.set(projectPreviewDirectoryKey(files.cwd), { files, unsubscribe })
  }
  private switchFiles(id: string, layout: SessionLayout): void {
    const directory = this.getDirectory(id)
    const key = projectPreviewDirectoryKey(directory)
    if (projectPreviewDirectoryKey(layout.files.cwd) === key) return
    let root = layout.roots.get(key)
    if (!root) {
      const files = this.createFiles(id, directory)
      this.attachRoot(id, layout, files)
      root = layout.roots.get(key)!
    }
    layout.files = root.files
    if (
      !root.files.state.activePath &&
      !root.files.state.activeDiff &&
      this.expandedWorkId !== id
    ) {
      layout.windowOpen = false
      layout.activePane = 'chat'
    }
  }
  private disposeLayout(layout: SessionLayout): void {
    for (const root of layout.roots.values()) {
      root.unsubscribe()
      root.files.dispose()
    }
    layout.roots.clear()
  }
  private publish(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}
