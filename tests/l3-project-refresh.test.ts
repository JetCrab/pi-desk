import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { L3ProjectFileRuntime } from '../src/client/l3_modules/project-files/l3-project-file-runtime'
import { L3ProjectGitRuntime } from '../src/client/l3_modules/project-files/l3-project-git-runtime'
import { L2GitWorkspaceRuntime } from '../src/client/l2_biz/workbench/git-workspace/l2-git-workspace-runtime'
import type { L3ProjectFileReader } from '../src/client/l3_modules/project-files/l3-project-reader'
import type { L2WorkSessionGitBiz } from '../src/client/l2_biz/workbench/git-workspace/l2-work-session-git-biz'
import type { L4GitRepository } from '../src/common/l4_foundation/git/l4-git-contract'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve
  }
}
function reader(overrides: Partial<L3ProjectFileReader> = {}): L3ProjectFileReader {
  return {
    async list() {
      return { entries: [{ name: 'before.ts', type: 'file' }], truncated: false }
    },
    async search() {
      return { fileMatches: [], contentMatches: [], truncated: false }
    },
    async get() {
      return { kind: 'text', content: 'before', size: 6 }
    },
    async diff() {
      return {
        kind: 'text',
        original: { path: 'a.ts', content: 'base' },
        modified: { path: 'a.ts', content: 'before' }
      }
    },
    ...overrides
  }
}

test('目录静默刷新合并在途请求并保留展开和滚动', async (context) => {
  const next = deferred<Awaited<ReturnType<L3ProjectFileReader['list']>>>()
  let calls = 0
  const runtime = new L3ProjectFileRuntime(
    '/project',
    reader({
      list: async () =>
        ++calls === 1
          ? { entries: [{ name: 'before.ts', type: 'file' }], truncated: false }
          : next.promise
    }),
    { imagePreviewMode: () => 'original' }
  )
  context.after(() => runtime.dispose())
  await runtime.ensureDirectory('src')
  runtime.setExpandedPaths(new Set(['src']), false)
  runtime.setTreeScrollTop(120)
  const before = runtime.state.directories.get('src')
  runtime.refreshDirectories(['src', 'src'])
  runtime.refreshDirectories(['src'])
  await tick()
  assert.equal(calls, 2)
  assert.equal(runtime.state.directories.get('src'), before)
  next.resolve({ entries: [{ name: 'after.ts', type: 'file' }], truncated: false })
  await tick()
  assert.deepEqual(runtime.state.directories.get('src'), {
    status: 'ready',
    entries: [{ name: 'after.ts', type: 'file' }],
    truncated: false
  })
  assert.deepEqual([...runtime.state.expandedPaths], ['src'])
  assert.equal(runtime.state.treeScrollTop, 120)
})

test('文本重读去重，保持阅读模式和位置，未变化时复用文档', async (context) => {
  let content = 'before'
  let calls = 0
  const runtime = new L3ProjectFileRuntime(
    '/project',
    reader({
      async get() {
        calls += 1
        return { kind: 'text', content, size: content.length }
      }
    }),
    { imagePreviewMode: () => 'original' }
  )
  context.after(() => runtime.dispose())
  runtime.openFile('readme.md')
  await tick()
  runtime.savePreviewScrollTop('readme.md', 230)
  const before = runtime.state.documents.get('readme.md')
  await Promise.all([
    runtime.ensureDocument('readme.md', true),
    runtime.ensureDocument('readme.md', true)
  ])
  assert.equal(calls, 2)
  assert.equal(runtime.state.documents.get('readme.md'), before)
  content = 'after'
  const request = runtime.ensureDocument('readme.md', true)
  assert.equal(runtime.state.documents.get('readme.md'), before)
  await request
  const after = runtime.state.documents.get('readme.md')
  assert.ok(after?.status === 'text')
  assert.equal(after.content, 'after')
  assert.equal(after.previewScrollTop, 230)
  assert.equal(after.viewMode, 'preview')
})

