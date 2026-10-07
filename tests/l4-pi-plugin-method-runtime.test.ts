import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { bindSessionPlugin } from '@jetcrab/pi-desk-sdk'
import { L4PiSessionPluginRuntime } from '../src/server/l4_foundation/pi/l4-pi-session-plugin-runtime'
import {
  L4PiPluginMethodConflictError,
  L4PiPluginMethodNotFoundError,
  L4PiPluginMethodPayloadTooLargeError
} from '../src/server/l4_foundation/pi/l4-pi-plugin-method-runtime'

const source = {
  workId: 'work-1',
  sessionId: '11111111-1111-4111-8111-111111111111',
  branchId: 'v1:main'
}

function createRuntime(
  onPush: (event: unknown) => void = () => undefined
): L4PiSessionPluginRuntime {
  return new L4PiSessionPluginRuntime({
    onChanged: () => undefined,
    onPush,
    onTasksChanged: () => undefined,
    onInvalidUpdate: (cause) => {
      throw cause
    }
  })
}

function extensionApi(runtime: L4PiSessionPluginRuntime): ExtensionAPI {
  return { events: runtime.eventBus } as ExtensionAPI
}

test('Session Plugin Facade 整体替换状态并调用当前方法', async () => {
  const runtime = createRuntime()
  const plugin = bindSessionPlugin(extensionApi(runtime), 'context-ignore')
  plugin.setState({ ignoredTokens: 10, potentialTokens: 20 })
  assert.deepEqual(runtime.snapshot(), {
    'context-ignore': { ignoredTokens: 10, potentialTokens: 20 }
  })

  let receivedSource = null as typeof source | null
  const unregister = plugin.registerMethod('ignore', async (input, context) => {
    receivedSource = context.source as typeof source
    assert.deepEqual(input, { force: true })
    return { ignored: 20 }
  })

  const output = await runtime.invokeMethod(
    'context-ignore',
    'ignore',
    { force: true },
    source,
    {} as ExtensionContext
  )
  assert.deepEqual(output, { ignored: 20 })
  assert.deepEqual(receivedSource, source)

  unregister()
  await assert.rejects(
    runtime.invokeMethod('context-ignore', 'ignore', {}, source, {} as ExtensionContext),
    L4PiPluginMethodNotFoundError
  )
  plugin.setState(null)
  assert.deepEqual(runtime.snapshot(), {})
  runtime.dispose()
})

test('Session Plugin Facade 通过现有 Push 合同发布结构化事件', () => {
  const pushes: unknown[] = []
  const runtime = createRuntime((event) => pushes.push(event))
  const plugin = bindSessionPlugin(extensionApi(runtime), 'deliverables')
  plugin.push('added', { entryId: 'entry-1', items: [] })
  assert.deepEqual(pushes, [
    {
      pluginName: 'deliverables',
      event: 'added',
      data: { entryId: 'entry-1', items: [] }
    }
  ])
  assert.throws(() => plugin.push('Invalid Event', {}))
  runtime.dispose()
})

test('Session 方法重复注册同步失败且旧 disposer 不删除新注册', async () => {
  const runtime = createRuntime()
  const plugin = bindSessionPlugin(extensionApi(runtime), 'context-ignore')
  const unregisterOld = plugin.registerMethod('ignore', async () => ({ owner: 'old' }))
  assert.throws(
    () => plugin.registerMethod('ignore', async () => ({ owner: 'duplicate' })),
    L4PiPluginMethodConflictError
  )

  unregisterOld()
  const unregisterNew = plugin.registerMethod('ignore', async () => ({ owner: 'new' }))
  unregisterOld()
  assert.deepEqual(
    await runtime.invokeMethod('context-ignore', 'ignore', {}, source, {} as ExtensionContext),
    { owner: 'new' }
  )

  unregisterNew()
  runtime.dispose()
})

test('Session 方法 JSON input/output 上限为 2MB', async () => {
  const runtime = createRuntime()
  const plugin = bindSessionPlugin(extensionApi(runtime), 'context-ignore')
  plugin.registerMethod('echo', async (input) => input)
  const largeInput = { value: 'x'.repeat(100 * 1024) }

  assert.deepEqual(
    await runtime.invokeMethod(
      'context-ignore',
      'echo',
      largeInput,
      source,
      {} as ExtensionContext
    ),
    largeInput
  )

  await assert.rejects(
    runtime.invokeMethod(
      'context-ignore',
      'echo',
      { value: 'x'.repeat(2 * 1024 * 1024) },
      source,
      {} as ExtensionContext
    ),
    (error: unknown) =>
      error instanceof L4PiPluginMethodPayloadTooLargeError && error.direction === 'input'
  )

  plugin.registerMethod('too-large', async () => ({ value: 'x'.repeat(2 * 1024 * 1024) }))
  await assert.rejects(
    runtime.invokeMethod('context-ignore', 'too-large', {}, source, {} as ExtensionContext),
    (error: unknown) =>
      error instanceof L4PiPluginMethodPayloadTooLargeError && error.direction === 'output'
  )
  runtime.dispose()
})
