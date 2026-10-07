import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveL4DisplaySize } from '../src/common/l4_foundation/l4-display-size'

test('当前默认显示尺度保留为紧凑', () => {
  assert.equal(resolveL4DisplaySize(null, null), 'compact')
  assert.equal(resolveL4DisplaySize('unknown', null), 'compact')
  assert.equal(resolveL4DisplaySize('unknown', { chatSize: 'large' }), 'compact')
})

test('用户新选择优先于旧聊天字号', () => {
  for (const size of ['compact', 'standard', 'large'] as const) {
    assert.equal(resolveL4DisplaySize(size, { chatSize: 'large' }), size)
  }
})

test('旧标准聊天迁移到紧凑，旧大号聊天迁移到标准', () => {
  assert.equal(resolveL4DisplaySize(null, { chatSize: 'standard' }), 'compact')
  assert.equal(resolveL4DisplaySize(null, { chatSize: 'large' }), 'standard')
})

test('无效旧配置不影响默认显示尺度', () => {
  for (const legacy of [null, [], ['large'], 'large', { chatSize: 'unknown' }]) {
    assert.equal(resolveL4DisplaySize(null, legacy), 'compact')
  }
})
