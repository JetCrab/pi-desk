import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { L2TerminalBiz } from '../src/client/l2_biz/terminal/l2-terminal-biz'
import type { L4AppSocketClient } from '../src/client/l4_foundation/realtime/app-socket/l4-app-socket'
import type {
  L4AppSocketPushContract,
  L4AppSocketRequestContract
} from '../src/common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  L2TerminalSocketContracts as contracts,
  type L2TerminalSummary
} from '../src/common/l2_biz/terminal/l2-terminal-contract'
import type {
  L4TerminalDimensions,
  L4TerminalRenderer
} from '../src/client/l4_foundation/terminal/l4-terminal-renderer'

class TerminalSocket implements L4AppSocketClient {
  readonly calls: Array<{ path: string; input: unknown }> = []
  readonly listeners = new Map<string, Set<(value: unknown) => void>>()
  readonly observing = new Set<string>()
  terminals: L2TerminalSummary[] = [0, 1].map(() => ({
    terminalId: randomUUID(),
    cwd: 'C:/workspace',
    shell: 'powershell.exe',
    title: '',
    status: 'running',
    exitCode: null
  }))
  connect = async (): Promise<boolean> => false
  waitForClose = async (): Promise<{ code: number; reason: string }> => ({ code: 1000, reason: '' })
  async request<TInput, TOutput>(
    contract: L4AppSocketRequestContract<TInput, TOutput>,
    input: TInput
  ): Promise<TOutput> {
    contract.inputSchema.parse(input)
    this.calls.push({ path: contract.path, input })
    let output: unknown = {}
    if (contract.path === contracts.list.path) output = { terminals: this.terminals }
    else if (contract.path === contracts.create.path) {
      const { cwd } = contracts.create.inputSchema.parse(input)
      const terminal: L2TerminalSummary = {
        terminalId: randomUUID(),
        cwd: cwd ?? 'C:/workspace',
        shell: 'powershell.exe',
        title: '',
        status: 'running',
        exitCode: null
      }
      this.terminals = [...this.terminals, terminal]
      this.push(contracts.update, { terminals: this.terminals })
      output = terminal
    } else if (contract.path === contracts.remove.path) {
      const { terminalId } = contracts.remove.inputSchema.parse(input)
      this.terminals = this.terminals.filter((item) => item.terminalId !== terminalId)
      this.observing.delete(terminalId)
      this.push(contracts.update, { terminals: this.terminals })
    } else if (contract.path === contracts.watch.path) {
      const { terminalId } = contracts.watch.inputSchema.parse(input)
      if (terminalId) this.observing.add(terminalId)
      else this.observing.clear()
      output = {
        snapshot: terminalId ? { cols: 80, rows: 24, data: `baseline:${terminalId}` } : null
      }
    } else if (contract.path === contracts.unwatch.path) {
      const { terminalId } = contracts.unwatch.inputSchema.parse(input)
      this.observing.delete(terminalId)
    }
    return contract.outputSchema.parse(output)
  }
  subscribe<TBody>(
    contract: L4AppSocketPushContract<TBody>,
    listener: (value: TBody) => void
  ): () => void {
    const channel = this.listeners.get(contract.path) ?? new Set<(value: unknown) => void>()
    const wrapped = (value: unknown): void => listener(contract.bodySchema.parse(value))
    channel.add(wrapped)
    this.listeners.set(contract.path, channel)
    return () => {
      channel.delete(wrapped)
    }
  }
  push<TBody>(contract: L4AppSocketPushContract<TBody>, value: TBody): void {
    for (const listener of this.listeners.get(contract.path) ?? []) listener(value)
  }
  output(id: string, data: string): void {
    this.push(contracts.event, { terminalId: id, event: { type: 'output', data } })
  }
  watchCount(): number {
    return this.calls.filter(
      (call) =>
        call.path === contracts.watch.path &&
        contracts.watch.inputSchema.parse(call.input).terminalId !== null
    ).length
  }
}

