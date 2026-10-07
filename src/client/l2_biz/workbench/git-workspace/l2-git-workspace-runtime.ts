import type {
  L2WorkSessionGitBranchTarget,
  L2WorkSessionGitBranchesListResponse,
  L2WorkSessionGitDiffGetResponse,
  L2WorkSessionGitRepository,
  L2WorkSessionGitRepositoryReady
} from '@common/l2_biz/work-session/l2-work-session-git-contract'
import type { L4GitRepositoryHead } from '@common/l4_foundation/git/l4-git-contract'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L2WorkSessionGitBiz } from './l2-work-session-git-biz'
import { l2WorkbenchText } from '../l2-workbench-text'

const HEADS_REFRESH_MIN_INTERVAL_MS = 30_000

export interface L2GitSnapshotState<Repository = L2WorkSessionGitRepository> {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly repositories: readonly Repository[]
  readonly error: string | null
}

export interface L2GitBranchesState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly data: L2WorkSessionGitBranchesListResponse | null
  readonly error: string | null
}

export interface L2CwdGitWorkspace {
  readonly cwd: string
  readonly heads: L2GitSnapshotState<L4GitRepositoryHead>
  readonly snapshot: L2GitSnapshotState
  readonly branches: ReadonlyMap<string, L2GitBranchesState>
  readonly layout: 'directory' | 'repository'
  readonly changesOnly: boolean
  readonly expandedRepositories: ReadonlySet<string>
  readonly branchOperations: ReadonlySet<string>
}

interface MutableRequest {
  controller: AbortController
  token: object
}

interface MutableCwdGitWorkspace {
  cwd: string
  heads: L2GitSnapshotState<L4GitRepositoryHead>
  headsRequest: MutableRequest | null
  lastHeadsStartedAt: number
  snapshot: L2GitSnapshotState
  snapshotRequest: MutableRequest | null
  branches: Map<string, L2GitBranchesState>
  branchRequests: Map<string, MutableRequest>
  layout: 'directory' | 'repository'
  changesOnly: boolean
  expandedRepositories: Set<string>
  branchOperations: Set<string>
}

interface ProjectRef {
  workId: string
  cwd: string
}

function createWorkspace(cwd: string): MutableCwdGitWorkspace {
  return {
    cwd,
    heads: { status: 'idle', repositories: [], error: null },
    headsRequest: null,
    lastHeadsStartedAt: 0,
    snapshot: { status: 'idle', repositories: [], error: null },
    snapshotRequest: null,
    branches: new Map(),
    branchRequests: new Map(),
    layout: 'directory',
    changesOnly: false,
    expandedRepositories: new Set(),
    branchOperations: new Set()
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof DOMException && cause.name === 'AbortError') return fallback
  return cause instanceof Error ? cause.message : fallback
}

export class L2GitWorkspaceRuntime {
  private readonly listeners = new Set<() => void>()
  private readonly workspaces = new Map<string, MutableCwdGitWorkspace>()
  private readonly projectRefs = new Map<string, ProjectRef>()
  private revision = 0

