import 'server-only'

import {
  L2TerminalSocketContracts,
  type L2TerminalEvent,
  type L2TerminalSnapshot
} from '@common/l2_biz/terminal/l2-terminal-contract'
import type {
  L4AppSocketRequest,
  L4AppSocketRequestContract
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { L2TerminalError, type L2TerminalManage } from '@server/l2_biz/terminal/l2-terminal-manage'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L1AppSocketRoute } from './l1-app-socket-route'

const MAX_GATE_BYTES = 512 * 1024
const MAX_GATE_EVENTS = 128
const MAX_WATCHES = 32

interface TerminalWatch {
  id: string
  dispose: (() => void) | null
  events: L2TerminalEvent[]
  bytes: number
  syncing: boolean
  overflowed: boolean
  rebuilding: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class L1TerminalSocketController {
  readonly routes: readonly L1AppSocketRoute[]
  private disposed = false
  private unsubscribeList: (() => void) | null = null
  private readonly watches = new Map<string, TerminalWatch>()
  private watchTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly connection: L4AppSocketConnection,
    private readonly manage: L2TerminalManage,
    private readonly isReady: () => boolean
  ) {
    const contracts = L2TerminalSocketContracts
    this.routes = [
      this.route(contracts.list, () => {
        // 注册与读取同处一个同步调用栈；响应先于下一次集合变更，无列表订阅空窗。
        if (!this.unsubscribeList)
          this.unsubscribeList = this.manage.subscribeList((terminals) => {
            if (!this.active()) return
            const validIds = new Set(terminals.map((item) => item.terminalId))
            for (const id of this.watches.keys()) {
              if (!validIds.has(id)) this.releaseWatch(id)
            }
            this.connection.sendPush(contracts.update, { terminals })
          })
        return { terminals: this.manage.list() }
      }),
      this.route(contracts.create, ({ cwd }) => this.manage.create(cwd)),
      this.route(contracts.remove, async ({ terminalId }) => {
        await this.manage.remove(terminalId)
        return {}
      }),
      {
        path: contracts.watch.path,
        access: 'ready',
        handle: (request) => this.enqueueWatch(() => this.watch(request))
      },
      {
        path: contracts.unwatch.path,
        access: 'ready',
        handle: (request) => this.enqueueWatch(() => this.unwatch(request))
      },
      this.route(contracts.input, async ({ terminalId, data }) => {
        await this.manage.input(terminalId, data)
        return {}
      }),
      this.route(contracts.activate, async ({ terminalId, cols, rows }) => {
        await this.manage.activate(terminalId, this.connection.connectionId, cols, rows)
        if (!this.active()) this.manage.releaseOwner(this.connection.connectionId)
        return {}
      }),
      this.route(contracts.resize, async ({ terminalId, cols, rows }) => {
        await this.manage.resize(terminalId, this.connection.connectionId, cols, rows)
        return {}
      })
    ]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeList?.()
    this.unsubscribeList = null
    this.releaseAllWatches()
    this.manage.releaseOwner(this.connection.connectionId)
  }

  private active(): boolean {
    return !this.disposed && this.connection.isCurrent() && this.isReady()
  }

  private route<TInput, TOutput>(
    contract: L4AppSocketRequestContract<TInput, TOutput>,
    operation: (input: TInput) => TOutput | Promise<TOutput>
  ): L1AppSocketRoute {
    return {
      path: contract.path,
      access: 'ready',
      handle: async (request) => {
        if (!this.active()) return
        const parsed = contract.inputSchema.safeParse(request.body)
        if (!parsed.success) {
          this.connection.sendError(contract.path, request.head.requestId, 400, '终端请求参数无效')
          return
        }
        try {
          const result = operation(parsed.data)
          // list 的同步基线不能因无必要的 await 给 push 留出抢先发送的机会。
          const output = result instanceof Promise ? await result : result
          if (this.active()) this.connection.sendSuccess(contract, request.head.requestId, output)
        } catch (error) {
          this.sendError(request, error)
        }
      }
    }
  }

  private enqueueWatch(operation: () => Promise<void>): Promise<void> {
    const result = this.watchTail.then(operation)
    this.watchTail = result.catch(() => undefined)
    return result
  }

