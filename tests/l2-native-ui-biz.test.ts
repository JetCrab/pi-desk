import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { L2NativeUiBiz } from '../src/client/l2_biz/workbench/native-ui/l2-native-ui-biz'
import { L3PiUiSocketContracts } from '../src/common/l3_modules/plugin-host/l3-plugin-native-ui-contract'
import {
  emptyL4PiUiSnapshot,
  type L4PiUiSnapshot
} from '../src/common/l4_foundation/pi/l4-pi-ui-contract'
import type { L4AppSocketClient } from '../src/client/l4_foundation/realtime/app-socket/l4-app-socket'
import type {
  L4AppSocketPushContract,
  L4AppSocketRequestContract
} from '../src/common/l4_foundation/realtime/l4-app-websocket-contract'

const source = {
  workId: 'native-ui-test',
  sessionId: '11111111-1111-4111-8111-111111111111',
  branchId: 'v1:main'
}
function snapshot(id = randomUUID()): L4PiUiSnapshot {
  return {
    ...emptyL4PiUiSnapshot(),
    requests: [{ id, method: 'input', title: '输入', placeholder: '', expiresAt: null }]
  }
}
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

class Socket implements L4AppSocketClient {
  calls: Array<{ path: string; resolve(value: unknown): void; reject(error: Error): void }> = []
  listener: ((value: unknown) => void) | null = null
  async connect(): Promise<boolean> {
    return true
  }
  waitForClose(): Promise<{ code: number; reason: string }> {
    return new Promise(() => undefined)
  }
  request<Input, Output>(
    contract: L4AppSocketRequestContract<Input, Output>,
    input: Input
  ): Promise<Output> {
    contract.inputSchema.parse(input)
    return new Promise((resolve, reject) =>
      this.calls.push({
        path: contract.path,
        resolve: (value) => resolve(contract.outputSchema.parse(value)),
        reject
      })
    )
  }
  subscribe<Body>(
    contract: L4AppSocketPushContract<Body>,
    listener: (value: Body) => void
  ): () => void {
    this.listener = (value) => listener(contract.bodySchema.parse(value))
    return () => {
      this.listener = null
    }
  }
  push(state: L4PiUiSnapshot): void {
    this.listener?.({ source, event: { type: 'snapshot', snapshot: state } })
  }
}
async function fixture(): Promise<{ socket: Socket; biz: L2NativeUiBiz; initial: L4PiUiSnapshot }> {
  const socket = new Socket()
  const biz = new L2NativeUiBiz(socket)
  biz.watch(source)
  biz.ready([source])
  const initial = snapshot()
  socket.calls[0]!.resolve(initial)
  await settle()
  return { socket, biz, initial }
}

test('原生命令通知有界保留，Source 失效后不串入新会话', async () => {
  const { socket, biz } = await fixture()
  try {
    for (let index = 0; index < 50; index += 1) {
      socket.listener?.({
        source,
        event: { type: 'notify', level: 'info', message: `notice-${index}` }
      })
    }
    const notices = biz.getState(source).notices
    assert.ok(notices.length > 0 && notices.length <= 32)
    assert.equal(notices.at(-1)?.message, 'notice-49')
    const next = { ...source, branchId: 'v1:fork:e:fixture:2' }
    biz.reconcile([next])
    socket.listener?.({
      source,
      event: { type: 'notify', level: 'error', message: 'late-old-source' }
    })
    assert.deepEqual(biz.getState(next).notices, [])
  } finally {
    biz.dispose()
  }
})

test('关闭命令输出只清除本地通知，保留待答问题与输入', async () => {
  const { socket, biz, initial } = await fixture()
  try {
    const id = initial.requests[0]!.id
    biz.edit(source, { answers: { [id]: '保留输入' } })
    socket.listener?.({
      source,
      event: { type: 'notify', level: 'info', message: '旧输出' }
    })
    const calls = socket.calls.length

    biz.edit(source, { notices: [] })
    assert.deepEqual(biz.getState(source).notices, [])
    assert.deepEqual(biz.getState(source).snapshot, initial)
    assert.equal(biz.getState(source).answers[id], '保留输入')
    assert.equal(socket.calls.length, calls)

    socket.listener?.({
      source,
      event: { type: 'notify', level: 'info', message: '新输出' }
    })
    assert.deepEqual(biz.getState(source).notices, [{ level: 'info', message: '新输出' }])
  } finally {
    biz.dispose()
  }
})

test('订阅回执前的完整更新不会被旧基线覆盖', async () => {
  const socket = new Socket()
  const biz = new L2NativeUiBiz(socket)
  biz.watch(source)
  biz.ready([source])
  const current = snapshot()
  socket.push(current)
  socket.calls[0]!.resolve(emptyL4PiUiSnapshot())
  await settle()
  assert.deepEqual(biz.getState(source).snapshot, current)
  assert.equal(biz.getState(source).ready, true)
  biz.dispose()
})