  constructor(
    private readonly biz: L2WorkSessionGitBiz,
    private readonly onRepositoryChanged: (cwd: string, repositoryRoot: string) => void
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getRevision = (): number => this.revision

  getWorkspace(cwd: string | null): L2CwdGitWorkspace | null {
    if (!cwd) return null
    return this.workspaces.get(cwd) ?? null
  }

  reconcileWorkSessions(
    workSessions: readonly L2WorkSessionListItem[],
    focusedWorkId: string | null
  ): void {
    const next = new Map<string, ProjectRef>()
    const focused = focusedWorkId
      ? (workSessions.find((workSession) => workSession.workId === focusedWorkId) ?? null)
      : null
    if (focused) next.set(focused.cwd, { workId: focused.workId, cwd: focused.cwd })
    for (const workSession of workSessions) {
      if (!next.has(workSession.cwd)) {
        next.set(workSession.cwd, { workId: workSession.workId, cwd: workSession.cwd })
      }
    }

    const changed =
      next.size !== this.projectRefs.size ||
      [...next].some(([cwd, ref]) => this.projectRefs.get(cwd)?.workId !== ref.workId)
    if (!changed) return
    this.projectRefs.clear()
    for (const [cwd, ref] of next) this.projectRefs.set(cwd, ref)
    for (const [cwd, workspace] of this.workspaces) {
      if (next.has(cwd)) continue
      this.abortRequests(workspace)
      this.workspaces.delete(cwd)
    }
  }

  ensureSnapshot(cwd: string): Promise<void> {
    const workspace = this.workspaceFor(cwd)
    if (workspace.snapshot.status === 'ready' || workspace.snapshot.status === 'loading') {
      return Promise.resolve()
    }
    return this.loadSnapshot(cwd, false)
  }

  refreshSnapshot(cwd: string): Promise<void> {
    return this.loadSnapshot(cwd, true)
  }

  async refreshHeads(cwd: string): Promise<void> {
    const workspace = this.workspaceFor(cwd)
    if (
      workspace.headsRequest ||
      Date.now() - workspace.lastHeadsStartedAt < HEADS_REFRESH_MIN_INTERVAL_MS
    ) {
      return
    }
    const project = this.projectRefs.get(cwd)
    if (!project) {
      workspace.heads = {
        ...workspace.heads,
        status: 'error',
        error: l2WorkbenchText('gitNoProjectStatus')
      }
      this.publish()
      return
    }

    const controller = new AbortController()
    const token = {}
    workspace.headsRequest = { controller, token }
    workspace.lastHeadsStartedAt = Date.now()
    workspace.heads = { ...workspace.heads, status: 'loading', error: null }
    this.publish()
    try {
      const result = await this.biz.getHeads(project, controller.signal)
      if (workspace.headsRequest?.token !== token) return
      workspace.headsRequest = null
      workspace.heads = { status: 'ready', repositories: result.repositories, error: null }
      this.publish()
    } catch (cause) {
      if (workspace.headsRequest?.token !== token) return
      workspace.headsRequest = null
      if (controller.signal.aborted) return
      workspace.heads = {
        ...workspace.heads,
        status: 'error',
        error: errorMessage(cause, l2WorkbenchText('gitStatusReadFailed'))
      }
      this.publish()
    }
  }

  setLayout(cwd: string, layout: 'directory' | 'repository'): void {
    const workspace = this.workspaceFor(cwd)
    if (workspace.layout === layout) return
    workspace.layout = layout
    this.publish()
  }

  setChangesOnly(cwd: string, changesOnly: boolean): void {
    const workspace = this.workspaceFor(cwd)
    if (workspace.changesOnly === changesOnly) return
    workspace.changesOnly = changesOnly
    this.publish()
  }

  toggleRepository(cwd: string, repositoryRoot: string): void {
    const workspace = this.workspaceFor(cwd)
    if (workspace.expandedRepositories.has(repositoryRoot)) {
      workspace.expandedRepositories.delete(repositoryRoot)
    } else {
      workspace.expandedRepositories.add(repositoryRoot)
    }
    this.publish()
  }

  async loadBranches(cwd: string, repositoryRoot: string): Promise<void> {
    const workspace = this.workspaceFor(cwd)
    const project = this.projectRefs.get(cwd)
    if (!project) {
      workspace.branches.set(repositoryRoot, {
        status: 'error',
        data: null,
        error: l2WorkbenchText('gitNoProjectBranches')
      })
      this.publish()
      return
    }

    workspace.branchRequests.get(repositoryRoot)?.controller.abort()
    const controller = new AbortController()
    const token = {}
    workspace.branchRequests.set(repositoryRoot, { controller, token })
    workspace.branches.set(repositoryRoot, {
      status: 'loading',
      data: workspace.branches.get(repositoryRoot)?.data ?? null,
      error: null
    })
    this.publish()

    try {
      const data = await this.biz.listBranches({ ...project, repositoryRoot }, controller.signal)
      if (workspace.branchRequests.get(repositoryRoot)?.token !== token) return
      workspace.branchRequests.delete(repositoryRoot)
      workspace.branches.set(repositoryRoot, { status: 'ready', data, error: null })
      this.publish()
    } catch (cause) {
      if (workspace.branchRequests.get(repositoryRoot)?.token !== token) return
      workspace.branchRequests.delete(repositoryRoot)
      if (controller.signal.aborted) return
      workspace.branches.set(repositoryRoot, {
        status: 'error',
        data: null,
        error: errorMessage(cause, l2WorkbenchText('gitBranchesReadFailed'))
      })
      this.publish()
    }
  }

  async replaceBranch(
    cwd: string,
    repositoryRoot: string,
    target: L2WorkSessionGitBranchTarget
  ): Promise<void> {
    const project = this.requireProject(cwd)
    const workspace = this.workspaceFor(cwd)
    if (workspace.branchOperations.has(repositoryRoot)) return
    workspace.branchOperations.add(repositoryRoot)
    this.publish()
    try {
      const result = await this.biz.replaceBranch({ ...project, repositoryRoot, target })
      this.applyRepository(workspace, result.repository)
      this.clearBranches(workspace, repositoryRoot)
      this.onRepositoryChanged(cwd, repositoryRoot)
    } finally {
      workspace.branchOperations.delete(repositoryRoot)
      this.publish()
    }
  }

  async addBranch(
    cwd: string,
    repositoryRoot: string,
    name: string,
    startPoint: L2WorkSessionGitBranchTarget | null
  ): Promise<void> {
    const project = this.requireProject(cwd)
    const workspace = this.workspaceFor(cwd)
    if (workspace.branchOperations.has(repositoryRoot)) return
    workspace.branchOperations.add(repositoryRoot)
    this.publish()
    try {
      const result = await this.biz.addBranch({
        ...project,
        repositoryRoot,
        name,
        startPoint
      })
      this.applyRepository(workspace, result.repository)
      this.clearBranches(workspace, repositoryRoot)
      this.onRepositoryChanged(cwd, repositoryRoot)
    } finally {
      workspace.branchOperations.delete(repositoryRoot)
      this.publish()
    }
  }

  getDiff(
    cwd: string,
    repositoryRoot: string,
    path: string,
    signal?: AbortSignal
  ): Promise<L2WorkSessionGitDiffGetResponse> {
    return this.biz.getDiff({ ...this.requireProject(cwd), repositoryRoot, path }, signal)
  }

  dispose(): void {
    for (const workspace of this.workspaces.values()) this.abortRequests(workspace)
    this.workspaces.clear()
    this.projectRefs.clear()
    this.listeners.clear()
  }

  private async loadSnapshot(cwd: string, force: boolean): Promise<void> {
    const workspace = this.workspaceFor(cwd)
    if (workspace.snapshotRequest && !force) return
    const project = this.projectRefs.get(cwd)
    if (!project) {
      workspace.snapshot = {
        status: 'error',
        repositories: workspace.snapshot.repositories,
        error: l2WorkbenchText('gitNoProjectStatus')
      }
      this.publish()
      return
    }

    workspace.snapshotRequest?.controller.abort()
    const controller = new AbortController()
    const token = {}
    workspace.snapshotRequest = { controller, token }
    workspace.snapshot = {
      status: 'loading',
      repositories: workspace.snapshot.repositories,
      error: null
    }
    this.publish()

    try {
      const result = await this.biz.get(project, controller.signal)
      if (workspace.snapshotRequest?.token !== token) return
      workspace.snapshotRequest = null
      workspace.snapshot = { status: 'ready', repositories: result.repositories, error: null }
      const roots = new Set(result.repositories.map((repository) => repository.root))
      const hasRepositoriesWithoutProjectRoot = result.repositories.length > 0 && !roots.has('')
      if (hasRepositoriesWithoutProjectRoot) roots.add('')
      for (const root of [...workspace.expandedRepositories]) {
        if (!roots.has(root)) workspace.expandedRepositories.delete(root)
      }
      this.publish()
    } catch (cause) {
      if (workspace.snapshotRequest?.token !== token) return
      workspace.snapshotRequest = null
      if (controller.signal.aborted) return
      workspace.snapshot = {
        status: 'error',
        repositories: workspace.snapshot.repositories,
        error: errorMessage(cause, l2WorkbenchText('gitStatusReadFailed'))
      }
      this.publish()
    }
  }

  private requireProject(cwd: string): ProjectRef {
    const project = this.projectRefs.get(cwd)
    if (!project) throw new Error(l2WorkbenchText('gitNoProjectOperation'))
    return project
  }

  private applyRepository(
    workspace: MutableCwdGitWorkspace,
    repository: L2WorkSessionGitRepositoryReady
  ): void {
    workspace.headsRequest?.controller.abort()
    workspace.headsRequest = null
    workspace.snapshotRequest?.controller.abort()
    workspace.snapshotRequest = null
    const head: L4GitRepositoryHead = {
      root: repository.root,
      state: repository.state,
      head: repository.head
    }
    const heads = [...workspace.heads.repositories]
    const headIndex = heads.findIndex((candidate) => candidate.root === repository.root)
    if (headIndex >= 0) heads[headIndex] = head
    else heads.push(head)
    workspace.heads = { status: 'ready', repositories: heads, error: null }
    workspace.lastHeadsStartedAt = Date.now()

    // 分支弹层不再预加载文件快照，单仓库操作结果不能充当项目完整快照。
    if (workspace.snapshot.status === 'idle') return
    const reloadSnapshot = workspace.snapshot.status === 'loading'
    const repositories = [...workspace.snapshot.repositories]
    const index = repositories.findIndex((candidate) => candidate.root === repository.root)
    if (index >= 0) repositories[index] = repository
    else repositories.push(repository)
    workspace.snapshot = {
      status: workspace.snapshot.status === 'ready' ? 'ready' : 'idle',
      repositories,
      error: null
    }
    if (reloadSnapshot) void this.refreshSnapshot(workspace.cwd)
  }

  private abortRequests(workspace: MutableCwdGitWorkspace): void {
    workspace.headsRequest?.controller.abort()
    workspace.headsRequest = null
    workspace.snapshotRequest?.controller.abort()
    workspace.snapshotRequest = null
    for (const request of workspace.branchRequests.values()) request.controller.abort()
    workspace.branchRequests.clear()
  }

  private clearBranches(workspace: MutableCwdGitWorkspace, repositoryRoot: string): void {
    workspace.branchRequests.get(repositoryRoot)?.controller.abort()
    workspace.branchRequests.delete(repositoryRoot)
    workspace.branches.delete(repositoryRoot)
  }

  private workspaceFor(cwd: string): MutableCwdGitWorkspace {
    const existing = this.workspaces.get(cwd)
    if (existing) return existing
    const workspace = createWorkspace(cwd)
    this.workspaces.set(cwd, workspace)
    return workspace
  }

  private publish(): void {
    this.revision += 1
    for (const listener of [...this.listeners]) listener()
  }
}
