import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs, { mkdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import test from 'node:test'
import { L4PiPluginOwnerRuntime } from '../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime'

interface RecoveryState {
  attempts: number
  otherAttempts: number
  cleanupStarted: number
  finishSetup?: () => void
  finishCleanup?: () => void
  finishOther?: () => void
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!check()) {
    assert.ok(performance.now() < deadline, '等待插件状态变化超时')
    await nextTurn()
  }
}

async function fixture(
  context: test.TestContext,
  body: string,
  otherBody = ''
): Promise<{
  runtime: L4PiPluginOwnerRuntime
  root: string
  state: RecoveryState
  events: string[]
  initializing: Promise<void>
}> {
  const root = resolve('temp/pi/plugin-owner-recovery', `load-recovery-${randomUUID()}`, 'agent')
  const key = `__pluginRecovery${randomUUID().replaceAll('-', '')}`
  const state: RecoveryState = { attempts: 0, otherAttempts: 0, cleanupStarted: 0 }
  const events: string[] = []
  Reflect.set(globalThis, key, state)
  context.mock.method(console, 'info', (message: string) => events.push(message))
  context.mock.method(console, 'warn', (message: string) => events.push(message))
  for (const name of ['recover-fixture', 'other-fixture']) {
    const directory = join(root, name)
    await mkdir(join(directory, 'browser'), { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name, type: 'module', piDesk: { entry: './entry.mjs' } })
    )
    await writeFile(join(directory, 'browser/entry.js'), 'export default () => undefined')
    await writeFile(
      join(directory, 'entry.mjs'),
      `export default { name: '${name}', async setup(plugin) {
        const state = globalThis.${key}
        ${name === 'recover-fixture' ? `state.attempts++; ${body}` : `state.otherAttempts++; ${otherBody}`}
        plugin.registerMethod('get', async () => ({ attempt: state.attempts }))
        plugin.registerBrowserEntry('./browser/entry.js')
      } }`
    )
  }
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new L4PiPluginOwnerRuntime(async () => [
    { source: 'fixture', installedPath: join(root, 'recover-fixture') },
    { source: 'other', installedPath: join(root, 'other-fixture') }
  ])
  context.after(async () => {
    state.finishSetup?.()
    state.finishCleanup?.()
    state.finishOther?.()
    await runtime.dispose()
    await nextTurn()
    context.mock.timers.reset()
    Reflect.deleteProperty(globalThis, key)
    await rm(resolve(root, '..'), { recursive: true, force: true })
  })
  const initializing = runtime.initialize()
  await waitFor(() => state.attempts === 1)
  return { runtime, root, state, events, initializing }
}

const blockFirst = `if (state.attempts === 1) await new Promise(resolve => { state.finishSetup = resolve })`
const recoveryScheduled = '[Pi Desk][GlobalPluginRuntime] 插件加载超时，稍后自动重试一次'
const recovered = '[Pi Desk][GlobalPluginRuntime] 插件自动重试成功'
const recoveryFailed = '[Pi Desk][GlobalPluginRuntime] 插件自动重试失败，不再自动加载'

async function flush(): Promise<void> {
  await nextTurn()
  await nextTurn()
}

