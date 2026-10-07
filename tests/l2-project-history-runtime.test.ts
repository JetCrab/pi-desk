import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as waitImmediate } from 'node:timers/promises'
import type {
  L4GitChanges,
  L4GitCommit,
  L4GitLog,
  L4GitReadBranches
} from '../src/common/l4_foundation/git/l4-git-history-contract'
import type { L3ProjectReader } from '../src/client/l3_modules/project-files/l3-project-reader'
import { L3ProjectFileRuntime } from '../src/client/l3_modules/project-files/l3-project-file-runtime'
import { L2ProjectHistoryRuntime } from '../src/client/l2_biz/project-preview/runtime/l2-project-history-runtime'

function commit(oid: string, subject = oid): L4GitCommit {
  return {
    oid,
    parents: [],
    subject,
    author: 'test',
    timestampMs: 1,
    refs: []
  }
}

function log(oid: string): L4GitLog {
  return { tip: oid, exclude: null, items: [commit(oid)], hasMore: false, truncated: false }
}

function changes(target: string, selectedCommit: L4GitCommit | null = null): L4GitChanges {
  return {
    comparison: { base: null, target, original: null },
    commit: selectedCommit
      ? { ...selectedCommit, message: selectedCommit.subject, selectedParent: null }
      : null,
    items: [{ path: 'src/app.ts', oldPath: null, status: 'modified' }],
    hasMore: false,
    truncated: false
  }
}

function branches(): L4GitReadBranches {
  return {
    head: { type: 'branch', name: 'main' },
    recent: ['main'],
    local: ['main'],
    remote: [],
    upstream: null
  }
}

function filesRuntime(reader: L3ProjectReader): L3ProjectFileRuntime {
  return new L3ProjectFileRuntime('C:/project', reader, { imagePreviewMode: () => 'original' })
}

test('作者筛选携带组合查询、分页并只用已加载提交生成建议，切仓库后重置', async () => {
  const requests: Array<{ root: string; query: Parameters<L3ProjectReader['log']>[1] }> = []
  const reader: L3ProjectReader = {
    list: async () => ({ entries: [], truncated: false }),
    search: async () => ({ matches: [], truncated: false }),
    get: async () => ({ kind: 'text', path: 'x', content: '', size: 0 }),
    diff: async () => ({
      kind: 'text',
      original: { path: 'x', content: '' },
      modified: { path: 'x', content: '' }
    }),
    snapshot: async () => ({ repositories: [] }),
    branches: async () => branches(),
    log: async (root, query) => {
      requests.push({ root, query })
      const item = commit(query.page.index === 1 ? 'a'.repeat(40) : 'b'.repeat(40))
      return {
        ...log(item.oid),
        items: [
          {
            ...item,
            subject: `page ${query.page.index}`,
            author: `Loaded Author ${query.page.index}`
          },
          ...(query.page.index === 1
            ? [{ ...item, oid: 'c'.repeat(40), author: 'Loaded Author 1' }]
            : [])
        ],
        hasMore: query.page.index === 1
      }
    },
    changes: async () => changes('d'.repeat(40))
  }
  const runtime = new L2ProjectHistoryRuntime(reader, filesRuntime(reader))
  runtime.setRepository('first')
  runtime.setAuthor('Known')
  runtime.setQuery('needle')
  await new Promise((resolve) => setTimeout(resolve, 260))
  assert.equal(requests.at(-1)?.query.author, 'Known')
  assert.equal(requests.at(-1)?.query.query, 'needle')
  assert.equal(requests.at(-1)?.query.page.index, 1)
  assert.deepEqual(runtime.state.authorSuggestions, ['Loaded Author 1'])

  runtime.loadMoreLog()
  await waitImmediate()
  assert.equal(requests.at(-1)?.query.page.index, 2)
  assert.deepEqual(runtime.state.authorSuggestions, ['Loaded Author 1', 'Loaded Author 2'])

  runtime.setRepository('second')
  assert.equal(runtime.state.author, '')
  assert.deepEqual(runtime.state.authorSuggestions, [])
  await waitImmediate()
  runtime.dispose()
})

