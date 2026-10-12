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

test('Manifest 只声明 Pi Desk Entry', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.pi, undefined)
  assert.equal(manifest.piDesk.entry, './dist/pi-desk.js')
})

test('Browser Entry 轻量注册 Contributions，React 留在 Lazy Chunk', async () => {
  const entry = await readFile(join(browserRoot, 'entry.js'), 'utf8')
  const sources = await browserSources()
  assert.ok(Buffer.byteLength(entry, 'utf8') < 20 * 1024)
  const register = (await import(pathToFileURL(join(browserRoot, 'entry.js')).href)).default
  const contributions = new Map<string, BrowserContributionDefinitionMap[BrowserContributionKind]>()
  let unsubscribed = false
  const dispose = register({
    host: {},
    onPush(): () => void {
      return () => {
        unsubscribed = true
      }
    },
    registerContribution(
      kind: BrowserContributionKind,
      name: string,
      definition: BrowserContributionDefinitionMap[BrowserContributionKind]
    ): void {
      contributions.set(`${kind}/${name}`, definition)
    }
  })
  try {
    for (const key of ['application/quota-viewer', 'settings-page/quota-sources']) {
      const definition = contributions.get(key)
      assert.ok(definition, `缺少贡献：${key}`)
      assert.equal(typeof (await definition.load()).mount, 'function')
    }
  } finally {
    await dispose()
  }
  assert.equal(unsubscribed, true)
  assert.equal(entry.includes('react-dom'), false)
  for (const source of sources) {
    assert.equal(/(?:from\s*|import\s*\()["']node:/.test(source), false)
  }
  assert.ok(sources.some((source) => source.includes('@jetcrab/pi-desk-sdk/react/base')))
  assert.ok(sources.length > 1)
})
