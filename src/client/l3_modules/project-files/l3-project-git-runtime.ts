import type { L4GitRepository } from '@common/l4_foundation/git/l4-git-contract'
import type { L3ProjectReader } from './l3-project-reader'

interface GitBrowserState {
  readonly snapshot: {
    readonly status: 'idle' | 'loading' | 'ready' | 'error'
    readonly repositories: readonly L4GitRepository[]
    readonly error: string | null
  }
  readonly layout: 'directory' | 'repository'
  readonly changesOnly: boolean
  readonly expandedRepositories: ReadonlySet<string>
}
export interface L3ProjectGitBrowser {
  subscribe(listener: () => void): () => void
  getRevision(): number
  getWorkspace(cwd: string): GitBrowserState | null
  ensureSnapshot(cwd: string): Promise<void>
  refreshSnapshot(cwd: string): Promise<void>
  setLayout(cwd: string, layout: 'directory' | 'repository'): void
  setChangesOnly(cwd: string, value: boolean): void
  toggleRepository(cwd: string, root: string): void
}

export class L3ProjectGitRuntime implements L3ProjectGitBrowser {
  private state: { -readonly [Key in keyof GitBrowserState]: GitBrowserState[Key] } = {
    snapshot: { status: 'idle', repositories: [], error: null },
    layout: 'directory',
    changesOnly: false,
    expandedRepositories: new Set()
  }
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private request: AbortController | null = null
  private disposed = false
  constructor(
    private readonly cwd: string,
    private readonly reader: Pick<L3ProjectReader, 'snapshot'>
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getRevision = (): number => this.revision
  getWorkspace(cwd: string): GitBrowserState | null {
    return cwd === this.cwd ? this.state : null
  }
  ensureSnapshot(cwd: string): Promise<void> {
    if (cwd !== this.cwd || this.state.snapshot.status === 'ready' || this.request)
      return Promise.resolve()
    return this.load(false)
  }
  refreshSnapshot(cwd: string): Promise<void> {
    return cwd === this.cwd ? this.load(true) : Promise.resolve()
  }
  setLayout(_cwd: string, layout: 'directory' | 'repository'): void {
    this.state.layout = layout
    this.publish()
  }
  setChangesOnly(_cwd: string, value: boolean): void {
    this.state.changesOnly = value
    this.publish()
  }
  toggleRepository(_cwd: string, root: string): void {
    const roots = new Set(this.state.expandedRepositories)
    if (roots.has(root)) roots.delete(root)
    else roots.add(root)
    this.state.expandedRepositories = roots
    this.publish()
  }
  dispose(): void {
    this.disposed = true
    this.request?.abort()
    this.request = null
    this.listeners.clear()
  }
  private async load(refresh: boolean): Promise<void> {
    if (this.disposed) return
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    this.state.snapshot = { ...this.state.snapshot, status: 'loading', error: null }
    this.publish()
    try {
      const result = await this.reader.snapshot(request.signal, refresh)
      if (this.request !== request) return
      this.state.snapshot = { status: 'ready', repositories: result.repositories, error: null }
    } catch (cause) {
      if (this.request !== request) return
      this.state.snapshot = {
        ...this.state.snapshot,
        status: 'error',
        error: cause instanceof Error ? cause.message : '读取 Git 状态失败'
      }
    }
    if (this.request !== request) return
    this.request = null
    this.publish()
  }
  private publish(): void {
    if (this.disposed) return
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}