test('未知结果只刷新状态，不自动重发回答', async () => {
  const { socket, biz, initial } = await fixture()
  const id = initial.requests[0]!.id
  biz.edit(source, { answers: { [id]: '保留输入' } })
  const response = biz.respond(source, { id, value: '保留输入' })
  socket.calls[1]!.reject(new Error('连接中断'))
  await settle()
  assert.equal(biz.getState(source).unknown, id)
  assert.equal(socket.calls[2]!.path, L3PiUiSocketContracts.subscribe.path)
  socket.calls[2]!.resolve(initial)
  await response
  assert.equal(
    socket.calls.filter((call) => call.path === L3PiUiSocketContracts.respond.path).length,
    1
  )
  assert.equal(biz.getState(source).answers[id], '保留输入')
  assert.equal(biz.getState(source).unknown, null)
  assert.equal(biz.getState(source).ready, true)
  biz.dispose()
})

test('旧回答回执不能解除下一个问题的提交锁', async () => {
  const { socket, biz, initial } = await fixture()
  const first = biz.respond(source, { id: initial.requests[0]!.id, value: '第一题' })
  const next = snapshot()
  socket.push(next)
  const second = biz.respond(source, { id: next.requests[0]!.id, value: '第二题' })
  socket.calls[1]!.resolve({})
  await first
  assert.equal(biz.getState(source).submitting, next.requests[0]!.id)
  socket.push(emptyL4PiUiSnapshot())
  socket.calls[2]!.resolve({})
  await second
  assert.equal(biz.getState(source).submitting, null)
  biz.dispose()
})

test('断线保留草稿，重连旧回执与失效 Source 不污染新状态', async () => {
  const { socket, biz, initial } = await fixture()
  const id = initial.requests[0]!.id
  biz.edit(source, { answers: { [id]: '本地回答' } })
  const response = biz.respond(source, { id, value: '本地回答' })
  biz.disconnected()
  assert.equal(biz.getState(source).answers[id], '本地回答')
  biz.ready([source])
  socket.calls[2]!.resolve(emptyL4PiUiSnapshot())
  await settle()
  socket.calls[1]!.reject(new Error('旧连接迟到失败'))
  await response
  assert.equal(biz.getState(source).error, null)
  assert.deepEqual(biz.getState(source).answers, {})
  const next = { ...source, branchId: 'v1:main.1' }
  biz.reconcile([next])
  assert.deepEqual(biz.getState(next).snapshot, emptyL4PiUiSnapshot())
  biz.dispose()
})

for (const pendingQuestion of [false, true]) {
  test(`订阅超时后重试和重连清除旧错误：${pendingQuestion ? '相同问题' : '无待回答问题'}`, async () => {
    const socket = new Socket()
    const biz = new L2NativeUiBiz(socket)
    const initial = pendingQuestion ? snapshot() : emptyL4PiUiSnapshot()
    try {
      biz.watch(source)
      biz.ready([source])
      socket.calls[0]!.resolve(initial)
      await settle()

      const failed = biz.refreshSource(source)
      socket.calls[1]!.reject(new Error('WebSocket 请求超时：pi/ui/subscribe'))
      await failed
      assert.equal(biz.getState(source).refreshing, false)
      assert.match(biz.getState(source).error!, /请求超时/)

      const retry = biz.refreshSource(source)
      assert.equal(biz.getState(source).refreshing, true)
      await biz.refreshSource(source)
      assert.equal(socket.calls.length, 3)
      socket.calls[2]!.resolve(initial)
      await retry
      assert.equal(biz.getState(source).ready, true)
      assert.equal(biz.getState(source).refreshing, false)
      assert.equal(biz.getState(source).error, null)

      const failedAgain = biz.refreshSource(source)
      socket.calls[3]!.reject(new Error('再次超时'))
      await failedAgain
      biz.disconnected()
      biz.ready([source])
      socket.calls[4]!.resolve(initial)
      await settle()
      assert.equal(biz.getState(source).ready, true)
      assert.equal(biz.getState(source).error, null)
    } finally {
      biz.dispose()
    }
  })
}

test('明确拒绝回答的原因不会被自动核对抹掉，手动刷新可清除', async () => {
  const { socket, biz, initial } = await fixture()
  try {
    const response = biz.respond(source, { id: initial.requests[0]!.id, value: '' })
    socket.calls[1]!.reject(Object.assign(new Error('回答不能为空'), { code: 400 }))
    await settle()
    socket.calls[2]!.resolve(initial)
    await response
    assert.equal(biz.getState(source).ready, true)
    assert.equal(biz.getState(source).unknown, null)
    assert.equal(biz.getState(source).error, '回答不能为空')

    const refresh = biz.refreshSource(source)
    socket.calls[3]!.resolve(initial)
    await refresh
    assert.equal(biz.getState(source).error, null)
  } finally {
    biz.dispose()
  }
})
