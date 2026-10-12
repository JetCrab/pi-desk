import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
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

test('Manifest 显式声明空原生资源，仅加载 Pi Desk Entry', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.pi, { extensions: [] })
  assert.equal(manifest.piDesk.entry, './dist/pi-desk.js')
  assert.ok(manifest.peerDependencies?.['@earendil-works/pi-coding-agent'])
  assert.equal(manifest.dependencies?.['@earendil-works/pi-coding-agent'], undefined)
})

test('Node Runtime 通过裸模块导入复用宿主 Pi 核心', async () => {
  const source = await readFile(join(packageRoot, 'dist', 'usage-runtime.js'), 'utf8')
  assert.match(source, /from\s+['"]@earendil-works\/pi-coding-agent['"]/u)
})

test('Browser Entry 分别懒加载 Dashboard 与 Session Analysis', async () => {
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
    for (const key of ['application/usage-dashboard', 'composer-panel/session-analysis']) {
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
  assert.ok(sources.some((source) => source.includes('@jetcrab/pi-desk-sdk/react/base')))
  assert.equal((await stat(join(packageRoot, 'dist', 'usage-worker.js'))).isFile(), true)
})
