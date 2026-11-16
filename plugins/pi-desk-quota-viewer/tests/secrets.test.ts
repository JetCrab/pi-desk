import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { bindConfigStore, getUnifiedConfigPath } from '@jetcrab/pi-desk-sdk/config'
import { quotaAdapterRegistry } from '../src/adapters/registry.js'
import { readStoredConfig, writeStoredConfig, type StoredConfig } from '../src/l2-quota-config.js'
import { QuotaViewerRuntime } from '../src/runtime.js'

function config(): StoredConfig {
  return {
    sources: [
      {
        sourceId: '11111111-1111-4111-8111-111111111111',
        adapter: 'openrouter',
        name: '测试账户',
        enabled: false,
        config: { managementKey: 'test-only-api-key', apiKey: '' }
      }
    ],
    display: { resetTimeFormat: 'countdown', hiddenItemKeys: [] }
  }
}

async function fixture(t: test.TestContext) {
  const root = fileURLToPath(new URL('../../../temp/run/quota-secrets/', import.meta.url))
  await mkdir(root, { recursive: true })
  const agentDir = await mkdtemp(join(root, 'inline-credentials-'))
  t.after(() => rm(agentDir, { recursive: true, force: true }))
  return {
    agentDir,
    path: getUnifiedConfigPath(agentDir),
    store: bindConfigStore('plugins', 'quota-viewer', {
      agentDir,
      keyProvider: async () => new Uint8Array(32).fill(11)
    })
  }
}

test('设置页返回明文，保存内联密文，空值与普通字段保持原值', async (t) => {
  const { store, path } = await fixture(t)
  await writeStoredConfig(store, config())
  assert.deepEqual(await readStoredConfig(store, quotaAdapterRegistry), config())
  const saved = await store.get()
  assert.equal((await readFile(path, 'utf8')).includes('test-only-api-key'), false)
  const source = (saved.sources as Array<{ config: Record<string, string> }>)[0]!
  assert.match(source.config.managementKey!, /^enc:v1:/u)
  assert.equal(source.config.apiKey, '')
  await writeStoredConfig(store, config())
  assert.deepEqual(await readStoredConfig(store, quotaAdapterRegistry), config())
})

test('密钥不可用时查询及更新失败并保留现有配置', async (t) => {
  const { agentDir, store, path } = await fixture(t)
  await writeStoredConfig(store, config())
  const before = await readFile(path)
  const unavailable = bindConfigStore('plugins', 'quota-viewer', {
    agentDir,
    keyProvider: async () => {
      throw new Error('测试密钥不可用')
    }
  })
  const runtime = new QuotaViewerRuntime({ config: unavailable, pushGlobal() {} })
  t.after(() => runtime.dispose())
  await assert.rejects(runtime.settings(), /密钥不可用/u)
  await assert.rejects(
    runtime.saveSettings({ display: { resetTimeFormat: 'absolute' } }),
    /密钥不可用/u
  )
  assert.deepEqual(await readFile(path), before)
})

test('旧配置及保险库不读取不修改，非法更新不覆盖有效配置', async (t) => {
  const { agentDir, store, path } = await fixture(t)
  await mkdir(join(agentDir, 'config'), { recursive: true })
  const legacy = join(agentDir, 'config', 'pi-desk-quota-viewer.json')
  const vault = join(agentDir, 'config', 'credentials.enc')
  await writeFile(legacy, 'legacy-invalid-format')
  await writeFile(vault, 'legacy-vault-bytes')
  assert.deepEqual((await readStoredConfig(store, quotaAdapterRegistry)).sources, [])
  await writeStoredConfig(store, config())
  const before = await readFile(path)
  const invalid = config()
  invalid.sources[0]!.sourceId = 'invalid'
  await assert.rejects(writeStoredConfig(store, invalid))
  assert.deepEqual(await readFile(path), before)
  assert.equal(await readFile(legacy, 'utf8'), 'legacy-invalid-format')
  assert.equal(await readFile(vault, 'utf8'), 'legacy-vault-bytes')
})
