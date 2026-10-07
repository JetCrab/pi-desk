import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { L1TerminalSocketController } from '../src/server/l1_entry/websocket/l1-terminal-socket-controller'
import { L4AppSocketConnection } from '../src/server/l4_foundation/realtime/app-socket/l4-app-socket-connection'
import { L2TerminalManage } from '../src/server/l2_biz/terminal/l2-terminal-manage'
import type { L4TerminalRuntime as TerminalRuntime } from '../src/server/l4_foundation/terminal/l4-terminal-runtime'
import {
  L4AppSocketPushSchema,
  L4AppSocketResponseSchema
} from '../src/common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  L2TerminalSnapshotSchema,
  L2TerminalSummarySchema
} from '../src/common/l2_biz/terminal/l2-terminal-contract'

const { createRequire } = process.getBuiltinModule('module')
const { L4TerminalRuntime } = createRequire(import.meta.url)(
  '../src/server/l4_foundation/terminal/l4-terminal-runtime.ts'
) as typeof import('../src/server/l4_foundation/terminal/l4-terminal-runtime')

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 12_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待终端网络事件超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

class Peer {
  readonly events: unknown[] = []
  readonly frames: string[] = []
  private readonly pending = new Map<
    string,
    (body: { code: number; msg: string; data: unknown }) => void
  >()
  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const text = raw.toString()
      this.frames.push(text)
      const payload: unknown = JSON.parse(text)
      const response = L4AppSocketResponseSchema.safeParse(payload)
      if (response.success) {
        const resolve = this.pending.get(response.data.head.requestId)
        this.pending.delete(response.data.head.requestId)
        resolve?.(response.data.body)
      } else this.events.push(L4AppSocketPushSchema.parse(payload))
    })
  }
  request(path: string, body: object): Promise<{ code: number; msg: string; data: unknown }> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`请求超时 ${path}`))
      }, 15_000)
      this.pending.set(requestId, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      this.socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
    })
  }
}

