import type {
  L4ProjectFileEntry,
  L4ProjectFileImageMimeType,
  L4ProjectFileImagePreviewMode,
  L4ProjectFileSearch,
  L4ProjectSearchInput
} from '@common/l4_foundation/file/l4-project-file-contract'
import type { L4GitHistoricalDiff } from '@common/l4_foundation/git/l4-git-history-contract'
import { L3_PROJECT_FILES_LOCALE_MESSAGES } from '@common/l3_modules/project-files/l3-project-files-locale-messages'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import { createL4Base64ImageBlob } from '@client/l4_foundation/media/l4-base64-image'
import type {
  L4CodePreviewState,
  L4CodeLineNavigation
} from '@client/l4_foundation/ui/code/l4-code-preview'
import type { L4CodeDiffState } from '@client/l4_foundation/ui/code/l4-code-diff'
import { saveL4CodePreferences } from '@client/l4_foundation/ui/code/l4-code-preferences'
import { L3ProjectRequestError, type L3ProjectFileReader } from './l3-project-reader'
import { getL3ProjectTextPreviewKind } from './l3-project-text-preview'
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
export type L3FileComparison =
  | { status: 'loading' }
  | {
      status: 'ready'
      repositoryRoot: string
      path: string
      original: { path: string; content: string }
    }
  | { status: 'unavailable' }
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
      previewScrollTop: number
      comparison?: L3FileComparison
    }
  | { status: 'image'; mimeType: L4ProjectFileImageMimeType; size: number; objectUrl: string }
  | { status: 'error'; error: string }
