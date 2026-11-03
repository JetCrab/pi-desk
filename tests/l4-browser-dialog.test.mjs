import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

test('宿主与桌面控制中心不得依赖 WebView 原生 JavaScript 确认框', async () => {
  const violations = []
  for (const directory of ['src/client', 'apps/desktop/web']) {
    const entries = await readdir(resolve(root, directory), {
      recursive: true,
      withFileTypes: true
    })
    for (const entry of entries) {
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue
      const file = resolve(entry.parentPath, entry.name)
      const source = await readFile(file, 'utf8')
      if (/\b(?:window|globalThis)\.(?:confirm|alert|prompt)\s*\(/.test(source)) {
        violations.push(file.slice(root.length + 1))
      }
    }
  }
  assert.deepEqual(violations, [], '使用现有应用内弹窗；WKWebView 未实现原生弹窗时会静默取消')
})
