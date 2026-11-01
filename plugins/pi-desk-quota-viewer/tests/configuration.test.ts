import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { quotaAdapterRegistry } from '../src/adapters/registry.js'
import { readStoredConfig, writeStoredConfig } from '../src/l2-quota-config.js'
import { migrateQuotaVisibilityKey, quotaVisibilityKey } from '../src/l2-quota-display-key.js'
import { quota } from './fixtures.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('旧 CPA 来源同连接归并并保留密钥、身份、启用和显示偏好', async (context) => {
  const directory = join(root, 'temp/run/quota-config', `legacy-migration-${process.pid}`)
  await mkdir(directory, { recursive: true })
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.json')
  const firstId = '11111111-1111-4111-8111-111111111111'
  const before = {
    sources: [
      {
        sourceId: firstId,
        adapter: 'cpa-codex',
        name: '自定义管理器',
        enabled: false,
        config: {
          managementUrl: 'https://cpa.example.test/',
          managementKey: 'first-key',
          accounts: 'obsolete@example.com'
        }
      },
      {
        sourceId: '22222222-2222-4222-8222-222222222222',
        adapter: 'cpa-devin',
        name: 'Devin（通过 CPA）',
        enabled: true,
        config: {
          managementUrl: 'https://cpa.example.test/v0/management',
          managementKey: 'first-key'
        }
      },
      {
        sourceId: '33333333-3333-4333-8333-333333333333',
        adapter: 'cpa-codex',
        name: 'Codex（通过 CPA）',
        enabled: true,
        config: { managementUrl: 'https://cpa.example.test', managementKey: 'different-key' }
      }
    ],
    display: {
      resetTimeFormat: 'absolute',
      hiddenItemKeys: [
        'cpa-codex:["quota","周额度",""]',
        'cpa-devin:["quota","日额度",""]',
        'commandcode:["balance","购买 Credits 余额",""]'
      ]
    }
  }
  const original = JSON.stringify(before)
  await writeFile(path, original)
  const result = await readStoredConfig(path, quotaAdapterRegistry)
  assert.equal(result.sources.length, 2)
  assert.equal(result.sources[0].sourceId, firstId)
  assert.equal(result.sources[0].name, '自定义管理器')
  assert.equal(result.sources[0].enabled, true)
  assert.equal(result.sources[0].config.managementKey, 'first-key')
  assert.equal(result.sources[0].config.accounts, undefined)
  assert.equal(result.sources[1].name, 'CPA')
  assert.equal(result.sources[1].config.managementKey, 'different-key')
  assert.ok(result.sources.every((source) => source.adapter === 'cpa'))
  assert.deepEqual(result.display, {
    resetTimeFormat: 'absolute',
    hiddenItemKeys: [
      'codex:["quota","周额度","",""]',
      'devin:["quota","日额度","",""]',
      'commandcode:["balance","购买 Credits 余额","",""]'
    ]
  })
  assert.equal(await readFile(path, 'utf8'), original)
  await writeStoredConfig(path, result)
  assert.deepEqual(await readStoredConfig(path, quotaAdapterRegistry), result)
})

test('显示项按类型迁移且包含模型身份，不依赖当前渠道注册', () => {
  assert.equal(
    migrateQuotaVisibilityKey('cpa-codex:["quota","周额度",""]'),
    'codex:["quota","周额度","",""]'
  )
  const model = quota('model/example', '模型额度')
  model.scope.model = 'model-a'
  const first = quotaVisibilityKey('antigravity', model)
  model.scope.model = 'model-b'
  assert.notEqual(quotaVisibilityKey('antigravity', model), first)
  assert.equal(
    migrateQuotaVisibilityKey('future-product:["balance","余额","",""]'),
    'future-product:["balance","余额","",""]'
  )
  assert.equal(migrateQuotaVisibilityKey('invalid'), null)
})
