import type {
  L4ProjectFileEntry,
  L4ProjectFileImageMimeType,
  L4ProjectFileImagePreviewMode
} from '@common/l4_foundation/file/l4-project-file-contract'
import type { L4GitHistoricalDiff } from '@common/l4_foundation/git/l4-git-history-contract'
import { L3_PROJECT_FILES_LOCALE_MESSAGES } from '@common/l3_modules/project-files/l3-project-files-locale-messages'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import { createL4Base64ImageBlob } from '@client/l4_foundation/media/l4-base64-image'
import type { L4CodePreviewState } from '@client/l4_foundation/ui/code/l4-code-preview'
import type { L4CodeDiffState } from '@client/l4_foundation/ui/code/l4-code-diff'
import { saveL4CodePreferences } from '@client/l4_foundation/ui/code/l4-code-preferences'
import { L3ProjectRequestError, type L3ProjectFileReader } from './l3-project-reader'
import type { L3ProjectRevealTargetType } from '@common/l3_modules/project-files/l3-project-files-contract'
import {
  compactL3ProjectDirectory,
  joinL3ProjectPath,
  type L3CompactDirectory
} from './l3-project-path-tree'

export type L3DirectoryState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; entries: L4ProjectFileEntry[]; truncated: boolean }
  | { status: 'error'; error: string }
export type L3FileDocument =
  | { status: 'unloaded' }
  | { status: 'loading' }
  | {
      status: 'text'
      content: string
      size: number
      editorState: L4CodePreviewState | null
      viewMode: 'source' | 'preview'
    }
  | { status: 'image'; mimeType: L4ProjectFileImageMimeType; size: number; objectUrl: string }
  | { status: 'error'; error: string }
export interface L3FileSearch {
  query: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  matches: string[]
  truncated: boolean
  error: string | null
}
interface DiffOptions {
  repositoryRoot: string
  path: string
  comparison?: L4GitHistoricalDiff
  editorState?: L4CodeDiffState | null
  label?: string
}
export type L3FileDiff = DiffOptions &
  (
    | { status: 'loading' }
    | {
        status: 'text'
        original: { path: string; content: string }
        modified: { path: string; content: string }
      }
    | { status: 'metadata'; originalMetadata: string; modifiedMetadata: string }
    | { status: 'binary' | 'too_large' | 'error'; error: string | null }
  )
export type L3FileTabCloseScope = 'current' | 'others' | 'left' | 'right' | 'all'
export interface L3ProjectFileState {
  tabs: string[]
  activePath: string | null
  directories: Map<string, L3DirectoryState>
  expandedPaths: Set<string>
  treeScrollTop: number
  search: L3FileSearch
  documents: Map<string, L3FileDocument>
  activeDiff: L3FileDiff | null
}
interface RuntimeOptions {
  imagePreviewMode: () => L4ProjectFileImagePreviewMode
  onNotice?: (message: string) => void
  reveal?: (path: string, targetType?: L3ProjectRevealTargetType) => Promise<void>
  htmlPreview?: boolean
  maxTabs?: number
}
export interface L3ProjectFileBrowsingState {
  tabs: string[]
  activePath: string | null
  editorStates: Record<string, L4CodePreviewState>
  fileViewModes: Record<string, 'source' | 'preview'>
  expandedPaths: string[]
  treeScrollTop: number
  searchQuery: string
  activeDiff: { repositoryRoot: string; path: string; comparison?: L4GitHistoricalDiff } | null
}
function projectText(
  key: keyof (typeof L3_PROJECT_FILES_LOCALE_MESSAGES)['zh-CN'],
  params?: Record<string, string | number>
): string {
  return l4LocalizedErrorMessage({
    msg: L3_PROJECT_FILES_LOCALE_MESSAGES['zh-CN'][key],
    i18n: { key: `projectFiles:${key}`, ...(params ? { params } : {}) }
  })
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : projectText('projectReadFailed')
}
function normalizePath(cwd: string, path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const prefix = `${cwd.replaceAll('\\', '/').replace(/\/+$/, '')}/`
  const windows = /^[a-z]:\//i.test(prefix) || prefix.startsWith('//')
  const inside = windows
    ? normalized.toLowerCase().startsWith(prefix.toLowerCase())
    : normalized.startsWith(prefix)
  return inside ? normalized.slice(prefix.length) : normalized
}

