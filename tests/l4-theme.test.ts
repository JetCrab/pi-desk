import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isL4Theme,
  L4_DEFAULT_THEME,
  resolveL4Theme
} from '../src/common/l4_foundation/theme/l4-theme'

test('主题取值只接受已支持选项', () => {
  assert.equal(isL4Theme('system'), true)
  assert.equal(isL4Theme('light'), true)
  assert.equal(isL4Theme('dark'), true)
  assert.equal(isL4Theme('auto'), false)
  assert.equal(isL4Theme(null), false)
  assert.equal(L4_DEFAULT_THEME, 'dark')
})

test('跟随系统主题会解析为当前系统外观', () => {
  assert.equal(resolveL4Theme('system', true), 'dark')
  assert.equal(resolveL4Theme('system', false), 'light')
  assert.equal(resolveL4Theme('light', true), 'light')
  assert.equal(resolveL4Theme('dark', false), 'dark')
})
