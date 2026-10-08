import assert from 'node:assert/strict'
import { access, lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const pluginNames = [
  'pi-desk-bg-run',
  'pi-desk-ctx',
  'pi-desk-deliverables',
  'pi-desk-quota-viewer',
  'pi-desk-remote-debug',
  'pi-desk-sdk',
  'pi-desk-subagent',
  'pi-desk-tibo-monitor',
  'pi-desk-tool-reason',
  'pi-desk-usage'
]

async function manifest(directory) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
}

test('公开插件仅包含已确认范围并使用公共发布依赖', async () => {
  const entries = await readdir(join(root, 'plugins'), { withFileTypes: true })
  assert.deepEqual(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    pluginNames
  )
  const packages = [await manifest(root)]
  for (const name of pluginNames) {
    const item = await manifest(join(root, 'plugins', name))
    assert.equal(item.name, `@jetcrab/${name}`)
    assert.equal(
      (item.files ?? []).some((file) => /^docs(?:\/|$)/.test(file)),
      false,
      `${name} 不应默认分发详细文档`
    )
    await assert.rejects(access(join(root, 'plugins', name, 'docs')), { code: 'ENOENT' })
    packages.push(item)
  }
  for (const item of packages) {
    assert.equal(item.publishConfig.registry, 'https://registry.npmjs.org')
    assert.equal(item.publishConfig.access, 'public')
    for (const group of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies'
    ]) {
      for (const [name, version] of Object.entries(item[group] ?? {})) {
        assert.ok(!name.startsWith('@jetcrab-private/'), `${item.name} 依赖私有包 ${name}`)
        assert.doesNotMatch(
          version,
          /^(?:link:|file:)|https?:\/\/(?!registry\.npmjs\.org)/,
          `${item.name} 依赖外部目录或非公共源`
        )
      }
    }
  }
  const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
  assert.doesNotMatch(lock, /@jetcrab-private|npm\.wanquant\.com|(?:link:|file:)\.\.\/\.\.\/github/)
})

test('源码目录不包含真实签名文件或维护者配置', async () => {
  const excluded = new Set([
    '.git',
    'node_modules',
    'temp',
    'dist',
    'target',
    'build',
    '.next',
    '.gradle',
    'web-dist'
  ])
  const privateNames = new Set([
    'maintainer-settings.json',
    'task-ssh.yaml',
    'remote-debug.yaml',
    'android-release.properties',
    'release.properties'
  ])
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue
      const path = join(directory, entry.name)
      const local = relative ? `${relative}/${entry.name}` : entry.name
      const metadata = await lstat(path)
      assert.equal(metadata.isSymbolicLink(), false, `源码不得通过链接引入外部内容：${local}`)
      if (entry.isDirectory()) {
        await visit(path, local)
      } else {
        assert.doesNotMatch(
          local,
          /\.(?:p12|pfx|pem|key|jks|keystore)$/i,
          `源码包含签名或私钥文件：${local}`
        )
        assert.ok(!privateNames.has(entry.name), `源码包含维护者配置：${local}`)
        assert.ok(
          !/^\.pi\/(?:settings\.json|task_ssh\.yaml|remote_debug\.yaml)$/.test(local),
          `源码包含个人 Pi 配置：${local}`
        )
        assert.ok(
          !/^\.env(?:\.|$)/.test(entry.name) || entry.name === '.env.example',
          `源码包含非示例环境配置：${local}`
        )
      }
    }
  }
  await visit(root)
})

test('官网应用可独立公开，维护资料仍留在私有侧', async () => {
  const sdk = await manifest(join(root, 'plugins/pi-desk-sdk'))
  assert.equal(sdk.files.includes('docs'), false)
  assert.equal(sdk.files.includes('PLUGIN-UI-STANDARD.md'), false)
  for (const path of [
    '.pi',
    'config',
    'secrets',
    'release',
    'docs/api.md',
    'plugins/pi-desk-sdk/PLUGIN-UI-STANDARD.md',
    'plugins/pi-desk-sdk/docs'
  ]) {
    await assert.rejects(access(join(root, path)), { code: 'ENOENT' })
  }
  const website = await manifest(join(root, 'apps/website'))
  assert.equal(website.private, true, '官网应用不发布到 npm')
  assert.equal(website.name, '@jetcrab/pi-desk-website')
  assert.ok(!JSON.stringify(website).includes('.pi/打包'))
  const docs = await readdir(join(root, 'apps/website/content/docs'))
  assert.deepEqual(docs.sort(), [
    'development.md',
    'devices.md',
    'faq.md',
    'installation.md',
    'overview.md',
    'plugins.md',
    'quickstart.md'
  ])
})
