import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BrowserConnectionSnapshot,
  BrowserPluginHost,
  PluginJsonObject,
  PluginSource
} from '@jetcrab/pi-desk-sdk/browser'
import {
  createTodoBrowserController,
  publishTodoPush,
  resetTodoBrowserRuntime
} from '../src/browser-runtime.js'
import type { TodoSnapshot } from '../src/contract.js'

const source: PluginSource = { workId: 'work', sessionId: 'session', branchId: 'v1:root' }
const a: TodoSnapshot = {
  todo: { title: '迁移', items: [{ id: 'a', title: '客户端', status: 1 }] },
  hidden: false
}
const b: TodoSnapshot = {
  todo: { title: '迁移', items: [{ id: 'a', title: '客户端', status: 2 }] },
  hidden: false
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 1500
  while (Date.now() < end) {
    if (predicate()) return
    await new Promise<void>((finish) => setImmediate(finish))
  }
  throw Error('控制器状态未收敛')
}
function fixture(): {
  host: Pick<BrowserPluginHost, 'connection' | 'piDesk'>
  pending: Array<{
    method: string
    finish: (snapshot: PluginJsonObject) => void
    reject: (error: Error) => void
  }>
  connect: (ready: boolean) => void
} {
  const pending: Array<{
    method: string
    finish: (snapshot: PluginJsonObject) => void
    reject: (error: Error) => void
  }> = []
  let status: BrowserConnectionSnapshot['status'] = 'ready'
  const listeners = new Set<() => void>()
  const host = {
    connection: {
      getSnapshot: () => ({ status }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    },
    piDesk: {
      invokeSession: async (_source: PluginSource, method: string): Promise<PluginJsonObject> =>
        new Promise((finish, reject) => pending.push({ method, finish, reject }))
    }
  } as unknown as Pick<BrowserPluginHost, 'connection' | 'piDesk'>
  return {
    host,
    pending,
    connect: (ready: boolean): void => {
      status = ready ? 'ready' : 'disconnected'
      for (const listener of listeners) listener()
    }
  }
}
function push(target = source): void {
  publishTodoPush({
    pluginName: 'todo',
    target: { scope: 'session', source: target },
    event: 'changed',
    data: {}
  })
}

test('初始基线静默，查询期间Push合并且不应用旧结果', async (context) => {
  resetTodoBrowserRuntime()
  const { host, pending } = fixture()
  const controller = createTodoBrowserController(host, source)
  context.after(() => {
    controller.dispose()
    resetTodoBrowserRuntime()
  })
  assert.equal(pending.length, 1)
  pending[0].finish(a)
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, a)
  push()
  assert.equal(pending.length, 2)
  push()
  push()
  pending[1].finish(a)
  await until(() => pending.length === 3)
  assert.deepEqual(controller.getSnapshot().snapshot, a)
  pending[2].finish(b)
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, b)
  assert.equal(pending.length, 3)
})

test('旧Native二级快照摊平，单层任务重排和改名同步到最新快照', async (context) => {
  resetTodoBrowserRuntime()
  const { host, pending } = fixture()
  const controller = createTodoBrowserController(host, source)
  context.after(() => {
    controller.dispose()
    resetTodoBrowserRuntime()
  })
  const prepare = { id: 'prepare', title: '准备', status: 2 }
  const client = { id: 'client', title: '客户端', status: 2 }
  const backend = { id: 'backend', title: '后台', status: 1 }
  pending[0].finish({
    todo: {
      title: '迁移',
      items: [prepare, { id: 'stage', title: '分端迁移', children: [client, backend] }]
    },
    hidden: false
  })
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, {
    todo: { title: '迁移', items: [prepare, client, backend] },
    hidden: false
  })
  push()
  pending[1].finish({
    todo: {
      title: '迁移',
      items: [{ ...backend, title: '后台接口', status: 3, note: '等待确认' }, prepare, client]
    },
    hidden: false
  })
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, {
    todo: {
      title: '迁移',
      items: [{ id: 'backend', title: '后台接口', status: 3, note: '等待确认' }, prepare, client]
    },
    hidden: false
  })
  assert.equal(controller.getSnapshot().error, null)
})

test('hide保留服务端内容，Push与hide响应交错仍以最新查询为准', async (context) => {
  resetTodoBrowserRuntime()
  const { host, pending } = fixture()
  const controller = createTodoBrowserController(host, source)
  context.after(() => {
    controller.dispose()
    resetTodoBrowserRuntime()
  })
  pending[0].finish(a)
  await until(() => !controller.getSnapshot().loading)
  const hiding = controller.hide()
  assert.equal(pending[1].method, 'hide')
  push()
  pending[1].finish({ ...a, hidden: true })
  await until(() => pending.length === 3)
  pending[2].finish({ ...a, hidden: true })
  await hiding
  assert.deepEqual(controller.getSnapshot().snapshot, { ...a, hidden: true })
  assert.equal(controller.getSnapshot().hiding, false)
  push()
  pending[3].finish(a)
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, a)
})

