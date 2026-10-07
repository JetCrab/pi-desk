import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { bindSessionPlugin, type SessionPluginPushEvent } from '@jetcrab/pi-desk-sdk'
import { createJiti } from 'jiti'

type SessionPluginRuntimeModule =
  typeof import('../src/server/l4_foundation/pi/l4-pi-session-plugin-runtime')
type CapabilityRuntimeModule =
  typeof import('../src/server/l4_foundation/pi/l4-pi-capability-runtime')
type SessionPluginRuntime = InstanceType<SessionPluginRuntimeModule['L4PiSessionPluginRuntime']>

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})

async function loadSessionPluginRuntime(): Promise<SessionPluginRuntimeModule> {
  return jiti.import<SessionPluginRuntimeModule>(
    '../src/server/l4_foundation/pi/l4-pi-session-plugin-runtime.ts'
  )
}

async function loadCapabilityRuntime(): Promise<CapabilityRuntimeModule> {
  return jiti.import<CapabilityRuntimeModule>(
    '../src/server/l4_foundation/pi/l4-pi-capability-runtime.ts'
  )
}

const source = {
  workId: 'work-1',
  sessionId: '11111111-1111-4111-8111-111111111111',
  branchId: 'v1:main'
}

function createRuntime(
  onChanged: () => void,
  onPush: (event: SessionPluginPushEvent) => void,
  onTasksChanged: (taskIds: readonly string[]) => void,
  Runtime: SessionPluginRuntimeModule['L4PiSessionPluginRuntime']
): SessionPluginRuntime {
  return new Runtime({
    onChanged,
    onPush,
    onTasksChanged,
    onInvalidUpdate: (cause) => {
      throw cause
    }
  })
}

function extensionApi(runtime: SessionPluginRuntime): ExtensionAPI {
  return { events: runtime.eventBus } as ExtensionAPI
}

test('Session Plugin reset 清空状态、方法、Push 与任务监听并重新绑定一次', async () => {
  const { L4PiSessionPluginRuntime } = await loadSessionPluginRuntime()
  let changedCount = 0
  const pushes: SessionPluginPushEvent[] = []
  const taskUpdates: string[][] = []
  const runtime = createRuntime(
    () => changedCount++,
    (event) => pushes.push(event),
    (taskIds) => taskUpdates.push([...taskIds]),
    L4PiSessionPluginRuntime
  )
  const oldPlugin = bindSessionPlugin(extensionApi(runtime), 'context-ignore')
  oldPlugin.setState({ ignoredTokens: 4 })
  oldPlugin.registerMethod('read', async () => ({ owner: 'old' }))
  oldPlugin.startTask({ taskId: 'old-task', title: 'Old task' })
  let staleSubscriptionCalls = 0
  runtime.eventBus.on('fixture:old-subscription', () => staleSubscriptionCalls++)

  assert.deepEqual(runtime.snapshot()['context-ignore'], { ignoredTokens: 4 })
  assert.deepEqual(runtime.activeTaskIds(), ['old-task'])

  const beforeResetChanges = changedCount
  runtime.reset()

  assert.deepEqual(runtime.snapshot(), {})
  assert.deepEqual(runtime.activeTaskIds(), [])
  assert.equal(runtime.taskRecord('old-task'), null)
  assert.deepEqual(taskUpdates.at(-1), [])
  assert.equal(changedCount, beforeResetChanges + 1)
  await assert.rejects(
    runtime.invokeMethod('context-ignore', 'read', {}, source, {} as never),
    /method was not found/i
  )

  runtime.eventBus.emit('fixture:old-subscription', {})
  assert.equal(staleSubscriptionCalls, 0)

  const newPlugin = bindSessionPlugin(extensionApi(runtime), 'context-ignore')
  newPlugin.setState({ ignoredTokens: 8 })
  newPlugin.registerMethod('read', async () => ({ owner: 'new' }))
  newPlugin.push('updated', { revision: 2 })
  const beforeFreshTaskUpdates = taskUpdates.length
  newPlugin.startTask({ taskId: 'new-task', title: 'New task' })

  assert.deepEqual(runtime.snapshot()['context-ignore'], { ignoredTokens: 8 })
  assert.deepEqual(runtime.activeTaskIds(), ['new-task'])
  assert.equal(taskUpdates.length, beforeFreshTaskUpdates + 1)
  assert.deepEqual(taskUpdates.at(-1), ['new-task'])
  assert.equal(pushes.length, 1)
  assert.deepEqual(pushes[0], {
    pluginName: 'context-ignore',
    event: 'updated',
    data: { revision: 2 }
  })
  assert.equal(changedCount, beforeResetChanges + 3)
  assert.deepEqual(await runtime.invokeMethod('context-ignore', 'read', {}, source, {} as never), {
    owner: 'new'
  })

  runtime.dispose()
})

