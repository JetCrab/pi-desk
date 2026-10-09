import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { L4PiPluginOwnerRuntime } from '../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void
  const promise = new Promise<void>((done) => {
    resolvePromise = done
  })
  return { promise, resolve: resolvePromise }
}

async function fixture(
  context: test.TestContext
): Promise<{ runtime: L4PiPluginOwnerRuntime; release: () => void; entered: Promise<void> }> {
  const root = resolve('temp/run/plugin-management', `owner-idle-${randomUUID()}`)
  const key = `__pluginIdle${randomUUID().replaceAll('-', '')}`
  const entered = deferred()
  const gate = deferred()
  Reflect.set(globalThis, key, { entered: entered.resolve, gate: gate.promise })
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'idle-fixture', type: 'module', piDesk: { entry: './entry.mjs' } })
  )
  await writeFile(
    join(root, 'entry.mjs'),
    `export default { name: 'idle-fixture', setup(plugin) {
    plugin.registerMethod('wait', async (_input, context) => {
      globalThis.${key}.entered(); await globalThis.${key}.gate;
      return { aborted: context.signal.aborted };
    });
    plugin.registerMethod('get', async () => ({ active: true }));
  } }`
  )
  const runtime = new L4PiPluginOwnerRuntime(async () => [
    { source: 'fixture', installedPath: root }
  ])
  context.after(async () => {
    gate.resolve()
    await runtime.dispose()
    Reflect.deleteProperty(globalThis, key)
    await rm(root, { recursive: true, force: true })
  })
  await runtime.initialize()
  return { runtime, release: gate.resolve, entered: entered.promise }
}

test('维护等待在途调用自然完成，同时拒绝新调用后再卸载', { timeout: 10_000 }, async (context) => {
  const { runtime, release, entered } = await fixture(context)
  const active = runtime.invoke('idle-fixture', 'wait', {})
  await entered
  const waiting = deferred()
  let replaced = false
  const maintenance = runtime.withSourceIdle(
    'fixture',
    async () => {
      replaced = true
      await runtime.replaceSource('fixture', null)
    },
    new AbortController().signal,
    waiting.resolve
  )
  await waiting.promise
  assert.equal(replaced, false)
  await assert.rejects(runtime.invoke('idle-fixture', 'get', {}), /仍有调用|busy/i)
  release()
  assert.deepEqual(await active, { aborted: false })
  await maintenance
  assert.equal(replaced, true)
  await assert.rejects(runtime.invoke('idle-fixture', 'get', {}), /not found/i)
})

test('撤销等待不取消插件调用且解除维护占用', { timeout: 10_000 }, async (context) => {
  const { runtime, release, entered } = await fixture(context)
  const active = runtime.invoke('idle-fixture', 'wait', {})
  await entered
  const waiting = deferred()
  const controller = new AbortController()
  const maintenance = runtime.withSourceIdle(
    'fixture',
    async () => {
      throw new Error('不应执行')
    },
    controller.signal,
    waiting.resolve
  )
  await waiting.promise
  controller.abort(new Error('维护已取消'))
  await assert.rejects(maintenance, /aborted|取消/i)
  assert.deepEqual(await runtime.invoke('idle-fixture', 'get', {}), { active: true })
  release()
  assert.deepEqual(await active, { aborted: false })
})
