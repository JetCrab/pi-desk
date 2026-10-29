import assert from 'node:assert/strict'
import test from 'node:test'
import { createGitHubClient } from '../.github/scripts/release-github.mjs'

const repository = 'fixture/project'
const token = 'fixture-release-token'

test('GitHub网络失败保留请求位置和底层原因，消息不包含授权', async () => {
  const cause = Object.assign(new Error('连接中断'), { code: 'ECONNRESET' })
  const failure = new TypeError(`fetch failed ${token}`, { cause })
  let calls = 0
  const github = createGitHubClient({
    repository,
    token,
    fetchImpl: async () => {
      calls += 1
      throw failure
    }
  })
  await assert.rejects(github.request('/releases'), (error) => {
    assert.equal(error.cause, failure)
    assert.match(error.message, /GitHub GET \/releases 网络失败或超时/)
    assert.match(error.message, /连接中断.*ECONNRESET/)
    assert.ok(!error.message.includes(token))
    return true
  })
  assert.equal(calls, 1)
})

test('GitHub写入失败保留响应原因、请求ID和限流证据，不泄露授权或自动重放', async () => {
  let calls = 0
  const github = createGitHubClient({
    repository,
    token,
    fetchImpl: async (_url, options) => {
      calls += 1
      assert.equal(options.method, 'POST')
      return Response.json(
        { message: `Resource not accessible by integration ${token}` },
        {
          status: 403,
          headers: {
            'x-github-request-id': 'fixture-request',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1793244000',
            'retry-after': '60',
            'x-accepted-github-permissions': 'contents=write',
            authorization: `Bearer ${token}`
          }
        }
      )
    }
  })
  await assert.rejects(
    github.request('/releases', { method: 'POST', body: { draft: true } }),
    (error) => {
      assert.match(error.message, /GitHub POST \/releases 请求失败：HTTP 403/)
      assert.match(error.message, /Resource not accessible by integration/)
      for (const detail of [
        'x-github-request-id: fixture-request',
        'x-ratelimit-remaining: 0',
        'x-ratelimit-reset: 1793244000',
        'retry-after: 60',
        'x-accepted-github-permissions: contents=write'
      ]) {
        assert.ok(error.message.includes(detail))
      }
      assert.ok(!error.message.includes(token))
      assert.ok(!error.message.includes('authorization'))
      return true
    }
  )
  assert.equal(calls, 1)
})

test('GitHub错误正文读取中断不覆盖HTTP状态与请求ID', async () => {
  const github = createGitHubClient({
    repository,
    token,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`连接中断 ${token}`))
          }
        }),
        { status: 403, headers: { 'x-github-request-id': 'fixture-interrupted' } }
      )
  })
  await assert.rejects(github.request('/releases', { method: 'POST' }), (error) => {
    assert.match(error.message, /HTTP 403/)
    assert.match(error.message, /响应正文读取失败：连接中断/)
    assert.match(error.message, /x-github-request-id: fixture-interrupted/)
    assert.ok(!error.message.includes(token))
    return true
  })
})

test('GitHub过长错误正文截断后仍保留请求ID', async () => {
  const github = createGitHubClient({
    repository,
    token,
    fetchImpl: async () =>
      new Response(`${token}${'x'.repeat(3000)}`, {
        status: 502,
        headers: { 'x-github-request-id': 'fixture-long-response' }
      })
  })
  await assert.rejects(github.request('/releases'), (error) => {
    assert.match(error.message, /HTTP 502/)
    assert.match(error.message, /x-github-request-id: fixture-long-response/)
    assert.ok(error.message.length < 2300)
    assert.ok(!error.message.includes(token))
    return true
  })
})

test('GitHub响应体读取失败仍能定位请求，兼容空响应和允许缺失', async () => {
  const responses = [
    new Response('{'),
    new Response(null, { status: 204 }),
    new Response('', { status: 404 })
  ]
  const github = createGitHubClient({
    repository,
    token,
    fetchImpl: async () => responses.shift()
  })
  await assert.rejects(github.request('/actions/runs/42/artifacts'), (error) => {
    assert.match(error.message, /GET \/actions\/runs\/42\/artifacts 响应读取失败/)
    assert.ok(error.cause instanceof SyntaxError)
    return true
  })
  assert.equal(await github.request('/releases/42', { method: 'DELETE' }), null)
  assert.equal(await github.request('/contents/missing', { allow404: true }), null)
})
