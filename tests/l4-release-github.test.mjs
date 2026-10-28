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

test('GitHub写入失败保留方法、路径和HTTP状态，不自动重放', async () => {
  let calls = 0
  const github = createGitHubClient({
    repository,
    token,
    fetchImpl: async (_url, options) => {
      calls += 1
      assert.equal(options.method, 'POST')
      return new Response('forbidden', { status: 403 })
    }
  })
  await assert.rejects(
    github.request('/releases', { method: 'POST', body: { draft: true } }),
    /GitHub POST \/releases 请求失败：HTTP 403/
  )
  assert.equal(calls, 1)
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
