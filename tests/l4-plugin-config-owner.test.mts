import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createJiti } from 'jiti'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { PluginConfig } from '../plugins/pi-desk-sdk/src/config-api.ts'
import { bindSessionPlugin } from '../plugins/pi-desk-sdk/src/session.ts'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') },
  tsconfigPaths: resolve('tsconfig.json'),
  nativeModules: ['@earendil-works/pi-coding-agent']
})
const { L4PiPluginOwnerRuntime } = await jiti.import<
  typeof import('../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime.ts')
>('../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime.ts')

test('宿主自动绑定配置身份，Native 共用分组，旧 Owner 不可写入', async () => {
  const runs = resolve('temp/run/unified-config')
  await mkdir(runs, { recursive: true })
  const root = await mkdtemp(join(runs, 'host-owner-'))
  const agentDir = join(root, 'agent')
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const key = `__configTest${randomUUID().replaceAll('-', '')}`
  const stores: Record<string, PluginConfig> = {}
  Reflect.set(globalThis, key, stores)
  const sources: Array<{ source: string; installedPath: string }> = []
  let runtime: InstanceType<typeof L4PiPluginOwnerRuntime> | undefined
  try {
    for (const name of ['config-a', 'config-b']) {
      const directory = join(root, name)
      await mkdir(directory)
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({ name, type: 'module', piDesk: { entry: './entry.mjs' } })
      )
      await writeFile(
        join(directory, 'entry.mjs'),
        `export default { name: '${name}', setup(plugin) {
        globalThis.${key}['${name}'] = plugin.config
        plugin.registerMethod('set', async (input) => { await plugin.config.set(input); return {} })
        plugin.registerMethod('get', async () => plugin.config.get())
      } }`
      )
      sources.push({ source: name, installedPath: directory })
    }
    runtime = new L4PiPluginOwnerRuntime(async () => sources)
    await runtime.initialize()
    await Promise.all([
      runtime.invoke('config-a', 'set', { value: 'first' }),
      runtime.invoke('config-b', 'set', { value: 'second' })
    ])
    assert.deepEqual(await runtime.invoke('config-a', 'get', {}), { value: 'first' })
    assert.deepEqual(await runtime.invoke('config-b', 'get', {}), { value: 'second' })
    const native = bindSessionPlugin({} as ExtensionAPI, 'config-b')
    assert.deepEqual(await native.config.get(), { value: 'second' })
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await stores['config-b']!.set({ value: 'project', nested: { project: true } }, { cwd })
    assert.deepEqual(
      await native.config.get({ cwd, defaults: { fallback: true, nested: { default: true } } }),
      { value: 'project', fallback: true, nested: { default: true, project: true } }
    )
    assert.deepEqual(await runtime.invoke('config-b', 'get', {}), { value: 'second' })
    await runtime.replaceSource('config-a', null)
    await assert.rejects(stores['config-a']!.set({ value: 'stale' }), /active|失效|不可用/i)
    await assert.rejects(
      stores['config-a']!.set({ value: 'stale-project' }, { cwd }),
      /active|失效|不可用/i
    )
    await assert.rejects(stores['config-a']!.get({ cwd }), /active|失效|不可用/i)
    assert.deepEqual(await runtime.invoke('config-b', 'get', {}), { value: 'second' })
  } finally {
    await runtime?.dispose()
    Reflect.deleteProperty(globalThis, key)
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
