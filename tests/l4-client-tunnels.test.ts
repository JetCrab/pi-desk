import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserTunnelHandle, BrowserTunnelSnapshot } from '@jetcrab/pi-desk-sdk/browser'
import {
  L4ClientTunnelHostRuntime,
  type L4NativeTunnelBridge,
  type L4NativeTunnelRequest
} from '../src/client/l4_foundation/tunnel/l4-client-tunnels'

const target = {
  controlServerUrl: 'http://tunnel.example.test:7001',
  providerId: 'ab'.repeat(32),
  remotePort: 43191
}
const ready: BrowserTunnelSnapshot = {
  status: 'ready',
  localPort: 53191,
  path: 'unknown',
  error: null
}

async function waitState(
  handle: BrowserTunnelHandle,
  status: BrowserTunnelSnapshot['status']
): Promise<void> {
  if (handle.getSnapshot().status === status) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`等待 ${status} 超时：${JSON.stringify(handle.getSnapshot())}`))
    }, 3_000)
    const unsubscribe = handle.subscribe(() => {
      if (handle.getSnapshot().status !== status) return
      clearTimeout(timeout)
      unsubscribe()
      resolve()
    })
  })
}

function fixture(
  options: {
    status?: boolean
    resolveError?: Error
    delayOpen?: Promise<void>
    closeError?: Error
  } = {}
): {
  host: L4ClientTunnelHostRuntime
  calls: L4NativeTunnelRequest[]
  resolved: number[]
} {
  const calls: L4NativeTunnelRequest[] = []
  const resolved: number[] = []
  const bridge: L4NativeTunnelBridge = {
    async invoke(request) {
      calls.push(request)
      if (request.action === 'status')
        return {
          ready: options.status !== false,
          error: options.status === false ? '隧道未配置' : null
        }
      if (request.action === 'open') {
        await options.delayOpen
        return ready
      }
      if (request.action === 'get') return { ...ready, path: 'direct' }
      if (options.closeError) throw options.closeError
      return null
    }
  }
  const host = new L4ClientTunnelHostRuntime(
    async (port) => {
      resolved.push(port)
      if (options.resolveError) throw options.resolveError
      return { ...target, remotePort: port }
    },
    () => ({ hostname: 'desk.example.test', bridge })
  )
  return { host, calls, resolved }
}

