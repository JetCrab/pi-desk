import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { L4PiPluginOwnerRuntime } from '../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime'
import { L4PiPluginMethodNotFoundError } from '../src/server/l4_foundation/pi/l4-pi-plugin-method-runtime-core'

async function fixture(context: test.TestContext): Promise<{
  runtime: L4PiPluginOwnerRuntime
  candidate: (name: string, body: string) => Promise<string>
  state: { setups: string[]; releases: string[] }
}> {
  const root = resolve('temp/pi/l4-owner-replace', `replace-${randomUUID()}`, 'agent')
  const key = `__ownerReplace${randomUUID().replaceAll('-', '')}`
  const state = { setups: [] as string[], releases: [] as string[] }
  Reflect.set(globalThis, key, state)
  let index = 0
  const candidate = async (name: string, body: string): Promise<string> => {
    const directory = join(root, `package-${index++}`)
    await mkdir(join(directory, 'browser'), { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        type: 'module',
        piDesk: { entry: './entry.mjs' }
      })
    )
    await writeFile(join(directory, 'browser/entry.js'), 'export default () => undefined')
    await writeFile(
      join(directory, 'entry.mjs'),
      `export default { name: '${name}', setup(plugin) {
      const state = globalThis.${key}
      state.setups.push('${name}')
      plugin.registerBrowserEntry('./browser/entry.js')
      ${body}
    } }`
    )
    return directory
  }
  const a = await candidate(
    'owner-a',
    `
    plugin.registerMethod('get', async () => ({ version: 1 }))
    return () => { state.releases.push('owner-a') }
  `
  )
  const b = await candidate(
    'owner-b',
    `
    plugin.registerMethod('get', async () => ({ version: 1 }))
    return () => { state.releases.push('owner-b') }
  `
  )
  const runtime = new L4PiPluginOwnerRuntime(async () => [
    { source: 'source-a', installedPath: a },
    { source: 'source-b', installedPath: b }
  ])
  context.after(async () => {
    await runtime.dispose()
    Reflect.deleteProperty(globalThis, key)
    await rm(dirname(root), { recursive: true, force: true })
  })
  await runtime.initialize()
  return { runtime, candidate, state }
}

test('替换一个Owner保持其他服务和Browser资源身份不变', async (context) => {
  const { runtime, candidate, state } = await fixture(context)
  const before = (await runtime.listBrowserEntries()).find(
    (entry) => entry.pluginName === 'owner-b'
  )
  const next = await candidate(
    'owner-a',
    `plugin.registerMethod('get', async () => ({ version: 2 }))`
  )
  await runtime.replaceSource('source-a', next)
  assert.deepEqual(await runtime.invoke('owner-a', 'get', {}), { version: 2 })
  assert.deepEqual(await runtime.invoke('owner-b', 'get', {}), { version: 1 })
  assert.equal(
    (await runtime.listBrowserEntries()).find((entry) => entry.pluginName === 'owner-b')
      ?.resourceKey,
    before?.resourceKey
  )
  assert.equal(state.setups.filter((name) => name === 'owner-b').length, 1)
  assert.deepEqual(state.releases, ['owner-a'])
})

test('卸载仅撤销目标Owner，重复卸载不重复调用清理', async (context) => {
  const { runtime, state } = await fixture(context)
  await runtime.replaceSource('source-a', null)
  await runtime.replaceSource('source-a', null)
  await assert.rejects(runtime.invoke('owner-a', 'get', {}), L4PiPluginMethodNotFoundError)
  assert.deepEqual(await runtime.invoke('owner-b', 'get', {}), { version: 1 })
  assert.deepEqual(
    (await runtime.listBrowserEntries()).map((entry) => entry.pluginName),
    ['owner-b']
  )
  assert.deepEqual(state.releases, ['owner-a'])
})

test('新版setup失败只停用目标来源，修复后可重新加载', async (context) => {
  const { runtime, candidate } = await fixture(context)
  await assert.rejects(
    runtime.replaceSource(
      'source-a',
      await candidate('owner-a', `throw new Error('candidate failed')`)
    ),
    /candidate failed/
  )
  await assert.rejects(runtime.invoke('owner-a', 'get', {}), L4PiPluginMethodNotFoundError)
  assert.deepEqual(await runtime.invoke('owner-b', 'get', {}), { version: 1 })
  await runtime.replaceSource(
    'source-a',
    await candidate('owner-a', `plugin.registerMethod('get', async () => ({ version: 3 }))`)
  )
  assert.deepEqual(await runtime.invoke('owner-a', 'get', {}), { version: 3 })
})

test('旧关闭钩子在新Owner创建后返回也只能完成一次', async (context) => {
  const { runtime, candidate, state } = await fixture(context)
  const first = await candidate(
    'owner-a',
    `
    return { beforeReload() { state.releases.push('before') }, dispose() { state.releases.push('dispose') } }
  `
  )
  await runtime.replaceSource('source-a', first)
  await runtime.replaceSource(
    'source-a',
    await candidate('owner-a', `plugin.registerMethod('get', async () => ({ version: 2 }))`)
  )
  await runtime.dispose()
  assert.equal(state.releases.filter((item) => item === 'before').length, 1)
  assert.equal(state.releases.filter((item) => item === 'dispose').length, 1)
  await assert.rejects(runtime.invoke('owner-a', 'get', {}), /disposed/)
})