  private async watch(request: L4AppSocketRequest): Promise<void> {
    if (!this.active()) return
    const contract = L2TerminalSocketContracts.watch
    const parsed = contract.inputSchema.safeParse(request.body)
    if (!parsed.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '终端观察参数无效')
      return
    }
    if (parsed.data.terminalId === null) {
      this.releaseAllWatches()
      this.connection.sendSuccess(contract, request.head.requestId, { snapshot: null })
      return
    }
    this.releaseWatch(parsed.data.terminalId)
    if (this.watches.size >= MAX_WATCHES) {
      this.sendError(request, new L2TerminalError(429, '终端观察已达 32 个上限'))
      return
    }
    const gate: TerminalWatch = {
      id: parsed.data.terminalId,
      dispose: null,
      events: [],
      bytes: 0,
      syncing: true,
      overflowed: false,
      rebuilding: false,
      timer: null
    }
    this.watches.set(gate.id, gate)
    try {
      await this.prepareSnapshot(gate, (snapshot) => {
        this.connection.sendSuccess(contract, request.head.requestId, { snapshot })
      })
    } catch (error) {
      if (this.watches.get(gate.id) === gate) this.releaseWatch(gate.id)
      this.sendError(request, error)
    }
  }

  private async unwatch(request: L4AppSocketRequest): Promise<void> {
    if (!this.active()) return
    const contract = L2TerminalSocketContracts.unwatch
    const parsed = contract.inputSchema.safeParse(request.body)
    if (!parsed.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '终端观察参数无效')
      return
    }
    this.releaseWatch(parsed.data.terminalId)
    this.connection.sendSuccess(contract, request.head.requestId, {})
  }

  private valid(gate: TerminalWatch): boolean {
    return this.watches.get(gate.id) === gate && this.active()
  }

  private async prepareSnapshot(
    gate: TerminalWatch,
    deliver: (snapshot: L2TerminalSnapshot) => void
  ): Promise<void> {
    gate.rebuilding = true
    gate.syncing = true
    try {
      while (this.valid(gate)) {
        gate.dispose?.()
        gate.dispose = null
        gate.events = []
        gate.bytes = 0
        gate.overflowed = false
        const observation = await this.manage.watch(gate.id, (event) =>
          this.acceptEvent(gate, event)
        )
        if (!this.valid(gate)) {
          observation.dispose()
          return
        }
        gate.dispose = observation.dispose
        if (!gate.overflowed) {
          // 在同一个同步片段内发送基线并开闸，避免 await 返回期间的新溢出使基线失效。
          deliver(observation.snapshot)
          gate.syncing = false
          this.scheduleDrain(gate)
          return
        }
      }
    } finally {
      gate.rebuilding = false
    }
  }

  private acceptEvent(gate: TerminalWatch, event: L2TerminalEvent): void {
    if (!this.valid(gate) || gate.overflowed) return
    const bytes = this.eventBytes(event)
    if (gate.bytes + bytes > MAX_GATE_BYTES || gate.events.length >= MAX_GATE_EVENTS) {
      gate.overflowed = true
      gate.syncing = true
      gate.events = []
      gate.bytes = 0
      console.warn('[Pi Desk][TerminalSocket] 观察队列溢出，重建快照', {
        terminalId: gate.id,
        connectionId: this.connection.connectionId
      })
      if (!gate.rebuilding) {
        void this.enqueueWatch(async () => {
          if (!this.valid(gate)) return
          try {
            await this.prepareSnapshot(gate, (snapshot) => {
              this.connection.sendPush(L2TerminalSocketContracts.event, {
                terminalId: gate.id,
                event: { type: 'snapshot', snapshot }
              })
            })
          } catch (error) {
            console.error('[Pi Desk][TerminalSocket] 快照重建失败', { terminalId: gate.id, error })
            if (this.valid(gate)) {
              this.releaseWatch(gate.id)
              this.connection.close(1011, '终端画面无法同步')
            }
          }
        })
      }
      return
    }
    gate.events.push(event)
    gate.bytes += bytes
    if (!gate.syncing) this.scheduleDrain(gate)
  }

  private scheduleDrain(gate: TerminalWatch): void {
    if (!this.valid(gate) || gate.syncing || gate.timer || !gate.events.length) return
    // 一轮最多 64KiB 输出，为共用连接上的聊天和其他请求让出调度机会。
    gate.timer = setTimeout(() => {
      gate.timer = null
      if (!this.valid(gate) || gate.syncing) return
      for (let i = 0; i < 4 && gate.events.length && this.valid(gate); i += 1) {
        const event = gate.events.shift()!
        gate.bytes -= this.eventBytes(event)
        this.connection.sendPush(L2TerminalSocketContracts.event, { terminalId: gate.id, event })
      }
      this.scheduleDrain(gate)
    }, 8)
  }

  private eventBytes(event: L2TerminalEvent): number {
    if (event.type === 'output') return Buffer.byteLength(event.data)
    if (event.type === 'snapshot') return Buffer.byteLength(event.snapshot.data)
    return 32
  }

  private releaseWatch(id: string): void {
    const gate = this.watches.get(id)
    if (!gate) return
    this.watches.delete(id)
    gate.dispose?.()
    if (gate.timer) clearTimeout(gate.timer)
    gate.events = []
    gate.bytes = 0
  }

  private releaseAllWatches(): void {
    for (const id of this.watches.keys()) this.releaseWatch(id)
  }

  private sendError(request: L4AppSocketRequest, error: unknown): void {
    if (!this.active()) return
    if (error instanceof L2TerminalError) {
      this.connection.sendError(
        request.head.path,
        request.head.requestId,
        error.code,
        error.message
      )
      return
    }
    console.error('[Pi Desk][TerminalSocket] 终端请求失败', {
      path: request.head.path,
      connectionId: this.connection.connectionId,
      error
    })
    this.connection.sendError(request.head.path, request.head.requestId, 500, '终端操作失败')
  }
}
