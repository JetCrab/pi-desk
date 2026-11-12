import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BrowserPluginHost,
  BrowserTunnelHandle,
  BrowserTunnelSnapshot,
  PluginJsonObject
} from '@jetcrab/pi-desk-sdk/browser'
import { createRemoteDebugBrowserTunnels } from '../src/l4-browser-tunnels.js'

test('运行中只映射Gateway一次，界面取消订阅不停止，Run结束与插件退出释放各自连接', async (context) => {
  const logs: string[] = []
  context.mock.method(console, 'info', (message: string) => logs.push(message))
  let state: PluginJsonObject = { runs: [{ runId: 'one', status: 'starting', gatewayPort: null }] }
  const stateListeners = new Set<() => void>()
  const opened: number[] = []
  const closed: number[] = []
  const snapshots: BrowserTunnelSnapshot[] = []
  const updates: Array<Set<() => void>> = []
  const host = {
    globalState: {
      getSnapshot: () => state,
      subscribe(listener: () => void): () => void {
        stateListeners.add(listener)
        return () => stateListeners.delete(listener)
      }
    },
    tunnels: {
      open({ remotePort }: { remotePort: number }): BrowserTunnelHandle {
        const index = opened.length
        opened.push(remotePort)
        snapshots.push({ status: 'connecting', localPort: null, path: 'unknown', error: null })
        updates.push(new Set())
        return {
          getSnapshot: () => snapshots[index],
          subscribe(listener): () => void {
            updates[index].add(listener)
            return () => updates[index].delete(listener)
          },
          async close(): Promise<void> {
            closed.push(remotePort)
          }
        }
      }
    }
  } as unknown as BrowserPluginHost
  const store = createRemoteDebugBrowserTunnels(host)
  const publish = (runs: PluginJsonObject[]): void => {
    state = { runs }
    for (const listener of stateListeners) listener()
  }
  try {
    assert.deepEqual(opened, [])
    publish([
      { runId: 'one', profile: 'web', cwd: '/fixture', status: 'running', gatewayPort: 49100 }
    ])
    store.sync()
    assert.deepEqual(opened, [49100])
    const unsubscribeView = store.subscribe(() => undefined)
    unsubscribeView()
    assert.deepEqual(closed, [])
    snapshots[0] = { status: 'ready', localPort: 53191, path: 'direct', error: null }
    for (const listener of updates[0]) listener()
    assert.equal(store.getSnapshot().get('one')?.localPort, 53191)
    const loggedCount = logs.length
    for (const listener of updates[0]) listener()
    assert.equal(logs.length, loggedCount)
    assert.ok(
      logs.some(
        (line) =>
          line.includes('本地映射状态') &&
          line.includes('"runId":"one"') &&
          line.includes('"localPort":53191')
      )
    )
    publish([
      { runId: 'one', status: 'stopped', gatewayPort: null },
      { runId: 'two', status: 'running', gatewayPort: 49101 }
    ])
    await Promise.resolve()
    assert.deepEqual(closed, [49100])
    assert.equal(store.getSnapshot().has('one'), false)
    assert.deepEqual(opened, [49100, 49101])
  } finally {
    await store.dispose()
  }
  assert.deepEqual(closed, [49100, 49101])
  assert.equal(stateListeners.size, 0)
  assert.ok(
    logs.some(
      (line) =>
        /^\[\d{4}-\d{2}-\d{2}T/.test(line) &&
        line.includes('申请本地映射') &&
        line.includes('"runId":"one"') &&
        line.includes('"profile":"web"') &&
        line.includes('"cwd":"/fixture"') &&
        line.includes('"gatewayPort":49100')
    )
  )
  assert.ok(logs.some((line) => line.includes('reason=Run结束') && line.includes('"runId":"one"')))
  assert.ok(
    logs.some((line) => line.includes('reason=Browser Owner释放') && line.includes('"runId":"two"'))
  )
  assert.ok(logs.some((line) => line.includes('Browser Owner 释放 mappings=1')))
})

test('旧客户端缺少能力时保持原访问方式，不创建错误映射', async () => {
  const host = {
    globalState: {
      getSnapshot: () => ({ runs: [{ runId: 'one', status: 'running', gatewayPort: 49100 }] }),
      subscribe: () => () => undefined
    }
  } as unknown as BrowserPluginHost
  const store = createRemoteDebugBrowserTunnels(host)
  assert.equal(store.getSnapshot().size, 0)
  await store.dispose()
})
