import 'server-only'

import { isAbsolute } from 'node:path'
import {
  L3PluginLogSocketContracts,
  type L3PluginLogEvent
} from '@common/l3_modules/plugin-host/l3-plugin-log-contract'
import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  getL4TextLogPool,
  type L4TextLogObservation
} from '@server/l4_foundation/file/l4-text-log-runtime'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L1AppSocketRoute } from './l1-app-socket-route'

const MAX_LOG_WATCHES_PER_CONNECTION = 16
const MAX_SYNC_EVENT_QUEUE = 128

interface L1PluginLogWatchState {
  key: string
  pluginName: string
  path: string
  observation: L4TextLogObservation
  status: 'syncing' | 'ready'
  queuedEvents: L3PluginLogEvent[]
  overflowed: boolean
}

function watchKey(pluginName: string, path: string): string {
  return JSON.stringify([pluginName, path])
}

export class L1PluginLogSocketController {
  readonly routes: readonly L1AppSocketRoute[]

  private readonly watches = new Map<string, L1PluginLogWatchState>()
  private operationTail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly connection: L4AppSocketConnection) {
    this.routes = Object.freeze([
      {
        path: L3PluginLogSocketContracts.watch.path,
        access: 'ready',
        handle: (request) => this.enqueue(() => this.watch(request))
      },
      {
        path: L3PluginLogSocketContracts.unwatch.path,
        access: 'ready',
        handle: (request) => this.enqueue(() => this.unwatch(request))
      }
    ])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const state of this.watches.values()) state.observation.release()
    this.watches.clear()
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async watch(request: L4AppSocketRequest): Promise<void> {
    const contract = L3PluginLogSocketContracts.watch
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '日志观察参数无效')
      return
    }
    if (!isAbsolute(input.data.path)) {
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        400,
        '日志路径必须是服务端绝对路径'
      )
      return
    }

    const key = watchKey(input.data.pluginName, input.data.path)
    const existing = this.watches.get(key)
    if (existing) {
      this.connection.sendSuccess(contract, request.head.requestId, {
        snapshot: existing.observation.readSnapshot()
      })
      return
    }
    if (this.watches.size >= MAX_LOG_WATCHES_PER_CONNECTION) {
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        409,
        '当前页面观察的日志过多'
      )
      return
    }

    try {
      const state = await this.createStableWatch(key, input.data.pluginName, input.data.path)
      if (this.disposed || !this.connection.isCurrent()) {
        state.observation.release()
        return
      }
      this.watches.set(key, state)
      this.connection.sendSuccess(contract, request.head.requestId, {
        snapshot: state.observation.snapshot
      })
      state.status = 'ready'
      this.flushQueuedEvents(state)
      console.info('[Pi Desk][PluginLogSocket] 日志观察完成', {
        clientId: this.connection.clientId,
        pluginName: state.pluginName,
        path: state.path
      })
    } catch (error) {
      console.warn('[Pi Desk][PluginLogSocket] 初始化日志观察失败', {
        pluginName: input.data.pluginName,
        path: input.data.path,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error)
      })
      this.connection.sendError(contract.path, request.head.requestId, 500, '读取日志失败')
    }
  }

  private async createStableWatch(
    key: string,
    pluginName: string,
    path: string
  ): Promise<L1PluginLogWatchState> {
    while (true) {
      const queuedEvents: L3PluginLogEvent[] = []
      const holder: { state: L1PluginLogWatchState | null } = { state: null }
      const observation = await getL4TextLogPool().observe(path, (event) => {
        const state = holder.state
        if (!state || this.watches.get(key) !== state || this.disposed) {
          if (queuedEvents.length < MAX_SYNC_EVENT_QUEUE) queuedEvents.push(event)
          return
        }
        this.handleEvent(state, event)
      })
      const state: L1PluginLogWatchState = {
        key,
        pluginName,
        path,
        observation,
        status: 'syncing',
        queuedEvents,
        overflowed: queuedEvents.length >= MAX_SYNC_EVENT_QUEUE
      }
      holder.state = state
      if (!state.overflowed) return state
      observation.release()
    }
  }

  private async unwatch(request: L4AppSocketRequest): Promise<void> {
    const contract = L3PluginLogSocketContracts.unwatch
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '日志解除观察参数无效')
      return
    }
    if (!isAbsolute(input.data.path)) {
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        400,
        '日志路径必须是服务端绝对路径'
      )
      return
    }
    this.releaseWatch(watchKey(input.data.pluginName, input.data.path))
    this.connection.sendSuccess(contract, request.head.requestId, {})
  }

  private handleEvent(state: L1PluginLogWatchState, event: L3PluginLogEvent): void {
    if (this.watches.get(state.key) !== state || this.disposed || !this.connection.isCurrent()) {
      return
    }
    if (state.status === 'syncing') {
      if (state.queuedEvents.length >= MAX_SYNC_EVENT_QUEUE) {
        state.queuedEvents.length = 0
        state.overflowed = true
        return
      }
      state.queuedEvents.push(event)
      return
    }

    this.connection.sendPush(L3PluginLogSocketContracts.event, {
      pluginName: state.pluginName,
      path: state.path,
      event
    })
    if (event.type === 'unavailable') this.releaseWatch(state.key)
  }

  private flushQueuedEvents(state: L1PluginLogWatchState): void {
    if (this.watches.get(state.key) !== state) return
    if (state.overflowed) {
      this.connection.sendPush(L3PluginLogSocketContracts.event, {
        pluginName: state.pluginName,
        path: state.path,
        event: { type: 'snapshot', snapshot: state.observation.readSnapshot() }
      })
      state.queuedEvents.length = 0
      state.overflowed = false
      return
    }
    for (const event of state.queuedEvents.splice(0)) {
      this.connection.sendPush(L3PluginLogSocketContracts.event, {
        pluginName: state.pluginName,
        path: state.path,
        event
      })
      if (event.type === 'unavailable') {
        this.releaseWatch(state.key)
        return
      }
    }
  }

  private releaseWatch(key: string): void {
    const state = this.watches.get(key)
    if (!state) return
    this.watches.delete(key)
    state.observation.release()
  }
}