class Screen implements L4TerminalRenderer {
  readonly baselines: string[] = []
  readonly output: string[] = []
  async restore(snapshot: L4TerminalDimensions & { data: string }): Promise<void> {
    this.baselines.push(snapshot.data)
  }
  async write(data: string): Promise<void> {
    this.output.push(data)
  }
  resize(): void {}
  measure(): L4TerminalDimensions {
    return { cols: 80, rows: 24 }
  }
  focus(): void {}
  key(): void {}
  setControl(): void {}
  setVisible(): void {}
  dispose(): void {}
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '终端缓存状态未收敛')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function setup(): Promise<{
  socket: TerminalSocket
  biz: L2TerminalBiz
  ids: string[]
  a: Screen
  b: Screen
  detach: Array<() => void>
}> {
  const socket = new TerminalSocket()
  const biz = new L2TerminalBiz(socket)
  await biz.connected()
  const ids = socket.terminals.map((item) => item.terminalId)
  const a = new Screen()
  const b = new Screen()
  const detach: Array<() => void> = []
  biz.select(ids[0])
  detach.push(biz.attach(ids[0], a))
  await until(() => a.baselines.length === 1)
  biz.select(ids[1])
  detach.push(biz.attach(ids[1], b))
  await until(() => b.baselines.length === 1)
  return { socket, biz, ids, a, b, detach }
}

test('首次创建立即展开且不伪造终端记录，等待期间拦截重复打开', async (context) => {
  const socket = new TerminalSocket()
  socket.terminals = []
  const biz = new L2TerminalBiz(socket)
  const accepted = Promise.withResolvers<void>()
  let creating: Promise<void> | undefined
  try {
    await biz.connected()
    const request = socket.request.bind(socket)
    let attempts = 0
    context.mock.method(
      socket,
      'request',
      async <TInput, TOutput>(
        contract: L4AppSocketRequestContract<TInput, TOutput>,
        input: TInput
      ): Promise<TOutput> => {
        if (contract.path === contracts.create.path) {
          attempts += 1
          await accepted.promise
        }
        return request(contract, input)
      }
    )
    creating = biz.open('C:/workspace')
    assert.equal(biz.getSnapshot().expanded, true)
    assert.equal(biz.getSnapshot().opening, true)
    assert.equal(biz.getSnapshot().busy, true)
    assert.deepEqual(biz.getSnapshot().terminals, [])
    socket.push(contracts.update, { terminals: [] })
    assert.equal(biz.getSnapshot().expanded, true, '创建中空列表不能收起布局')
    await biz.open('C:/workspace')
    assert.equal(attempts, 1, '重复入口不能再创建一个终端')
    accepted.resolve()
    await creating
    assert.equal(biz.getSnapshot().opening, false)
    assert.equal(biz.getSnapshot().busy, false)
    assert.equal(biz.getSnapshot().selectedId, socket.terminals[0].terminalId)
    assert.equal(biz.getSnapshot().terminals.length, 1)
  } finally {
    accepted.resolve()
    await creating
    biz.dispose()
  }
})

test('添加等待期间保留已有终端，主动折叠后不重新展开', async (context) => {
  const { socket, biz, ids, a, detach } = await setup()
  const accepted = Promise.withResolvers<void>()
  let creating: Promise<void> | undefined
  try {
    const request = socket.request.bind(socket)
    context.mock.method(
      socket,
      'request',
      async <TInput, TOutput>(
        contract: L4AppSocketRequestContract<TInput, TOutput>,
        input: TInput
      ): Promise<TOutput> => {
        if (contract.path === contracts.create.path) await accepted.promise
        return request(contract, input)
      }
    )
    creating = biz.open('C:/another-project')
    assert.equal(biz.getSnapshot().opening, true)
    assert.equal(biz.getSnapshot().selectedId, ids[1])
    socket.output(ids[0], 'output-during-create')
    await until(() => a.output.includes('output-during-create'))
    biz.setExpanded(false)
    accepted.resolve()
    await creating
    const created = socket.terminals.find((terminal) => terminal.cwd === 'C:/another-project')!
    assert.equal(biz.getSnapshot().selectedId, created.terminalId)
    assert.equal(biz.getSnapshot().expanded, false)
    assert.equal(biz.getSnapshot().opening, false)
  } finally {
    accepted.resolve()
    await creating
    for (const release of detach) release()
    biz.dispose()
  }
})

