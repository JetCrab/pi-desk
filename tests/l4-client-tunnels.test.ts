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
  options: { status?: boolean; resolveError?: Error; delayOpen?: Promise<void> } = {}
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

test('A隧道不可用不查询B，B无发布时不创建A映射', async () => {
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
    } finally {
      await host.dispose()
    }
  }
})

test('SDK自行查询目标、建立映射并更新实际路径，关闭后不再查询', async () => {
  const { host, calls, resolved } = fixture()
  try {
    const mapping = host.open({ remotePort: 43191 })
    assert.equal(mapping.getSnapshot().localPort, null)
    await waitState(mapping, 'ready')
    assert.deepEqual(resolved, [43191])
    assert.equal(mapping.getSnapshot().path, 'unknown')
    assert.equal(mapping.getSnapshot().localPort, 53191)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error('未更新实际路径'))
      }, 2_500)
      const unsubscribe = mapping.subscribe(() => {
        if (mapping.getSnapshot().path !== 'direct') return
        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
    })
    const open = calls.find((call) => call.action === 'open')
    assert.deepEqual(open && { ...open, id: '<id>' }, { action: 'open', id: '<id>', ...target })
    const closing = mapping.close()
    assert.equal(mapping.close(), closing)
    await closing
    assert.equal(mapping.getSnapshot().status, 'closed')
    assert.equal(calls.filter((call) => call.action === 'close').length, 1)
  } finally {
    await host.dispose()
  }
})

test('创建返回前关闭仍回收迟到的原生映射，不重放open', async () => {
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
  } finally {
    finish()
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