test('断线恢复静默重建，不处理别的Source或dispose后的Push', async (context) => {
  resetTodoBrowserRuntime()
  const { host, pending, connect } = fixture()
  const signal = new AbortController()
  const controller = createTodoBrowserController(host, source, signal.signal)
  context.after(() => {
    controller.dispose()
    resetTodoBrowserRuntime()
  })
  pending[0].finish(a)
  await until(() => !controller.getSnapshot().loading)
  push({ ...source, branchId: 'v1:other' })
  assert.equal(pending.length, 1)
  connect(false)
  connect(true)
  assert.equal(pending.length, 2)
  pending[1].finish(b)
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, b)
  signal.abort()
  push()
  assert.equal(pending.length, 2)
})

test('旧会话缺少查询方法时静默，重连仍兼容，Push后可恢复进度', async (context) => {
  resetTodoBrowserRuntime()
  const log = context.mock.method(console, 'error', (): void => undefined)
  const { host, pending, connect } = fixture()
  const controller = createTodoBrowserController(host, source)
  context.after(() => {
    controller.dispose()
    resetTodoBrowserRuntime()
  })
  pending[0].reject(Object.assign(Error('Plugin method not found'), { code: 404 }))
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, { todo: null, hidden: false })
  assert.equal(controller.getSnapshot().error, null)
  connect(false)
  connect(true)
  pending[1].reject(Object.assign(Error('插件方法不存在'), { code: 404 }))
  await until(() => !controller.getSnapshot().loading)
  assert.equal(controller.getSnapshot().error, null)
  assert.equal(log.mock.callCount(), 0)
  push()
  pending[2].finish(a)
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, a)
})

test('查询方法失效时清空已有进度', async (context) => {
  resetTodoBrowserRuntime()
  const { host, pending } = fixture()
  const controller = createTodoBrowserController(host, source)
  context.after(() => {
    controller.dispose()
    resetTodoBrowserRuntime()
  })
  pending[0].finish(a)
  await until(() => !controller.getSnapshot().loading)
  push()
  pending[1].finish(b)
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, b)
  push()
  pending[2].reject(Object.assign(Error('插件方法不存在'), { code: 404 }))
  await until(() => !controller.getSnapshot().loading)
  assert.deepEqual(controller.getSnapshot().snapshot, { todo: null, hidden: false })
  assert.equal(controller.getSnapshot().error, null)
})

for (const error of [
  Object.assign(Error('工作会话来源已变化'), { code: 409 }),
  Object.assign(Error('插件执行失败'), { code: 500 }),
  Error('插件方法不存在')
]) {
  test(`非404查询异常保留错误并可重试：${error.message}`, async (context) => {
    resetTodoBrowserRuntime()
    const log = context.mock.method(console, 'error', (): void => undefined)
    const { host, pending } = fixture()
    const controller = createTodoBrowserController(host, source)
    context.after(() => {
      controller.dispose()
      resetTodoBrowserRuntime()
    })
    pending[0].reject(error)
    await until(() => !controller.getSnapshot().loading)
    assert.deepEqual(controller.getSnapshot().error, { action: 'get', message: error.message })
    assert.equal(log.mock.callCount(), 1)
    const retry = controller.refresh()
    pending[1].finish(a)
    await retry
    assert.deepEqual(controller.getSnapshot().snapshot, a)
    assert.equal(controller.getSnapshot().error, null)
  })
}

test('隐藏方法不存在时保留进度和错误，允许重试', async (context) => {
  resetTodoBrowserRuntime()
  const log = context.mock.method(console, 'error', (): void => undefined)
  const { host, pending } = fixture()
  const controller = createTodoBrowserController(host, source)
  context.after(() => {
    controller.dispose()
    resetTodoBrowserRuntime()
  })
  pending[0].finish(a)
  await until(() => !controller.getSnapshot().loading)
  const hiding = controller.hide()
  pending[1].reject(Object.assign(Error('插件方法不存在'), { code: 404 }))
  await hiding
  assert.deepEqual(controller.getSnapshot().snapshot, a)
  assert.deepEqual(controller.getSnapshot().error, { action: 'hide', message: '插件方法不存在' })
  assert.equal(log.mock.callCount(), 1)
  const retry = controller.hide()
  pending[2].finish({ ...a, hidden: true })
  await retry
  assert.equal(controller.getSnapshot().snapshot.hidden, true)
  assert.equal(controller.getSnapshot().error, null)
})

test('关闭失败不隐藏；人工重试成功；dispose拒绝迟到回写', async (context) => {
  resetTodoBrowserRuntime()
  const { host, pending } = fixture()
  const controller = createTodoBrowserController(host, source)
  context.after(() => {
    controller.dispose()
    resetTodoBrowserRuntime()
  })
  pending[0].finish(a)
  await until(() => !controller.getSnapshot().loading)
  const hiding = controller.hide()
  pending[1].reject(Error('测试：关闭失败'))
  await hiding
  assert.deepEqual(controller.getSnapshot().snapshot, a)
  assert.equal(controller.getSnapshot().error?.action, 'hide')
  const retry = controller.hide()
  pending[2].finish({ ...a, hidden: true })
  await retry
  assert.equal(controller.getSnapshot().snapshot.hidden, true)
  const refreshing = controller.refresh()
  controller.dispose()
  pending[3].finish(b)
  await refreshing
  assert.equal(controller.getSnapshot().snapshot.hidden, true)
})
