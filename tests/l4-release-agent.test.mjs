import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createGitEvidence } from '../.github/release-agent/git-evidence.mjs'
import { createReleaseTools, runReleaseAgent } from '../.github/release-agent/run.mjs'
import { renderReleaseNotes, validateChanges } from '../.github/scripts/release-notes.mjs'

const empty = () => ({ breaking: [], features: [], added: [], changed: [], fixed: [], removed: [] })
async function fixture(t, source = 'export const feature = "fixture"\n') {
  const parent = resolve('temp/tests/release-agent/isolated-review')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'repo-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', `core.hooksPath=${root}/no-hooks`, '-c', 'commit.gpgSign=false', ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  await writeFile(join(root, 'source.js'), source)
  await writeFile(join(root, '.env'), 'FIXTURE_SECRET=not-for-model\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
  const head = git('rev-parse', 'HEAD')
  await writeFile(join(root, 'untracked.txt'), 'untracked secret')
  return { root, source: { base: null, head }, git }
}

test('Git证据只能读取指定提交普通文件，拒绝工作树、私有路径和穿越', async (t) => {
  const repo = await fixture(t)
  const reader = await createGitEvidence(repo)
  assert.deepEqual(reader.changedPaths, ['source.js'])
  assert.match((await reader.readFile({ revision: 'head', path: 'source.js' })).text, /fixture/)
  for (const path of ['../source.js', '.env', 'untracked.txt', 'C:/key', 'source.js/../.env'])
    await assert.rejects(reader.readFile({ revision: 'head', path }))
  await assert.rejects(reader.readFile({ revision: repo.source.head, path: 'source.js' }))
  await writeFile(join(repo.root, 'source.js'), 'modified worktree')
  assert.match((await reader.readFile({ revision: 'head', path: 'source.js' })).text, /fixture/)
})

test('大diff必须逐页读完，作者与审核者的读取证据独立', async (t) => {
  const repo = await fixture(
    t,
    Array.from({ length: 1800 }, (_, i) => `// 中文内容 ${i}`).join('\n')
  )
  const reader = await createGitEvidence(repo)
  const first = createReleaseTools(reader)
  const call = (name, params = {}) =>
    first.tools
      .find((tool) => tool.name === name)
      .execute('fixture', params, new AbortController().signal)
  await assert.rejects(call('submit_changes', empty()), /EVIDENCE_REQUIRED/)
  await call('list_changes')
  await call('read_diff', { path: 'source.js' })
  await call('read_file', { revision: 'head', path: 'source.js' })
  await assert.rejects(call('submit_changes', empty()), /EVIDENCE_REQUIRED/)
  let offset = 0
  do {
    const result = await call('read_diff', { path: 'source.js', offset })
    offset = result.details.nextOffset
  } while (offset !== null)
  await call('submit_changes', empty())
  assert.deepEqual(first.state.submitted, empty())
  const second = createReleaseTools(reader)
  await assert.rejects(
    second.tools
      .find((tool) => tool.name === 'submit_changes')
      .execute('fixture', empty(), new AbortController().signal),
    /EVIDENCE_REQUIRED/
  )
})

test('真实Pi SDK运行两个独立会话，通过工具多轮读取后提交一致记录', async (t) => {
  const repo = await fixture(t)
  const requests = []
  const changes = { ...empty(), added: ['新增示例功能。'] }
  const commands = [
    ['list_changes', {}],
    ['read_diff', { path: 'source.js' }],
    ['read_file', { revision: 'head', path: 'source.js' }],
    ['submit_changes', changes]
  ]
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer fixture-token')
    const tools = (body.messages ?? []).filter((message) => message.role === 'tool').length
    const [name, args] = commands[Math.min(tools, commands.length - 1)]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const common = {
      id: 'chatcmpl-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'release-fixture'
    }
    res.write(
      `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${tools}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`
    )
    res.write(
      `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
    )
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const output = join(repo.root, 'output/changes.json')
  try {
    const result = await runReleaseAgent({
      root: repo.root,
      plan: { record: { source: repo.source } },
      output,
      config: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'release-fixture',
        apiKey: 'fixture-token'
      }
    })
    assert.deepEqual(result, changes)
    assert.equal(requests.length, 8, '两个会话各需四次模型工具响应')
    const audit = JSON.parse(await readFile(`${output}.evidence.json`, 'utf8'))
    assert.ok(audit.author.reads.some((item) => item.tool === 'read_file'))
    assert.ok(audit.reviewer.reads.some((item) => item.tool === 'read_file'))
    for (const request of requests) {
      const text = JSON.stringify(request)
      assert.ok(!text.includes('fixture-token'))
      assert.ok(!text.includes('FIXTURE_SECRET'))
      const names = request.tools.map((item) => item.function.name)
      for (const tool of ['bash', 'write', 'edit']) assert.ok(!names.includes(tool))
    }
    assert.ok(!JSON.stringify(audit).includes('fixture-token'))
  } finally {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    const check = createServer()
    check.listen(port, '127.0.0.1')
    await once(check, 'listening')
    await new Promise((done) => check.close(done))
  }
})

test('模型拒绝请求时只返回类别并释放会话，不暴露认证响应', async (t) => {
  const repo = await fixture(t)
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({ error: { message: 'fixture-sensitive-provider-body', type: 'auth_error' } })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const output = join(repo.root, 'failure/changes.json')
  try {
    await assert.rejects(
      runReleaseAgent({
        root: repo.root,
        plan: { record: { source: repo.source } },
        output,
        config: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          model: 'release-fixture',
          apiKey: 'fixture-token'
        }
      }),
      (error) => {
        assert.ok(!error.message.includes('fixture-sensitive-provider-body'))
        assert.ok(!error.message.includes('fixture-token'))
        return /发布说明错误/.test(error.message)
      }
    )
    const evidence = await readFile(`${output}.evidence.json`, 'utf8')
    assert.ok(!evidence.includes('fixture-sensitive-provider-body'))
    assert.ok(!evidence.includes('fixture-token'))
  } finally {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
})

test('Markdown固定标题、转义模型内容，并保留macOS签名限制', () => {
  const record = {
    tag: 'release-123456abcdef',
    changes: { ...empty(), fixed: ['修复 <script> 与 [伪链接](https://evil.example)。'] },
    packages: [{ name: '@jetcrab/pi-desk', version: '1.0.0' }],
    clients: [
      { platform: 'macos', version: '1.0.0', file: 'pi-desk-macos-1.0.0-universal-adhoc.dmg' }
    ]
  }
  const markdown = renderReleaseNotes(record, { repository: 'fixture/project' })
  assert.match(markdown, /^## Pi Desk 1\.0\.0/)
  assert.match(markdown, /releases\/tag\/release-123456abcdef/)
  assert.match(markdown, /临时签名，未公证/)
  assert.ok(!markdown.includes('<script>'))
  assert.throws(() => validateChanges({ ...empty(), fixed: ['bad\nsecond heading'] }))
  assert.throws(() => validateChanges({ ...empty(), extra: [] }))
})