// 单个目录阅读实例；会话身份、窗口和聊天布局由调用方拥有。
export class L3ProjectFileRuntime {
  readonly state: L3ProjectFileState = {
    tabs: [],
    activePath: null,
    directories: new Map(),
    expandedPaths: new Set(),
    treeScrollTop: 0,
    search: { query: '', status: 'idle', matches: [], truncated: false, error: null },
    documents: new Map(),
    activeDiff: null
  }
  private readonly listeners = new Set<() => void>()
  private readonly directoryRequests = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >()
  private readonly compactRequests = new Map<string, object>()
  private readonly documentRequests = new Map<string, AbortController>()
  private readonly closeMissing = new Set<string>()
  private readonly restoredTabs = new Set<string>()
  private readonly restoredEditorStates = new Map<string, L4CodePreviewState>()
  private readonly restoredFileViewModes = new Map<string, 'source' | 'preview'>()
  private searchRequest: AbortController | null = null
  private diffRequest: AbortController | null = null
  private revision = 0
  private disposed = false

  constructor(
    readonly cwd: string,
    private readonly reader: L3ProjectFileReader,
    private readonly options: RuntimeOptions
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getRevision = (): number => this.revision
  get canReveal(): boolean {
    return Boolean(this.options.reveal)
  }
  getBrowsingDocumentSettings(): Pick<
    L3ProjectFileBrowsingState,
    'editorStates' | 'fileViewModes'
  > {
    const editorStates: Record<string, L4CodePreviewState> = {}
    const fileViewModes: Record<string, 'source' | 'preview'> = {}
    for (const path of this.state.tabs) {
      const document = this.state.documents.get(path)
      const editorState =
        document?.status === 'text' ? document.editorState : this.restoredEditorStates.get(path)
      if (editorState && JSON.stringify(editorState).length < 32_768)
        editorStates[path] = editorState
      const viewMode =
        document?.status === 'text' ? document.viewMode : this.restoredFileViewModes.get(path)
      if (viewMode) fileViewModes[path] = viewMode
    }
    return { editorStates, fileViewModes }
  }
  restoreBrowsing(input: L3ProjectFileBrowsingState): void {
    this.state.tabs = [...input.tabs]
    for (const path of input.tabs) {
      this.restoredTabs.add(path)
      const editorState = input.editorStates[path]
      if (editorState) this.restoredEditorStates.set(path, editorState)
      const viewMode = input.fileViewModes[path]
      if (viewMode) this.restoredFileViewModes.set(path, viewMode)
    }
    this.state.activePath =
      input.activePath && input.tabs.includes(input.activePath) ? input.activePath : null
    this.state.expandedPaths = new Set(input.expandedPaths)
    this.state.treeScrollTop = input.treeScrollTop
    this.state.search = {
      query: input.searchQuery,
      status: input.searchQuery ? 'loading' : 'idle',
      matches: [],
      truncated: false,
      error: null
    }
    for (const path of input.tabs) this.state.documents.set(path, { status: 'unloaded' })
    for (const path of input.expandedPaths) void this.ensureDirectory(path)
    if (input.activeDiff) {
      this.openDiff(
        input.activeDiff.repositoryRoot,
        input.activeDiff.path,
        input.activeDiff.comparison
      )
    } else if (this.state.activePath) {
      void this.ensureDocument(this.state.activePath)
    }
  }
  async revealFile(path: string, targetType: L3ProjectRevealTargetType = 'file'): Promise<void> {
    if (!this.options.reveal) throw new Error(projectText('revealUnavailable'))
    await this.options.reveal(path, targetType)
  }
  ensureRoot(): Promise<void> {
    return this.ensureDirectory('')
  }
  ensureDirectory(path: string): Promise<void> {
    if (this.disposed || this.state.directories.get(path)?.status === 'ready')
      return Promise.resolve()
    const existing = this.directoryRequests.get(path)
    if (existing) return existing.promise
    const controller = new AbortController()
    const promise = Promise.resolve().then(async (): Promise<void> => {
      try {
        if (controller.signal.aborted) return
        const result = await this.reader.list(path, controller.signal)
        if (this.directoryRequests.get(path)?.controller !== controller) return
        this.state.directories.set(path, { status: 'ready', ...result })
      } catch (cause) {
        if (this.directoryRequests.get(path)?.controller !== controller) return
        this.state.directories.set(path, { status: 'error', error: message(cause) })
      }
      if (this.directoryRequests.get(path)?.controller !== controller) return
      this.directoryRequests.delete(path)
      this.publish()
    })
    this.directoryRequests.set(path, { controller, promise })
    this.state.directories.set(path, { status: 'loading' })
    this.publish()
    return promise
  }
  setExpandedPaths(paths: Set<string>, load = true): void {
    const closed = [...this.state.expandedPaths].filter((path) => !paths.has(path))
    this.state.expandedPaths = new Set(paths)
    for (const path of this.compactRequests.keys()) {
      if (closed.some((parent) => path === parent || path.startsWith(`${parent}/`)))
        this.compactRequests.delete(path)
    }
    this.publish()
    if (load) for (const path of paths) void this.ensureDirectory(path)
  }
  cancelDirectoryExpansion(root = ''): void {
    for (const path of this.compactRequests.keys()) {
      if (!root || path === root || path.startsWith(`${root}/`)) this.compactRequests.delete(path)
    }
  }
  compactDirectory(path: string, boundaries: ReadonlySet<string>): L3CompactDirectory {
    return compactL3ProjectDirectory(
      path,
      (current) => {
        const next = this.onlyDirectory(current)
        // 未探测的尾部保留独立可展开节点，不能在预算用完后显示永久加载。
        return next && this.state.directories.has(next) ? next : null
      },
      boundaries
    )
  }
  async expandDirectoryChain(path: string, boundaries: ReadonlySet<string>): Promise<void> {
    const token = {}
    this.compactRequests.set(path, token)
    let current = path
    let remaining = 16
    while (
      !this.disposed &&
      this.compactRequests.get(path) === token &&
      this.state.expandedPaths.has(path)
    ) {
      if (this.state.directories.get(current)?.status !== 'ready') {
        if (remaining-- <= 0) break
        await this.ensureDirectory(current)
      }
      if (this.compactRequests.get(path) !== token || this.disposed) return
      const next = this.onlyDirectory(current)
      if (!next || boundaries.has(current) || boundaries.has(next)) break
      if (remaining <= 0 && this.state.directories.get(next)?.status !== 'ready') break
      this.state.expandedPaths.add(next)
      current = next
      this.publish()
    }
    if (this.compactRequests.get(path) === token) this.compactRequests.delete(path)
  }
  private onlyDirectory(path: string): string | null {
    const directory = this.state.directories.get(path)
    if (directory?.status !== 'ready' || directory.truncated || directory.entries.length !== 1)
      return null
    const entry = directory.entries[0]!
    return entry.type === 'directory' ? joinL3ProjectPath(path, entry.name) : null
  }
  setTreeScrollTop(value: number): void {
    this.state.treeScrollTop = value
  }
  refreshTree(): void {
    this.compactRequests.clear()
    for (const request of this.directoryRequests.values()) request.controller.abort()
    this.directoryRequests.clear()
    this.state.directories.clear()
    this.cancelSearch()
    this.state.search = {
      query: this.state.search.query,
      status: this.state.search.query ? 'loading' : 'idle',
      matches: [],
      truncated: false,
      error: null
    }
    this.publish()
    void this.ensureRoot().then(() => {
      if (this.disposed) return
      for (const path of this.state.expandedPaths) void this.ensureDirectory(path)
      if (this.state.search.query) {
        this.cancelSearch()
        this.state.search = { ...this.state.search, status: 'loading' }
        void this.search(this.state.search.query)
      }
    })
  }
  setSearchQuery(query: string): void {
    if (this.state.search.query === query) return
    this.cancelSearch()
    this.state.search = {
      query,
      status: query.trim() ? 'loading' : 'idle',
      matches: [],
      truncated: false,
      error: null
    }
    this.publish()
  }
  async search(query: string): Promise<void> {
    if (
      this.disposed ||
      !query.trim() ||
      this.state.search.query !== query ||
      this.state.search.status === 'ready' ||
      this.searchRequest
    )
      return
    const request = new AbortController()
    this.searchRequest = request
    this.state.search = { query, status: 'loading', matches: [], truncated: false, error: null }
    this.publish()
    try {
      const result = await this.reader.search(query.trim(), request.signal)
      if (this.searchRequest !== request) return
      this.state.search = { query, status: 'ready', ...result, error: null }
    } catch (cause) {
      if (this.searchRequest !== request) return
      this.state.search = {
        query,
        status: 'error',
        matches: [],
        truncated: false,
        error: message(cause)
      }
    }
    if (this.searchRequest !== request) return
    this.searchRequest = null
    this.publish()
  }
  openFile(input: string): void {
    if (this.disposed) return
    const normalized = normalizePath(this.cwd, input)
    const windows = /^[a-z]:[\\/]/i.test(this.cwd) || this.cwd.startsWith('\\\\')
    const path = windows
      ? (this.state.tabs.find((tab) => tab.toLowerCase() === normalized.toLowerCase()) ??
        normalized)
      : normalized
    if (!this.state.tabs.includes(path)) {
      if (this.options.maxTabs && this.state.tabs.length >= this.options.maxTabs) {
        this.options.onNotice?.(projectText('maxOpenFiles', { count: this.options.maxTabs }))
        return
      }
      this.state.tabs.push(path)
    }
    this.clearDiff()
    if (!this.state.documents.has(path)) this.state.documents.set(path, { status: 'unloaded' })
    this.state.activePath = path
    this.publish()
    void this.ensureDocument(path)
  }
  closeTabs(target: string | null, scope: L3FileTabCloseScope): void {
    const state = this.state
    const tabs: (string | null)[] = [...state.tabs, ...(state.activeDiff ? [null] : [])]
    const index = tabs.indexOf(target)
    if (index < 0 && scope !== 'all') return
    const removed = new Set(
      tabs.filter(
        (tab, position) =>
          scope === 'all' ||
          (scope === 'current'
            ? tab === target
            : scope === 'others'
              ? tab !== target
              : scope === 'left'
                ? position < index
                : position > index)
      )
    )
    if (!removed.size) return
    const previousActive = state.activeDiff ? null : state.activePath
    for (const path of removed) {
      if (path === null) {
        this.clearDiff()
        continue
      }
      this.documentRequests.get(path)?.abort()
      this.documentRequests.delete(path)
      this.releaseDocument(state.documents.get(path))
      state.documents.delete(path)
      this.restoredEditorStates.delete(path)
      this.restoredFileViewModes.delete(path)
      this.closeMissing.delete(path)
      this.restoredTabs.delete(path)
    }
    state.tabs = state.tabs.filter((path) => !removed.has(path))
    if (state.activePath && removed.has(state.activePath)) {
      const activeIndex = tabs.indexOf(state.activePath)
      state.activePath =
        tabs.slice(activeIndex + 1).find((path) => path !== null && !removed.has(path)) ??
        tabs
          .slice(0, activeIndex)
          .reverse()
          .find((path) => path !== null && !removed.has(path)) ??
        null
    }
    this.publish()
    if (!state.activeDiff && state.activePath && previousActive !== state.activePath)
      void this.ensureDocument(state.activePath)
  }
  reloadFile(path: string): void {
    if (!this.state.tabs.includes(path)) return
    this.invalidateDocument(path)
    this.publish()
    void this.ensureDocument(path)
  }
  async ensureDocument(path: string): Promise<void> {
    if (this.disposed || !this.state.tabs.includes(path)) return
    const current = this.state.documents.get(path)
    if (current && ['loading', 'text', 'image'].includes(current.status)) return
    const request = new AbortController()
    this.documentRequests.set(path, request)
    this.state.documents.set(path, { status: 'loading' })
    this.publish()
    try {
      const result = await this.reader.get(path, this.options.imagePreviewMode(), request.signal)
      if (this.documentRequests.get(path) !== request) return
      this.documentRequests.delete(path)
      this.closeMissing.delete(path)
      this.restoredTabs.delete(path)
      this.state.documents.set(
        path,
        result.kind === 'text'
          ? {
              status: 'text',
              content: result.content,
              size: result.size,
              editorState: this.restoredEditorStates.get(path) ?? null,
              viewMode:
                this.restoredFileViewModes.get(path) ??
                (this.options.htmlPreview && /\.html?$/i.test(path) ? 'preview' : 'source')
            }
          : {
              status: 'image',
              mimeType: result.mimeType,
              size: result.size,
              objectUrl: URL.createObjectURL(createL4Base64ImageBlob(result))
            }
      )
    } catch (cause) {
      if (this.documentRequests.get(path) !== request) return
      this.documentRequests.delete(path)
      const restored = this.restoredTabs.delete(path)
      const changedBranch = this.closeMissing.delete(path)
      if (
        (restored || changedBranch) &&
        cause instanceof L3ProjectRequestError &&
        cause.status === 404 &&
        cause.errorKey === 'errors:fileMissing'
      ) {
        this.closeTabs(path, 'current')
        if (changedBranch) this.options.onNotice?.(projectText('branchFileClosed', { path }))
        return
      }
      console.warn('[Pi Desk][ProjectFile] 读取文件失败', {
        cwd: this.cwd,
        path,
        error: message(cause)
      })
      this.state.documents.set(path, { status: 'error', error: message(cause) })
    }
    this.publish()
  }
  openDiff(
    repositoryRoot: string,
    path: string,
    comparison?: L4GitHistoricalDiff,
    label?: string
  ): void {
    if (this.disposed) return
    this.clearDiff()
    this.state.activeDiff = {
      status: 'loading',
      repositoryRoot,
      path,
      comparison,
      label
    }
    this.publish()
    void this.ensureDiff()
  }
  closeDiff(): void {
    this.closeTabs(null, 'current')
  }
  reloadDiff(): void {
    const previous = this.state.activeDiff
    if (!previous) return
    this.clearDiff()
    this.state.activeDiff = { ...previous, status: 'loading' }
    this.publish()
    void this.ensureDiff()
  }
  saveDiffState(expected: L3FileDiff, state: L4CodeDiffState | null): void {
    if (this.state.activeDiff === expected) expected.editorState = state
  }
  setDiffViewMode(diffViewMode: 'side-by-side' | 'inline'): void {
    if (this.state.activeDiff) saveL4CodePreferences({ diffViewMode })
  }
  setDiffWrapLines(wrapLines: boolean): void {
    if (this.state.activeDiff) saveL4CodePreferences({ wrapLines })
  }
  setDiffCollapseUnchanged(collapseUnchanged: boolean): void {
    if (this.state.activeDiff) saveL4CodePreferences({ collapseUnchanged })
  }
  handleGitBranchChanged(repositoryRoot: string): void {
    this.refreshTree()
    for (const path of this.state.tabs) {
      if (repositoryRoot && path !== repositoryRoot && !path.startsWith(`${repositoryRoot}/`))
        continue
      this.invalidateDocument(path)
      this.closeMissing.add(path)
    }
    if (this.state.activeDiff?.repositoryRoot === repositoryRoot) this.reloadDiff()
    else this.publish()
    if (!this.state.activeDiff && this.state.activePath)
      void this.ensureDocument(this.state.activePath)
  }
  saveEditorState(path: string, state: L4CodePreviewState | null): void {
    const document = this.state.documents.get(path)
    if (document?.status === 'text') document.editorState = state
  }
  setWrapLines(path: string, wrapLines: boolean): void {
    if (this.state.documents.get(path)?.status === 'text') saveL4CodePreferences({ wrapLines })
  }
  setTextViewMode(path: string, viewMode: 'source' | 'preview'): void {
    const document = this.state.documents.get(path)
    if (document?.status !== 'text' || document.viewMode === viewMode) return
    document.viewMode = viewMode
    this.publish()
  }
  dispose(): void {
    this.disposed = true
    this.compactRequests.clear()
    for (const request of this.directoryRequests.values()) request.controller.abort()
    this.directoryRequests.clear()
    for (const request of this.documentRequests.values()) request.abort()
    this.documentRequests.clear()
    this.cancelSearch()
    this.clearDiff()
    for (const document of this.state.documents.values()) this.releaseDocument(document)
    this.state.documents.clear()
    this.listeners.clear()
  }
  private async ensureDiff(): Promise<void> {
    const current = this.state.activeDiff
    if (this.disposed || current?.status !== 'loading' || this.diffRequest) return
    const request = new AbortController()
    this.diffRequest = request
    try {
      const result = await this.reader.diff(
        current.repositoryRoot,
        current.path,
        request.signal,
        current.comparison
      )
      if (this.diffRequest !== request) return
      this.state.activeDiff =
        result.kind === 'text'
          ? { ...current, status: 'text', original: result.original, modified: result.modified }
          : result.kind === 'metadata'
            ? {
                ...current,
                status: 'metadata',
                originalMetadata: result.original,
                modifiedMetadata: result.modified
              }
            : { ...current, status: result.kind, error: null }
    } catch (cause) {
      if (this.diffRequest !== request) return
      this.state.activeDiff = { ...current, status: 'error', error: message(cause) }
    }
    if (this.diffRequest !== request) return
    this.diffRequest = null
    this.publish()
  }
  private clearDiff(): void {
    this.diffRequest?.abort()
    this.diffRequest = null
    this.state.activeDiff = null
  }
  private cancelSearch(): void {
    this.searchRequest?.abort()
    this.searchRequest = null
  }
  private invalidateDocument(path: string): void {
    this.documentRequests.get(path)?.abort()
    this.documentRequests.delete(path)
    this.releaseDocument(this.state.documents.get(path))
    this.state.documents.set(path, { status: 'unloaded' })
  }
  private releaseDocument(document: L3FileDocument | undefined): void {
    if (document?.status === 'image') URL.revokeObjectURL(document.objectUrl)
  }
  private publish(): void {
    if (this.disposed) return
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}
