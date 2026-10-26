import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import {
  L4ProjectSearchInputSchema,
  L4ProjectFileSearchSchema,
  type L4ProjectFileSearch,
  type L4ProjectFileContent,
  type L4ProjectSearchInput
} from '../src/common/l4_foundation/file/l4-project-file-contract'
import { L3ProjectFileRuntime } from '../src/client/l3_modules/project-files/l3-project-file-runtime'
import type { L3ProjectFileReader } from '../src/client/l3_modules/project-files/l3-project-reader'

const empty: L4ProjectFileSearch = { fileMatches: [], contentMatches: [], truncated: false }
function reader(overrides: Partial<L3ProjectFileReader> = {}): L3ProjectFileReader {
  return {
    list: async () => ({ entries: [], truncated: false }),
    search: async () => empty,
    get: async () => ({ kind: 'text', content: 'first\nsecond\n', size: 13 }),
    diff: async () => ({
      kind: 'text',
      original: { path: 'a.ts', content: '' },
      modified: { path: 'a.ts', content: '' }
    }),
    ...overrides
  }
}
function runtime(
  overrides: Partial<L3ProjectFileReader> = {},
  notices?: string[]
): L3ProjectFileRuntime {
  return new L3ProjectFileRuntime('C:/project', reader(overrides), {
    imagePreviewMode: () => 'compressed',
    htmlPreview: true,
    onNotice: (message) => notices?.push(message)
  })
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('搜索合同默认全部并保留关键词空格，拒绝非法查询和区间', () => {
  assert.deepEqual(L4ProjectSearchInputSchema.parse({ query: ' text ' }), {
    query: ' text ',
    scope: 'all',
    caseSensitive: false,
    wholeWord: false,
    regex: false
  })
  for (const query of ['', '  ', 'a\nb', 'a\rb', 'a\0b', 'a'.repeat(201)]) {
    assert.equal(L4ProjectSearchInputSchema.safeParse({ query }).success, false)
  }
  assert.equal(
    L4ProjectFileSearchSchema.safeParse({
      ...empty,
      contentMatches: [{ path: 'a.ts', line: 1, text: '😀中文', ranges: [{ start: 2, end: 4 }] }]
    }).success,
    true
  )
  for (const ranges of [[{ start: 3, end: 2 }], [{ start: 0, end: 9 }]]) {
    assert.equal(
      L4ProjectFileSearchSchema.safeParse({
        ...empty,
        contentMatches: [{ path: 'a.ts', line: 1, text: 'abc', ranges }]
      }).success,
      false
    )
  }
  assert.equal(
    L4ProjectFileSearchSchema.safeParse({
      ...empty,
      contentMatches: [{ path: 'a.ts', line: 1, text: '', ranges: [{ start: 0, end: 0 }] }]
    }).success,
    true
  )
})

test('完整条件进入reader，同一查询的多个视图只启动一次', async () => {
  const requests: L4ProjectSearchInput[] = []
  const result = deferred<L4ProjectFileSearch>()
  const files = runtime({
    search: async (input) => {
      requests.push(input)
      return result.promise
    }
  })
  files.setSearchOpen(true)
  files.setSearchQuery(' text ')
  const first = files.search(' text ')
  await files.search(' text ')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.query, ' text ')
  result.resolve(empty)
  await first
  await files.search(' text ')
  assert.equal(requests.length, 1)
  files.setSearchOptions({ scope: 'content', regex: true, caseSensitive: true, wholeWord: true })
  await nextTurn()
  assert.deepEqual(requests[1], {
    query: ' text ',
    scope: 'content',
    regex: true,
    caseSensitive: true,
    wholeWord: true
  })
  files.dispose()
})

test('切换范围取消旧请求，迟到结果不覆盖新条件', async () => {
  const requests: Array<{
    signal: AbortSignal | undefined
    result: ReturnType<typeof deferred<L4ProjectFileSearch>>
  }> = []
  const files = runtime({
    search: (_input, signal) => {
      const result = deferred<L4ProjectFileSearch>()
      requests.push({ signal, result })
      return result.promise
    }
  })
  files.setSearchOpen(true)
  files.setSearchQuery('session')
  const first = files.search('session')
  files.setSearchOptions({ scope: 'files' })
  assert.equal(requests[0]?.signal?.aborted, true)
  requests[1]!.result.resolve({ ...empty, fileMatches: [{ path: 'new.ts', ranges: [] }] })
  await nextTurn()
  requests[0]!.result.resolve({ ...empty, fileMatches: [{ path: 'old.ts', ranges: [] }] })
  await first
  assert.equal(files.state.search.scope, 'files')
  assert.deepEqual(
    files.state.search.fileMatches.map((match) => match.path),
    ['new.ts']
  )
  files.dispose()
})

test('退出取消并保留输入选项，重进默认全部且重新搜索', async () => {
  const signals: AbortSignal[] = []
  const files = runtime({
    search: async (_input, signal) => {
      if (signal) signals.push(signal)
      return empty
    }
  })
  files.setSearchOpen(true)
  files.setSearchQuery('needle')
  files.setSearchOptions({ scope: 'content', regex: true })
  await nextTurn()
  files.setSearchOpen(false)
  assert.equal(files.state.search.query, 'needle')
  assert.equal(files.state.search.regex, true)
  files.setSearchOpen(true)
  assert.equal(files.state.search.scope, 'all')
  assert.equal(files.state.search.status, 'loading')
  await files.search('needle')
  assert.equal(signals.length, 2)
  files.dispose()
})

