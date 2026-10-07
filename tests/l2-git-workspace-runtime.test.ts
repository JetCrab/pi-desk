import assert from 'node:assert/strict'
import { setImmediate as waitImmediate } from 'node:timers/promises'
import test from 'node:test'
import type { L2WorkSessionGitRepositoryReady } from '../src/common/l2_biz/work-session/l2-work-session-git-contract'
import type { L2WorkSessionListItem } from '../src/common/l2_biz/work-session/l2-work-session-contract'
import type { L4GitRepositoryHead } from '../src/common/l4_foundation/git/l4-git-contract'
import { buildL2GitBranchTree } from '../src/client/l2_biz/workbench/git-workspace/l2-git-workspace-model'
import { L2GitWorkspaceRuntime } from '../src/client/l2_biz/workbench/git-workspace/l2-git-workspace-runtime'
import type { L2WorkSessionGitBiz } from '../src/client/l2_biz/workbench/git-workspace/l2-work-session-git-biz'

function workSession(workId: string, cwd: string): L2WorkSessionListItem {
  return {
    workId,
    cwd,
    sessionId: `session-${workId}`,
    branchId: 'v1:main',
    projectName: workId,
    sessionTitle: workId,
    status: 'idle',
    messageCounts: { user: 0, total: 0 },
    lastMessageUpdatedAt: null
  }
}

function repository(branch: string): L2WorkSessionGitRepositoryReady {
  return {
    root: '',
    state: 'ready',
    head: { type: 'branch', name: branch },
    changes: []
  }
}

function repositoryHead(branch: string, root = ''): L4GitRepositoryHead {
  return { root, state: 'ready', head: { type: 'branch', name: branch } }
}

test('本地和远程分支按斜杠构建目录层级', () => {
  const tree = buildL2GitBranchTree([
    'beta',
    'feature/lwh/task-b',
    'feature/lwh/task-a',
    'origin/feature/team/task',
    'origin/main'
  ])

  assert.deepEqual(
    tree.map((node) => ({ name: node.name, branchName: node.branchName })),
    [
      { name: 'beta', branchName: 'beta' },
      { name: 'feature', branchName: null },
      { name: 'origin', branchName: null }
    ]
  )
  const feature = tree.find((node) => node.path === 'feature')
  assert.deepEqual(
    feature?.children[0]?.children.map((node) => node.branchName),
    ['feature/lwh/task-a', 'feature/lwh/task-b']
  )
  const origin = tree.find((node) => node.path === 'origin')
  assert.equal(origin?.children.find((node) => node.name === 'main')?.branchName, 'origin/main')
  assert.equal(
    origin?.children
      .find((node) => node.name === 'feature')
      ?.children.find((node) => node.name === 'team')?.children[0]?.branchName,
    'origin/feature/team/task'
  )
})

test('同 cwd 多消费者共用一次 Git Snapshot 请求', async () => {
  let resolveGet: (value: { repositories: L2WorkSessionGitRepositoryReady[] }) => void = () => {
    throw new Error('Git Snapshot Promise 尚未初始化')
  }
  let getCount = 0
  const biz: L2WorkSessionGitBiz = {
    async getHeads() {
      return { repositories: [repositoryHead('main')] }
    },
    get() {
      getCount += 1
      return new Promise((resolve) => {
        resolveGet = resolve
      })
    },
    async listBranches() {
      return { head: { type: 'branch', name: 'main' }, recent: [], local: ['main'], remote: [] }
    },
    async replaceBranch() {
      return { repository: repository('main') }
    },
    async addBranch() {
      return { repository: repository('feature') }
    },
    async getDiff() {
      return { kind: 'binary' }
    }
  }
  const runtime = new L2GitWorkspaceRuntime(biz, () => undefined)
  const first = workSession('work-1', 'C:/project')
  const second = workSession('work-2', 'C:/project')
  runtime.reconcileWorkSessions([first, second], first.workId)

  const firstRequest = runtime.ensureSnapshot(first.cwd)
  await runtime.ensureSnapshot(second.cwd)
  assert.equal(getCount, 1)
  assert.equal(runtime.getWorkspace(first.cwd)?.snapshot.status, 'loading')

  resolveGet({ repositories: [repository('main')] })
  await firstRequest
  assert.equal(runtime.getWorkspace(first.cwd)?.snapshot.status, 'ready')
  assert.equal(runtime.getWorkspace(first.cwd)?.layout, 'directory')
  runtime.dispose()
})

