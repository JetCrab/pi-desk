import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browserRoot = join(packageRoot, 'dist', 'browser')

async function browserSources(): Promise<string[]> {
  const paths = await readdir(browserRoot, { recursive: true })
  return Promise.all(
    paths
      .filter((path) => path.endsWith('.js'))
      .map((path) => readFile(join(browserRoot, path), 'utf8'))
  )
}

test('Manifest 只声明 Pi Desk Entry', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.pi, undefined)
  assert.equal(manifest.piDesk.entry, './dist/pi-desk.js')
  assert.deepEqual([...manifest.files].sort(), ['README.md', 'dist'])
})

test('Browser Entry 轻量注册 Contributions，React 留在 Lazy Chunk', async () => {
  const entry = await readFile(join(browserRoot, 'entry.js'), 'utf8')
  const sources = await browserSources()
  assert.ok(Buffer.byteLength(entry, 'utf8') < 20 * 1024)
  assert.match(entry, /registerContribution\("application","quota-viewer"/)
  assert.match(entry, /registerContribution\("settings-page","quota-sources"/)
  assert.match(entry, /import\(/)
  assert.equal(entry.includes('react-dom'), false)
  for (const source of sources) {
    assert.equal(/(?:from\s*|import\s*\()["']node:/.test(source), false)
  }
  assert.ok(sources.some((source) => source.includes('@jetcrab/pi-desk-sdk/react/base')))
  const bundleText = sources
    .join('\n')
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )
  for (const text of ['额度设置', '额度记录', '显示项', '保存']) {
    assert.ok(bundleText.includes(text), `Bundle 缺少文本：${text}`)
  }
  assert.ok(sources.length > 1)
})

test('Quota Bundle 保留稳定的额度文案和懒加载结构', async () => {
  const sources = await browserSources()
  const bundleText = sources
    .join('\n')
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )

  for (const text of ['额度记录', '额度渠道', '显示项', '刷新', '来源编辑', '保存全部更改']) {
    assert.ok(bundleText.includes(text), `Bundle 缺少稳定文案：${text}`)
  }
  assert.ok(sources.some((source) => source.includes('Intl.NumberFormat')))
  assert.ok(sources.some((source) => source.includes('maximumFractionDigits')))
})