test('图片未变化保留Blob URL，变化及关闭时释放旧资源', async (context) => {
  let data = 'AQID'
  let count = 0
  const revoked: string[] = []
  context.mock.method(URL, 'createObjectURL', () => `blob:${++count}`)
  context.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url))
  const runtime = new L3ProjectFileRuntime(
    '/project',
    reader({
      async get() {
        return { kind: 'image', mimeType: 'image/png', size: 3, data }
      }
    }),
    { imagePreviewMode: () => 'original' }
  )
  context.after(() => runtime.dispose())
  runtime.openFile('image.png')
  await tick()
  const before = runtime.state.documents.get('image.png')
  await runtime.ensureDocument('image.png', true)
  assert.equal(runtime.state.documents.get('image.png'), before)
  assert.equal(count, 1)
  assert.deepEqual(revoked, [])
  data = 'BAUG'
  await runtime.ensureDocument('image.png', true)
  assert.equal(count, 2)
  assert.deepEqual(revoked, ['blob:1'])
  runtime.closeTabs('image.png', 'current')
  assert.deepEqual(revoked, ['blob:1', 'blob:2'])
})

test('工作区Diff静默刷新去重，历史Diff不自动重新读取', async (context) => {
  let content = 'before'
  let calls = 0
  const runtime = new L3ProjectFileRuntime(
    '/project',
    reader({
      async diff() {
        calls += 1
        return {
          kind: 'text',
          original: { path: 'a.ts', content: 'base' },
          modified: { path: 'a.ts', content }
        }
      }
    }),
    { imagePreviewMode: () => 'original' }
  )
  context.after(() => runtime.dispose())
  runtime.openDiff('', 'a.ts')
  await tick()
  const diff = runtime.state.activeDiff
  content = 'after'
  runtime.refreshDiff()
  runtime.refreshDiff()
  assert.equal(diff?.status, 'text')
  await tick()
  assert.equal(calls, 2)
  assert.equal(runtime.state.activeDiff, diff)
  assert.ok(diff?.status === 'text')
  assert.equal(diff.modified.content, 'after')
  runtime.openDiff('', 'a.ts', { baseCommit: null, targetCommit: 'a'.repeat(40) })
  await tick()
  runtime.refreshDiff()
  await tick()
  assert.equal(calls, 3)
})

test('独立预览和工作台Git在刷新期间保留快照且不并发重复查询', async () => {
  for (const workbench of [false, true]) {
    const next = deferred<{ repositories: L4GitRepository[] }>()
    let calls = 0
    const get = async (): Promise<{ repositories: L4GitRepository[] }> => {
      calls += 1
      return calls === 1 ? { repositories: [] } : next.promise
    }
    const unused = async (): Promise<never> => {
      throw new Error('本用例不应调用其他 Git 操作')
    }
    const biz: L2WorkSessionGitBiz = {
      get,
      getHeads: unused,
      listBranches: unused,
      replaceBranch: unused,
      addBranch: unused,
      getDiff: unused
    }
    const runtime = workbench
      ? new L2GitWorkspaceRuntime(biz, () => {})
      : new L3ProjectGitRuntime('/project', { snapshot: get })
    try {
      if (runtime instanceof L2GitWorkspaceRuntime)
        runtime.reconcileWorkSessions([], null, [{ workId: 'preview', cwd: '/project' }])
      await runtime.ensureSnapshot('/project')
      const before = runtime.getWorkspace('/project')?.snapshot
      const request = runtime.refreshSnapshot('/project')
      await runtime.refreshSnapshot('/project')
      assert.equal(calls, 2)
      assert.equal(runtime.getWorkspace('/project')?.snapshot, before)
      assert.equal(before?.status, 'ready')
      next.resolve({
        repositories: [
          { root: '', state: 'ready', head: { type: 'branch', name: 'main' }, changes: [] }
        ]
      })
      await request
      assert.equal(runtime.getWorkspace('/project')?.snapshot.repositories.length, 1)
    } finally {
      runtime.dispose()
    }
  }
})
