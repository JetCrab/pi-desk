import { L2_PROJECT_HISTORY_MESSAGES } from '@common/l2_biz/project-preview/l2-project-history-messages'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import type {
  L4GitHistorySelection,
  L4GitCommit,
  L4GitLog,
  L4GitChanges,
  L4GitReadBranches
} from '@common/l4_foundation/git/l4-git-history-contract'
import type { L3ProjectReader } from '@client/l3_modules/project-files/l3-project-reader'
import type { L3ProjectFileRuntime } from '@client/l3_modules/project-files/l3-project-file-runtime'
import type { L2ProjectPreviewProject } from '../l2-project-preview-storage'

import {
  buildL3ProjectPathTree,
  flattenL3ProjectPathTree,
  type L3PathTreeRow
} from '@client/l3_modules/project-files/l3-project-path-tree'

type Load<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T | null
  error: string | null
}
type BranchRange = Extract<L4GitHistorySelection, { base: string }>
export interface L2ProjectHistoryState {
  repositoryRoot: string | null
  mode: 'history' | 'compare'
  tip: string
  base: string
  target: string
  strategy: 'merge-base' | 'direct'
  query: string
  author: string
  authorSuggestions: string[]
  selectedCommit: string | null
  selectedChangePath: string | null
  branches: Load<L4GitReadBranches>
  log: Load<L4GitLog>
  changes: Load<L4GitChanges>
}
function historyText(
  key: keyof (typeof L2_PROJECT_HISTORY_MESSAGES)['zh-CN'],
  params?: Record<string, string | number>
): string {
  return l4LocalizedErrorMessage({
    msg: L2_PROJECT_HISTORY_MESSAGES['zh-CN'][key],
    i18n: { key: `projectHistory:${key}`, ...(params ? { params } : {}) }
  })
}

function empty<T>(): Load<T> {
  return { status: 'idle', data: null, error: null }
}

