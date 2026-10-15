import assert from 'node:assert/strict'
import { setImmediate as waitImmediate } from 'node:timers/promises'
import test from 'node:test'
import type { L2WorkSessionListItem } from '../src/common/l2_biz/work-session/l2-work-session-contract'
import type { L2WorkSessionFileGetResponse } from '../src/common/l2_biz/work-session/l2-work-session-file-contract'
import { L2FileWorkspaceRuntime } from '../src/client/l2_biz/workbench/file-workspace/l2-file-workspace-runtime'
import type { L2WorkSessionFilesBiz } from '../src/client/l2_biz/workbench/file-workspace/l2-work-session-files-biz'
import { L3ProjectRequestError } from '../src/client/l3_modules/project-files/l3-project-reader'
import type { L2WorkSessionGitBiz } from '../src/client/l2_biz/workbench/git-workspace/l2-work-session-git-biz'
import type { L4CodePreviewState } from '../src/client/l4_foundation/ui/code/l4-code-preview'

function workSession(workId: string, cwd = 'C:/project'): L2WorkSessionListItem {
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

function fileBiz(overrides: Partial<L2WorkSessionFilesBiz> = {}): L2WorkSessionFilesBiz {
  return {
    async list() {
      return { entries: [], truncated: false }
    },
    async search() {
      return { matches: [], truncated: false }
    },
    async reveal() {
      return {}
    },
    async get(input) {
      return { kind: 'text', content: input.path, size: input.path.length }
    },
    ...overrides
  }
}

function gitBiz(): L2WorkSessionGitBiz {
  const repository = {
    root: '',
    state: 'ready' as const,
    head: { type: 'branch' as const, name: 'main' },
    changes: []
  }
  return {
    async getHeads() {
      return {
        repositories: [{ root: repository.root, state: repository.state, head: repository.head }]
      }
    },
    async get() {
      return { repositories: [repository] }
    },
    async listBranches() {
      return { head: repository.head, recent: [], local: ['main'], remote: [] }
    },
    async replaceBranch() {
      return { repository }
    },
    async addBranch() {
      return { repository }
    },
    async getDiff(input) {
      return {
        kind: 'text',
        original: { path: input.path, content: 'before\n' },
        modified: { path: input.path, content: 'after\n' }
      }
    }
  }
}

test('多目录按根隔离文件状态，默认推送不覆盖手动选择', async () => {
  const requests: string[] = []
  const runtime = new L2FileWorkspaceRuntime(
    fileBiz({
      async get(input) {
        requests.push(`${input.cwd}:${input.path}`)
        return { kind: 'text', content: input.cwd, size: input.cwd.length }
      }
    }),
    gitBiz()
  )
  const session = workSession('a')
  runtime.reconcileWorkSessions([session])
  assert.deepEqual(runtime.getDirectories('a'), [session.cwd])
  runtime.openFile('a', 'README.md')
  runtime.setExpandedPaths('a', new Set(['src']))
  runtime.setSearchQuery('a', 'readme')
  await waitImmediate()
  const original = runtime.getWorkspace('a')?.documents.get('README.md')
  const state = { directories: ['C:/isolated'], defaultDirectory: 'C:/isolated' }
  runtime.applyPreviewDirectories(session, state)
  assert.equal(runtime.getDirectory('a'), 'C:/isolated')
  runtime.openFile('a', 'README.md')
  await waitImmediate()
  const isolated = runtime.getWorkspace('a')?.documents.get('README.md')
  assert.notEqual(isolated, original)
  assert.equal(isolated?.status, 'text')
  if (isolated?.status === 'text') assert.equal(isolated.content, 'C:/isolated')

  runtime.selectDirectory('a', session.cwd)
  runtime.applyPreviewDirectories(session, structuredClone(state))
  assert.equal(runtime.getDirectory('a'), session.cwd)
  assert.equal(runtime.getWorkspace('a')?.documents.get('README.md'), original)
  assert.equal(runtime.getWorkspace('a')?.expandedPaths.has('src'), true)
  assert.equal(runtime.getWorkspace('a')?.search.query, 'readme')
  runtime.applyPreviewDirectories(session, {
    directories: ['C:/isolated', 'C:/extra'],
    defaultDirectory: 'C:/isolated'
  })
  assert.equal(runtime.getDirectory('a'), session.cwd)
  runtime.selectDirectory('a', 'C:/isolated')
  assert.equal(runtime.getWorkspace('a')?.documents.get('README.md'), isolated)
  assert.deepEqual(requests, ['C:/project:README.md', 'C:/isolated:README.md'])
  runtime.dispose()
})

test('预览根随Source失效释放，迟到登记不影响新会话', async () => {
  const requests: AbortSignal[] = []
  const runtime = new L2FileWorkspaceRuntime(
    fileBiz({
      get(_input, signal) {
        if (signal) requests.push(signal)
        return new Promise(() => undefined)
      }
    }),
    gitBiz()
  )
  const session = workSession('a')
  runtime.reconcileWorkSessions([session])
  runtime.applyPreviewDirectories(session, {
    directories: ['C:/isolated'],
    defaultDirectory: 'C:/isolated'
  })
  runtime.openFile('a', 'pending.ts')
  runtime.applyPreviewDirectories(session, { directories: [], defaultDirectory: null })
  assert.equal(requests[0]?.aborted, true)
  assert.deepEqual(runtime.getDirectories('a'), [session.cwd])
  assert.equal(runtime.getDirectory('a'), session.cwd)
  runtime.reconcileWorkSessions([{ ...session, branchId: 'v1:new' }])
  runtime.applyPreviewDirectories(session, {
    directories: ['C:/old-branch'],
    defaultDirectory: 'C:/old-branch'
  })
  assert.deepEqual(runtime.getDirectories('a'), [session.cwd])
  assert.equal(runtime.getDirectory('a'), session.cwd)
  runtime.dispose()
})

test('同项目会话独立保留文件，收起恢复和焦点快照不重新读取正文', async () => {
  const requests: string[] = []
  const runtime = new L2FileWorkspaceRuntime(
    fileBiz({
      async get(input) {
        requests.push(`${input.workId}:${input.path}`)
        return { kind: 'text', content: input.path, size: input.path.length }
      }
    }),
    gitBiz()
  )
  const first = workSession('a')
  const second = workSession('b')
  runtime.reconcileWorkSessions([first, second])
  runtime.openFile(first.workId, 'a.ts')
  runtime.openFile(second.workId, 'b.ts')
  await waitImmediate()
  assert.deepEqual(runtime.getWorkspace('a')?.tabs, ['a.ts'])
  assert.deepEqual(runtime.getWorkspace('b')?.tabs, ['b.ts'])

  const state: L4CodePreviewState = {
    cursorState: [],
    viewState: {
      scrollTop: 420,
      scrollLeft: 16,
      firstPosition: { lineNumber: 1, column: 1 },
      firstPositionDeltaTop: 0
    },
    contributionsState: {}
  }
  runtime.saveEditorState('a', 'a.ts', state)
  runtime.hideWindow('a')
  assert.equal(runtime.getWorkspace('b')?.windowOpen, true)
  runtime.showWindow('a')
  const revision = runtime.getRevision()
  runtime.reconcileWorkSessions([second, first])
  assert.equal(runtime.getRevision(), revision)
  runtime.openFile('a', 'a.ts')
  await waitImmediate()
  const restored = runtime.getWorkspace('a')?.documents.get('a.ts')
  assert.equal(restored?.status, 'text')
  if (restored?.status === 'text') assert.equal(restored.editorState, state)
  assert.deepEqual(requests, ['a:a.ts', 'b:b.ts'])
  runtime.dispose()
})

test('相同路径在两个会话中分别打开，所有请求使用真实来源 workId', async () => {
  const calls: string[] = []
  const runtime = new L2FileWorkspaceRuntime(
    fileBiz({
      async get(input) {
        calls.push(`get:${input.workId}`)
        return { kind: 'text', content: input.workId, size: input.workId.length }
      },
      async reveal(input) {
        calls.push(`reveal:${input.workId}`)
        return {}
      }
    }),
    gitBiz()
  )
  runtime.reconcileWorkSessions([workSession('a'), workSession('b')])
  runtime.openFile('a', 'README.md')
  runtime.openFile('b', 'README.md')
  await runtime.revealFile('a', 'README.md')
  await waitImmediate()
  runtime.closeFile('a', 'README.md')
  assert.deepEqual(runtime.getWorkspace('a')?.tabs, [])
  assert.equal(runtime.getWorkspace('a')?.windowOpen, false)
  assert.equal(runtime.getWorkspace('a')?.activePane, 'chat')
  assert.deepEqual(runtime.getWorkspace('b')?.tabs, ['README.md'])
  assert.deepEqual(calls, ['get:a', 'get:b', 'reveal:a'])
  runtime.dispose()
})

test('消息绝对路径与项目相对路径复用标签，目录前缀不误匹配', async () => {
  const runtime = new L2FileWorkspaceRuntime(fileBiz(), gitBiz())
  runtime.reconcileWorkSessions([workSession('a')])
  runtime.openFile('a', 'src/app.ts')
  runtime.openFile('a', 'c:\\project\\src\\APP.ts')
  runtime.openFile('a', 'C:/project-other/app.ts')
  await waitImmediate()
  assert.deepEqual(runtime.getWorkspace('a')?.tabs, ['src/app.ts', 'C:/project-other/app.ts'])
  runtime.dispose()
})

test('文件和聊天的当前视图独立于窗口显隐，放大只保留一个会话', async () => {
  const runtime = new L2FileWorkspaceRuntime(fileBiz(), gitBiz())
  runtime.reconcileWorkSessions([workSession('a'), workSession('b')])
  runtime.showWindow('a')
  assert.equal(runtime.getWorkspace('a')?.windowOpen, false)
  runtime.openFile('a', 'a.ts')
  runtime.openFile('b', 'b.ts')
  runtime.setActivePane('a', 'chat')
  assert.equal(runtime.getWorkspace('a')?.windowOpen, true)
  assert.equal(runtime.getWorkspace('a')?.activePane, 'chat')
  assert.equal(runtime.getWorkspace('b')?.activePane, 'files')
  runtime.expandWindow('a')
  runtime.expandWindow('b')
  assert.equal(runtime.getExpandedWorkId(), 'b')
  runtime.collapseExpandedWindow()
  assert.equal(runtime.getExpandedWorkId(), null)
  assert.equal(runtime.getWorkspace('a')?.windowOpen, true)
  assert.equal(runtime.getWorkspace('b')?.windowOpen, true)
  runtime.hideWindow('a')
  assert.equal(runtime.getWorkspace('a')?.activePane, 'chat')
  assert.equal(runtime.getWorkspace('b')?.windowOpen, true)
  await waitImmediate()
  runtime.dispose()
})

for (const path of ['report.html', 'README.MD', 'guide.markdown']) {
  test(`${path}默认预览，项目、消息及插件入口复用文档和源码模式`, async () => {
    const runtime = new L2FileWorkspaceRuntime(fileBiz(), gitBiz())
    try {
      runtime.reconcileWorkSessions([workSession('a')])
      runtime.openFile('a', path)
      await waitImmediate()
      const document = runtime.getWorkspace('a')?.documents.get(path)
      assert.equal(document?.status, 'text')
      if (document?.status === 'text') assert.equal(document.viewMode, 'preview')
      runtime.setTextViewMode('a', path, 'source')
      runtime.hideWindow('a')
      runtime.openFile('a', path)
      assert.equal(runtime.getWorkspace('a')?.documents.get(path), document)
      if (document?.status === 'text') assert.equal(document.viewMode, 'source')
      assert.deepEqual(runtime.getWorkspace('a')?.tabs, [path])
    } finally {
      runtime.dispose()
    }
  })
}

test('Markdown滚动不广播，切换与重读保留位置，关闭文件后释放', async () => {
  const runtime = new L2FileWorkspaceRuntime(fileBiz(), gitBiz())
  try {
    runtime.reconcileWorkSessions([workSession('a')])
    runtime.openFile('a', 'guide.md')
    await waitImmediate()
    const files = runtime.getFileRuntime('a')
    const revision = files.getRevision()
    files.savePreviewScrollTop('guide.md', 640)
    assert.equal(files.getRevision(), revision)
    files.setTextViewMode('guide.md', 'source')
    files.reloadFile('guide.md')
    await waitImmediate()
    const reloaded = files.state.documents.get('guide.md')
    assert.equal(reloaded?.status, 'text')
    if (reloaded?.status === 'text') {
      assert.equal(reloaded.previewScrollTop, 640)
      assert.equal(reloaded.viewMode, 'source')
    }
    files.closeTabs('guide.md', 'current')
    files.openFile('guide.md')
    await waitImmediate()
    const reopened = files.state.documents.get('guide.md')
    if (reopened?.status !== 'text') assert.fail('重新打开文档失败')
    assert.equal(reopened.previewScrollTop, 0)
    assert.equal(reopened.viewMode, 'preview')
    files.openFile('code.ts')
    await waitImmediate()
    const code = files.state.documents.get('code.ts')
    if (code?.status !== 'text') assert.fail('打开代码失败')
    assert.equal(code.viewMode, 'source')
  } finally {
    runtime.dispose()
  }
})

test('来源替换或删除中止请求，迟到正文不会重新进入工作区', async () => {
  const pending: {
    signal: AbortSignal | undefined
    resolve: (response: L2WorkSessionFileGetResponse) => void
  }[] = []
  const runtime = new L2FileWorkspaceRuntime(
    fileBiz({
      get(_input, signal) {
        return new Promise((resolve) => pending.push({ signal, resolve }))
      }
    }),
    gitBiz()
  )
  const first = workSession('a')
  runtime.reconcileWorkSessions([first])
  runtime.openFile('a', 'old.ts')
  runtime.expandWindow('a')
  runtime.reconcileWorkSessions([{ ...first, branchId: 'v1:other' }])
  assert.equal(pending[0]?.signal?.aborted, true)
  assert.equal(runtime.getWorkspace('a'), null)
  assert.equal(runtime.getExpandedWorkId(), null)
  runtime.openFile('a', 'new.ts')
  pending[0]!.resolve({ kind: 'text', content: 'old', size: 3 })
  pending[1]!.resolve({ kind: 'text', content: 'new', size: 3 })
  await waitImmediate()
  assert.deepEqual(runtime.getWorkspace('a')?.tabs, ['new.ts'])
  assert.equal(runtime.getWorkspace('a')?.documents.has('old.ts'), false)
  runtime.reconcileWorkSessions([])
  assert.equal(runtime.getWorkspace('a'), null)
  assert.throws(() => runtime.openFile('a', 'new.ts'), /来源已变化/)
  runtime.dispose()
})

test('同 workId 的 sessionId 或 cwd 替换只清理对应会话', async () => {
  const runtime = new L2FileWorkspaceRuntime(fileBiz(), gitBiz())
  const a = workSession('a')
  const b = workSession('b')
  runtime.reconcileWorkSessions([a, b])
  runtime.openFile('a', 'a.ts')
  runtime.openFile('b', 'b.ts')
  await waitImmediate()
  const changed = { ...a, sessionId: 'new-session' }
  runtime.reconcileWorkSessions([changed, b])
  assert.equal(runtime.getWorkspace('a'), null)
  assert.deepEqual(runtime.getWorkspace('b')?.tabs, ['b.ts'])
  runtime.openFile('a', 'a.ts')
  runtime.reconcileWorkSessions([{ ...changed, cwd: 'C:/other' }, b])
  assert.equal(runtime.getWorkspace('a'), null)
  assert.deepEqual(runtime.getWorkspace('b')?.tabs, ['b.ts'])
  await waitImmediate()
  runtime.dispose()
})

test('关闭正在读取的文件丢弃迟到响应，重新打开保留新的请求', async () => {
  const responses: ((response: L2WorkSessionFileGetResponse) => void)[] = []
  const runtime = new L2FileWorkspaceRuntime(
    fileBiz({
      get() {
        return new Promise((resolve) => responses.push(resolve))
      }
    }),
    gitBiz()
  )
  runtime.reconcileWorkSessions([workSession('a')])
  runtime.openFile('a', 'a.ts')
  runtime.closeFile('a', 'a.ts')
  runtime.openFile('a', 'a.ts')
  responses[0]!({ kind: 'text', content: 'old', size: 3 })
  responses[1]!({ kind: 'text', content: 'new', size: 3 })
  await waitImmediate()
  const document = runtime.getWorkspace('a')?.documents.get('a.ts')
  assert.equal(document?.status, 'text')
  if (document?.status === 'text') assert.equal(document.content, 'new')
  runtime.dispose()
})

test('Git工作树切换同时失效同项目会话，缺失文件按需关闭', async () => {
  let missing = false
  const notices: string[] = []
  const runtime = new L2FileWorkspaceRuntime(
    fileBiz({
      async get(input) {
        if (missing)
          throw new L3ProjectRequestError(
            404,
            404,
            'The file no longer exists',
            'errors:fileMissing'
          )
        return { kind: 'text', content: input.path, size: input.path.length }
      }
    }),
    gitBiz(),
    (message) => notices.push(message)
  )
  runtime.reconcileWorkSessions([workSession('a'), workSession('b'), workSession('c', 'C:/other')])
  for (const id of ['a', 'b', 'c']) runtime.openFile(id, 'removed.ts')
  await waitImmediate()
  missing = true
  runtime.handleGitBranchChanged('C:/project', '')
  await waitImmediate()
  assert.deepEqual(runtime.getWorkspace('a')?.tabs, [])
  assert.deepEqual(runtime.getWorkspace('b')?.tabs, [])
  assert.deepEqual(runtime.getWorkspace('c')?.tabs, ['removed.ts'])
  assert.equal(notices.length, 2)
  runtime.dispose()
})

test('会话内聊天宽度比例按workId记忆并随来源释放', async () => {
  const runtime = new L2FileWorkspaceRuntime(fileBiz(), gitBiz())
  const first = workSession('a')
  const second = workSession('b')
  runtime.reconcileWorkSessions([first, second])
  runtime.openFile('a', 'a.ts')
  runtime.openFile('b', 'b.ts')
  await waitImmediate()

  assert.equal(runtime.getWorkspace('a')?.chatWidthPercent, 50)
  assert.equal(runtime.getWorkspace('b')?.chatWidthPercent, 50)
  let publishes = 0
  const unsubscribe = runtime.subscribe(() => {
    publishes += 1
  })
  runtime.setChatWidthPercent('a', 62.5)
  assert.equal(publishes, 1)
  assert.equal(runtime.getWorkspace('a')?.chatWidthPercent, 62.5)
  assert.equal(runtime.getWorkspace('b')?.chatWidthPercent, 50)

  const unchangedRevision = runtime.getRevision()
  for (const percentage of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 100, 101, 62.5005]) {
    runtime.setChatWidthPercent('a', percentage)
  }
  assert.equal(runtime.getRevision(), unchangedRevision)
  assert.equal(runtime.getWorkspace('a')?.chatWidthPercent, 62.5)

  runtime.setChatWidthPercent('a', 62.502)
  assert.equal(runtime.getWorkspace('a')?.chatWidthPercent, 62.502)
  assert.equal(runtime.getWorkspace('b')?.chatWidthPercent, 50)
  runtime.hideWindow('a')
  runtime.showWindow('a')
  assert.equal(runtime.getWorkspace('a')?.chatWidthPercent, 62.502)

  runtime.reconcileWorkSessions([{ ...first, branchId: 'v2:main' }, second])
  assert.equal(runtime.getWorkspace('a'), null)
  assert.equal(runtime.getWorkspace('b')?.chatWidthPercent, 50)
  runtime.openFile('a', 'new.ts')
  assert.equal(runtime.getWorkspace('a')?.chatWidthPercent, 50)
  runtime.setChatWidthPercent('missing', 40)
  unsubscribe()
  runtime.dispose()
  assert.equal(runtime.getWorkspace('a'), null)
  assert.equal(runtime.getWorkspace('b'), null)
})

