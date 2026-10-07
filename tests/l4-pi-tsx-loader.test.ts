import assert from 'node:assert/strict'
import test from 'node:test'
import { readL4PiTsxImport } from '../src/server/l4_foundation/pi/l4-pi-tsx-loader'

test('读取开发模式的 tsx import specifier', () => {
  assert.equal(readL4PiTsxImport(['--import', 'tsx']), 'tsx')
})

test('读取生产模式的 tsx loader 文件 URL', () => {
  const loader = 'file:///C:/app/node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs'
  assert.equal(readL4PiTsxImport(['--require', 'register', '--import', loader]), loader)
})

test('读取等号形式并跳过其他 import', () => {
  const loader = 'C:\\app\\node_modules\\tsx\\dist\\loader.mjs'
  assert.equal(readL4PiTsxImport(['--import=data:text/javascript,', `--import=${loader}`]), loader)
})

test('缺少 tsx loader 时明确失败', () => {
  assert.throws(() => readL4PiTsxImport(['--import', 'data:text/javascript,']), /缺少 tsx loader/)
})
