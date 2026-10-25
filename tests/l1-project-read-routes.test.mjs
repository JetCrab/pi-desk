import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

const testPiRoot = join(
  process.cwd(),
  'temp/pi/l1-project-read-routes',
  `host-review-${process.pid}`
)
const agentDir = join(testPiRoot, 'agent')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
await mkdir(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true })
test.after(async () => {
  await rm(testPiRoot, { recursive: true, force: true })
})

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})
const { projectFileGet, projectFileList, projectFileSearch } = await jiti.import(
  '../src/server/l1_entry/api/l1-project-read-routes.ts'
)

const { createL1ProjectRoute } = await jiti.import('../src/server/l1_entry/api/l1-project-route.ts')
const { L3ProjectFileSearch } = await jiti.import(
  '../src/common/l3_modules/project-files/l3-project-files-contract.ts'
)
const { getL2WorkSessionManage } = await jiti.import(
  '../src/server/l2_biz/work-session/l2-work-session-manage.ts'
)
const { L4ProjectSearchError } = await jiti.import(
  '../src/server/l4_foundation/file/l4-project-search.ts'
)

function post(body) {
  return new Request('http://localhost/api/project-files/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function envelope(response) {
  return { response, body: await response.json() }
}

test('Project L1按Request Schema执行并保留错误Envelope状态码', async (context) => {
  const testRoot = join(
    process.cwd(),
    'temp/tests/l1-project-read-routes',
    `host-review-${process.pid}`
  )
  await mkdir(testRoot, { recursive: true })
  const cwd = await mkdtemp(join(testRoot, 'project-'))
  context.after(() => rm(testRoot, { recursive: true, force: true }))
  await writeFile(join(cwd, 'README.md'), '# Fixture\n', 'utf8')

  const invalidJson = await projectFileList(
    new Request('http://localhost/api/project-files/list', {
      method: 'POST',
      body: '{'
    })
  )
  assert.equal(invalidJson.status, 400)
  assert.equal((await invalidJson.json()).data, null)

  const invalidCwd = await envelope(await projectFileList(post({ cwd: 'relative', path: '' })))
  assert.equal(invalidCwd.response.status, 400)
  assert.notEqual(invalidCwd.body.code, 0)
  assert.equal(invalidCwd.body.data, null)

  const success = await envelope(await projectFileList(post({ cwd, path: '' })))
  assert.equal(success.response.status, 200)
  assert.equal(success.body.code, 0)
  assert.ok(success.body.data.entries.some((entry) => entry.name === 'README.md'))

  const missing = await envelope(
    await projectFileGet(
      new Request('http://localhost/api/project-files/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, path: 'missing.txt', imagePreviewMode: 'original' })
      })
    )
  )
  assert.equal(missing.response.status, 404)
  assert.notEqual(missing.body.code, 0)
  assert.equal(missing.body.data, null)
})

async function searchFixture(context) {
  const parent = join(process.cwd(), 'temp/tests/l1-project-read-routes')
  await mkdir(parent, { recursive: true })
  const cwd = await mkdtemp(join(parent, 'search-route-'))
  context.after(() => rm(cwd, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true })
  await writeFile(join(cwd, 'needle.txt'), 'needle needle\n')
  return cwd
}

test('搜索HTTP应用完整条件、缺省值及新结果合同，非法查询和正则返回400', async (context) => {
  const cwd = await searchFixture(context)
  const defaults = await envelope(await projectFileSearch(post({ cwd, query: 'needle' })))
  assert.equal(defaults.response.status, 200)
  assert.deepEqual(defaults.body.data.fileMatches, [
    { path: 'needle.txt', ranges: [{ start: 0, end: 6 }] }
  ])
  assert.deepEqual(defaults.body.data.contentMatches, [
    {
      path: 'needle.txt',
      line: 1,
      text: 'needle needle',
      ranges: [
        { start: 0, end: 6 },
        { start: 7, end: 13 }
      ]
    }
  ])
  const files = await envelope(
    await projectFileSearch(post({ cwd, query: 'needle', scope: 'files' }))
  )
  assert.deepEqual(files.body.data.contentMatches, [])
  const content = await envelope(
    await projectFileSearch(post({ cwd, query: 'NEEDLE', scope: 'content', caseSensitive: true }))
  )
  assert.deepEqual(content.body.data, { fileMatches: [], contentMatches: [], truncated: false })
  for (const query of ['  ', 'x\ny', 'x'.repeat(201)]) {
    assert.equal((await projectFileSearch(post({ cwd, query }))).status, 400)
  }
  const invalid = await envelope(await projectFileSearch(post({ cwd, query: '[', regex: true })))
  assert.equal(invalid.response.status, 400)
  assert.equal(invalid.body.data, null)
  assert.equal(invalid.body.i18n.key, 'errors:projectSearchPatternInvalid')
})

test('项目路由传递原Request.signal，搜索错误映射保留400、503、504与500', async (context) => {
  const cwd = await searchFixture(context)
  const controller = new AbortController()
  let received
  const route = createL1ProjectRoute(L3ProjectFileSearch, async (_input, signal) => {
    received = signal
    return { fileMatches: [], contentMatches: [], truncated: false }
  })
  const request = new Request('http://localhost/api/project-files/search', {
    method: 'POST',
    body: JSON.stringify({ cwd, query: 'needle' }),
    signal: controller.signal
  })
  assert.equal((await route(request)).status, 200)
  assert.equal(received, request.signal)
  controller.abort()
  assert.equal(received.aborted, true)
  for (const [kind, status] of [
    ['invalid-pattern', 400],
    ['unavailable', 503],
    ['timeout', 504],
    ['read-failed', 500]
  ]) {
    const fail = createL1ProjectRoute(L3ProjectFileSearch, async () => {
      throw new L4ProjectSearchError(kind, '搜索失败')
    })
    const result = await envelope(await fail(post({ cwd, query: 'needle' })))
    assert.equal(result.response.status, status)
    assert.equal(result.body.data, null)
    assert.notEqual(result.body.code, 0)
  }
})

test('已取消Request传入真实搜索入口后返回取消状态，后续请求可继续执行', async (context) => {
  const cwd = await searchFixture(context)
  const controller = new AbortController()
  const request = new Request('http://localhost/api/project-files/search', {
    method: 'POST',
    body: JSON.stringify({ cwd, query: 'needle', scope: 'content' }),
    signal: controller.signal
  })
  controller.abort()
  assert.equal((await projectFileSearch(request)).status, 499)
  assert.equal((await projectFileSearch(post({ cwd, query: 'needle' }))).status, 200)
})

test('搜索保留会话404、未登记来源409及操作后来源校验且不启动Worker', async (context) => {
  const cwd = await searchFixture(context)
  const manage = getL2WorkSessionManage()
  context.mock.method(manage, 'getWorkSession', async (workId) =>
    workId === 'missing' ? null : { workId }
  )
  let valid = false
  let current = true
  context.mock.method(manage, 'getProjectPreviewContext', () =>
    valid ? { cwd, isCurrent: () => current } : null
  )
  let executed = 0
  const route = createL1ProjectRoute(L3ProjectFileSearch, async () => {
    executed += 1
    current = false
    return { fileMatches: [], contentMatches: [], truncated: false }
  })
  assert.equal((await route(post({ cwd, workId: 'missing', query: 'needle' }))).status, 404)
  assert.equal((await route(post({ cwd, workId: 'known', query: 'needle' }))).status, 409)
  assert.equal(executed, 0)
  valid = true
  assert.equal((await route(post({ cwd, workId: 'known', query: 'needle' }))).status, 409)
  assert.equal(executed, 1)
})