test('多仓库加载后保持目录视图，同 cwd 分支摘要共用 30 秒最短间隔', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  let getCount = 0
  let getHeadsCount = 0
  const biz: L2WorkSessionGitBiz = {
    async getHeads() {
      getHeadsCount += 1
      return {
        repositories: [repositoryHead('main'), repositoryHead('develop', 'packages/child')]
      }
    },
    async get() {
      getCount += 1
      return {
        repositories: [repository('main'), { ...repository('develop'), root: 'packages/child' }]
      }
    },
    async listBranches() {
      return { head: { type: 'branch', name: 'main' }, recent: [], local: ['main'], remote: [] }
    },
    async replaceBranch() {
      return { repository: repository('main') }
    },
    async addBranch() {
      return { repository: repository('feature') }
    },
    async getDiff() {
      return { kind: 'binary' }
    }
  }
  const runtime = new L2GitWorkspaceRuntime(biz, () => undefined)
  const session = workSession('work-1', 'C:/project')
  runtime.reconcileWorkSessions([session], session.workId)

  await runtime.ensureSnapshot(session.cwd)
  assert.equal(runtime.getWorkspace(session.cwd)?.layout, 'directory')
  assert.deepEqual([...(runtime.getWorkspace(session.cwd)?.expandedRepositories ?? [])], [])
  runtime.setLayout(session.cwd, 'repository')
  assert.equal(runtime.getWorkspace(session.cwd)?.layout, 'repository')
  runtime.toggleRepository(session.cwd, '')
  assert.deepEqual([...(runtime.getWorkspace(session.cwd)?.expandedRepositories ?? [])], [''])
  await runtime.refreshHeads(session.cwd)
  await runtime.refreshHeads(session.cwd)
  assert.equal(getHeadsCount, 1)
  now += 29_999
  await runtime.refreshHeads(session.cwd)
  assert.equal(getHeadsCount, 1)
  now += 1
  await runtime.refreshHeads(session.cwd)
  assert.equal(getHeadsCount, 2)
  assert.equal(getCount, 1)
  await runtime.refreshSnapshot(session.cwd)
  assert.equal(getCount, 2)
  assert.deepEqual([...(runtime.getWorkspace(session.cwd)?.expandedRepositories ?? [])], [''])
  runtime.toggleRepository(session.cwd, '')
  await runtime.refreshSnapshot(session.cwd)
  assert.equal(getCount, 3)
  assert.deepEqual([...(runtime.getWorkspace(session.cwd)?.expandedRepositories ?? [])], [])
  runtime.dispose()
})

test('同 cwd 慢请求不会中止重发，失败后仍按请求开始时间限频', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  let resolveHeads: (value: { repositories: L4GitRepositoryHead[] }) => void = () => {
    throw new Error('分支摘要 Promise 尚未初始化')
  }
  let getHeadsCount = 0
  let requestSignal: AbortSignal | undefined
  const biz: L2WorkSessionGitBiz = {
    getHeads(_input, signal) {
      getHeadsCount += 1
      requestSignal = signal
      if (getHeadsCount === 1) {
        return new Promise((resolve) => {
          resolveHeads = resolve
        })
      }
      if (getHeadsCount === 2) return Promise.reject(new Error('读取 Git 分支失败'))
      return Promise.resolve({ repositories: [repositoryHead('develop')] })
    },
    async get() {
      return { repositories: [repository('main')] }
    },
    async listBranches() {
      return { head: { type: 'branch', name: 'main' }, recent: [], local: ['main'], remote: [] }
    },
    async replaceBranch() {
      return { repository: repository('main') }
    },
    async addBranch() {
      return { repository: repository('feature') }
    },
    async getDiff() {
      return { kind: 'binary' }
    }
  }
  const runtime = new L2GitWorkspaceRuntime(biz, () => undefined)
  t.after(() => runtime.dispose())
  const first = workSession('work-1', 'C:/project')
  const second = workSession('work-2', first.cwd)
  runtime.reconcileWorkSessions([first, second], first.workId)

  const reading = runtime.refreshHeads(first.cwd)
  now += 31_000
  runtime.reconcileWorkSessions([first, second], second.workId)
  await runtime.refreshHeads(second.cwd)
  assert.equal(getHeadsCount, 1)
  assert.equal(requestSignal?.aborted, false)
  resolveHeads({ repositories: [repositoryHead('main')] })
  await reading
  assert.equal(runtime.getWorkspace(first.cwd)?.heads.status, 'ready')

  await runtime.refreshHeads(second.cwd)
  assert.equal(getHeadsCount, 2)
  assert.equal(runtime.getWorkspace(first.cwd)?.heads.status, 'error')
  assert.deepEqual(runtime.getWorkspace(first.cwd)?.heads.repositories, [repositoryHead('main')])
  now += 29_999
  await runtime.refreshHeads(first.cwd)
  assert.equal(getHeadsCount, 2)
  now += 1
  await runtime.refreshHeads(first.cwd)
  assert.equal(getHeadsCount, 3)
  assert.deepEqual(runtime.getWorkspace(first.cwd)?.heads.repositories, [repositoryHead('develop')])
})

test('分支操作替换单仓库 Snapshot 并释放 pending 状态', async () => {
  const changed: Array<{ cwd: string; root: string }> = []
  const biz: L2WorkSessionGitBiz = {
    async getHeads() {
      return { repositories: [repositoryHead('main')] }
    },
    async get() {
      return { repositories: [repository('main')] }
    },
    async listBranches() {
      return { head: { type: 'branch', name: 'main' }, recent: [], local: ['main'], remote: [] }
    },
    async replaceBranch() {
      await waitImmediate()
      return { repository: repository('develop') }
    },
    async addBranch() {
      return { repository: repository('feature/new') }
    },
    async getDiff() {
      return { kind: 'binary' }
    }
  }
  const runtime = new L2GitWorkspaceRuntime(biz, (cwd, root) => changed.push({ cwd, root }))
  const session = workSession('work-1', 'C:/project')
  runtime.reconcileWorkSessions([session], session.workId)
  await runtime.ensureSnapshot(session.cwd)

  const switching = runtime.replaceBranch(session.cwd, '', { type: 'local', name: 'develop' })
  assert.equal(runtime.getWorkspace(session.cwd)?.branchOperations.has(''), true)
  await switching
  assert.equal(runtime.getWorkspace(session.cwd)?.branchOperations.has(''), false)
  const updated = runtime.getWorkspace(session.cwd)?.snapshot.repositories[0]
  assert.equal(updated?.state, 'ready')
  if (updated?.state === 'ready') {
    assert.deepEqual(updated.head, { type: 'branch', name: 'develop' })
  }
  assert.deepEqual(changed, [{ cwd: session.cwd, root: '' }])
  runtime.dispose()
})