export class L2ProjectHistoryRuntime {
  readonly state: L2ProjectHistoryState = {
    repositoryRoot: null,
    mode: 'history',
    tip: 'HEAD',
    base: '',
    target: 'HEAD',
    strategy: 'merge-base',
    query: '',
    author: '',
    authorSuggestions: [],
    selectedCommit: null,
    selectedChangePath: null,
    branches: empty(),
    log: empty(),
    changes: empty()
  }
  readonly scroll = { log: 0, changes: 0 }
  private readonly listeners = new Set<() => void>()
  private readonly requests = new Map<'branches' | 'log' | 'changes', AbortController>()
  private revision = 0
  private disposed = false
  private logPage = 1
  private changesPage = 1
  private range: BranchRange | null = null
  private selection: L4GitHistorySelection | null = null
  private restoredCommit: string | null = null
  private restoredChangePath: string | null = null
  private restoredChangesScroll: number | null = null
  private queryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly collapsedDirectories = new Set<string>()
  private changeTree = buildL3ProjectPathTree([])
  private changeRows: L3PathTreeRow[] = []
  constructor(
    private readonly reader: L3ProjectReader,
    private readonly files: L3ProjectFileRuntime
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getRevision = (): number => this.revision

  getChangeRows(): readonly L3PathTreeRow[] {
    return this.changeRows
  }
  restoreBrowsing(input: L2ProjectPreviewProject['history']): void {
    Object.assign(this.state, {
      repositoryRoot: input.repositoryRoot,
      mode: input.mode,
      tip: input.tip,
      base: input.base,
      target: input.target,
      strategy: input.strategy,
      query: input.query,
      author: input.author
    })
    this.scroll.log = input.logScroll
    this.restoredChangesScroll = input.changesScroll
    this.restoredCommit = input.selectedCommit
    this.restoredChangePath = input.selectedChangePath
    if (input.repositoryRoot !== null) {
      void this.loadBranches()
      void this.reload()
    }
  }
  selectChange(path: string): void {
    if (!this.state.changes.data?.items.some((item) => item.path === path)) return
    this.state.selectedChangePath = path
    this.publish()
  }
  toggleChangeDirectory(path: string): void {
    const row = this.changeRows.find((item) => item.directory?.path === path)
    if (!row?.directory) return
    if (row.expanded) this.collapsedDirectories.add(path)
    else for (const part of row.directory.paths) this.collapsedDirectories.delete(part)
    this.rebuildChangeRows()
    this.publish()
  }

  setScroll(pane: 'log' | 'changes', value: number): void {
    this.scroll[pane] = value
  }

  setRepository(root: string): void {
    if (root === this.state.repositoryRoot) return
    this.cancel('branches')
    this.state.repositoryRoot = root
    this.state.tip = this.state.target = 'HEAD'
    this.state.base = ''
    this.state.author = ''
    this.state.authorSuggestions = []
    this.state.branches = empty()
    this.resetSelection()
    void this.loadBranches()
    void this.reload()
  }
  setMode(mode: 'history' | 'compare'): void {
    if (this.state.mode === mode) return
    this.state.mode = mode
    this.resetSelection()
    void this.reload()
  }
  setRevision(field: 'tip' | 'base' | 'target', value: string): void {
    if (this.state[field] === value) return
    this.state[field] = value
    this.resetSelection()
    void this.reload()
  }
  setStrategy(strategy: 'merge-base' | 'direct'): void {
    if (this.state.strategy === strategy) return
    this.state.strategy = strategy
    this.resetSelection()
    void this.reload()
  }
  setQuery(query: string): void {
    this.setLogFilter('query', query)
  }
  setAuthor(author: string): void {
    this.setLogFilter('author', author)
  }
  private setLogFilter(field: 'query' | 'author', value: string): void {
    this.state[field] = value
    this.resetSelection()
    this.queryTimer = setTimeout(() => {
      this.queryTimer = null
      void this.reload()
    }, 220)
  }
  refresh(): void {
    this.resetSelection()
    void this.loadBranches()
    void this.reload()
  }
  async reload(): Promise<void> {
    if (this.disposed || this.state.repositoryRoot === null) return
    if (this.state.mode === 'compare') {
      if (!this.state.base) {
        this.publish()
        return
      }
      await this.loadChanges(
        { base: this.state.base, target: this.state.target, strategy: this.state.strategy },
        1,
        true
      )
      return
    }
    await this.loadLog(1)
  }
  selectCommit(commit: L4GitCommit | string, parent?: string): void {
    const oid = typeof commit === 'string' ? commit : commit.oid
    this.state.selectedCommit = oid
    this.scroll.changes = 0
    this.clearHistoricalDiff()
    void this.loadChanges({ commit: oid, ...(parent ? { parent } : {}) }, 1)
  }
  showAggregate(): void {
    if (!this.range) return
    this.state.selectedCommit = null
    this.clearHistoricalDiff()
    void this.loadChanges(this.range, 1)
  }
  loadMoreLog(): void {
    if (
      this.state.log.status !== 'ready' ||
      !this.state.log.data?.hasMore ||
      this.state.log.data.items.length >= 2000
    )
      return
    void this.loadLog(this.logPage + 1)
  }
  loadMoreChanges(): void {
    if (
      !this.selection ||
      this.state.changes.status !== 'ready' ||
      !this.state.changes.data?.hasMore
    )
      return
    void this.loadChanges(this.selection, this.changesPage + 1)
  }
  openChange(path: string): void {
    if (this.state.repositoryRoot === null) return
    const data = this.state.changes.data
    const change = data?.items.find((item) => item.path === path)
    if (!data || !change) return
    this.state.selectedChangePath = path
    this.publish()
    const { original, target } = data.comparison
    const left = original ? original.slice(0, 8) : historyText('emptyRevision')
    const label = historyText(
      !this.state.selectedCommit && this.state.strategy === 'merge-base'
        ? 'historyDiffAncestor'
        : 'historyDiffDirect',
      { left, target: target.slice(0, 8) }
    )
    this.files.openDiff(
      this.state.repositoryRoot,
      path,
      {
        baseCommit: original,
        targetCommit: target,
        ...(change.oldPath ? { oldPath: change.oldPath } : {})
      },
      label
    )
  }
  dispose(): void {
    this.disposed = true
    if (this.queryTimer) clearTimeout(this.queryTimer)
    for (const request of this.requests.values()) request.abort()
    this.requests.clear()
    this.resetChangeTree()
    this.listeners.clear()
  }
  private async loadBranches(): Promise<void> {
    const root = this.state.repositoryRoot
    if (root === null || this.disposed) return
    const request = this.begin('branches')
    this.state.branches = { status: 'loading', data: this.state.branches.data, error: null }
    this.publish()
    try {
      const data = await this.reader.branches(root, request.signal)
      if (!this.current('branches', request)) return
      this.state.branches = { status: 'ready', data, error: null }
    } catch (cause) {
      if (!this.current('branches', request)) return
      this.state.branches = { status: 'error', data: null, error: this.error(cause) }
    }
    this.requests.delete('branches')
    this.publish()
  }
  private async loadLog(page: number): Promise<void> {
    const root = this.state.repositoryRoot
    if (this.disposed || root === null) return
    const previous = page > 1 ? this.state.log.data : null
    const tip =
      previous?.tip ?? (this.state.mode === 'compare' ? this.range?.target : this.state.tip)
    const exclude =
      previous?.exclude ?? (this.state.mode === 'compare' ? this.range?.base : undefined)
    if (!tip) return
    const request = this.begin('log')
    this.state.log = { status: 'loading', data: previous, error: null }
    this.publish()
    try {
      const data = await this.reader.log(
        root,
        {
          tip,
          ...(exclude ? { exclude } : {}),
          query: this.state.query,
          ...(this.state.author.trim() ? { author: this.state.author.trim() } : {}),
          page: { index: page, size: 50 }
        },
        request.signal
      )
      if (!this.current('log', request)) return
      this.logPage = page
      for (const { author } of data.items) {
        if (
          author &&
          this.state.authorSuggestions.length < 200 &&
          !this.state.authorSuggestions.includes(author)
        ) {
          this.state.authorSuggestions.push(author)
        }
      }
      this.state.log = {
        status: 'ready',
        data: { ...data, items: [...(previous?.items ?? []), ...data.items].slice(0, 2000) },
        error: null
      }
      if (page === 1 && data.items[0]) {
        const restored = data.items.find((item) => item.oid === this.restoredCommit)
        this.restoredCommit = null
        if (restored) {
          this.state.selectedCommit = restored.oid
          void this.loadChanges({ commit: restored.oid }, 1)
        } else if (this.state.mode === 'history') this.selectCommit(data.items[0])
      }
    } catch (cause) {
      if (!this.current('log', request)) return
      this.state.log = { status: 'error', data: previous, error: this.error(cause) }
    }
    this.requests.delete('log')
    this.publish()
  }
  private async loadChanges(
    selection: L4GitHistorySelection,
    page: number,
    initializeRange = false
  ): Promise<void> {
    const root = this.state.repositoryRoot
    if (this.disposed || root === null) return
    const request = this.begin('changes')
    const previous = page > 1 ? this.state.changes.data : null
    if (page === 1) this.resetChangeTree()
    this.selection = selection
    this.state.changes = { status: 'loading', data: previous, error: null }
    this.publish()
    try {
      const data = await this.reader.changes(
        root,
        { selection, page: { index: page, size: 200 } },
        request.signal
      )
      if (!this.current('changes', request)) return
      this.changesPage = page
      const items = [...(previous?.items ?? []), ...data.items]
      this.state.changes = { status: 'ready', data: { ...data, items }, error: null }
      this.changeTree = buildL3ProjectPathTree(items.map((item) => item.path))
      if (this.restoredChangesScroll !== null) {
        this.scroll.changes = this.restoredChangesScroll
        this.restoredChangesScroll = null
      }
      this.rebuildChangeRows()
      if (this.restoredChangePath && items.some((item) => item.path === this.restoredChangePath)) {
        this.state.selectedChangePath = this.restoredChangePath
        this.restoredChangePath = null
      }
      this.selection =
        'commit' in selection
          ? {
              commit: data.comparison.target,
              ...(data.commit?.selectedParent ? { parent: data.commit.selectedParent } : {})
            }
          : {
              base: data.comparison.base!,
              target: data.comparison.target,
              strategy: selection.strategy
            }
      if (initializeRange && 'base' in this.selection) {
        this.range = this.selection
        void this.loadLog(1)
      }
    } catch (cause) {
      if (!this.current('changes', request)) return
      this.state.changes = { status: 'error', data: previous, error: this.error(cause) }
    }
    this.requests.delete('changes')
    this.publish()
  }
  private resetSelection(): void {
    this.restoredCommit = null
    this.restoredChangePath = null
    this.restoredChangesScroll = null
    if (this.queryTimer) clearTimeout(this.queryTimer)
    this.queryTimer = null
    this.scroll.log = this.scroll.changes = 0
    this.cancel('log')
    this.cancel('changes')
    this.range = null
    this.selection = null
    this.state.selectedCommit = null
    this.state.log = empty()
    this.state.changes = empty()
    this.resetChangeTree()
    this.clearHistoricalDiff()
    this.publish()
  }
  private resetChangeTree(): void {
    this.collapsedDirectories.clear()
    this.changeTree = buildL3ProjectPathTree([])
    this.changeRows = []
    this.state.selectedChangePath = null
    this.scroll.changes = 0
  }
  private rebuildChangeRows(): void {
    const index = Math.floor(this.scroll.changes / 36)
    const anchor = this.changeRows[index]
    const offset = this.scroll.changes % 36
    this.changeRows = flattenL3ProjectPathTree(this.changeTree, this.collapsedDirectories)
    const next = anchor ? this.changeRows.findIndex((row) => row.key === anchor.key) : -1
    this.scroll.changes =
      next >= 0
        ? next * 36 + offset
        : Math.min(this.scroll.changes, Math.max(0, (this.changeRows.length - 1) * 36))
  }
  private clearHistoricalDiff(): void {
    if (this.files.state.activeDiff?.comparison) this.files.closeDiff()
  }
  private begin(key: 'branches' | 'log' | 'changes'): AbortController {
    this.cancel(key)
    const request = new AbortController()
    this.requests.set(key, request)
    return request
  }
  private cancel(key: 'branches' | 'log' | 'changes'): void {
    this.requests.get(key)?.abort()
    this.requests.delete(key)
  }
  private current(key: 'branches' | 'log' | 'changes', request: AbortController): boolean {
    return !this.disposed && this.requests.get(key) === request
  }
  private error(cause: unknown): string {
    return cause instanceof Error ? cause.message : historyText('historyReadFailed')
  }
  private publish(): void {
    if (this.disposed) return
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}
