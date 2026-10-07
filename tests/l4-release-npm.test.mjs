import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { selectPackages, assertPackedManifest, run } from '../.github/scripts/release-npm.mjs'

const publishConfig = { registry: 'https://registry.npmjs.org', access: 'public' }
async function fixture(context) {
  const parent = resolve('temp/tests/release-npm/selection')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'packages-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  for (const [directory, name] of [
    ['.', 'pi-desk'],
    ['plugins/pi-desk-usage', 'pi-desk-usage'],
    ['plugins/pi-desk-sdk', 'pi-desk-sdk']
  ]) {
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(
      join(root, directory, 'package.json'),
      JSON.stringify({ name: `@jetcrab/${name}`, version: '1.0.0', publishConfig })
    )
  }
  return root
}

test('包管理命令保留参数与带空格路径而不被Shell二次转义', async (context) => {
  const root = await fixture(context)
  const directory = join(root, 'command fixture')
  await mkdir(directory)
  await writeFile(join(directory, 'package.json'), '{"private":true}')
  const script = join(directory, 'arguments.cjs')
  await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const output = run(
    'pnpm',
    ['--dir', directory, 'exec', process.execPath, script, 'value with spaces'],
    { capture: true }
  )
  assert.deepEqual(JSON.parse(output), ['value with spaces'])
})

test('插件独立配置解析SDK发布入口而非宿主源码别名', () => {
  const directory = resolve('plugins/pi-desk-tibo-monitor')
  const output = run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      'console.log(import.meta.resolve("@jetcrab/pi-desk-sdk/host-runtime/base.js"))'
    ],
    {
      cwd: directory,
      capture: true,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(directory, 'tsconfig.json') }
    }
  )
  assert.match(output.trim(), /\/dist\/host-runtime\/base\.js$/)
})

test('公开包发布先SDK，允许单独选择包但不接受未知目标', async (context) => {
  const root = await fixture(context)
  const all = await selectPackages(root, 'all')
  assert.equal(all.length, 3)
  assert.equal(all[0].manifest.name, '@jetcrab/pi-desk-sdk')
  assert.equal(
    (await selectPackages(root, 'pi-desk-usage'))[0].manifest.name,
    '@jetcrab/pi-desk-usage'
  )
  await assert.rejects(selectPackages(root, '../private'))
})

test('拒绝把私有包或私有Registry纳入公开发布', async (context) => {
  const root = await fixture(context)
  await writeFile(
    join(root, 'plugins/pi-desk-usage/package.json'),
    JSON.stringify({ name: '@jetcrab-private/pi-desk-usage', version: '1.0.0', publishConfig })
  )
  await assert.rejects(selectPackages(root, 'all'))
})

test('验证tarball身份与普通版本依赖，不允许workspace或文件路径泄入制品', () => {
  const source = { name: '@jetcrab/pi-desk', version: '1.0.0' }
  const packed = { ...source, publishConfig, dependencies: { '@jetcrab/pi-desk-sdk': '^1.0.0' } }
  assert.doesNotThrow(() => assertPackedManifest(packed, source))
  for (const version of ['workspace:^', 'file:../sdk', 'link:../sdk']) {
    assert.throws(() =>
      assertPackedManifest({ ...packed, dependencies: { '@jetcrab/pi-desk-sdk': version } }, source)
    )
  }
  assert.throws(() => assertPackedManifest({ ...packed, version: '2.0.0' }, source))
  assert.throws(() =>
    assertPackedManifest(
      { ...packed, publishConfig: { registry: 'https://registry.example', access: 'public' } },
      source
    )
  )
})
