import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { L3ProjectFileRuntime } from '../src/client/l3_modules/project-files/l3-project-file-runtime'
import type { L3ProjectFileReader } from '../src/client/l3_modules/project-files/l3-project-reader'
import type {
  L4GitHistoricalDiff,
  L4GitPreviewDiff
} from '../src/common/l4_foundation/git/l4-git-history-contract'

const first = { baseCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40) }
const second = { baseCommit: 'b'.repeat(40), targetCommit: 'c'.repeat(40) }

function reader(overrides: Partial<L3ProjectFileReader> = {}): L3ProjectFileReader {
  return {
    list: async () => ({ entries: [], truncated: false }),
    search: async () => ({ fileMatches: [], contentMatches: [], truncated: false }),
    get: async (path) => ({ kind: 'text', path, content: path, size: path.length }),
    diff: async (_root, path, _signal, comparison) => ({
      kind: 'text',
      original: { path, content: comparison?.baseCommit ?? 'HEAD' },
      modified: { path, content: comparison?.targetCommit ?? 'working' }
    }),
    ...overrides
  }
}

function createFiles(source = reader()): L3ProjectFileRuntime {
  return new L3ProjectFileRuntime('C:/fixture', source, { imagePreviewMode: () => 'original' })
}

test('普通文件与多个历史Diff共存，重复比较复用，不同提交和改名前路径独立', async (context) => {
  let reads = 0
  const source = reader()
  const files = createFiles(
    reader({
      diff: async (...args) => {
        reads += 1
        return source.diff(...args)
      }
    })
  )
  context.after(() => files.dispose())
  files.openFile('one.ts')
  files.openFile('two.ts')
  files.openDiff('', 'one.ts', first)
  files.openDiff('', 'two.ts', first)
  files.openDiff('', 'one.ts', second)
  await tick()
  assert.deepEqual(files.state.tabs, ['one.ts', 'two.ts'])
  assert.equal(files.state.diffs.length, 3)
  assert.equal(files.state.activeDiff?.comparison?.targetCommit, second.targetCommit)
  files.openFile('two.ts')
  const ordinarySelection = files.state.activeDiff
  assert.equal(ordinarySelection, null)
  assert.equal(files.state.diffs.length, 3)
  files.openDiff('', 'one.ts', first)
  await tick()
  assert.equal(reads, 3)
  assert.equal(files.state.diffs.length, 3)
  assert.equal(files.state.activeDiff?.status, 'text')
  const active = files.state.activeDiff
  assert.ok(active?.status === 'text')
  assert.equal(active.modified.content, first.targetCommit)
  files.openDiff('', 'one.ts', { ...first, oldPath: 'old-one.ts' })
  await tick()
  assert.equal(files.state.diffs.length, 4)
  assert.equal(reads, 4)
})

test('混合标签的当前、其他、左侧、右侧和全部关闭遵循显示顺序', async (context) => {
  for (const scope of ['current', 'others', 'left', 'right', 'all'] as const) {
    await context.test(scope, async () => {
      const files = createFiles()
      try {
        files.openFile('one.ts')
        files.openFile('two.ts')
        files.openDiff('', 'three.ts', first)
        files.openDiff('', 'four.ts', first)
        await tick()
        const target = files.state.diffs.find((diff) => diff.path === 'three.ts')!
        files.closeTabs(target, scope)
        const expected = {
          current: ['one.ts', 'two.ts', 'four.ts'],
          others: ['three.ts'],
          left: ['three.ts', 'four.ts'],
          right: ['one.ts', 'two.ts', 'three.ts'],
          all: []
        }
        assert.deepEqual(
          [...files.state.tabs, ...files.state.diffs.map((diff) => diff.path)],
          expected[scope]
        )
        if (scope === 'all') {
          assert.equal(files.state.activeDiff, null)
          assert.equal(files.state.activePath, null)
        } else {
          assert.ok(
            files.state.activeDiff
              ? files.state.diffs.includes(files.state.activeDiff)
              : files.state.tabs.includes(files.state.activePath!)
          )
        }
      } finally {
        files.dispose()
      }
    })
  }
})