test('启动超时后继续加载其他插件，旧加载结束后延迟十秒自动恢复一次', async (context) => {
  const { runtime, state, events, initializing } = await fixture(context, blockFirst)
  context.mock.timers.tick(15_000)
  await initializing
  assert.equal(
    runtime.readDiagnostics().packages.find((item) => item.source === 'fixture')?.status,
    'failed'
  )
  assert.equal(state.otherAttempts, 1)
  const before = (await runtime.listBrowserEntries())[0]!.resourceKey
  state.finishSetup!()
  await waitFor(() => events.includes(recoveryScheduled))
  context.mock.timers.tick(9_999)
  await flush()
  assert.equal(state.attempts, 1)
  let changes = 0
  runtime.subscribeChanges(() => changes++)
  context.mock.timers.tick(1)
  await waitFor(() => events.includes(recovered))
  assert.equal(state.attempts, 2)
  assert.deepEqual(await runtime.invoke('recover-fixture', 'get', {}), { attempt: 2 })
  const diagnostic = runtime.readDiagnostics().packages.find((item) => item.source === 'fixture')!
  assert.equal(diagnostic.status, 'ready')
  assert.equal(diagnostic.error, null)
  assert.ok(changes > 0)
  const entries = await runtime.listBrowserEntries()
  assert.equal(entries.length, 2)
  assert.equal(entries.find((entry) => entry.pluginName === 'other-fixture')!.resourceKey, before)
  assert.equal(state.otherAttempts, 1)
  context.mock.timers.tick(60_000)
  await flush()
  assert.equal(state.attempts, 2)
})

test('setup 明确报错不触发自动恢复', async (context) => {
  const { runtime, state, initializing } = await fixture(
    context,
    `throw new Error('fixture setup error')`
  )
  await initializing
  context.mock.timers.tick(60_000)
  await flush()
  assert.equal(state.attempts, 1)
  assert.match(
    runtime.readDiagnostics().packages.find((item) => item.source === 'fixture')!.error!.message,
    /fixture setup error/
  )
})

test('自动恢复再次超时后停止，不形成重试循环', async (context) => {
  const { runtime, state, events, initializing } = await fixture(
    context,
    `await new Promise(resolve => { state.finishSetup = resolve })`
  )
  context.mock.timers.tick(15_000)
  await initializing
  state.finishSetup!()
  await waitFor(() => events.includes(recoveryScheduled))
  context.mock.timers.tick(10_000)
  await waitFor(() => state.attempts === 2)
  context.mock.timers.tick(15_000)
  await waitFor(() => events.includes(recoveryFailed))
  state.finishSetup!()
  context.mock.timers.tick(120_000)
  await flush()
  assert.equal(state.attempts, 2)
  assert.equal(
    runtime.readDiagnostics().packages.find((item) => item.source === 'fixture')!.status,
    'failed'
  )
})

test('旧 setup 或异步清理尚未结束时不创建自动恢复实例', async (context) => {
  const { state, events, initializing } = await fixture(
    context,
    `if (state.attempts === 1) {
      await new Promise(resolve => { state.finishSetup = resolve })
      return async () => {
        state.cleanupStarted++
        await new Promise(resolve => { state.finishCleanup = resolve })
      }
    }`
  )
  context.mock.timers.tick(15_000)
  await initializing
  context.mock.timers.tick(60_000)
  await flush()
  assert.equal(state.attempts, 1)
  state.finishSetup!()
  await waitFor(() => state.cleanupStarted === 1)
  context.mock.timers.tick(1_500)
  await flush()
  context.mock.timers.tick(60_000)
  await flush()
  assert.equal(state.attempts, 1)
  assert.equal(events.includes(recoveryScheduled), false)
  state.finishCleanup!()
  await waitFor(() => events.includes(recoveryScheduled))
  context.mock.timers.tick(10_000)
  await waitFor(() => events.includes(recovered))
  assert.equal(state.attempts, 2)
})

test('人工重载取消已安排的自动恢复，不覆盖人工加载实例', async (context) => {
  const { runtime, root, state, events, initializing } = await fixture(context, blockFirst)
  context.mock.timers.tick(15_000)
  await initializing
  state.finishSetup!()
  await waitFor(() => events.includes(recoveryScheduled))
  await runtime.replaceSource('fixture', join(root, 'recover-fixture'))
  const resourceKey = (await runtime.listBrowserEntries()).find(
    (item) => item.pluginName === 'recover-fixture'
  )!.resourceKey
  context.mock.timers.tick(60_000)
  await flush()
  assert.equal(state.attempts, 2)
  assert.equal(
    (await runtime.listBrowserEntries()).find((item) => item.pluginName === 'recover-fixture')!
      .resourceKey,
    resourceKey
  )
})