test('快速切仓库时迟到成功与错误均不能污染当前历史', async () => {
  const pending: Array<{
    root: string
    resolve: (value: L4GitLog) => void
    reject: (error: Error) => void
  }> = []
  const reader: L3ProjectReader = {
    list: async () => ({ entries: [], truncated: false }),
    search: async () => ({ matches: [], truncated: false }),
    get: async () => ({ kind: 'text', path: 'src/app.ts', content: '', size: 0 }),
    diff: async () => ({
      kind: 'text',
      original: { path: 'src/app.ts', content: '' },
      modified: { path: 'src/app.ts', content: '' }
    }),
    snapshot: async () => ({ repositories: [] }),
    branches: async () => branches(),
    log: (_root, _query, signal) =>
      new Promise<L4GitLog>((resolve, reject) => {
        const item = { root: _root, resolve, reject }
        pending.push(item)
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    changes: async () => changes('b'.repeat(40))
  }
  const files = filesRuntime(reader)
  const runtime = new L2ProjectHistoryRuntime(reader, files)
  runtime.setRepository('A')
  runtime.setRepository('B')
  const first = pending.find((item) => item.root === 'A')
  const second = pending.find((item) => item.root === 'B')
  assert.ok(first)
  assert.ok(second)
  first.reject(new Error('旧错误'))
  second.resolve(log('b'.repeat(40)))
  await waitImmediate()
  await waitImmediate()
  assert.equal(runtime.state.repositoryRoot, 'B')
  assert.equal(runtime.state.log.error, null)
  assert.equal(runtime.state.log.data?.tip, 'b'.repeat(40))
  runtime.dispose()
})

test('累计比较、提交单次比较、返回累计保持固定范围并可打开Diff', async () => {
  const calls: string[] = []
  const selected = commit('c'.repeat(40), '单次提交')
  const reader: L3ProjectReader = {
    list: async () => ({ entries: [], truncated: false }),
    search: async () => ({ matches: [], truncated: false }),
    get: async () => ({ kind: 'text', path: 'src/app.ts', content: '', size: 0 }),
    diff: async () => ({
      kind: 'text',
      original: { path: 'src/app.ts', content: 'old' },
      modified: { path: 'src/app.ts', content: 'new' }
    }),
    snapshot: async () => ({ repositories: [] }),
    branches: async () => branches(),
    log: async (_root, query) => {
      calls.push(`log:${query.tip}`)
      return log('t'.repeat(40))
    },
    changes: async (_root, query) => {
      calls.push('commit' in query.selection ? 'commit' : query.selection.strategy)
      return 'commit' in query.selection ? changes(selected.oid, selected) : changes('t'.repeat(40))
    }
  }
  const files = filesRuntime(reader)
  const runtime = new L2ProjectHistoryRuntime(reader, files)
  runtime.setRepository('')
  runtime.setMode('compare')
  runtime.setRevision('base', 'refs/heads/main')
  await waitImmediate()
  await waitImmediate()
  assert.equal(runtime.state.changes.status, 'ready')
  runtime.selectCommit(selected)
  await waitImmediate()
  await waitImmediate()
  assert.equal(runtime.state.selectedCommit, selected.oid)
  assert.equal(runtime.state.changes.data?.commit?.oid, selected.oid)
  runtime.showAggregate()
  await waitImmediate()
  await waitImmediate()
  assert.equal(runtime.state.selectedCommit, null)
  assert.equal(runtime.state.changes.data?.commit, null)
  runtime.openChange('src/app.ts')
  assert.equal(files.state.activeDiff?.status, 'loading')
  assert.ok(calls.includes('merge-base'))
  assert.ok(calls.includes('commit'))
  runtime.dispose()
})

test('恢复已选提交时保留先恢复的历史 Diff', async () => {
  const selected = commit('c'.repeat(40))
  const reader: L3ProjectReader = {
    list: async () => ({ entries: [], truncated: false }),
    search: async () => ({ matches: [], truncated: false }),
    get: async () => ({ kind: 'text', path: 'src/app.ts', content: '', size: 0 }),
    diff: async () => ({
      kind: 'text',
      original: { path: 'src/app.ts', content: 'old' },
      modified: { path: 'src/app.ts', content: 'new' }
    }),
    snapshot: async () => ({ repositories: [] }),
    branches: async () => branches(),
    log: async () => log(selected.oid),
    changes: async () => changes(selected.oid, selected)
  }
  const files = filesRuntime(reader)
  const runtime = new L2ProjectHistoryRuntime(reader, files)
  files.openDiff('', 'src/app.ts', { baseCommit: null, targetCommit: selected.oid })
  runtime.restoreBrowsing({
    repositoryRoot: '',
    mode: 'history',
    tip: 'HEAD',
    base: '',
    target: 'HEAD',
    strategy: 'merge-base',
    query: '',
    author: '',
    selectedCommit: selected.oid,
    selectedChangePath: 'src/app.ts',
    logScroll: 0,
    changesScroll: 0
  })
  await waitImmediate()
  await waitImmediate()
  assert.equal(runtime.state.selectedCommit, selected.oid)
  assert.equal(runtime.state.selectedChangePath, 'src/app.ts')
  assert.equal(files.state.activeDiff?.comparison?.targetCommit, selected.oid)
  runtime.dispose()
  files.dispose()
})

test('搜索与分页触发独立请求，dispose后迟到结果不再发布', async () => {
  let logCalls = 0
  let aborted = false
  const reader: L3ProjectReader = {
    list: async () => ({ entries: [], truncated: false }),
    search: async () => ({ matches: [], truncated: false }),
    get: async () => ({ kind: 'text', path: 'x', content: '', size: 0 }),
    diff: async () => ({
      kind: 'text',
      original: { path: 'x', content: '' },
      modified: { path: 'x', content: '' }
    }),
    snapshot: async () => ({ repositories: [] }),
    branches: async () => branches(),
    log: async (_root, query, signal) => {
      logCalls += 1
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 260)
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      })
      return { ...log('d'.repeat(40)), items: [commit('d'.repeat(40), query.query)] }
    },
    changes: async () => changes('d'.repeat(40))
  }
  const runtime = new L2ProjectHistoryRuntime(reader, filesRuntime(reader))
  runtime.setRepository('')
  runtime.setQuery('needle')
  await new Promise((resolve) => setTimeout(resolve, 300))
  runtime.dispose()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(logCalls >= 1)
  assert.equal(aborted, true)
})
