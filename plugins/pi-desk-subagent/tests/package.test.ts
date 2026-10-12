import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  BrowserContributionDefinitionMap,
  BrowserContributionKind
} from '@jetcrab/pi-desk-sdk/browser'

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
  const definition = (await import(pathToFileURL(join(packageRoot, 'dist', 'pi-desk.js')).href))
    .default
  const methods = new Set<string>()
  const dispose = definition.setup({
    registerMethod(name: string): void {
      methods.add(name)
    },
    registerBrowserEntry(): void {},
    declareCapabilities(): void {},
    declareMessage(): void {}
  })
  try {
    assert.ok(methods.has('settings-get'))
    assert.ok(methods.has('settings-save'))
  } finally {
    await dispose?.()
  }
})

test('Browser Entry 注册设置页和子代理 Message View 并保留 Lazy Chunks', async () => {
  const entry = await readFile(join(browserRoot, 'entry.js'), 'utf8')
  const sources = await browserSources()
  assert.ok(Buffer.byteLength(entry, 'utf8') < 20 * 1024)
  const register = (await import(pathToFileURL(join(browserRoot, 'entry.js')).href)).default
  const contributions = new Map<string, BrowserContributionDefinitionMap[BrowserContributionKind]>()
  const dispose = register({
    registerContribution(
      kind: BrowserContributionKind,
      name: string,
      definition: BrowserContributionDefinitionMap[BrowserContributionKind]
    ): void {
      contributions.set(`${kind}/${name}`, definition)
    }
  })
  try {
    for (const key of [
      'settings-page/subagent',
      'message-view/start',
      'message-view/return',
      'message-view/list',
      'message-view/control'
    ]) {
      const definition = contributions.get(key)
      assert.ok(definition, `缺少贡献：${key}`)
      assert.equal(typeof (await definition.load()).mount, 'function')
    }
  } finally {
    await dispose?.()
  }
  assert.equal(entry.includes('react-dom'), false)
  for (const source of sources) {
    assert.equal(/(?:from\s*|import\s*\()["']node:/.test(source), false)
  }
  const browserSource = sources.join('\n')
  assert.ok(browserSource.includes('@jetcrab/pi-desk-sdk/react/base'))
  assert.ok(browserSource.includes('@jetcrab/pi-desk-sdk/react/markdown'))
})
