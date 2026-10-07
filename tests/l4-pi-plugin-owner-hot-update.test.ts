import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { L4PiPluginOwnerRuntime } from '../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime'

async function fixture(
  context: test.TestContext,
  body: string
): Promise<{
  runtime: L4PiPluginOwnerRuntime
  replace: (next: string) => Promise<void>
  state: Record<string, unknown>
}> {
  const root = resolve('temp/pi/l4-owner-hot-update', `owner-${randomUUID()}`, 'agent')
  const key = `__ownerHot${randomUUID().replaceAll('-', '')}`
  const state: Record<string, unknown> = {}
  Reflect.set(globalThis, key, state)
  let index = 0
  const create = async (code: string): Promise<string> => {
    const directory = join(root, `code-${index++}`)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'hot-fixture',
        type: 'module',
        piDesk: { entry: './entry.mjs' }
      })
    )
    await writeFile(
      join(directory, 'entry.mjs'),
      `export default { name: 'hot-fixture', setup(plugin) {
      const state = globalThis.${key}
      ${code}
    } }`
    )
    return directory
  }
  const directory = await create(body)
  const runtime = new L4PiPluginOwnerRuntime(async () => [
    { source: 'fixture', installedPath: directory }
  ])
  runtime.bindAppRuntimeSink({
    setState: (_name, value) => {
      state.published = value
    },
    publishNotification: () => 'notification',
    updateNotification: () => undefined,
    deleteNotification: () => undefined,
    releasePlugin: () => {
      delete state.published
    }
  })
  context.after(async () => {
    await runtime.dispose()
    Reflect.deleteProperty(globalThis, key)
    await rm(join(root, '..'), { recursive: true, force: true })
  })
  await runtime.initialize()
  return {
    runtime,
    state,
    replace: async (next) => runtime.replaceSource('fixture', await create(next))
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('旧插件阻塞了宿主替换')), 3000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('替换中止不返回的方法，旧结果不能成为新版结果', async (context) => {
  const { runtime, replace, state } = await fixture(
    context,
    `
    plugin.registerMethod('hold', async (_input, context) => {
      state.signal = context.signal
      return new Promise(resolve => { state.complete = () => resolve({ version: 1 }) })
    })
  `
  )
  const pending = runtime.invoke('hot-fixture', 'hold', {})
  const rejected = assert.rejects(pending)
  while (!state.signal) await new Promise<void>((done) => setImmediate(done))
  await bounded(replace(`plugin.registerMethod('get', async () => ({ version: 2 }))`))
  assert.equal((state.signal as AbortSignal).aborted, true)
  await bounded(rejected)
  assert.deepEqual(await runtime.invoke('hot-fixture', 'get', {}), { version: 2 })
  const complete = state.complete
  assert.equal(typeof complete, 'function')
  Reflect.apply(complete as () => void, undefined, [])
})

test('清理异常和永久未返回都不能阻止新版注册', async (context) => {
  const { runtime, replace } = await fixture(
    context,
    `
    return {
      beforeReload() { throw new Error('fixture cleanup failed') },
      dispose() { return new Promise(() => {}) }
    }
  `
  )
  await bounded(replace(`plugin.registerMethod('get', async () => ({ version: 2 }))`))
  assert.deepEqual(await runtime.invoke('hot-fixture', 'get', {}), { version: 2 })
})

test('旧清理晚返回不能写新版状态或删新版方法', async (context) => {
  const { runtime, replace, state } = await fixture(
    context,
    `
    const unregister = plugin.registerMethod('get', async () => ({ version: 1 }))
    return async () => {
      await new Promise(resolve => { state.finishCleanup = resolve })
      unregister()
      try { plugin.setState({ version: 1 }) } catch { state.staleRejected = true }
    }
  `
  )
  await bounded(
    replace(`
    plugin.setState({ version: 2 })
    plugin.registerMethod('get', async () => ({ version: 2 }))
  `)
  )
  const finish = state.finishCleanup
  assert.equal(typeof finish, 'function')
  Reflect.apply(finish as () => void, undefined, [])
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(state.staleRejected, true)
  assert.deepEqual(state.published, { version: 2 })
  assert.deepEqual(await runtime.invoke('hot-fixture', 'get', {}), { version: 2 })
})
