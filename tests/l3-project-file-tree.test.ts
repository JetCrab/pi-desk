import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildL3ProjectPathTree,
  compactL3PathTreeDirectory,
  flattenL3ProjectPathTree
} from '../src/client/l3_modules/project-files/l3-project-path-tree'
import { L3ProjectFileRuntime } from '../src/client/l3_modules/project-files/l3-project-file-runtime'
import type { L3ProjectReader } from '../src/client/l3_modules/project-files/l3-project-reader'
import type { L4GitReadBranches } from '../src/common/l4_foundation/git/l4-git-history-contract'

const wait = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function branches(): L4GitReadBranches {
  return {
    head: { type: 'branch', name: 'main' },
    recent: ['main'],
    local: ['main'],
    remote: [],
    upstream: null
  }
}

function readerForRuntime(
  list: (
    path: string,
    signal?: AbortSignal
  ) => Promise<{ entries: { name: string; type: 'directory' | 'file' }[]; truncated: boolean }>
): L3ProjectReader {
  return {
    list,
    search: async () => ({ matches: [], truncated: false }),
    get: async (path) => ({ kind: 'text', path, content: path, size: path.length }),
    diff: async (_root, path) => ({
      kind: 'text',
      original: { path, content: 'old' },
      modified: { path, content: 'new' }
    }),
    snapshot: async () => ({ repositories: [] }),
    branches: async () => branches(),
    log: async () => ({
      tip: 't'.repeat(40),
      exclude: null,
      items: [],
      hasMore: false,
      truncated: false
    }),
    changes: async () => ({
      comparison: { base: null, target: 't'.repeat(40), original: null },
      commit: null,
      items: [],
      hasMore: false,
      truncated: false
    })
  }
}

test('路径树合并分叉并保留同名文件目录', () => {
  const tree = buildL3ProjectPathTree([
    'a',
    'a/b.ts',
    'src/mapper/UserMapper.java',
    'src/service/impl/UserService.java'
  ])
  const rows = flattenL3ProjectPathTree(tree, new Set())
  assert.ok(rows.some((row) => row.type === 'file' && row.path === 'a'))
  assert.ok(rows.some((row) => row.type === 'directory' && row.path === 'a'))
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length)
  const compact = compactL3PathTreeDirectory('src/service', tree)
  assert.equal(compact.targetPath, 'src/service/impl')
  assert.deepEqual(compact.paths, ['src/service', 'src/service/impl'])
})

test('目录链最多读取16层并在truncated尾部停止', async () => {
  const calls: string[] = []
  const reader = readerForRuntime(async (path) => {
    calls.push(path)
    const depth = path === '' ? 0 : path.split('/').length
    if (depth === 16) {
      return { entries: [{ name: 'd17', type: 'directory' }], truncated: true }
    }
    return depth < 20
      ? { entries: [{ name: `d${depth + 1}`, type: 'directory' }], truncated: false }
      : { entries: [{ name: 'leaf.ts', type: 'file' }], truncated: false }
  })
  const runtime = new L3ProjectFileRuntime('C:/project', reader, {
    imagePreviewMode: () => 'original'
  })
  await runtime.ensureRoot()
  runtime.setExpandedPaths(new Set(['']), false)
  await runtime.expandDirectoryChain('', new Set())
  assert.equal(calls.length, 17)
  const truncatedPath = Array.from({ length: 16 }, (_, index) => `d${index + 1}`).join('/')
  assert.equal(runtime.state.directories.get(truncatedPath)?.status, 'ready')
  assert.equal(
    (runtime.state.directories.get(truncatedPath) as { truncated: boolean }).truncated,
    true
  )
  assert.equal(runtime.state.expandedPaths.has(`${truncatedPath}/d17`), false)
  runtime.dispose()
})

test('图片预览通过Blob加载且重载关闭和释放时撤销URL', async (context) => {
  let sequence = 0
  const blobs: Blob[] = []
  const revoked: string[] = []
  context.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    blobs.push(blob)
    sequence += 1
    return `blob:${sequence}`
  })
  context.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url))
  const reader: L3ProjectReader = {
    ...readerForRuntime(async () => ({ entries: [], truncated: false })),
    async get() {
      return { kind: 'image', mimeType: 'image/png', data: 'AQID', size: 3 }
    }
  }
  const runtime = new L3ProjectFileRuntime('C:/project', reader, {
    imagePreviewMode: () => 'original'
  })

  runtime.openFile('image.png')
  await wait()
  const initial = runtime.state.documents.get('image.png')
  assert.equal(initial?.status, 'image')
  assert.equal(blobs[0]?.type, 'image/png')
  assert.deepEqual([...new Uint8Array(await blobs[0]!.arrayBuffer())], [1, 2, 3])

  runtime.reloadFile('image.png')
  await wait()
  assert.deepEqual(revoked, ['blob:1'])
  assert.equal(runtime.state.documents.get('image.png')?.status, 'image')

  runtime.closeTabs('image.png', 'current')
  assert.deepEqual(revoked, ['blob:1', 'blob:2'])
  runtime.openFile('image.png')
  await wait()
  runtime.dispose()
  assert.deepEqual(revoked, ['blob:1', 'blob:2', 'blob:3'])
})

test('收起后迟到目录结果不能继续探测下一层', async () => {
  const pending = new Map<
    string,
    (value: { entries: { name: string; type: 'directory' }[]; truncated: boolean }) => void
  >()
  const calls: string[] = []
  const runtime = new L3ProjectFileRuntime(
    'C:/project',
    readerForRuntime((path) => {
      calls.push(path)
      return new Promise((resolve) => pending.set(path, resolve))
    }),
    { imagePreviewMode: () => 'original' }
  )
  const root = runtime.ensureRoot()
  runtime.setExpandedPaths(new Set(['']), false)
  await wait()
  pending.get('')?.({ entries: [{ name: 'next', type: 'directory' }], truncated: false })
  await root
  const chain = runtime.expandDirectoryChain('', new Set())
  await wait()
  runtime.setExpandedPaths(new Set(), false)
  pending.get('next')?.({ entries: [{ name: 'after', type: 'directory' }], truncated: false })
  await chain
  for (const resolve of pending.values()) resolve({ entries: [], truncated: false })
  await wait()
  assert.deepEqual(calls, ['', 'next'])
  runtime.dispose()
})
