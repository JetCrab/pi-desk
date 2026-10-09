import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url, {
  nativeModules: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai'
  ],
  tsconfigPaths: resolve('tsconfig.json')
})
const {
  readL4PiPluginPreferences,
  removeL4PiPluginPreference,
  setL4PiPluginDownloadSource,
  setL4PiPluginEnabled,
  readL4PiPluginUpdateTag,
  setL4PiPluginUpdateTag,
  setL4PiPluginRegistry
} = await jiti.import<typeof import('../src/server/l4_foundation/pi/l4-pi-plugin-preferences')>(
  '../src/server/l4_foundation/pi/l4-pi-plugin-preferences.ts'
)
import {
  l4PluginSourceIdentity as l2PluginSourceIdentity,
  readL4PluginDescription as readL2PluginDescription
} from '../src/common/l4_foundation/plugin/l4-plugin-package'
import { selectL4LocalizedText } from '../src/common/l4_foundation/locale/l4-localized-text'
import { L2PluginDownloadSourceSchema } from '../src/common/l2_biz/plugin/l2-plugin-catalog-contract'

test('禁用跟随包身份而不是版本，切换公共下载源保留私有包归属', async (context) => {
  const root = resolve('temp/run/plugin-management', `preferences-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  context.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(readL4PiPluginPreferences(root), {
    downloadSource: { mode: 'auto' },
    disabled: [],
    registries: {},
    updateTags: {}
  })
  setL4PiPluginEnabled('npm:@fixture/plugin@1.0.0', false, root)
  setL4PiPluginRegistry('npm:@fixture/plugin@1.0.0', 'https://registry.example.test', root)
  setL4PiPluginDownloadSource({ mode: 'domestic' }, root)
  const preferences = readL4PiPluginPreferences(root)
  assert.deepEqual(preferences.disabled, ['npm:@fixture/plugin'])
  assert.equal(preferences.registries['npm:@fixture/plugin'], 'https://registry.example.test')
  setL4PiPluginEnabled('npm:@fixture/plugin@2.0.0', true, root)
  assert.deepEqual(readL4PiPluginPreferences(root).disabled, [])
  setL4PiPluginEnabled('C:\\plugins\\local', false, root)
  assert.ok(readL4PiPluginPreferences(root).disabled.includes('C:/plugins/local'))
  removeL4PiPluginPreference('npm:@fixture/plugin@2.0.0', root)
  assert.deepEqual(readL4PiPluginPreferences(root).registries, {})
  const saved = JSON.parse(await readFile(join(root, 'pi-desk-plugins.json'), 'utf8'))
  assert.deepEqual(Object.keys(saved).sort(), [
    'disabled',
    'downloadSource',
    'registries',
    'updateTags'
  ])
})

test('更新渠道按包身份保存，指定版本不改变渠道，卸载清理偏好', async (context) => {
  const root = resolve('temp/run/plugin-management', `update-channel-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  context.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(readL4PiPluginUpdateTag('npm:@fixture/new-plugin', root), 'latest')
  assert.equal(readL4PiPluginUpdateTag('npm:@fixture/plugin@dev', root), 'dev')
  assert.equal(readL4PiPluginUpdateTag('npm:@fixture/plugin@1.0.1-dev.1', root), 'latest')
  setL4PiPluginUpdateTag('npm:@fixture/plugin@1.0.1-dev.1', 'dev', root)
  assert.equal(readL4PiPluginUpdateTag('npm:@fixture/plugin@1.0.1-dev.2', root), 'dev')
  assert.equal(readL4PiPluginUpdateTag('npm:@fixture/other', root), 'latest')
  assert.deepEqual(readL4PiPluginPreferences(root).updateTags, { 'npm:@fixture/plugin': 'dev' })
  setL4PiPluginUpdateTag('npm:@fixture/plugin', 'latest', root)
  assert.equal(readL4PiPluginUpdateTag('npm:@fixture/plugin@dev', root), 'latest')
  removeL4PiPluginPreference('npm:@fixture/plugin@1.0.1-dev.2', root)
  assert.deepEqual(readL4PiPluginPreferences(root).updateTags, {})
})

test('旧简介与语言覆盖共存，缺少翻译回退标准description', () => {
  assert.equal(
    readL2PluginDescription({ description: '  Default description  ' }),
    'Default description'
  )
  const description = readL2PluginDescription({
    description: 'Run tasks',
    piDesk: { i18n: { 'zh-CN': { description: '运行任务' } } }
  })
  assert.ok(description)
  assert.equal(selectL4LocalizedText(description, 'zh-CN'), '运行任务')
  assert.equal(selectL4LocalizedText(description, 'en'), 'Run tasks')
  assert.equal(readL2PluginDescription({}), null)
  assert.equal(l2PluginSourceIdentity('npm:@fixture/tool@1.2.3'), 'npm:@fixture/tool')
  assert.equal(l2PluginSourceIdentity('npm:tool@next'), 'npm:tool')
})

test('自定义源只接受完整HTTP仓库地址，不接受夹带认证或查询的URL', () => {
  assert.ok(
    L2PluginDownloadSourceSchema.safeParse({
      mode: 'custom',
      registry: 'https://registry.example.test/npm/'
    }).success
  )
  for (const registry of [
    'file:///tmp/packages',
    'https://user:password@example.test',
    'https://example.test/?token=secret',
    'https://example.test/#fragment'
  ]) {
    assert.equal(
      L2PluginDownloadSourceSchema.safeParse({ mode: 'custom', registry }).success,
      false
    )
  }
})