export interface L3FileSearch extends L4ProjectSearchInput, L4ProjectFileSearch {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
}
const DEFAULT_SEARCH_OPTIONS = {
  scope: 'all',
  caseSensitive: false,
  wholeWord: false,
  regex: false
} as const
function emptySearch(input: L4ProjectSearchInput): L3FileSearch {
  return {
    ...input,
    status: input.query.trim() ? 'loading' : 'idle',
    fileMatches: [],
    contentMatches: [],
    truncated: false,
    error: null
  }
}
interface DiffOptions {
  repositoryRoot: string
  path: string
  comparison?: L4GitHistoricalDiff
  editorState?: L4CodeDiffState | null
  label?: string
  initialLine?: number
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
  searchOpen: boolean
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
    search: emptySearch({ query: '', ...DEFAULT_SEARCH_OPTIONS }),
    searchOpen: false,
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
  private readonly restoredPreviewScrollTops = new Map<string, number>()
  private searchRequest: AbortController | null = null
  private navigation: L4CodeLineNavigation | null = null
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
  setSearchOpen(open: boolean): void {
    if (this.disposed || this.state.searchOpen === open) return
    this.cancelSearch()
    this.state.searchOpen = open
    this.state.search = emptySearch({
      ...this.searchInput(),
      scope: open ? 'all' : this.state.search.scope
    })
    this.publish()
  }
  get pendingNavigation(): L4CodeLineNavigation | null {
    const path = this.state.activePath
    return path && !this.documentRequests.has(path) ? this.navigation : null
  }
  consumeNavigation(target: L4CodeLineNavigation, exists: boolean): void {
    if (this.navigation !== target) return
    this.navigation = null
    if (!exists) this.options.onNotice?.(projectText('searchLineUnavailable'))
    this.publish()
  }
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
    this.state.search = emptySearch({ query: input.searchQuery, ...DEFAULT_SEARCH_OPTIONS })
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
    this.state.search = emptySearch(this.searchInput())
    this.publish()
    void this.ensureRoot().then(() => {
      if (this.disposed) return
      for (const path of this.state.expandedPaths) void this.ensureDirectory(path)
      if (this.state.searchOpen && this.state.search.query.trim()) {
        this.cancelSearch()
        this.state.search = { ...this.state.search, status: 'loading' }
        void this.search(this.state.search.query)
      }
    })
  }
  setSearchQuery(query: string): void {
    if (this.disposed || this.state.search.query === query) return
    this.cancelSearch()
    this.state.search = emptySearch({ ...this.searchInput(), query })
    this.publish()
  }
  setSearchOptions(options: Partial<Omit<L4ProjectSearchInput, 'query'>>): void {
    if (this.disposed) return
    const previous = this.searchInput()
    const next = { ...previous, ...options }
    if (
      next.scope === previous.scope &&
      next.caseSensitive === previous.caseSensitive &&
      next.wholeWord === previous.wholeWord &&
      next.regex === previous.regex
    )
      return
    this.cancelSearch()
    this.state.search = emptySearch(next)
    this.publish()
    if (this.state.searchOpen) void this.search(next.query)
  }
  private searchInput(): L4ProjectSearchInput {
    const { query, scope, caseSensitive, wholeWord, regex } = this.state.search
    return { query, scope, caseSensitive, wholeWord, regex }
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
    const input = this.searchInput()
    this.state.search = emptySearch(input)
    this.publish()
    try {
      const result = await this.reader.search(input, request.signal)
      if (this.searchRequest !== request) return
      this.state.search = { ...input, status: 'ready', ...result, error: null }
    } catch (cause) {
      if (this.searchRequest !== request) return
      this.state.search = { ...emptySearch(input), status: 'error', error: message(cause) }
    }
    if (this.searchRequest !== request) return
    this.searchRequest = null
    this.publish()
  }
  openFile(input: string, line?: number): void {
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
    this.navigation = line === undefined ? null : { line }
    const document = this.state.documents.get(path)
    if (line !== undefined && document?.status === 'text') document.viewMode = 'source'
    void this.ensureDocument(path, line !== undefined)
    this.publish()
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
      this.restoredPreviewScrollTops.delete(path)
      this.closeMissing.delete(path)
      this.restoredTabs.delete(path)
    }
    state.tabs = state.tabs.filter((path) => !removed.has(path))
    if (state.activePath && removed.has(state.activePath)) {
      this.navigation = null
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
    if (this.state.activePath === path && this.navigation) {
      // 面板显示时的自动重读与搜索定位共用刷新，不能清除待消费的目标行。
      void this.ensureDocument(path, true)
      return
    }
    this.invalidateDocument(path)
    this.publish()
    void this.ensureDocument(path)
  }
  async ensureDocument(path: string, refresh = false): Promise<void> {
    if (this.disposed || !this.state.tabs.includes(path) || this.documentRequests.has(path)) return
    const current = this.state.documents.get(path)
    if (!refresh && current && ['loading', 'text', 'image'].includes(current.status)) return
    const request = new AbortController()
    this.documentRequests.set(path, request)
    // 搜索定位刷新正文时保留已挂载的代码视图，内容未变时不重建编辑器。
    if (current?.status !== 'text') this.state.documents.set(path, { status: 'loading' })
    this.publish()
    try {
      const result = await this.reader.get(path, this.options.imagePreviewMode(), request.signal)
      if (this.documentRequests.get(path) !== request) return
      this.documentRequests.delete(path)
      this.closeMissing.delete(path)
      this.restoredTabs.delete(path)
      const unchanged =
        current?.status === 'text' &&
        result.kind === 'text' &&
        current.content === result.content &&
        current.size === result.size
      if (!unchanged)
        this.state.documents.set(
          path,
          result.kind === 'text'
            ? {
                status: 'text',
                content: result.content,
                size: result.size,
                editorState:
                  current?.status === 'text'
                    ? current.editorState
                    : (this.restoredEditorStates.get(path) ?? null),
                viewMode:
                  this.state.activePath === path && this.navigation
                    ? 'source'
                    : current?.status === 'text'
                      ? current.viewMode
                      : (this.restoredFileViewModes.get(path) ??
                        (getL3ProjectTextPreviewKind(path) === 'markdown' ||
                        (this.options.htmlPreview && getL3ProjectTextPreviewKind(path) === 'html')
                          ? 'preview'
                          : 'source')),
                previewScrollTop:
                  current?.status === 'text'
                    ? current.previewScrollTop
                    : (this.restoredPreviewScrollTops.get(path) ?? 0)
              }
            : {
                status: 'image',
                mimeType: result.mimeType,
                size: result.size,
                objectUrl: URL.createObjectURL(createL4Base64ImageBlob(result))
              }
        )
      if (this.state.activePath === path && result.kind !== 'text') this.navigation = null
      this.releaseDocument(current)
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
      this.releaseDocument(current)
      if (this.state.activePath === path) this.navigation = null
    }
    this.publish()
  }
  async compareFile(
    path: string,
    target: { repositoryRoot: string; path: string } | null,
    signal: AbortSignal
  ): Promise<void> {
    const document = this.state.documents.get(path)
    if (this.disposed || signal.aborted || document?.status !== 'text') return
    if (!target) {
      if (document.comparison) {
        delete document.comparison
        this.publish()
      }
      return
    }
    const loading: L3FileComparison = { status: 'loading' }
    document.comparison = loading
    this.publish()
    const current = (): boolean =>
      !this.disposed &&
      !signal.aborted &&
      this.state.documents.get(path) === document &&
      document.comparison === loading
    try {
      const result = await this.reader.diff(target.repositoryRoot, target.path, signal)
      if (!current()) return
      if (result.kind === 'text') {
        // 比较结果的工作区正文与基线一起替换，不能把新行号画在缓存正文上。
        document.content = result.modified.content
        document.size = new TextEncoder().encode(result.modified.content).length
        document.comparison = {
          status: 'ready',
          repositoryRoot: target.repositoryRoot,
          path: target.path,
          original: result.original
        }
      } else {
        document.comparison = { status: 'unavailable' }
      }
    } catch (cause) {
      if (!current()) return
      console.warn('[Pi Desk][ProjectFile] 读取行变更失败', {
        cwd: this.cwd,
        path,
        error: message(cause)
      })
      document.comparison = { status: 'error', error: message(cause) }
    }
    this.publish()
  }
  openFileDiff(path: string, initialLine?: number): void {
    const document = this.state.documents.get(path)
    if (this.disposed || document?.status !== 'text' || document.comparison?.status !== 'ready')
      return
    const comparison = document.comparison
    this.clearDiff()
    this.state.activeDiff = {
      status: 'text',
      repositoryRoot: comparison.repositoryRoot,
      path: comparison.path,
      original: comparison.original,
      modified: { path: comparison.path, content: document.content },
      initialLine
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
  savePreviewScrollTop(path: string, scrollTop: number): void {
    const document = this.state.documents.get(path)
    if (document?.status !== 'text') return
    document.previewScrollTop = scrollTop
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
    this.restoredPreviewScrollTops.clear()
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
    this.navigation = null
    this.diffRequest?.abort()
    this.diffRequest = null
    this.state.activeDiff = null
  }
  private cancelSearch(): void {
    this.searchRequest?.abort()
    this.searchRequest = null
  }
  private invalidateDocument(path: string): void {
    if (this.state.activePath === path) this.navigation = null
    this.documentRequests.get(path)?.abort()
    this.documentRequests.delete(path)
    const document = this.state.documents.get(path)
    if (document?.status === 'text') {
      if (document.editorState) this.restoredEditorStates.set(path, document.editorState)
      this.restoredFileViewModes.set(path, document.viewMode)
      this.restoredPreviewScrollTops.set(path, document.previewScrollTop)
    }
    this.releaseDocument(document)
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
