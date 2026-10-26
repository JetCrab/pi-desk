import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import {
  L2BuildLoginHref,
  L2ResolveAuthReturnTo
} from '../src/common/l2_biz/auth/l2-auth-return-to'
import { buildL2ProjectPreviewHref } from '../src/common/l2_biz/project-preview/l2-project-preview-navigation'
import { createL2ProjectPreviewOwner } from '../src/client/l2_biz/project-preview/l2-project-preview-biz'
import {
  L2_PROJECT_PREVIEW_GLOBAL_DEFAULT,
  type L2ProjectPreviewProject
} from '../src/client/l2_biz/project-preview/l2-project-preview-storage'
import { createL3ProjectReader } from '../src/client/l3_modules/project-files/l3-project-reader'

function savedProject(): L2ProjectPreviewProject {
  return {
    page: 'files',
    historyPane: 'log',
    tabs: [],
    activePath: null,
    editorStates: {},
    fileViewModes: {},
    expandedPaths: [],
    treeScrollTop: 0,
    searchQuery: '',
    changesOnly: false,
    expandedRepositories: [],
    activeDiff: null,
    history: {
      repositoryRoot: '',
      mode: 'history',
      tip: 'HEAD',
      base: '',
      target: 'HEAD',
      strategy: 'merge-base',
      query: '',
      author: '',
      selectedCommit: null,
      selectedChangePath: null,
      logScroll: 0,
      changesScroll: 0
    }
  }
}
function reply(data: unknown, status = 200): Response {
  return Response.json(
    { code: status === 200 ? 0 : status, msg: status === 200 ? '' : '请先登录', data },
    { status }
  )
}

test('项目地址与登录回跳保留目录编码，不允许离站或登录循环', () => {
  const cwd = 'C:\\项目 空格\\a#b&c'
  const href = buildL2ProjectPreviewHref(cwd)
  assert.equal(new URL(href, 'http://localhost').searchParams.get('cwd'), cwd)
  assert.equal(buildL2ProjectPreviewHref(), '/project-preview')
  for (const path of ['/.//example.test', '/a/..//example.test', '/%2e//example.test']) {
    assert.equal(L2ResolveAuthReturnTo(path), path)
    assert.equal(
      new URL(L2ResolveAuthReturnTo(path), 'https://preview.example').origin,
      'https://preview.example'
    )
  }
  assert.equal(L2ResolveAuthReturnTo(href), href)
  assert.equal(
    new URL(L2BuildLoginHref(href), 'http://localhost').searchParams.get('returnTo'),
    href
  )
  for (const unsafe of [
    null,
    '',
    'https://example.com',
    '//example.com',
    '/\\example.com',
    '/%2fexample.com',
    '/%5cexample.com',
    '/project-preview\n',
    '/project-preview?x=%0a',
    '/%',
    '/login',
    '/a/../login?returnTo=/project-preview',
    '/%6cogin/'
  ]) {
    assert.equal(L2ResolveAuthReturnTo(unsafe), '/', String(unsafe))
    assert.equal(L2BuildLoginHref(unsafe), '/login', String(unsafe))
  }
})

test('独立预览恢复隐藏历史不读取，首次展示只读取一次，旧模式保持立即恢复', async (context) => {
  const calls: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url)
    return reply(
      url.endsWith('branches/list')
        ? {
            head: { type: 'branch', name: 'main' },
            recent: [],
            local: ['main'],
            remote: [],
            upstream: null
          }
        : { tip: 'a'.repeat(40), exclude: null, items: [], hasMore: false, truncated: false }
    )
  })
  const owner = createL2ProjectPreviewOwner(
    'test-client',
    'C:/project',
    () => {},
    savedProject(),
    L2_PROJECT_PREVIEW_GLOBAL_DEFAULT,
    { lazyHistory: true }
  )
  context.after(() => owner.dispose())
  owner.restore()
  await tick()
  assert.deepEqual(calls, [])
  owner.history.setRepository('')
  owner.history.setRepository('')
  await tick()
  assert.deepEqual(calls, ['/api/project-git-branches/list', '/api/project-git-log/list'])
  assert.equal(owner.history.state.log.status, 'ready')
  owner.history.setRepository('')
  await tick()
  assert.equal(calls.length, 2)
  const original = createL2ProjectPreviewOwner(
    'test-client',
    'C:/project',
    () => {},
    savedProject(),
    L2_PROJECT_PREVIEW_GLOBAL_DEFAULT
  )
  context.after(() => original.dispose())
  original.restore()
  await tick()
  assert.equal(calls.length, 4)
})

test('预览释放取消读取，迟到成功不会发布状态', async (context) => {
  let signal: AbortSignal | null | undefined
  let finish!: (response: Response) => void
  context.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => {
    signal = init.signal
    return new Promise<Response>((resolve) => {
      finish = resolve
    })
  })
  const owner = createL2ProjectPreviewOwner(
    'test-client',
    'C:/project',
    () => {},
    null,
    L2_PROJECT_PREVIEW_GLOBAL_DEFAULT
  )
  let publishes = 0
  owner.files.subscribe(() => {
    publishes += 1
  })
  const request = owner.files.ensureRoot()
  await tick()
  assert.equal(signal?.aborted, false)
  owner.dispose()
  const before = publishes
  assert.equal(signal?.aborted, true)
  finish(reply({ entries: [], truncated: false }))
  await request
  assert.equal(publishes, before)
  assert.notEqual(owner.files.state.directories.get('')?.status, 'ready')
})

test('独立reader只在401时通知登录且不重放请求，已取消请求不跳转', async (context) => {
  let calls = 0
  let unauthorized = 0
  let status = 401
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return reply(null, status)
  })
  const reader = createL3ProjectReader('test-client', { cwd: 'C:/project' }, () => {
    unauthorized += 1
  })
  await assert.rejects(reader.list(''))
  assert.equal(unauthorized, 1)
  assert.equal(calls, 1)
  status = 404
  await assert.rejects(reader.list(''))
  assert.equal(unauthorized, 1)
  status = 401
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(reader.list('', controller.signal))
  assert.equal(unauthorized, 1)
  assert.equal(calls, 3)
})