test('回环工作台直接使用端口，不查询后端或调用桌面', async () => {
  for (const hostname of ['localhost', 'LOCALHOST.', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) {
    const host = new L4ClientTunnelHostRuntime(
      async () => {
        throw new Error('不应查询后端')
      },
      () => ({ hostname, bridge: undefined })
    )
    assert.equal(host.available(), true)
    const mapping = host.open({ remotePort: 43191 })
    assert.deepEqual(mapping.getSnapshot(), {
      status: 'ready',
      localPort: 43191,
      path: null,
      error: null
    })
    await host.dispose()
    assert.equal(mapping.getSnapshot().status, 'closed')
  }
})

test('局域网地址不当作本机；普通浏览器没有原生映射入口', async () => {
  const host = new L4ClientTunnelHostRuntime(
    async () => target,
    () => ({ hostname: '192.168.1.8', bridge: undefined })
  )
  assert.equal(host.available(), false)
  await host.dispose()
})

test('A隧道不可用不查询B，B无发布时不创建A映射', async (t) => {
  t.mock.method(console, 'info', () => {})
  const failures = t.mock.method(console, 'warn', () => {})
  for (const options of [{ status: false }, { resolveError: new Error('B端口未发布') }]) {
    const { host, calls, resolved } = fixture(options)
    try {
      const mapping = host.open({ remotePort: 43191 })
      await waitState(mapping, 'failed')
      assert.equal(
        calls.some((call) => call.action === 'open'),
        false
      )
      assert.equal(resolved.length, 'status' in options ? 0 : 1)
      assert.ok(mapping.getSnapshot().error)
      const failure = failures.mock.calls.at(-1)!
      const data = failure.arguments[1] as Record<string, unknown>
      assert.equal(data.error, mapping.getSnapshot().error)
      assert.equal(data.remotePort, 43191)
      assert.equal(typeof data.id, 'string')
    } finally {
      await host.dispose()
    }
  }
})

test('SDK自行查询目标、建立映射并更新实际路径，关闭后不再查询', async (t) => {
  const logs = t.mock.method(console, 'info', () => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { host, calls, resolved } = fixture()
  try {
    const mapping = host.open({ remotePort: 43191 })
    assert.equal(mapping.getSnapshot().localPort, null)
    await waitState(mapping, 'ready')
    assert.deepEqual(resolved, [43191])
    assert.equal(mapping.getSnapshot().path, 'unknown')
    assert.equal(mapping.getSnapshot().localPort, 53191)
    t.mock.timers.tick(1_000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(mapping.getSnapshot().path, 'direct')
    const changes = () =>
      logs.mock.calls.filter((call) => call.arguments[0].endsWith('连接状态变化'))
    assert.equal(changes().length, 2)
    t.mock.timers.tick(1_000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(calls.filter((call) => call.action === 'get').length, 2)
    assert.equal(changes().length, 2, '重复快照不重复打印')
    const open = calls.find((call) => call.action === 'open')
    assert.deepEqual(open && { ...open, id: '<id>' }, { action: 'open', id: '<id>', ...target })
    const closing = mapping.close()
    assert.equal(mapping.close(), closing)
    await closing
    assert.equal(mapping.getSnapshot().status, 'closed')
    assert.equal(calls.filter((call) => call.action === 'close').length, 1)
    const events = logs.mock.calls.map((call) => call.arguments[0])
    for (const event of [
      '发起本地端口映射',
      '桌面能力检查开始',
      '桌面能力检查完成',
      '查询端口发布开始',
      '端口发布目标已解析',
      '提交原生映射 open',
      '本地映射关闭开始',
      '原生映射关闭完成',
      '本地映射关闭完成'
    ]) {
      assert.equal(events.filter((entry) => entry.endsWith(event)).length, 1, event)
    }
    assert.ok(open && 'id' in open)
    for (const call of logs.mock.calls) {
      const data = call.arguments[1] as Record<string, unknown>
      assert.equal(data.id, open.id)
      assert.equal(data.remotePort, 43191)
      assert.ok(Number.isFinite(Date.parse(String(data.time))))
    }
    const targetLog = logs.mock.calls.find((call) =>
      call.arguments[0].endsWith('端口发布目标已解析')
    )!
    assert.equal((targetLog.arguments[1] as typeof target).providerId, target.providerId)
    assert.equal(
      (targetLog.arguments[1] as typeof target).controlServerUrl,
      target.controlServerUrl
    )
    assert.equal((changes()[1].arguments[1] as BrowserTunnelSnapshot).path, 'direct')
    assert.equal((changes()[1].arguments[1] as BrowserTunnelSnapshot).localPort, 53191)
    t.mock.timers.tick(2_000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(calls.filter((call) => call.action === 'get').length, 2)
  } finally {
    await host.dispose()
  }
})

test('创建返回前关闭仍回收迟到的原生映射，不重放open', async (t) => {
  const logs = t.mock.method(console, 'info', () => {})
  let finish!: () => void
  const delayOpen = new Promise<void>((resolve) => {
    finish = resolve
  })
  const { host, calls } = fixture({ delayOpen })
  try {
    const mapping = host.open({ remotePort: 43191 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(calls.filter((call) => call.action === 'open').length, 1)
    const closing = mapping.close()
    finish()
    await closing
    assert.equal(mapping.getSnapshot().status, 'closed')
    assert.equal(calls.filter((call) => call.action === 'close').length, 1)
    assert.equal(calls.filter((call) => call.action === 'open').length, 1)
    const snapshots = logs.mock.calls
      .filter((call) => call.arguments[0].endsWith('连接状态变化'))
      .map((call) => call.arguments[1] as BrowserTunnelSnapshot)
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.status),
      ['closed']
    )
    assert.equal(
      logs.mock.calls.filter((call) => call.arguments[0].endsWith('本地映射关闭完成')).length,
      1
    )
  } finally {
    finish()
    await host.dispose()
  }
})

test('关闭失败记录映射身份并保留拒绝结果，不重复提交关闭', async (t) => {
  const logs = t.mock.method(console, 'info', () => {})
  const errors = t.mock.method(console, 'error', () => {})
  const { host, calls } = fixture({ closeError: new Error('原生关闭失败') })
  try {
    const mapping = host.open({ remotePort: 43191 })
    await waitState(mapping, 'ready')
    await assert.rejects(mapping.close(), /原生关闭失败/)
    await assert.rejects(mapping.close(), /原生关闭失败/)
    assert.equal(mapping.getSnapshot().status, 'closed')
    assert.equal(calls.filter((call) => call.action === 'close').length, 1)
    assert.equal(errors.mock.calls.length, 1)
    const error = errors.mock.calls[0].arguments[1] as Record<string, unknown>
    const open = calls.find((call) => call.action === 'open')!
    assert.ok('id' in open)
    assert.equal(error.id, open.id)
    assert.equal(error.remotePort, 43191)
    assert.equal(error.error, '原生关闭失败')
    assert.equal(
      logs.mock.calls.some((call) => call.arguments[0].endsWith('本地映射关闭完成')),
      false
    )
  } finally {
    await host.dispose()
  }
})

test('不同句柄独立释放，插件Owner退出清理剩余句柄并拒绝新建', async () => {
  const { host, calls } = fixture()
  const first = host.open({ remotePort: 43191 })
  const second = host.open({ remotePort: 43192 })
  await Promise.all([waitState(first, 'ready'), waitState(second, 'ready')])
  await first.close()
  assert.equal(second.getSnapshot().status, 'ready')
  await host.dispose()
  assert.equal(second.getSnapshot().status, 'closed')
  const closes = calls.filter((call) => call.action === 'close')
  assert.equal(closes.length, 2)
  assert.ok('id' in closes[0] && 'id' in closes[1])
  assert.notEqual(closes[0].id, closes[1].id)
  assert.throws(() => host.open({ remotePort: 43191 }), /已释放/)
})
