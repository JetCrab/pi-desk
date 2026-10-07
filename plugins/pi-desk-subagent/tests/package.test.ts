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

test('Package 同时声明原生 Extension 与 Pi Desk Entry', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.pi.extensions, ['./dist/index.js'])
  assert.equal(manifest.piDesk.entry, './dist/pi-desk.js')
})

test('Pi Desk Entry 注册全局子代理设置方法', async () => {
  const entry = await readFile(join(packageRoot, 'dist', 'pi-desk.js'), 'utf8')
  assert.ok(entry.includes("from './global-settings.js'"))
  assert.match(entry, /registerMethod\('settings-get'/)
  assert.match(entry, /registerMethod\('settings-save'/)
})

test('Browser Entry 注册设置页和子代理 Message View 并保留 Lazy Chunks', async () => {
  const entry = await readFile(join(browserRoot, 'entry.js'), 'utf8')
  const sources = await browserSources()
  assert.ok(Buffer.byteLength(entry, 'utf8') < 20 * 1024)
  assert.match(entry, /registerContribution\("settings-page","subagent"/)
  assert.match(entry, /registerContribution\("message-view","start"/)
  assert.match(entry, /registerContribution\("message-view","return"/)
  assert.match(entry, /registerContribution\("message-view","list"/)
  assert.match(entry, /registerContribution\("message-view","control"/)
  assert.equal((entry.match(/import\(/g) ?? []).length, 2)
  assert.match(entry, /browser-settings-/)
  assert.equal(entry.includes('react-dom'), false)
  for (const source of sources) {
    assert.equal(/(?:from\s*|import\s*\()["']node:/.test(source), false)
  }
  const browserSource = sources.join('\n')
  assert.ok(browserSource.includes('@jetcrab/pi-desk-sdk/react/base'))
  assert.ok(browserSource.includes('@jetcrab/pi-desk-sdk/react/markdown'))
  assert.ok(
    sources.some(
      (source) =>
        source.includes('invokeGlobal("settings-get"') &&
        source.includes('invokeGlobal("settings-save"')
    )
  )
})
