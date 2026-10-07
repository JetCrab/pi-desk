import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { requestL4Api } from '../src/client/l4_foundation/lib/l4-api-request'

const schema = z.object({ value: z.number() }).strict()

test('POST请求携带页面身份、JSON正文与取消信号，并校验data', async (context) => {
  const controller = new AbortController()
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, '/api/example/get')
    assert.equal(init.method, 'POST')
    assert.equal(new Headers(init.headers).get('X-Pi-Desk-Client-Id'), 'page-client')
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json')
    assert.deepEqual(JSON.parse(String(init.body)), { query: '你好' })
    assert.equal(init.signal, controller.signal)
    return Response.json({ code: 0, msg: '', data: { value: 7 } })
  })
  assert.deepEqual(
    await requestL4Api('page-client', '/api/example/get', { query: '你好' }, schema, {
      signal: controller.signal
    }),
    { value: 7 }
  )
})

test('HTTP失败、业务错误和空data均拒绝成功结果', async (context) => {
  for (const [status, code, data] of [
    [500, 0, { value: 7 }],
    [200, 4, { value: 7 }],
    [200, 0, null]
  ] as const) {
    const mock = context.mock.method(globalThis, 'fetch', async () =>
      Response.json({ code, msg: '服务拒绝请求', data }, { status })
    )
    await assert.rejects(requestL4Api('page', '/api/example/get', {}, schema), /服务拒绝请求/)
    mock.mock.restore()
  }
})

test('保留调用方fallback并拒绝不符合业务Schema的数据', async (context) => {
  const mock = context.mock.method(globalThis, 'fetch', async () =>
    Response.json({ code: 3, msg: '', data: null })
  )
  await assert.rejects(
    requestL4Api('page', '/api/example/get', {}, schema, { fallbackMessage: '插件管理请求失败' }),
    /插件管理请求失败/
  )
  mock.mock.mockImplementation(async () =>
    Response.json({ code: 0, msg: '', data: { value: 'invalid' } })
  )
  await assert.rejects(requestL4Api('page', '/api/example/get', {}, schema), z.ZodError)
})

test('请求取消保持原始AbortError，不改写为业务错误', async (context) => {
  const error = new DOMException('cancelled', 'AbortError')
  context.mock.method(globalThis, 'fetch', async () => {
    throw error
  })
  await assert.rejects(
    requestL4Api('page', '/api/example/get', {}, schema),
    (cause) => cause === error
  )
})