test('dispose和清空查询取消尚未完成的请求', async () => {
  const requests: AbortSignal[] = []
  const files = runtime({
    search: (_input, signal) => {
      if (signal) requests.push(signal)
      return new Promise(() => undefined)
    }
  })
  files.setSearchQuery('first')
  void files.search('first')
  files.setSearchQuery('')
  assert.equal(requests[0]?.aborted, true)
  assert.equal(files.state.search.status, 'idle')
  files.setSearchQuery('second')
  void files.search('second')
  files.dispose()
  assert.equal(requests[1]?.aborted, true)
})

test('不同阅读实例的搜索条件和取消互不影响', async () => {
  const signals: AbortSignal[] = []
  const source = {
    search: (_input: L4ProjectSearchInput, signal?: AbortSignal): Promise<L4ProjectFileSearch> => {
      if (signal) signals.push(signal)
      return new Promise(() => undefined)
    }
  }
  const first = runtime(source)
  const second = runtime(source)
  first.setSearchQuery('first')
  second.setSearchQuery('second')
  void first.search('first')
  void second.search('second')
  first.dispose()
  assert.equal(signals[0]?.aborted, true)
  assert.equal(signals[1]?.aborted, false)
  assert.equal(second.state.search.query, 'second')
  second.dispose()
})

test('已打开正文导航等待新内容且刷新期间保留文本视图', async () => {
  const fresh = deferred<L4ProjectFileContent>()
  let calls = 0
  const files = runtime({
    get: async () => {
      calls += 1
      if (calls > 1) return fresh.promise
      return { kind: 'text', content: '# old\ntext', size: 10 }
    }
  })
  files.openFile('README.md')
  await nextTurn()
  const previous = files.state.documents.get('README.md')
  assert.equal(previous?.status, 'text')
  if (previous?.status === 'text') assert.equal(previous.viewMode, 'preview')
  files.openFile('README.md', 3)
  assert.equal(files.pendingNavigation, null)
  assert.equal(files.state.documents.get('README.md'), previous)
  fresh.resolve({ kind: 'text', content: '# new\ntext\nneedle', size: 17 })
  await nextTurn()
  const target = files.pendingNavigation
  assert.deepEqual(target, { line: 3 })
  const document = files.state.documents.get('README.md')
  if (document?.status === 'text') {
    assert.equal(document.viewMode, 'source')
    assert.equal(document.content, '# new\ntext\nneedle')
  }
  assert.ok(target)
  files.consumeNavigation(target, true)
  assert.equal(files.pendingNavigation, null)
  files.openFile('README.md', 3)
  await nextTurn()
  assert.deepEqual(files.pendingNavigation, { line: 3 })
  assert.notEqual(files.pendingNavigation, target)
  files.dispose()
})

test('旧文件迟到、切文件、关闭和Diff不会恢复旧导航', async () => {
  const old = deferred<L4ProjectFileContent>()
  const files = runtime({
    get: async (path) =>
      path === 'old.ts' ? old.promise : { kind: 'text', content: 'new', size: 3 }
  })
  files.openFile('old.ts', 8)
  files.openFile('new.ts', 1)
  await nextTurn()
  const target = files.pendingNavigation
  assert.deepEqual(target, { line: 1 })
  old.resolve({ kind: 'text', content: 'old', size: 3 })
  await nextTurn()
  assert.equal(files.pendingNavigation, target)
  files.closeTabs('new.ts', 'current')
  assert.equal(files.pendingNavigation, null)
  files.openFile('old.ts', 1)
  await nextTurn()
  files.openDiff('', 'old.ts')
  assert.equal(files.pendingNavigation, null)
  files.dispose()
})

test('重复定位读取到相同正文时保留文档与比较实例', async () => {
  const files = runtime()
  files.openFile('a.ts')
  await nextTurn()
  const document = files.state.documents.get('a.ts')
  assert.equal(document?.status, 'text')
  if (document?.status !== 'text') return
  const comparison = {
    status: 'ready' as const,
    repositoryRoot: '',
    path: 'a.ts',
    original: { path: 'a.ts', content: '' }
  }
  document.comparison = comparison
  files.openFile('a.ts', 2)
  await nextTurn()
  assert.equal(files.state.documents.get('a.ts'), document)
  assert.equal(document.comparison, comparison)
  assert.deepEqual(files.pendingNavigation, { line: 2 })
  files.dispose()
})

test('面板自动重读保留未消费导航并复用在途请求', async () => {
  const fresh = deferred<L4ProjectFileContent>()
  let reads = 0
  const files = runtime({
    get: async () => {
      reads += 1
      return reads === 1 ? { kind: 'text', content: 'old', size: 3 } : fresh.promise
    }
  })
  files.openFile('a.ts', 2)
  await nextTurn()
  assert.deepEqual(files.pendingNavigation, { line: 2 })
  files.reloadFile('a.ts')
  files.reloadFile('a.ts')
  assert.equal(reads, 2)
  assert.equal(files.state.documents.get('a.ts')?.status, 'text')
  fresh.resolve({ kind: 'text', content: 'one\nneedle', size: 10 })
  await nextTurn()
  assert.deepEqual(files.pendingNavigation, { line: 2 })
  files.dispose()
})

test('不存在的命中行给出提示并消费动作', async () => {
  const notices: string[] = []
  const files = runtime({}, notices)
  files.openFile('a.ts', 99)
  await nextTurn()
  const target = files.pendingNavigation
  assert.ok(target)
  files.consumeNavigation(target, false)
  assert.equal(files.pendingNavigation, null)
  assert.equal(notices.length, 1)
  files.consumeNavigation(target, false)
  assert.equal(notices.length, 1)
  files.dispose()
})
