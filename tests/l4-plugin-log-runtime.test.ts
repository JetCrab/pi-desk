import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserConnectionHost, BrowserConnectionSnapshot } from '@jetcrab/pi-desk-sdk/browser'
import type { L3PluginLogEvent } from '../src/common/l3_modules/plugin-host/l3-plugin-log-contract'
import {
  L4PluginLogHostRuntime,
  type L4PluginLogChannel
} from '../src/client/l4_foundation/plugin-host/l4-plugin-log-runtime'

class FakeConnection implements BrowserConnectionHost {
  private snapshot: BrowserConnectionSnapshot = { status: 'ready', error: null }
  private readonly listeners = new Set<() => void>()

  getSnapshot(): BrowserConnectionSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  replace(snapshot: BrowserConnectionSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeChannel implements L4PluginLogChannel {
  readonly watches: string[] = []
  readonly unwatches: string[] = []
  private readonly listeners = new Set<
    (message: { path: string; event: L3PluginLogEvent }) => void
  >()

  async watch(path: string) {
    this.watches.push(path)
    return { text: `snapshot:${this.watches.length}\n`, truncated: false }
  }

  async unwatch(path: string): Promise<void> {
    this.unwatches.push(path)
  }

  subscribe(listener: (message: { path: string; event: L3PluginLogEvent }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(path: string, event: L3PluginLogEvent): void {
    for (const listener of [...this.listeners]) listener({ path, event })
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveWait) => setImmediate(resolveWait))
  }
  throw new Error('等待日志 Host 状态超时')
}

test('相同日志 Handle 共享观察，最后释放才 unwatch', async () => {
  const connection = new FakeConnection()
  const channel = new FakeChannel()
  const runtime = new L4PluginLogHostRuntime(channel, connection)
  const path = 'C:\\temp\\plugin-log.log'
  const first = runtime.open(path)
  const second = runtime.open(path)

  await waitFor(() => channel.watches.length === 1)
  assert.equal(first.getSnapshot().text, 'snapshot:1\n')
  assert.equal(second.getSnapshot().text, 'snapshot:1\n')

  channel.emit(path, { type: 'text_append', text: '追加\n' })
  assert.equal(first.getSnapshot().text, 'snapshot:1\n追加\n')
  first.dispose()
  await new Promise((resolveWait) => setImmediate(resolveWait))
  assert.equal(channel.unwatches.length, 0)

  second.dispose()
  await waitFor(() => channel.unwatches.length === 1)
  runtime.dispose()
})

test('日志监听器同步抛错和异步拒绝不阻断健康监听器', async () => {
  const connection = new FakeConnection()
  const channel = new FakeChannel()
  const runtime = new L4PluginLogHostRuntime(channel, connection)
  const handle = runtime.open('C:\\temp\\callback-errors.log')
  await waitFor(() => handle.getSnapshot().loading === false)
  let healthyNotifications = 0
  handle.subscribe(() => {
    throw new Error('log sync')
  })
  handle.subscribe(async () => {
    throw new Error('log async')
  })
  handle.subscribe(() => {
    healthyNotifications += 1
  })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    channel.emit('C:\\temp\\callback-errors.log', {
      type: 'text_append',
      text: '追加内容\\n'
    })
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    assert.equal(healthyNotifications, 1)
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    handle.dispose()
    runtime.dispose()
  }
})

test('连接恢复后重新 watch 并用完整 Snapshot 重建', async () => {
  const connection = new FakeConnection()
  const channel = new FakeChannel()
  const runtime = new L4PluginLogHostRuntime(channel, connection)
  const path = 'C:\\temp\\reconnect.log'
  const handle = runtime.open(path)

  await waitFor(() => channel.watches.length === 1)
  connection.replace({ status: 'disconnected', error: 'offline' })
  assert.equal(handle.getSnapshot().loading, true)
  connection.replace({ status: 'ready', error: null })
  await waitFor(() => channel.watches.length === 2)
  assert.equal(handle.getSnapshot().text, 'snapshot:2\n')
  assert.equal(handle.getSnapshot().error, null)

  handle.dispose()
  runtime.dispose()
})
