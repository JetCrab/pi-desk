import assert from 'node:assert/strict'
import test from 'node:test'
import { createL2WorkbenchBiz } from '../src/client/l2_biz/workbench/l2-workbench-biz'
import { createL2WorkbenchVersionRefresh } from '../src/client/l2_biz/workbench/l2-workbench-version-refresh'
import type { L4AppSocketClient } from '../src/client/l4_foundation/realtime/app-socket/l4-app-socket'

function connection(): Promise<void> {
  return new Promise(() => undefined)
}

function health(version?: unknown): object {
  return {
    code: 0,
    msg: '',
    data: {
      application: 'Pi Desk',
      status: 'ready',
      ...(version === undefined ? {} : { version }),
      boundaries: { client: 'isolated', server: 'isolated', common: 'shared' },
      layers: ['L1 Entry', 'L2 Biz', 'L3 Modules', 'L4 Foundation']
    }
  }
}

test('版本查询使用无缓存 GET 和当前 clientId，兼容旧服务缺少版本', async (context) => {
  const signal = new AbortController().signal
  let response = health('0.1.113')
  let status = 200
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(input, '/api/health')
    assert.equal(init?.method, 'GET')
    assert.equal(init?.cache, 'no-store')
    assert.equal(init?.signal, signal)
    assert.equal(init?.body, undefined)
    assert.equal(new Headers(init?.headers).get('X-Pi-Desk-Client-Id'), 'page-client')
    return Response.json(response, { status })
  })
  const biz = createL2WorkbenchBiz('page-client', {} as L4AppSocketClient)
  assert.equal(await biz.readServerVersion(signal), '0.1.113')
  response = health()
  assert.equal(await biz.readServerVersion(signal), null)
  response = health(null)
  assert.equal(await biz.readServerVersion(signal), null)
  response = health(113)
  await assert.rejects(biz.readServerVersion(signal))
  response = { code: 503, msg: '服务尚未就绪', data: null }
  status = 503
  await assert.rejects(biz.readServerVersion(signal), /服务尚未就绪/)
})

test('仅物理重连查询版本，同版本不刷新，新版本直接且只刷新一次', async () => {
  const signal = new AbortController().signal
  let serverVersion = '0.1.112'
  let checks = 0
  let reloads = 0
  const refresh = createL2WorkbenchVersionRefresh(
    '0.1.112',
    async () => {
      checks += 1
      return serverVersion
    },
    () => {
      reloads += 1
    }
  )
  const first = connection()
  await refresh(true, signal, first)
  await refresh(false, signal, first)
  assert.equal(checks, 0)

  const second = connection()
  await refresh(true, signal, second)
  await refresh(false, signal, second)
  await refresh(false, signal, connection())
  assert.equal(checks, 1)
  assert.equal(reloads, 0)

  serverVersion = '0.1.113'
  await refresh(true, signal, connection())
  assert.equal(checks, 2)
  assert.equal(reloads, 1)
  await refresh(true, signal, connection())
  assert.equal(reloads, 1)
  assert.equal(checks, 2)
})

test('复用连接的业务初始化不打断正在进行的版本查询', async () => {
  const signal = new AbortController().signal
  const version = Promise.withResolvers<string | null>()
  let checkSignal: AbortSignal | undefined
  let reloads = 0
  const refresh = createL2WorkbenchVersionRefresh(
    '0.1.112',
    (checking) => {
      checkSignal = checking
      return version.promise
    },
    () => {
      reloads += 1
    }
  )
  await refresh(true, signal, connection())
  const pending = refresh(true, signal, connection())
  // 插件 Socket 包装器每次 waitForClose 返回新 Promise，但 connect(false) 表示物理连接未变。
  await refresh(false, signal, connection())
  assert.equal(checkSignal?.aborted, false)
  version.resolve('0.1.113')
  await pending
  assert.equal(reloads, 1)
})

test('首次接管已有连接也不检查，下一次实际重连才刷新', async () => {
  const signal = new AbortController().signal
  let reloads = 0
  const refresh = createL2WorkbenchVersionRefresh(
    '0.1.112',
    async () => '0.1.113',
    () => {
      reloads += 1
    }
  )
  await refresh(false, signal, connection())
  assert.equal(reloads, 0)
  await refresh(true, signal, connection())
  assert.equal(reloads, 1)
})

for (const reason of ['disconnect', 'unmount', 'new-connection'] as const) {
  test(`忽略失效连接的迟到版本响应：${reason}`, async () => {
    const lifecycle = new AbortController()
    const version = Promise.withResolvers<string | null>()
    const closed = Promise.withResolvers<void>()
    let checkSignal: AbortSignal | undefined
    let reloads = 0
    let checks = 0
    const refresh = createL2WorkbenchVersionRefresh(
      '0.1.112',
      (signal) => {
        checks += 1
        if (checks > 1) return Promise.resolve('0.1.112')
        checkSignal = signal
        return version.promise
      },
      () => {
        reloads += 1
      }
    )
    await refresh(true, lifecycle.signal, connection())
    const pending = refresh(true, lifecycle.signal, closed.promise)
    if (reason === 'disconnect') {
      closed.resolve()
      await Promise.resolve()
    } else if (reason === 'unmount') {
      lifecycle.abort()
    } else {
      await refresh(true, lifecycle.signal, connection())
    }
    assert.equal(checkSignal?.aborted, true)
    version.resolve('0.1.113')
    await pending
    assert.equal(reloads, 0)
  })
}

test('查询失败或旧服务未提供版本时保留页面，下次重连可再次检查', async (context) => {
  const signal = new AbortController().signal
  const warning = context.mock.method(console, 'warn', () => undefined)
  let checks = 0
  let reloads = 0
  const refresh = createL2WorkbenchVersionRefresh(
    '0.1.112',
    async () => {
      checks += 1
      if (checks === 1) throw new Error('network failed')
      return checks === 2 ? null : '0.1.113'
    },
    () => {
      reloads += 1
    }
  )
  await refresh(true, signal, connection())
  await refresh(true, signal, connection())
  await refresh(true, signal, connection())
  assert.equal(warning.mock.callCount(), 1)
  assert.equal(reloads, 0)
  await refresh(true, signal, connection())
  assert.equal(checks, 3)
  assert.equal(reloads, 1)
})

test('版本查询超时后取消，不刷新也不自动重试', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const lifecycle = new AbortController()
  let checks = 0
  let reloads = 0
  let checkSignal: AbortSignal | undefined
  const refresh = createL2WorkbenchVersionRefresh(
    '0.1.112',
    (signal) => {
      checks += 1
      checkSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true
        })
      })
    },
    () => {
      reloads += 1
    }
  )
  await refresh(true, lifecycle.signal, connection())
  const pending = refresh(true, lifecycle.signal, connection())
  context.mock.timers.tick(5_000)
  await pending
  context.mock.timers.tick(60_000)
  assert.equal(checkSignal?.aborted, true)
  assert.equal(checks, 1)
  assert.equal(reloads, 0)
})
