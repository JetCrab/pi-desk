import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import {
  L2PluginCatalogGetRequestSchema,
  type L2PluginCatalogDetail,
  type L2PluginCatalogGetRequest
} from '../src/common/l2_biz/plugin/l2-plugin-catalog-contract'
import {
  createL2PluginManagementBiz,
  type L2PluginManagementBiz
} from '../src/client/l2_biz/plugin-host/l2-plugin-management-biz'
import { queryL2PluginDevAvailability } from '../src/client/l2_biz/plugin-host/hooks/l2-use-plugin-dev-availability'

type DevResult = Parameters<Parameters<typeof queryL2PluginDevAvailability>[2]>[0]
type CatalogBiz = Pick<L2PluginManagementBiz, 'getCatalog'>

function detail(name: string, registry: string, version = '1.2.0-dev.3'): L2PluginCatalogDetail {
  return {
    name,
    registry,
    version,
    versions: ['1.0.0', '1.2.0-dev.3'],
    description: null,
    publisher: null,
    kind: 'desk',
    official: false,
    readme: null,
    homepage: null,
    repository: null,
    compatible: null,
    compatibilityNote: null
  }
}

test('dev 证据走真实业务请求，携带当前包和私有来源；不指定来源时交由 Owner 解析', async (t) => {
  const requests: Array<{
    path: string
    body: L2PluginCatalogGetRequest
    clientId: string | null
  }> = []
  const fetchCatalog: typeof globalThis.fetch = async (input, init) => {
    const path = input instanceof Request ? input.url : String(input)
    const body = L2PluginCatalogGetRequestSchema.parse(JSON.parse(String(init?.body)))
    requests.push({ path, body, clientId: new Headers(init?.headers).get('X-Pi-Desk-Client-Id') })
    return Response.json({
      code: 0,
      msg: '',
      data: detail(body.name, body.registry ?? 'http://127.0.0.1:42001/owned')
    })
  }
  t.mock.method(globalThis, 'fetch', fetchCatalog)
  const biz = createL2PluginManagementBiz('fixture-client', { subscribe: () => () => {} })
  const results: DevResult[] = []
  queryL2PluginDevAvailability(
    biz,
    { name: '@fixture/private', registry: 'http://127.0.0.1:42001/private' },
    (result) => results.push(result)
  )
  queryL2PluginDevAvailability(biz, { name: '@fixture/owned' }, (result) => results.push(result))
  await setImmediate()
  assert.deepEqual(requests, [
    {
      path: '/api/plugin-catalog/get',
      body: {
        name: '@fixture/private',
        registry: 'http://127.0.0.1:42001/private',
        version: 'dev'
      },
      clientId: 'fixture-client'
    },
    {
      path: '/api/plugin-catalog/get',
      body: { name: '@fixture/owned', version: 'dev' },
      clientId: 'fixture-client'
    }
  ])
  assert.deepEqual(results, [
    { version: '1.2.0-dev.3', error: null },
    { version: '1.2.0-dev.3', error: null }
  ])
})

test('404、网络错误或来源不一致均不产生可选 dev，也不猜版本名或回退 latest', async () => {
  const results: DevResult[] = []
  const selectors: Array<L2PluginCatalogGetRequest['version']> = []
  for (const error of [new Error('404: dev 标签不存在'), new Error('网络失败')]) {
    const biz: CatalogBiz = {
      getCatalog: async (input) => {
        selectors.push(input.version)
        throw error
      }
    }
    queryL2PluginDevAvailability(biz, { name: '@fixture/missing' }, (result) =>
      results.push(result)
    )
    await setImmediate()
  }
  const mismatched: CatalogBiz = {
    getCatalog: async (input) => detail(input.name, 'http://127.0.0.1:42001/other')
  }
  queryL2PluginDevAvailability(
    mismatched,
    { name: '@fixture/mismatch', registry: 'http://127.0.0.1:42001/private' },
    (result) => results.push(result)
  )
  await setImmediate()
  assert.deepEqual(selectors, ['dev', 'dev'])
  assert.equal(results.length, 3)
  for (const result of results) {
    assert.equal(result.version, null)
    assert.ok(result.error)
  }
})

test('同包切源、换包和关闭后取消旧查询；延迟成功或失败都不能覆盖当前结果', async () => {
  const pending: Array<{
    resolve: (value: L2PluginCatalogDetail) => void
    reject: (cause: Error) => void
  }> = []
  const biz: CatalogBiz = {
    getCatalog: (_input): Promise<L2PluginCatalogDetail> =>
      new Promise((resolve, reject) => pending.push({ resolve, reject }))
  }
  const results: DevResult[] = []
  const oldSource = queryL2PluginDevAvailability(
    biz,
    { name: '@fixture/a', registry: 'http://127.0.0.1:42001/first' },
    (result) => results.push(result)
  )
  assert.equal(results.length, 0, '尚未完成的查询不是成功证据')
  oldSource()
  const oldPackage = queryL2PluginDevAvailability(
    biz,
    { name: '@fixture/a', registry: 'http://127.0.0.1:42001/second' },
    (result) => results.push(result)
  )
  oldPackage()
  const close = queryL2PluginDevAvailability(biz, { name: '@fixture/b' }, (result) =>
    results.push(result)
  )
  pending[2]!.resolve(detail('@fixture/b', 'http://127.0.0.1:42001/owned', '2.0.0-dev.1'))
  await setImmediate()
  pending[0]!.resolve(detail('@fixture/a', 'http://127.0.0.1:42001/first'))
  pending[1]!.reject(new Error('旧来源失败'))
  await setImmediate()
  assert.equal(results.length, 1)
  close()
  const closed = queryL2PluginDevAvailability(biz, { name: '@fixture/closed' }, (result) =>
    results.push(result)
  )
  closed()
  pending[3]!.resolve(detail('@fixture/closed', 'http://127.0.0.1:42001/owned'))
  await setImmediate()
  assert.deepEqual(results, [{ version: '2.0.0-dev.1', error: null }])
})
