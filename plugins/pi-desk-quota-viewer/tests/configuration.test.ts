import assert from 'node:assert/strict'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createSecretStore } from '@jetcrab/pi-desk-sdk/secrets'
import { quotaAdapterRegistry } from '../src/adapters/registry.js'
import { readStoredConfig, writeStoredConfig, type StoredConfig } from '../src/l2-quota-config.js'
import { quotaVisibilityKey } from '../src/l2-quota-display-key.js'
import { QuotaDisplaySettingsSchema } from '../src/l2-quota-display-schema.js'
import { quota } from './fixtures.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('当前CPA来源独立保存身份启用状态与显示偏好，磁盘凭据仅为引用', async (context) => {
  const directory = join(root, 'temp/run/quota-config', `current-config-${process.pid}`)
  await mkdir(directory, { recursive: true })
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'config', 'pi-desk-quota-viewer.json')
  const store = createSecretStore({
    agentDir: directory,
    keyProvider: async () => new Uint8Array(32).fill(9)
  })
  const value: StoredConfig = {
    sources: [
      {
        sourceId: '11111111-1111-4111-8111-111111111111',
        adapter: 'cpa',
        name: '来源一',
        enabled: false,
        config: {
          managementUrl: 'https://cpa.example.test/v0/management',
          managementKey: 'test-only-key'
        }
      },
      {
        sourceId: '22222222-2222-4222-8222-222222222222',
        adapter: 'cpa',
        name: '来源二',
        enabled: true,
        config: {
          managementUrl: 'https://cpa.example.test/v0/management',
          managementKey: 'test-only-key'
        }
      }
    ],
    display: {
      resetTimeFormat: 'absolute',
      hiddenItemKeys: ['codex:["quota","周额度","",""]', 'devin:["quota","日额度","",""]']
    }
  }
  await writeStoredConfig(path, value, quotaAdapterRegistry, store)
  assert.deepEqual(await readStoredConfig(path, quotaAdapterRegistry, store), value)
  const before = await readFile(path, 'utf8')
  assert.equal(before.includes('test-only-key'), false)
  await writeStoredConfig(path, value, quotaAdapterRegistry, store)
  assert.equal(await readFile(path, 'utf8'), before)
  const vault = await readFile(join(directory, 'config', 'credentials.enc'))
  assert.equal(vault.includes(Buffer.from('test-only-key')), false)
})

test('显示设置只接受当前四元组，模型身份参与显示项标识', () => {
  const key = 'future-product:["balance","余额","",""]'
  assert.deepEqual(QuotaDisplaySettingsSchema.parse({ hiddenItemKeys: [key] }).hiddenItemKeys, [
    key
  ])
  assert.throws(
    () => QuotaDisplaySettingsSchema.parse({ hiddenItemKeys: ['codex:["quota","周额度",""]'] }),
    /显示项标识/
  )
  const model = quota('model/example', '模型额度')
  model.scope.model = 'model-a'
  const first = quotaVisibilityKey('antigravity', model)
  model.scope.model = 'model-b'
  assert.notEqual(quotaVisibilityKey('antigravity', model), first)
})