test('关闭正在读取的Diff只取消该项，迟到响应不恢复；dispose取消剩余请求', async () => {
  const pending = new Map<
    string,
    { signal: AbortSignal | undefined; resolve: (value: L4GitPreviewDiff) => void }
  >()
  const files = createFiles(
    reader({
      diff: (_root, path, signal) =>
        new Promise((resolve) => pending.set(path, { signal, resolve }))
    })
  )
  try {
    files.openDiff('', 'one.ts', first)
    files.openDiff('', 'two.ts', first)
    const removed = files.state.diffs.find((diff) => diff.path === 'one.ts')!
    files.closeTabs(removed, 'current')
    assert.equal(pending.get('one.ts')?.signal?.aborted, true)
    assert.equal(pending.get('two.ts')?.signal?.aborted, false)
    pending.get('one.ts')!.resolve({
      kind: 'text',
      original: { path: 'one.ts', content: '' },
      modified: { path: 'one.ts', content: 'late' }
    })
    await tick()
    assert.deepEqual(
      files.state.diffs.map((diff) => diff.path),
      ['two.ts']
    )
    assert.equal(files.state.activeDiff?.path, 'two.ts')
    files.dispose()
    assert.equal(pending.get('two.ts')?.signal?.aborted, true)
  } finally {
    files.dispose()
  }
})

test('恢复多个Diff只读取激活项，旧单Diff记录仍可恢复', async (context) => {
  const calls: Array<{ path: string; comparison?: L4GitHistoricalDiff }> = []
  const original = reader()
  const source = reader({
    diff: async (root, path, signal, comparison) => {
      calls.push({ path, comparison })
      return original.diff(root, path, signal, comparison)
    }
  })
  const saved = {
    tabs: ['one.ts'],
    activePath: 'one.ts',
    editorStates: {},
    fileViewModes: {},
    expandedPaths: [],
    treeScrollTop: 0,
    searchQuery: '',
    activeDiff: { repositoryRoot: '', path: 'one.ts', comparison: second }
  }
  const files = createFiles(source)
  context.after(() => files.dispose())
  files.restoreBrowsing({
    ...saved,
    diffs: [{ repositoryRoot: '', path: 'one.ts', comparison: first }, saved.activeDiff]
  })
  await tick()
  assert.equal(files.state.diffs.length, 2)
  assert.deepEqual(
    calls.map((call) => call.comparison?.targetCommit),
    [second.targetCommit]
  )
  files.openDiff('', 'one.ts', first)
  await tick()
  assert.deepEqual(
    calls.map((call) => call.comparison?.targetCommit),
    [second.targetCommit, first.targetCommit]
  )
  const legacy = createFiles(source)
  context.after(() => legacy.dispose())
  legacy.restoreBrowsing(saved)
  await tick()
  assert.equal(legacy.state.diffs.length, 1)
  assert.equal(legacy.state.activeDiff?.comparison?.targetCommit, second.targetCommit)
})

test('Diff切换后的卸载回调保存原标签位置，异步读取完成不覆盖位置', async (context) => {
  const files = createFiles()
  context.after(() => files.dispose())
  files.openDiff('', 'one.ts', first)
  const previous = files.state.activeDiff!
  files.openDiff('', 'two.ts', first)
  files.saveDiffState(previous, {
    original: null,
    modified: {
      cursorState: [],
      viewState: {
        scrollLeft: 0,
        firstPosition: { lineNumber: 20, column: 1 },
        firstPositionDeltaTop: 0
      },
      contributionsState: {}
    }
  })
  await tick()
  files.openDiff('', 'one.ts', first)
  assert.equal(
    files.state.activeDiff?.editorState?.modified?.viewState.firstPosition.lineNumber,
    20
  )
  files.saveDiffState(previous, null)
  assert.equal(
    files.state.activeDiff?.editorState?.modified?.viewState.firstPosition.lineNumber,
    20
  )
})

test('文件和Diff合计使用现有标签上限，达到上限仍可激活已有项', async (context) => {
  const notices: string[] = []
  const files = new L3ProjectFileRuntime('C:/fixture', reader(), {
    imagePreviewMode: () => 'original',
    maxTabs: 2,
    onNotice: (message) => notices.push(message)
  })
  context.after(() => files.dispose())
  files.openFile('one.ts')
  files.openDiff('', 'two.ts', first)
  await tick()
  files.openFile('three.ts')
  files.openDiff('', 'four.ts', first)
  assert.deepEqual(files.state.tabs, ['one.ts'])
  assert.equal(files.state.diffs.length, 1)
  assert.equal(notices.length, 2)
  files.openFile('one.ts')
  files.openDiff('', 'two.ts', first)
  assert.equal(files.state.activeDiff?.path, 'two.ts')
  assert.equal(notices.length, 2)
})
