import assert from 'node:assert/strict'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  BrowserContributionDefinitionMap,
  BrowserContributionKind
} from '@jetcrab/pi-desk-sdk/browser'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browserRoot = join(packageRoot, 'dist', 'browser')

test('Manifest 声明配置 Skill 与Pi Desk Entry，不再携带原生客户端', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.pi.skills, ['./skills'])
  assert.equal(manifest.piDesk.entry, './dist/pi-desk.js')
  assert.equal(manifest.os, undefined)
  assert.equal(manifest.cpu, undefined)
  const skill = await readFile(
    join(packageRoot, 'skills', 'remote-debug-config', 'SKILL.md'),
    'utf8'
  )
  assert.match(skill, /name: remote-debug-config/)
  assert.match(skill, /description: .*远程调试/)
  assert.equal(
    (await stat(join(packageRoot, 'dist', 'l4-remote-debug-config-cli.js'))).isFile(),
    true
  )
  await assert.rejects(access(join(packageRoot, 'dist', 'bin')), { code: 'ENOENT' })
})

test('Browser Entry 懒加载启动页和设置页，不包含 Node 实现', async () => {
  const entry = await readFile(join(browserRoot, 'entry.js'), 'utf8')
  const paths = await readdir(browserRoot, { recursive: true })
  const sources = await Promise.all(
    paths
      .filter((path) => path.endsWith('.js'))
      .map((path) => readFile(join(browserRoot, path), 'utf8'))
  )

  assert.ok(Buffer.byteLength(entry, 'utf8') < 20 * 1024)
  const register = (await import(pathToFileURL(join(browserRoot, 'entry.js')).href)).default
  const contributions = new Map<string, BrowserContributionDefinitionMap[BrowserContributionKind]>()
  let unsubscribed = false
  const dispose = register({
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
    for (const key of ['application/remote-debug', 'settings-page/remote-debug']) {
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
})
