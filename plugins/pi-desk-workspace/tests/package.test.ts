import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '../src/core.js'

interface PackageManifest {
  name?: string
  version?: string
  license?: string
  publishConfig?: { registry?: string; access?: string }
  pi?: { extensions?: string[]; skills?: string[]; prompts?: string[] }
  piDesk?: { entry?: string }
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browserRoot = join(packageRoot, 'dist', 'browser')

test('环境归档仅声明Handler资源，统一配置由宿主归档', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.piDesk.environment.files, [
    { base: 'project', path: 'workspace', format: 'binary', secretPaths: [] }
  ])
})

test('package 同时声明原生 Extension 与 Pi Desk Browser Adapter', async () => {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8')
  ) as PackageManifest
  assert.equal(manifest.name, '@jetcrab/pi-desk-workspace')
  assert.equal(manifest.license, 'Apache-2.0')
  assert.deepEqual(manifest.publishConfig, {
    registry: 'https://registry.npmjs.org',
    access: 'public'
  })
  assert.match(manifest.version ?? '', /^\d+\.\d+\.\d+(?:-dev)?$/u)
  assert.deepEqual(manifest.pi?.extensions, ['./dist/index.js'])
  assert.deepEqual(manifest.pi?.skills, ['./dist/skills/workspace-usage'])
  assert.deepEqual(manifest.pi?.prompts, ['./dist/prompts/init-workspace.md'])
  assert.equal(new Set(manifest.pi?.skills).size, manifest.pi?.skills?.length)
  assert.equal(manifest.piDesk?.entry, './dist/pi-desk.js')
  assert.equal(manifest.dependencies?.['@jetcrab/pi-desk-sdk'], 'workspace:^')
  assert.equal(manifest.dependencies?.['cross-spawn'], '^7.0.6')
  assert.equal(manifest.peerDependencies?.typebox, '*')
})

test('初始化提示词随包完整分发，配置示例符合生命周期合同', async () => {
  const prompt = await readFile(join(packageRoot, 'dist/prompts/init-workspace.md'), 'utf8')
  assert.equal(prompt, await readFile(join(packageRoot, 'prompts/init-workspace.md'), 'utf8'))
  assert.deepEqual(await readdir(join(packageRoot, 'dist/skills')), ['workspace-usage'])

  const example = /```yaml\r?\n([\s\S]*?)\r?\n```/u.exec(prompt)?.[1]
  assert.ok(example, '提示词包含可解析的完整配置示例')
  const config = parseConfig(example, 'init-workspace.md')
  for (const definition of Object.values(config.definitions)) {
    assert.deepEqual(definition.commands.reset?.from, ['occupied'])
    assert.equal(definition.commands.reset?.onSuccess, 'available')
    assert.deepEqual(definition.commands.remove?.from, ['available', 'occupied'])
    assert.equal(definition.commands.remove?.onSuccess, 'removed')
  }
})

test('Browser Entry 轻量注册隔离工作区会话侧栏', async () => {
  const entry = await readFile(join(browserRoot, 'entry.js'), 'utf8')
  const files = await readdir(browserRoot, { recursive: true })
  const topLevelBrowserFiles = (await readdir(join(packageRoot, 'dist'))).filter(
    (name) => name.startsWith('browser') && name !== 'browser'
  )

  assert.ok(Buffer.byteLength(entry, 'utf8') < 20 * 1024)
  assert.match(entry, /registerContribution\("session-sidebar-tab","workspace"/)
  assert.match(entry, /import\(/)
  assert.equal(entry.includes('react-dom'), false)
  assert.ok(files.filter((path) => path.endsWith('.js')).length > 1)
  assert.deepEqual(topLevelBrowserFiles, [])
})
