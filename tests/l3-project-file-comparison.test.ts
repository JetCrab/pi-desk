import assert from 'node:assert/strict'
import test from 'node:test'
import { L3ProjectFileRuntime } from '../src/client/l3_modules/project-files/l3-project-file-runtime'
import { findL3GitFile } from '../src/client/l3_modules/project-files/l3-project-git-model'
import type { L3ProjectFileReader } from '../src/client/l3_modules/project-files/l3-project-reader'
import type { L4GitPreviewDiff } from '../src/common/l4_foundation/git/l4-git-history-contract'
import type { L4GitRepository } from '../src/common/l4_foundation/git/l4-git-contract'

function createRuntime(diff: L3ProjectFileReader['diff']): L3ProjectFileRuntime {
  return new L3ProjectFileRuntime(
    'C:/project',
    {
      async list() {
        return { entries: [], truncated: false }
      },
      async search() {
        return { fileMatches: [], contentMatches: [], truncated: false }
      },
      async get() {
        return { kind: 'text', content: 'cached', size: 6 }
      },
      diff
    },
    { imagePreviewMode: () => 'original' }
  )
}
const target = { repositoryRoot: 'nested', path: 'file.ts' }
const changed: L4GitPreviewDiff = {
  kind: 'text',
  original: { path: 'old.ts', content: 'before\n' },
  modified: { path: 'file.ts', content: 'after\n新增\n' }
}

test('行标记正文与基线原子更新，跳转 Diff 使用同一快照而非再次读取', async () => {
  let calls = 0
  let result = changed
  const runtime = createRuntime(async () => {
    calls += 1
    return result
  })
  try {
    runtime.openFile('nested/file.ts')
    await runtime.ensureDocument('nested/file.ts')
    await runtime.compareFile('nested/file.ts', target, new AbortController().signal)
    const document = runtime.state.documents.get('nested/file.ts')
    assert.equal(document?.status, 'text')
    if (document?.status !== 'text') return
    assert.equal(document.content, 'after\n新增\n')
    assert.equal(document.size, Buffer.byteLength(document.content))
    assert.equal(document.comparison?.status, 'ready')
    runtime.openFileDiff('nested/file.ts', 2)
    const diff = runtime.state.activeDiff
    assert.equal(diff?.status, 'text')
    if (diff?.status !== 'text') return
    assert.equal(diff.original.content, 'before\n')
    assert.equal(diff.original.path, 'old.ts')
    assert.equal(diff.modified.content, document.content)
    assert.equal(diff.repositoryRoot, 'nested')
    assert.equal(diff.path, 'file.ts')
    assert.equal(diff.initialLine, 2)
    assert.equal(calls, 1)
    runtime.openFile('nested/file.ts')
    result = {
      kind: 'text',
      original: { path: 'old.ts', content: 'before\n' },
      modified: { path: 'file.ts', content: 'newer snapshot\n' }
    }
    await runtime.compareFile('nested/file.ts', target, new AbortController().signal)
    runtime.openFileDiff('nested/file.ts', 1)
    const reopened = runtime.state.activeDiff
    assert.equal(runtime.state.diffs.length, 1)
    assert.ok(reopened?.status === 'text')
    assert.equal(reopened.modified.content, 'newer snapshot\n')
    assert.equal(reopened.initialLine, 1)
    assert.equal(calls, 2)
  } finally {
    runtime.dispose()
  }
})

test('取消、关闭重开和重载均不允许迟到比较覆盖当前文件', async () => {
  for (const action of ['abort', 'close', 'reload'] as const) {
    let resolve!: (result: L4GitPreviewDiff) => void
    const runtime = createRuntime(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    try {
      runtime.openFile('file.ts')
      await runtime.ensureDocument('file.ts')
      const controller = new AbortController()
      const request = runtime.compareFile(
        'file.ts',
        { repositoryRoot: '', path: 'file.ts' },
        controller.signal
      )
      if (action === 'abort') controller.abort()
      if (action === 'close') {
        runtime.closeTabs('file.ts', 'current')
        runtime.openFile('file.ts')
      }
      if (action === 'reload') runtime.reloadFile('file.ts')
      await runtime.ensureDocument('file.ts')
      resolve(changed)
      await request
      const document = runtime.state.documents.get('file.ts')
      assert.equal(document?.status, 'text')
      if (document?.status === 'text') assert.equal(document.content, 'cached', action)
    } finally {
      runtime.dispose()
    }
  }
})

test('比较失败或不支持时保留源码，清除 Git 状态会移除旧标记', async () => {
  let result: L4GitPreviewDiff = changed
  const runtime = createRuntime(async () => result)
  try {
    runtime.openFile('file.ts')
    await runtime.ensureDocument('file.ts')
    await runtime.compareFile('file.ts', target, new AbortController().signal)
    result = { kind: 'too_large' }
    await runtime.compareFile('file.ts', target, new AbortController().signal)
    const document = runtime.state.documents.get('file.ts')
    assert.equal(document?.status, 'text')
    if (document?.status !== 'text') return
    assert.equal(document.content, 'after\n新增\n')
    assert.equal(document.comparison?.status, 'unavailable')
    await runtime.compareFile('file.ts', null, new AbortController().signal)
    assert.equal(document.comparison, undefined)
  } finally {
    runtime.dispose()
  }
})

test('文件匹配最内层仓库，Windows大小写与路径边界不串仓库', () => {
  const repositories: L4GitRepository[] = [
    { root: '', state: 'ready', head: { type: 'branch', name: 'main' }, changes: [] },
    {
      root: 'nested',
      state: 'ready',
      head: { type: 'branch', name: 'dev' },
      changes: [{ path: 'File.ts', oldPath: null, indexStatus: null, worktreeStatus: 'modified' }]
    }
  ]
  const found = findL3GitFile('C:/project', 'NESTED/file.ts', repositories)
  assert.equal(found?.repository.root, 'nested')
  assert.equal(found?.change?.worktreeStatus, 'modified')
  assert.equal(
    findL3GitFile('C:/project', 'nested-other/file.ts', repositories)?.repository.root,
    ''
  )
  assert.equal(findL3GitFile('C:/project', 'C:/outside/file.ts', repositories), null)
  assert.equal(findL3GitFile('/project', '/outside/file.ts', repositories), null)
  assert.equal(findL3GitFile('/project', 'NESTED/file.ts', repositories)?.repository.root, '')
  assert.equal(
    findL3GitFile('C:/project', 'nested/file.ts', [
      repositories[0]!,
      { root: 'nested', state: 'unavailable', message: 'unavailable' }
    ])?.repository.state,
    'unavailable'
  )
})
