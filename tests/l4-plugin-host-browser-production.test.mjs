import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)

test('生产 bundle 可以读取 SDK Host Runtime', async () => {
  const routePath = resolve(
    'temp',
    'build',
    'pi-desk',
    'release',
    '.next',
    'server',
    'app',
    'api',
    'plugins',
    'host-runtime',
    '[runtimeVersion]',
    '[...resourcePath]',
    'route.js'
  )
  const route = require(routePath)
  const response = await route.routeModule.userland.GET(
    new Request('http://127.0.0.1/api/plugins/host-runtime/v1/base.js'),
    { params: Promise.resolve({ runtimeVersion: 'v1', resourcePath: ['base.js'] }) }
  )
  const content = await response.text()
  assert.equal(response.status, 200, content)
  assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/u)
  assert.match(content, /pi-desk-ui-root/u)
})