test('创建失败保留可见错误并释放创建状态，允许再次打开', async (context) => {
  const socket = new TerminalSocket()
  socket.terminals = []
  const biz = new L2TerminalBiz(socket)
  const failure = new Error('测试 Shell 启动失败')
  context.mock.method(console, 'warn', () => undefined)
  try {
    await biz.connected()
    const request = socket.request.bind(socket)
    let failNext = true
    context.mock.method(
      socket,
      'request',
      async <TInput, TOutput>(
        contract: L4AppSocketRequestContract<TInput, TOutput>,
        input: TInput
      ): Promise<TOutput> => {
        if (contract.path === contracts.create.path && failNext) {
          failNext = false
          throw failure
        }
        return request(contract, input)
      }
    )
    await assert.rejects(biz.open(), (cause: unknown) => cause === failure)
    await biz.refreshList()
    assert.equal(biz.getSnapshot().expanded, true)
    assert.equal(biz.getSnapshot().error, failure.message)
    assert.equal(biz.getSnapshot().opening, false)
    assert.equal(biz.getSnapshot().busy, false)
    await biz.open()
    assert.equal(biz.getSnapshot().error, null)
    assert.equal(biz.getSnapshot().terminals.length, 1)
  } finally {
    biz.dispose()
  }
})

test('取消后创建未成功时清除空面板，不展示取消操作的错误', async (context) => {
  const socket = new TerminalSocket()
  socket.terminals = []
  const biz = new L2TerminalBiz(socket)
  const controller = new AbortController()
  const accepted = Promise.withResolvers<L2TerminalSummary>()
  const failure = new Error('测试创建已取消')
  let creating: Promise<void> | undefined
  try {
    await biz.connected()
    const request = socket.request.bind(socket)
    context.mock.method(
      socket,
      'request',
      async <TInput, TOutput>(
        contract: L4AppSocketRequestContract<TInput, TOutput>,
        input: TInput
      ): Promise<TOutput> => {
        if (contract.path === contracts.create.path)
          return contract.outputSchema.parse(await accepted.promise)
        return request(contract, input)
      }
    )
    creating = biz.open(undefined, controller.signal)
    assert.equal(biz.getSnapshot().expanded, true)
    const rejected = assert.rejects(creating, (cause: unknown) => cause === failure)
    controller.abort()
    accepted.reject(failure)
    await rejected
    await biz.refreshList()
    assert.equal(biz.getSnapshot().expanded, false)
    assert.equal(biz.getSnapshot().opening, false)
    assert.equal(biz.getSnapshot().error, null)
  } finally {
    accepted.reject(failure)
    await creating?.catch(() => undefined)
    biz.dispose()
  }
})

test('首次观察不先取消，替换观察仍隔离旧事件', async (context) => {
  const { socket, biz, ids, a, detach } = await setup()
  const barrier = Promise.withResolvers<void>()
  try {
    assert.equal(socket.calls.filter((call) => call.path === contracts.unwatch.path).length, 0)
    const request = socket.request.bind(socket)
    let resetting = false
    context.mock.method(
      socket,
      'request',
      async <TInput, TOutput>(
        contract: L4AppSocketRequestContract<TInput, TOutput>,
        input: TInput
      ): Promise<TOutput> => {
        if (contract.path === contracts.unwatch.path) {
          resetting = true
          await barrier.promise
        }
        return request(contract, input)
      }
    )
    const replacement = new Screen()
    detach.push(biz.attach(ids[0], replacement))
    await until(() => resetting)
    socket.output(ids[0], 'stale-before-unwatch')
    barrier.resolve()
    await until(() => replacement.baselines.length === 1 && !biz.getSnapshot().tabs[ids[0]].syncing)
    socket.output(ids[0], 'new-watch-output')
    await until(() => replacement.output.length === 1)
    assert.deepEqual(replacement.output, ['new-watch-output'])
    assert.deepEqual(a.output, [])
  } finally {
    barrier.resolve()
    for (const release of detach) release()
    biz.dispose()
  }
})

test('删除以服务端接纳为准，推送移除后不重复查询列表', async (context) => {
  const { socket, biz, ids, detach } = await setup()
  const accepted = Promise.withResolvers<void>()
  try {
    const request = socket.request.bind(socket)
    context.mock.method(
      socket,
      'request',
      async <TInput, TOutput>(
        contract: L4AppSocketRequestContract<TInput, TOutput>,
        input: TInput
      ): Promise<TOutput> => {
        if (contract.path === contracts.remove.path) await accepted.promise
        return request(contract, input)
      }
    )
    const lists = socket.calls.filter((call) => call.path === contracts.list.path).length
    const removing = biz.remove(ids[0])
    assert.equal(biz.getSnapshot().busy, true)
    assert.equal(biz.getSnapshot().terminals.length, 2, '接纳前不得本地删除共享记录')
    accepted.resolve()
    await removing
    assert.equal(biz.getSnapshot().busy, false)
    assert.deepEqual(
      biz.getSnapshot().terminals.map((item) => item.terminalId),
      [ids[1]]
    )
    assert.equal(socket.calls.filter((call) => call.path === contracts.list.path).length, lists)
  } finally {
    accepted.resolve()
    for (const release of detach) release()
    biz.dispose()
  }
})

