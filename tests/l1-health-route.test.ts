import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import { L2SystemStatusSchema } from '../src/common/l2_biz/system/l2-system-contract'

const require = createRequire(import.meta.url)

test('健康检查返回当前构建版本并禁止缓存', async () => {
  const previous = process.env.PI_DESK_APP_VERSION
  process.env.PI_DESK_APP_VERSION = '0.1.113'
  try {
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      fsCache: false,
      tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
      alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
    })
    const { GET } = await jiti.import<typeof import('../src/server/l1_entry/api/l1-health-route')>(
      '../src/server/l1_entry/api/l1-health-route.ts'
    )
    const response = GET()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const envelope = await response.json()
    assert.equal(envelope.code, 0)
    assert.equal(L2SystemStatusSchema.parse(envelope.data).version, '0.1.113')
  } finally {
    if (previous === undefined) delete process.env.PI_DESK_APP_VERSION
    else process.env.PI_DESK_APP_VERSION = previous
  }
})