test('Diff与普通文件互斥但不影响其他会话的Diff', async () => {
  const runtime = new L2FileWorkspaceRuntime(fileBiz(), gitBiz())
  runtime.reconcileWorkSessions([workSession('a'), workSession('b')])
  runtime.openDiff('a', '', 'app.ts')
  runtime.openDiff('b', '', 'app.ts')
  await waitImmediate()
  assert.equal(runtime.getWorkspace('a')?.activeDiff?.status, 'text')
  runtime.openFile('a', 'app.ts')
  await waitImmediate()
  assert.equal(runtime.getWorkspace('a')?.activeDiff, null)
  assert.equal(runtime.getWorkspace('b')?.activeDiff?.status, 'text')
  runtime.dispose()
})

test('closeTabs按普通标签后Diff的顺序批量关闭并只发布一次', async () => {
  const createRuntime = async (): Promise<L2FileWorkspaceRuntime> => {
    const runtime = new L2FileWorkspaceRuntime(fileBiz(), gitBiz())
    runtime.reconcileWorkSessions([workSession('a')])
    runtime.openFile('a', 'one.ts')
    runtime.openFile('a', 'two.ts')
    runtime.openFile('a', 'three.ts')
    runtime.openDiff('a', '', 'app.ts')
    await waitImmediate()
    return runtime
  }

  const leftRuntime = await createRuntime()
  let leftPublishes = 0
  const unsubscribeLeft = leftRuntime.subscribe(() => {
    leftPublishes += 1
  })
  leftRuntime.closeTabs('a', 'two.ts', 'left')
  assert.equal(leftPublishes, 1)
  assert.deepEqual(leftRuntime.getWorkspace('a')?.tabs, ['two.ts', 'three.ts'])
  assert.equal(leftRuntime.getWorkspace('a')?.activeDiff?.status, 'text')
  unsubscribeLeft()
  leftRuntime.dispose()

  const rightRuntime = await createRuntime()
  let rightPublishes = 0
  const unsubscribeRight = rightRuntime.subscribe(() => {
    rightPublishes += 1
  })
  rightRuntime.closeTabs('a', 'two.ts', 'right')
  assert.equal(rightPublishes, 1)
  assert.deepEqual(rightRuntime.getWorkspace('a')?.tabs, ['one.ts', 'two.ts'])
  assert.equal(rightRuntime.getWorkspace('a')?.activeDiff, null)
  unsubscribeRight()
  rightRuntime.dispose()

  const diffRuntime = await createRuntime()
  diffRuntime.closeTabs('a', null, 'left')
  assert.deepEqual(diffRuntime.getWorkspace('a')?.tabs, [])
  assert.equal(diffRuntime.getWorkspace('a')?.activeDiff?.status, 'text')
  assert.equal(diffRuntime.getWorkspace('a')?.windowOpen, true)
  diffRuntime.closeTabs('a', null, 'current')
  assert.equal(diffRuntime.getWorkspace('a')?.activeDiff, null)
  assert.equal(diffRuntime.getWorkspace('a')?.windowOpen, false)
  assert.equal(diffRuntime.getWorkspace('a')?.activePane, 'chat')
  diffRuntime.dispose()

  const allRuntime = await createRuntime()
  let allPublishes = 0
  const unsubscribeAll = allRuntime.subscribe(() => {
    allPublishes += 1
  })
  allRuntime.closeTabs('a', 'two.ts', 'all')
  assert.equal(allPublishes, 1)
  assert.deepEqual(allRuntime.getWorkspace('a')?.tabs, [])
  assert.equal(allRuntime.getWorkspace('a')?.activePath, null)
  assert.equal(allRuntime.getWorkspace('a')?.activeDiff, null)
  assert.equal(allRuntime.getWorkspace('a')?.windowOpen, false)
  assert.equal(allRuntime.getWorkspace('a')?.activePane, 'chat')
  unsubscribeAll()
  allRuntime.dispose()
})

