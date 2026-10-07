import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseQuotaSnapshot,
  resetQuotaBrowserRuntime,
  readQuotaSnapshot,
  replaceQuotaSnapshot
} from '../src/browser-runtime.js'

test('Browser Runtime 重设旧账号偏好，解析渠道显示项和时间格式', () => {
  resetQuotaBrowserRuntime()
  assert.deepEqual(
    parseQuotaSnapshot({ error: null, sources: [], hiddenResourceKeys: ['old-account'] }),
    {
      error: null,
      sources: [],
      display: { resetTimeFormat: 'countdown', hiddenItemKeys: [] }
    }
  )
  const display = {
    resetTimeFormat: 'absolute',
    hiddenItemKeys: ['cpa-codex:["quota","周额度",""]']
  }
  const snapshot = parseQuotaSnapshot({ error: null, sources: [], display })
  assert.deepEqual(snapshot.display, display)
  replaceQuotaSnapshot(snapshot)
  assert.deepEqual(readQuotaSnapshot(), snapshot)
  resetQuotaBrowserRuntime()
})
