import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { bindConfigStore, getUnifiedConfigPath } from '../plugins/pi-desk-sdk/src/config-store.ts'
import {
  readContextIgnoreSettings,
  writeContextIgnoreSettings
} from '../plugins/pi-desk-ctx/src/context-settings-store.ts'
import { quotaAdapterRegistry } from '../plugins/pi-desk-quota-viewer/src/adapters/registry.ts'
import {
  readStoredConfig,
  writeStoredConfig
} from '../plugins/pi-desk-quota-viewer/src/l2-quota-config.ts'
import { readStore, writeStore } from '../plugins/pi-desk-tibo-monitor/src/l4-tibo-storage.ts'
import { RemoteDebugSettingsStore } from '../plugins/pi-desk-remote-debug/src/l4-remote-debug-settings.ts'
import {
  listGlobalSubagentSettings,
  discoverSubagentConfigs
} from '../plugins/pi-desk-subagent/src/agent-config.ts'

test('公开插件共用 YAML，旧全局文件不读取或修改', async (t) => {
  const root = resolve('temp/run/unified-config')
  await mkdir(root, { recursive: true })
  const agentDir = await mkdtemp(join(root, 'public-plugins-'))
  t.after(() => rm(agentDir, { recursive: true, force: true }))
  await mkdir(join(agentDir, 'config'), { recursive: true })
  const legacyFiles = [
    'pi-desk-ctx.json',
    'pi-desk-quota-viewer.json',
    'pi-desk-tibo-monitor.json',
    'pi-desk-remote-debug-ports.json',
    'pi-desk-subagent.json'
  ]
  for (const name of legacyFiles)
    await writeFile(join(agentDir, 'config', name), 'legacy-invalid-format')
  const key = randomBytes(32)
  const config = (name: string) =>
    bindConfigStore('plugins', name, { agentDir, keyProvider: async () => key })

  const context = config('context-ignore')
  const defaults = await readContextIgnoreSettings(context)
  const settings = { ...defaults, enabled: !defaults.enabled }
  await writeContextIgnoreSettings(settings, context)
  assert.deepEqual(await readContextIgnoreSettings(context), settings)

  const quota = config('quota-viewer')
  const initial = await readStoredConfig(quota, quotaAdapterRegistry)
  const quotaSettings = {
    ...initial,
    sources: [
      {
        sourceId: '11111111-1111-4111-8111-111111111111',
        adapter: 'cpa',
        name: 'fixture',
        enabled: false,
        config: {
          managementUrl: 'https://cpa.example.test/v0/management',
          managementKey: 'fixture-management-key'
        }
      }
    ]
  }
  await writeStoredConfig(quota, quotaSettings, quotaAdapterRegistry)
  assert.deepEqual(await readStoredConfig(quota, quotaAdapterRegistry), quotaSettings)
  assert.equal(
    (await readFile(getUnifiedConfigPath(agentDir), 'utf8')).includes('fixture-management-key'),
    false
  )

  const tibo = config('tibo-monitor')
  const dataPath = join(agentDir, 'pi-desk', 'tibo-monitor.json')
  const data = await readStore(tibo, dataPath)
  await writeStore(tibo, data, dataPath)
  assert.deepEqual(await readStore(tibo, dataPath), data)
  assert.deepEqual(await tibo.get(), { settings: data.settings })

  const remote = new RemoteDebugSettingsStore({
    config: config('remote-debug'),
    agentDir,
    readTunnelServer: async () => null
  })
  const ranges = await remote.get()
  await remote.saveRanges({ localRange: ranges.localRange, publicRange: ranges.publicRange })
  assert.deepEqual((await remote.get()).localRange, ranges.localRange)
  assert.equal(Object.hasOwn(await config('remote-debug').get(), 'registrations'), false)

  await mkdir(join(agentDir, 'agents'), { recursive: true })
  await writeFile(
    join(agentDir, 'agents', 'fixture.md'),
    '---\ndescription: 配置验证\ntools: read\n---\n只用于隔离测试。\n'
  )
  const subagent = config('subagent')
  await subagent.set({ agents: { fixture: { model: 'provider/model', disabled: true } } })
  const selected = await subagent.get()
  assert.equal(
    listGlobalSubagentSettings(agentDir, selected).find((item) => item.name === 'fixture')
      ?.disabled,
    true
  )
  assert.equal(
    discoverSubagentConfigs({
      cwd: agentDir,
      projectTrusted: false,
      agentDir,
      builtinAgentsDir: null,
      settings: selected
    }).configs.size,
    0
  )

  for (const name of legacyFiles)
    assert.equal(await readFile(join(agentDir, 'config', name), 'utf8'), 'legacy-invalid-format')
})