test('批量关闭和来源释放时回收图片Blob URL', async (context) => {
  Object.defineProperty(globalThis, 'window', { value: { atob }, configurable: true })
  context.after(() => Reflect.deleteProperty(globalThis, 'window'))
  let sequence = 0
  const released: string[] = []
  context.mock.method(URL, 'createObjectURL', () => `blob:${++sequence}`)
  context.mock.method(URL, 'revokeObjectURL', (url: string) => released.push(url))
  const runtime = new L2FileWorkspaceRuntime(
    fileBiz({
      async get() {
        return { kind: 'image', mimeType: 'image/png', data: 'AA==', size: 1 }
      }
    }),
    gitBiz()
  )
  runtime.reconcileWorkSessions([workSession('a'), workSession('b')])
  runtime.openFile('a', 'one.png')
  runtime.openFile('b', 'two.png')
  await waitImmediate()
  runtime.hideWindow('a')
  assert.deepEqual(released, [])
  runtime.closeTabs('a', 'one.png', 'all')
  assert.equal(runtime.getWorkspace('a')?.windowOpen, false)
  assert.deepEqual(released, ['blob:1'])
  runtime.reconcileWorkSessions([workSession('a')])
  runtime.openFile('a', 'three.png')
  await waitImmediate()
  runtime.dispose()
  assert.deepEqual(released, ['blob:1', 'blob:2', 'blob:3'])
})
