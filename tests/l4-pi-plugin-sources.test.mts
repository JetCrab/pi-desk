import assert from 'node:assert/strict'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { discoverL4PiPluginSources } from '../src/server/l4_foundation/pi/l4-pi-plugin-sources'

const testRoot = resolve('temp', 'pi', 'l4-pi-plugin-sources-test', String(process.pid))

test('静态discover使用官方PackageManager、归属本地入口且不执行extension factory', async (context) => {
  await mkdir(testRoot, { recursive: true })
  const root = testRoot
  const agentDir = join(root, 'agent')
  const extensionDir = join(agentDir, 'extensions')
  const cwd = join(root, 'project')
  const packageRoot = join(root, 'local-package')
  const configuredFile = join(root, 'configured-extension.ts')
  const marker = join(root, 'factory-executed.txt')
  const missingPackage = 'npm:@pi-desk-fixture/not-installed-m3'
  context.after(() => rm(root, { recursive: true, force: true }))

  await Promise.all([
    mkdir(extensionDir, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(join(extensionDir, 'pure-node'), { recursive: true }),
    mkdir(join(extensionDir, 'combined'), { recursive: true }),
    mkdir(join(extensionDir, '.hidden'), { recursive: true }),
    mkdir(join(extensionDir, 'node_modules', 'fixture-hidden'), { recursive: true }),
    mkdir(packageRoot, { recursive: true })
  ])
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: [packageRoot, missingPackage],
      extensions: [configuredFile, configuredFile, '-extensions/combined/native.ts']
    }),
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: 'm3-local-package',
      version: '1.2.3',
      description: '  查看插件变更与历史  ',
      pi: { extensions: ['./native.mjs'] },
      piDesk: { entry: './plugin.mjs' }
    }),
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'native.mjs'),
    'export default (pi) => pi.on("session_start", () => {})\n'
  )
  await writeFile(
    join(packageRoot, 'plugin.mjs'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'package')\nexport default { name: 'm3-local-package', setup() {} }\n`,
    'utf8'
  )
  await writeFile(
    join(extensionDir, 'bare.ts'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'bare')\nexport default (pi) => pi.on('session_start', () => {})\n`,
    'utf8'
  )
  await writeFile(
    configuredFile,
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'configured')\nexport default (pi) => pi.on('session_start', () => {})\n`,
    'utf8'
  )
  await symlink(packageRoot, join(extensionDir, 'package-alias'), 'junction')
  await writeFile(
    join(extensionDir, 'pure-node', 'package.json'),
    JSON.stringify({
      name: 'm3-pure-node-directory',
      version: '0.1.0',
      description: '本地插件说明',
      piDesk: { entry: './index.ts' }
    }),
    'utf8'
  )
  await writeFile(
    join(extensionDir, 'pure-node', 'index.ts'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'pure-node')\nexport default { name: 'm3-pure-node-directory', setup() {} }\n`,
    'utf8'
  )
  await writeFile(
    join(extensionDir, 'combined', 'package.json'),
    JSON.stringify({
      name: 'm3-combined-directory',
      version: '0.1.0',
      pi: { extensions: ['./native.ts'] },
      piDesk: { entry: './index.ts' }
    }),
    'utf8'
  )
  await writeFile(
    join(extensionDir, 'combined', 'index.ts'),
    'export default { name: "must-not-load" }\n'
  )
  await writeFile(
    join(extensionDir, 'combined', 'native.ts'),
    'export default (pi) => pi.on("session_start", () => {})\n'
  )
  await writeFile(
    join(extensionDir, '.hidden', 'package.json'),
    JSON.stringify({ name: 'hidden-node-plugin', piDesk: { entry: './index.ts' } }),
    'utf8'
  )
  await writeFile(
    join(extensionDir, '.hidden', 'index.ts'),
    'throw new Error("hidden plugin executed")\n'
  )
  await writeFile(
    join(extensionDir, 'node_modules', 'fixture-hidden', 'package.json'),
    JSON.stringify({ name: 'nested-node-plugin', piDesk: { entry: './index.ts' } }),
    'utf8'
  )
  await writeFile(
    join(extensionDir, 'node_modules', 'fixture-hidden', 'index.ts'),
    'throw new Error("nested plugin executed")\n'
  )
  await mkdir(join(extensionDir, 'bad-manifest'), { recursive: true })
  await writeFile(join(extensionDir, 'bad-manifest', 'package.json'), '{invalid json', 'utf8')
  await writeFile(join(extensionDir, 'bad-manifest', 'index.ts'), 'export default {}\n')
  await mkdir(join(extensionDir, 'no-manifest'), { recursive: true })
  await writeFile(join(extensionDir, 'no-manifest', 'index.ts'), 'export default {}\n')

  const snapshot = await discoverL4PiPluginSources(cwd, agentDir, {
    DefaultPackageManager,
    SettingsManager
  })
  const bySource = new Map(snapshot.sources.map((source) => [source.source, source]))
  const canonicalPackageRoot = resolve(packageRoot)

  const packageSource = bySource.get(packageRoot)
  assert.ok(packageSource)
  assert.equal(packageSource.source, packageRoot)
  assert.equal(packageSource.kind, 'package')
  assert.equal(packageSource.path, canonicalPackageRoot)
  assert.deepEqual(packageSource.nativePaths, [resolve(packageRoot, 'native.mjs')])
  assert.equal(packageSource.piDeskRoot, canonicalPackageRoot)
  assert.equal(packageSource.version, '1.2.3')
  assert.equal(packageSource.description, '查看插件变更与历史')
  assert.equal(packageSource.enabled, true)
  assert.equal(packageSource.error, null)
  assert.equal(
    snapshot.sources.filter((source) => source.path === canonicalPackageRoot).length,
    1,
    'Package root与extension junction alias只能有一个source归属'
  )
  assert.equal(bySource.get(missingPackage)?.kind, 'package')
  assert.equal(bySource.get(missingPackage)?.path, null)
  assert.match(bySource.get(missingPackage)?.error ?? '', /未安装/)
  assert.equal(bySource.get(resolve(extensionDir, 'bare.ts'))?.kind, 'extension')
  assert.equal(bySource.get(resolve(extensionDir, 'bare.ts'))?.enabled, true)
  assert.equal(bySource.get(resolve(extensionDir, 'bare.ts'))?.description, null)
  assert.equal(bySource.get(missingPackage)?.description, null)
  assert.equal(bySource.get(resolve(extensionDir, 'no-manifest'))?.description, null)
  assert.equal(bySource.get(resolve(extensionDir, 'pure-node'))?.description, '本地插件说明')
  assert.deepEqual(bySource.get(resolve(configuredFile))?.nativePaths, [resolve(configuredFile)])
  assert.equal(
    bySource.get(resolve(extensionDir, 'pure-node'))?.piDeskRoot,
    resolve(extensionDir, 'pure-node')
  )
  assert.equal(bySource.get(resolve(extensionDir, 'pure-node'))?.enabled, true)
  assert.equal(
    bySource.get(resolve(extensionDir, 'combined'))?.enabled,
    false,
    JSON.stringify(bySource.get(resolve(extensionDir, 'combined')))
  )
  assert.equal(bySource.get(resolve(extensionDir, 'combined'))?.piDeskRoot, null)
  assert.match(bySource.get(resolve(extensionDir, 'bad-manifest'))?.error ?? '', /JSON|position/i)
  assert.equal(bySource.get(resolve(extensionDir, 'no-manifest'))?.kind, 'extension')
  assert.equal(bySource.get(resolve(extensionDir, 'no-manifest'))?.piDeskRoot, null)
  assert.equal(bySource.has(resolve(extensionDir, '.hidden')), false)
  assert.equal(bySource.has(resolve(extensionDir, 'node_modules', 'fixture-hidden')), false)
  assert.equal(bySource.has(resolve(configuredFile)), true)
  assert.equal(
    snapshot.sources.filter((source) => source.source === resolve(configuredFile)).length,
    1
  )
  assert.equal(snapshot.errors.length, 1)
  assert.match(snapshot.errors[0] ?? '', /与已配置包 .* 重复，保留包来源/)
  assert.deepEqual(bySource.get(packageRoot)?.nativePaths, [resolve(packageRoot, 'native.mjs')])
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(marker)))
})