test(
  '终端真实WebSocket晚加入、原子watch、旧连接释放与参数拒绝',
  { timeout: 55_000 },
  async (context) => {
    const manage = new L2TerminalManage()
    const release = Promise.withResolvers<void>()
    const dispose = L4TerminalRuntime.prototype.dispose
    let blockedId = ''
    let released = false
    context.mock.method(
      L4TerminalRuntime.prototype,
      'dispose',
      async function (this: TerminalRuntime): Promise<void> {
        if (this.terminalId === blockedId) await release.promise
        await dispose.call(this)
        if (this.terminalId === blockedId) released = true
      }
    )
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    const connections: Array<{
      connection: L4AppSocketConnection
      controller: L1TerminalSocketController
    }> = []
    const peers: Peer[] = []
    server.on('connection', (socket, request) => {
      const clientId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('clientId')!
      const connection = new L4AppSocketConnection(clientId, socket)
      const controller = new L1TerminalSocketController(connection, manage, () => true)
      connections.push({ connection, controller })
      connection.start(
        async (message) => {
          const route = controller.routes.find((item) => item.path === message.head.path)
          assert.ok(route)
          await route.handle(message)
        },
        () => controller.dispose()
      )
    })
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const connect = async (clientId: string): Promise<Peer> => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?clientId=${clientId}`)
      const peer = new Peer(socket)
      peers.push(peer)
      await once(socket, 'open')
      assert.equal((await peer.request('terminals/list', {})).code, 0)
      return peer
    }
    try {
      const sameId = randomUUID()
      const a = await connect(sameId)
      const b = await connect(randomUUID())
      const created = await a.request('terminals/create', { cwd: process.cwd() })
      assert.equal(created.code, 0)
      const terminal = L2TerminalSummarySchema.parse(created.data)
      await until(() => b.frames.some((frame) => frame.includes(terminal.terminalId)))
      const firstWatch = await a.request('terminals/watch', { terminalId: terminal.terminalId })
      assert.equal(firstWatch.code, 0)
      const marker =
        process.platform === 'win32'
          ? "Write-Output ('WIRE_' + 'READY')\r"
          : "printf '\\nWIRE_%s\\n' READY\r"
      assert.equal(
        (await a.request('terminals/input', { terminalId: terminal.terminalId, data: marker }))
          .code,
        0
      )
      await until(() => a.frames.some((frame) => frame.includes('WIRE_READY')))
      const late = await b.request('terminals/watch', { terminalId: terminal.terminalId })
      assert.equal(late.code, 0)
      const snapshot = L2TerminalSnapshotSchema.parse((late.data as { snapshot: unknown }).snapshot)
      assert.ok(snapshot.data.includes('WIRE_READY'))
      const secondCreated = await b.request('terminals/create', { cwd: process.cwd() })
      assert.equal(secondCreated.code, 0)
      const second = L2TerminalSummarySchema.parse(secondCreated.data)
      assert.equal((await b.request('terminals/watch', { terminalId: second.terminalId })).code, 0)
      const twoStart = b.frames.length
      const sharedMarker =
        process.platform === 'win32'
          ? "Write-Output ('BOTH_' + 'WATCHED')\r"
          : "printf '\\nBOTH_%s\\n' WATCHED\r"
      for (const terminalId of [terminal.terminalId, second.terminalId]) {
        assert.equal(
          (await b.request('terminals/input', { terminalId, data: sharedMarker })).code,
          0
        )
      }
      await until(() =>
        [terminal.terminalId, second.terminalId].every((id) =>
          b.frames
            .slice(twoStart)
            .some(
              (frame) =>
                frame.includes('terminals/event') &&
                frame.includes(id) &&
                frame.includes('BOTH_WATCHED')
            )
        )
      )
      assert.equal(
        (await b.request('terminals/unwatch', { terminalId: terminal.terminalId })).code,
        0
      )
      assert.equal(
        (await b.request('terminals/unwatch', { terminalId: terminal.terminalId })).code,
        0
      )
      const targetedStart = b.frames.length
      const retainedMarker =
        process.platform === 'win32'
          ? "Write-Output ('RETAINED_' + 'WATCH')\r"
          : "printf '\\nRETAINED_%s\\n' WATCH\r"
      for (const terminalId of [terminal.terminalId, second.terminalId]) {
        await b.request('terminals/input', { terminalId, data: retainedMarker })
      }
      await until(() =>
        b.frames
          .slice(targetedStart)
          .some((frame) => frame.includes(second.terminalId) && frame.includes('RETAINED_WATCH'))
      )
      assert.ok(
        b.frames
          .slice(targetedStart)
          .every(
            (frame) => !frame.includes('terminals/event') || !frame.includes(terminal.terminalId)
          )
      )
      blockedId = second.terminalId
      const starts = [a.events.length, b.events.length]
      assert.equal((await b.request('terminals/remove', { terminalId: second.terminalId })).code, 0)
      await until(() =>
        [a, b].every((peer, index) =>
          peer.events.slice(starts[index]).some((event) => {
            const push = L4AppSocketPushSchema.parse(event)
            return (
              push.head.path === 'terminals/update' &&
              !JSON.stringify(push.body).includes(second.terminalId)
            )
          })
        )
      )
      assert.equal(released, false, '所有页面同步删除及接纳响应不能等待原生清理')
      assert.equal(
        (await b.request('terminals/watch', { terminalId: second.terminalId })).code,
        404
      )
      release.resolve()
      assert.equal(
        (
          await b.request('terminals/input', {
            terminalId: terminal.terminalId,
            data: '中'.repeat(9000)
          })
        ).code,
        400
      )
      assert.equal(
        (await b.request('terminals/resize', { terminalId: terminal.terminalId, cols: 0, rows: 2 }))
          .code,
        400
      )
      assert.equal((await b.request('terminals/watch', { terminalId: randomUUID() })).code, 404)
      const replacement = await connect(sameId)
      assert.equal(
        (
          await replacement.request('terminals/activate', {
            terminalId: terminal.terminalId,
            cols: 51,
            rows: 19
          })
        ).code,
        0
      )
      connections[0].controller.dispose()
      connections[0].connection.supersede()
      await until(() => a.socket.readyState === WebSocket.CLOSED)
      assert.equal(
        (
          await replacement.request('terminals/resize', {
            terminalId: terminal.terminalId,
            cols: 53,
            rows: 20
          })
        ).code,
        0
      )
      const after = await b.request('terminals/watch', { terminalId: terminal.terminalId })
      const resized = L2TerminalSnapshotSchema.parse((after.data as { snapshot: unknown }).snapshot)
      assert.equal(resized.cols, 53, '旧连接释放不得清除同clientId新连接的驱动身份')
      assert.equal(resized.rows, 20)
      const index = b.frames.length
      assert.equal((await b.request('terminals/watch', { terminalId: null })).code, 0)
      await replacement.request('terminals/watch', { terminalId: terminal.terminalId })
      const afterUnwatch =
        process.platform === 'win32'
          ? "Write-Output ('AFTER_' + 'UNWATCH')\r"
          : "printf '\\nAFTER_%s\\n' UNWATCH\r"
      await replacement.request('terminals/input', {
        terminalId: terminal.terminalId,
        data: afterUnwatch
      })
      await until(() => replacement.frames.some((frame) => frame.includes('AFTER_UNWATCH')))
      assert.ok(b.frames.slice(index).every((frame) => !frame.includes('terminals/event')))
      assert.equal(
        (await replacement.request('terminals/remove', { terminalId: terminal.terminalId })).code,
        0
      )
    } finally {
      release.resolve()
      for (const { connection, controller } of connections) {
        controller.dispose()
        connection.terminate()
      }
      for (const peer of peers) peer.socket.terminate()
      await manage.dispose()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
)
