import assert from 'node:assert/strict'
import test from 'node:test'
import { deliverableLoadError } from '../src/browser-runtime.js'

test('旧会话缺少方法时按错误码显示重载引导，不依赖错误文案', () => {
  for (const message of ['插件方法不存在', 'Plugin method not found']) {
    assert.deepEqual(deliverableLoadError(Object.assign(new Error(message), { code: 404 })), {
      kind: 'session-unavailable',
      message: '当前会话尚未加载交付物功能'
    })
  }
})

test('断线、来源失效和其他错误保留真实原因，不误导为需要重载', () => {
  for (const [code, message] of [
    [409, '工作会话来源已变化'],
    [500, '插件方法执行失败'],
    [503, '连接已断开']
  ] as const) {
    assert.deepEqual(deliverableLoadError(Object.assign(new Error(message), { code })), {
      kind: 'error',
      message
    })
  }
  assert.deepEqual(deliverableLoadError(new Error('插件方法不存在')), {
    kind: 'error',
    message: '插件方法不存在'
  })
  assert.deepEqual(deliverableLoadError('读取失败'), { kind: 'error', message: '读取失败' })
})