test('分支重建只清状态与任务视图，方法和 EventBus 订阅继续可用', async () => {
  const { L4PiSessionPluginRuntime } = await loadSessionPluginRuntime()
  const pushes: SessionPluginPushEvent[] = []
  const runtime = createRuntime(
    () => undefined,
    (event) => pushes.push(event),
    () => undefined,
    L4PiSessionPluginRuntime
  )
  const plugin = bindSessionPlugin(extensionApi(runtime), 'branch-fixture')
  const task = plugin.startTask({ taskId: 'previous-task', title: 'Previous task' })
  task.complete()
  plugin.setState({ leaf: 'old' })
  plugin.registerMethod('read', async (_input, context) => ({ branchId: context.source.branchId }))
  let pings = 0
  runtime.eventBus.on('fixture:ping', () => {
    pings += 1
  })
  try {
    runtime.resetBranch()
    assert.deepEqual(runtime.snapshot(), {})
    assert.equal(runtime.taskRecord('previous-task'), null)
    runtime.eventBus.emit('fixture:ping', {})
    assert.equal(pings, 1)
    const nextSource = { ...source, branchId: 'v1:fork:e:target:2' }
    assert.deepEqual(
      await runtime.invokeMethod('branch-fixture', 'read', {}, nextSource, {} as never),
      { branchId: nextSource.branchId }
    )
    plugin.setState({ leaf: 'new' })
    plugin.push('restored', {})
    assert.deepEqual(runtime.snapshot()['branch-fixture'], { leaf: 'new' })
    assert.equal(pushes.length, 1)
  } finally {
    runtime.dispose()
  }
})

test('dispose 后 reset 不会复活插件运行态', async () => {
  const { L4PiSessionPluginRuntime } = await loadSessionPluginRuntime()
  let changedCount = 0
  let pushCount = 0
  let taskUpdateCount = 0
  const runtime = createRuntime(
    () => changedCount++,
    () => pushCount++,
    () => taskUpdateCount++,
    L4PiSessionPluginRuntime
  )
  const plugin = bindSessionPlugin(extensionApi(runtime), 'context-ignore')
  runtime.dispose()
  const countsAtDispose = [changedCount, pushCount, taskUpdateCount]

  runtime.reset()
  runtime.resetBranch()
  plugin.setState({ ignoredTokens: 9 })
  plugin.push('ignored', {})
  plugin.startTask({ taskId: 'ignored-task', title: 'Ignored task' })

  assert.deepEqual(runtime.snapshot(), {})
  assert.deepEqual(runtime.activeTaskIds(), [])
  assert.deepEqual([changedCount, pushCount, taskUpdateCount], countsAtDispose)
})

test('宿主 shutdown 清理插件槽位但保留输入与工具权限 Handler', async () => {
  const [{ L4PiSessionPluginRuntime }, { L4PiCapabilityRuntime }] = await Promise.all([
    loadSessionPluginRuntime(),
    loadCapabilityRuntime()
  ])
  let changedCount = 0
  const runtime = createRuntime(
    () => changedCount++,
    () => undefined,
    () => undefined,
    L4PiSessionPluginRuntime
  )
  const plugin = bindSessionPlugin(extensionApi(runtime), 'context-ignore')
  plugin.setState({ ignoredTokens: 12 })
  const inputTexts: string[] = []
  const capability = new L4PiCapabilityRuntime(() => ({ tools: { allow: ['read'] } }))
  const extension = capability.createHostExtension(
    (event) => {
      inputTexts.push(event.text)
      return { action: 'handled' }
    },
    () => runtime.reset()
  )
  const inputHandler = extension.handlers.get('input')?.[0]
  const toolHandler = extension.handlers.get('tool_call')?.[0]
  const shutdownHandler = extension.handlers.get('session_shutdown')?.[0]
  assert.ok(inputHandler)
  assert.ok(toolHandler)
  assert.ok(shutdownHandler)

  assert.deepEqual(
    await Reflect.apply(inputHandler, undefined, [{ type: 'input', text: 'host input' }, {}]),
    { action: 'handled' }
  )
  assert.deepEqual(
    await Reflect.apply(toolHandler, undefined, [
      { type: 'tool_call', toolName: 'write', toolCallId: 'blocked', input: {} },
      {}
    ]),
    { block: true, reason: '当前能力模式不允许工具：write' }
  )

  const beforeShutdownChanges = changedCount
  await Reflect.apply(shutdownHandler, undefined, [
    { type: 'session_shutdown', reason: 'quit' },
    {}
  ])

  assert.deepEqual(runtime.snapshot(), {})
  assert.equal(changedCount, beforeShutdownChanges + 1)
  assert.deepEqual(
    await Reflect.apply(inputHandler, undefined, [{ type: 'input', text: 'still hosted' }, {}]),
    { action: 'handled' }
  )
  assert.deepEqual(
    await Reflect.apply(toolHandler, undefined, [
      { type: 'tool_call', toolName: 'write', toolCallId: 'still-blocked', input: {} },
      {}
    ]),
    { block: true, reason: '当前能力模式不允许工具：write' }
  )
  assert.deepEqual(inputTexts, ['host input', 'still hosted'])

  capability.dispose()
  runtime.dispose()
})