test('来源维护开始即取消恢复，卸载后旧加载结束也不能重新出现', async (context) => {
  const { runtime, state, initializing } = await fixture(context, blockFirst)
  context.mock.timers.tick(15_000)
  await initializing
  let finishMaintenance!: () => void
  let entered = false
  const maintenance = runtime.withSourceIdle(
    'fixture',
    async () => {
      entered = true
      await new Promise<void>((done) => {
        finishMaintenance = done
      })
      await runtime.replaceSource('fixture', null)
    },
    new AbortController().signal,
    () => undefined
  )
  await waitFor(() => entered)
  state.finishSetup!()
  context.mock.timers.tick(60_000)
  await flush()
  assert.equal(state.attempts, 1)
  finishMaintenance()
  await maintenance
  context.mock.timers.tick(60_000)
  await flush()
  assert.equal(state.attempts, 1)
  assert.equal(
    runtime.readDiagnostics().packages.some((item) => item.source === 'fixture'),
    false
  )
  assert.equal(
    (await runtime.listBrowserEntries()).some((item) => item.pluginName === 'recover-fixture'),
    false
  )
})

test('关闭宿主取消待执行恢复，不保留活动恢复计时器', async (context) => {
  const { runtime, state, events, initializing } = await fixture(context, blockFirst)
  context.mock.timers.tick(15_000)
  await initializing
  state.finishSetup!()
  await waitFor(() => events.includes(recoveryScheduled))
  await runtime.dispose()
  context.mock.timers.tick(60_000)
  await flush()
  assert.equal(state.attempts, 1)
  assert.equal(events.includes(recovered), false)
})

test('setup 已完成但 Browser 快照读取超时仍可恢复，并正确标记 resources 阶段', async (context) => {
  const readFile = fs.readFile
  let finishRead!: () => void
  let reading = false
  const gate = new Promise<void>((done) => {
    finishRead = done
  })
  const reader = context.mock.method(fs, 'readFile', ((...args: Parameters<typeof fs.readFile>) => {
    if (
      !reading &&
      String(args[0]).replaceAll('\\', '/').endsWith('/recover-fixture/browser/entry.js')
    ) {
      reading = true
      return gate.then(() => readFile(...args))
    }
    return readFile(...args)
  }) as typeof fs.readFile)
  syncBuiltinESMExports()
  context.after(() => {
    finishRead()
    reader.mock.restore()
    syncBuiltinESMExports()
  })
  const { runtime, state, events, initializing } = await fixture(context, '')
  await waitFor(() => reading)
  context.mock.timers.tick(15_000)
  await initializing
  assert.equal(
    runtime.readDiagnostics().packages.find((item) => item.source === 'fixture')!.error!.phase,
    'resources'
  )
  finishRead()
  await waitFor(() => events.includes(recoveryScheduled))
  context.mock.timers.tick(10_000)
  await waitFor(() => events.includes(recovered))
  assert.equal(state.attempts, 2)
  assert.deepEqual(await runtime.invoke('recover-fixture', 'get', {}), { attempt: 2 })
})

test('首轮其余插件尚未结束时不提前执行恢复延迟', async (context) => {
  const { state, events, initializing } = await fixture(
    context,
    blockFirst,
    `await new Promise(resolve => { state.finishOther = resolve })`
  )
  context.mock.timers.tick(15_000)
  await waitFor(() => state.otherAttempts === 1)
  state.finishSetup!()
  await flush()
  context.mock.timers.tick(10_000)
  await flush()
  assert.equal(state.attempts, 1)
  assert.equal(events.includes(recoveryScheduled), false)
  state.finishOther!()
  await initializing
  await waitFor(() => events.includes(recoveryScheduled))
  context.mock.timers.tick(10_000)
  await waitFor(() => events.includes(recovered))
  assert.equal(state.attempts, 2)
})
