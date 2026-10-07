import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('压缩后的浏览器运行时保留上游法律注释', async () => {
  const base = await readFile(new URL('../dist/host-runtime/base.js', import.meta.url), 'utf8')
  assert.match(base, /@license React/)
  assert.match(base, /Copyright.*Meta Platforms/)
})