test('终端标签切换、折叠和页面隐藏保留实例基线，后台持续接收', async () => {
  const { socket, biz, ids, a, b, detach } = await setup()
  try {
    const calls = socket.watchCount()
    for (let round = 0; round < 4; round++) {
      biz.select(ids[0])
      biz.select(ids[1])
    }
    biz.setExpanded(false)
    socket.output(ids[0], 'background-a')
    socket.output(ids[1], 'folded-b')
    biz.setPageVisible(false)
    socket.output(ids[0], 'page-hidden')
    biz.setPageVisible(true)
    biz.setExpanded(true)
    biz.select(ids[0])
    await until(() => a.output.includes('page-hidden') && b.output.includes('folded-b'))
    assert.deepEqual(a.output, ['background-a', 'page-hidden'])
    assert.equal(socket.watchCount(), calls, '普通切换不得重新获取快照')
    assert.equal(a.baselines.length, 1)
    assert.equal(b.baselines.length, 1)
    assert.deepEqual([...socket.observing].sort(), [...ids].sort())
    socket.terminals = socket.terminals.map((item) => ({
      ...item,
      title: item.terminalId === ids[0] ? 'π - SuperPI' : ''
    }))
    socket.push(contracts.update, { terminals: socket.terminals })
    assert.equal(biz.getSnapshot().terminals[0].title, 'π - SuperPI')
    assert.equal(socket.watchCount(), calls, '标题更新不能重建屏幕')
  } finally {
    for (const release of detach) release()
    biz.dispose()
  }
})

test('切换标签或折叠不会丢弃已接纳输入，仍然写到原终端', async () => {
  const { socket, biz, ids, b, detach } = await setup()
  try {
    biz.input(ids[1], 'echo pending\\r', b.measure())
    biz.select(ids[0])
    biz.setExpanded(false)
    await until(() => socket.calls.some((call) => call.path === contracts.input.path))
    const requests = socket.calls.filter((call) => call.path === contracts.input.path)
    assert.equal(requests.length, 1)
    assert.deepEqual(contracts.input.inputSchema.parse(requests[0].input), {
      terminalId: ids[1],
      data: 'echo pending\\r'
    })
  } finally {
    for (const release of detach) release()
    biz.dispose()
  }
})

test('断线保留显示但隔离旧输出，恢复时仅为已访问终端建立新基线', async () => {
  const { socket, biz, ids, a, b, detach } = await setup()
  try {
    biz.disconnected()
    socket.output(ids[0], 'old-connection')
    assert.deepEqual(a.output, [])
    assert.equal(a.baselines.length, 1)
    await biz.connected()
    await until(() => a.baselines.length === 2 && b.baselines.length === 2)
    socket.output(ids[0], 'new-connection-a')
    socket.output(ids[1], 'new-connection-b')
    await until(() => b.output.includes('new-connection-b'))
    assert.deepEqual(a.output, ['new-connection-a'])
    assert.equal(socket.watchCount(), 4)
  } finally {
    for (const release of detach) release()
    biz.dispose()
  }
})

test('单个标签释放或全局删除不重建其他标签，也不接受失效标签事件', async () => {
  const { socket, biz, ids, a, b, detach } = await setup()
  try {
    const calls = socket.watchCount()
    detach[0]()
    await until(() => !socket.observing.has(ids[0]))
    assert.equal(socket.observing.has(ids[1]), true)
    socket.output(ids[0], 'removed-a')
    socket.output(ids[1], 'live-b')
    await until(() => b.output.includes('live-b'))
    assert.deepEqual(a.output, [])
    assert.equal(b.baselines.length, 1)
    assert.equal(socket.watchCount(), calls)
    socket.terminals = socket.terminals.filter((item) => item.terminalId !== ids[1])
    socket.push(contracts.update, { terminals: socket.terminals })
    socket.output(ids[1], 'deleted-b')
    assert.deepEqual(b.output, ['live-b'])
  } finally {
    for (const release of detach) release()
    biz.dispose()
  }
})
