import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateL2PluginSessionHeaderInlineCount } from '../src/client/l2_biz/plugin-host/l2-plugin-session-header-layout'

test('没有条目时不预留更多入口', () => {
  assert.equal(calculateL2PluginSessionHeaderInlineCount([], 0, 28, 4), 0)
})

test('全部恰好放下时不因更多按钮而折叠', () => {
  assert.equal(calculateL2PluginSessionHeaderInlineCount([48, 80, 64], 200, 28, 4), 3)
})

test('空间不足时为更多按钮和间距预留宽度', () => {
  assert.equal(calculateL2PluginSessionHeaderInlineCount([48, 80, 64], 164, 28, 4), 2)
  assert.equal(calculateL2PluginSessionHeaderInlineCount([48, 80, 64], 163, 28, 4), 1)
})

test('保留稳定前缀，不跳过宽自定义项重新排列后面的按钮', () => {
  assert.equal(calculateL2PluginSessionHeaderInlineCount([160, 28, 28], 100, 28, 4), 0)
})

test('空自定义项不占宽度或间距，不单独触发更多入口', () => {
  assert.equal(calculateL2PluginSessionHeaderInlineCount([0, 0], 0, 28, 4), 2)
  assert.equal(calculateL2PluginSessionHeaderInlineCount([0, 80, 0, 64, 0], 148, 28, 4), 5)
  assert.equal(calculateL2PluginSessionHeaderInlineCount([0, 80, 0, 64, 0], 147, 28, 4), 3)
})

test('列宽恢复后重新平铺；放大字号后重新计算', () => {
  assert.equal(calculateL2PluginSessionHeaderInlineCount([48, 80, 64], 80, 28, 4), 1)
  assert.equal(calculateL2PluginSessionHeaderInlineCount([48, 80, 64], 300, 28, 4), 3)
  assert.equal(calculateL2PluginSessionHeaderInlineCount([72, 120, 96], 200, 42, 6), 1)
})
