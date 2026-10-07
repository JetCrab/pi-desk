import 'server-only'

import { L2TaskCenterSocketContracts } from '@common/l2_biz/task-center/l2-task-center-websocket-contract'
import type { L2TaskDetailEvent } from '@common/l2_biz/task-center/l2-task-center-contract'
import type { L3WorkSessionSource } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  L2TaskDetailUnsupportedError,
  L2TaskMessageNotFoundError,
  L2TaskNotFoundError,
  L2TaskNotInterruptibleError,
  type L2TaskDetailObservation,
  type L2TaskCenterRuntime
} from '@server/l2_biz/task-center/l2-task-center-runtime'
import {
  L2ChatSourceBindingError,
  type L2WorkSessionChatRuntimeEvent
} from '@server/l2_biz/work-session/l2-work-session-chat-runtime'
import type { WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L1AppSocketRoute } from './l1-app-socket-route'

const MAX_SYNC_EVENT_QUEUE = 128

interface L1TaskDetailWatchState {
  source: L3WorkSessionSource
  taskId: string
  observation: L2TaskDetailObservation
  status: 'syncing' | 'ready'
  queuedEvents: L2TaskDetailEvent[]
  overflowed: boolean
}

function sameSource(left: L3WorkSessionSource, right: L3WorkSessionSource): boolean {
  return (
    left.workId === right.workId &&
    left.sessionId === right.sessionId &&
    left.branchId === right.branchId
  )
}

export class L1TaskCenterSocketController {
  readonly routes: readonly L1AppSocketRoute[]

  private currentWatch: L1TaskDetailWatchState | null = null
  private pendingWatch: { source: L3WorkSessionSource; invalidated: boolean } | null = null
  private readonly unsubscribeSources: () => void
  private operationTail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly connection: L4AppSocketConnection,
    private readonly manage: WorkSessionManage,
    private readonly taskCenter: L2TaskCenterRuntime
  ) {
    this.unsubscribeSources = this.manage.subscribeMessageEvents((event) =>
      this.handleSourceEvent(event)
    )
    this.routes = Object.freeze([
      {
        path: L2TaskCenterSocketContracts.detailWatch.path,
        access: 'ready',
        handle: (request) => this.enqueue(() => this.watch(request))
      },
      {
        path: L2TaskCenterSocketContracts.interrupt.path,
        access: 'ready',
        handle: (request) => this.interrupt(request)
      }
    ])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeSources()
    this.pendingWatch = null
    this.releaseCurrentWatch()
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
    const contract = L2TaskCenterSocketContracts.detailWatch
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '任务详情参数无效')
      return
    }

    this.releaseCurrentWatch()
    if (input.data.taskId === null) {
      this.connection.sendSuccess(contract, request.head.requestId, { snapshot: null })
      return
    }

    const pending = { source: input.data.source, invalidated: false }
    this.pendingWatch = pending
    try {
      const watch = await this.createStableWatch(input.data.source, input.data.taskId)
      if (this.disposed || !this.connection.isCurrent()) {
        watch.observation.release()
        return
      }
      if (pending.invalidated) {
        watch.observation.release()
        throw new L2ChatSourceBindingError(pending.source)
      }
      this.currentWatch = watch
      this.connection.sendSuccess(contract, request.head.requestId, {
        snapshot: watch.observation.snapshot
      })
      watch.status = 'ready'
      this.flushQueuedEvents(watch)
      console.info('[Pi Desk][TaskCenterSocket] 任务详情观察完成', {
        clientId: this.connection.clientId,
        workId: watch.source.workId,
        taskId: watch.taskId
      })
    } catch (error) {
      this.sendTaskError(contract.path, request.head.requestId, error, '任务详情初始化失败')
    } finally {
      if (this.pendingWatch === pending) this.pendingWatch = null
    }
  }

  private async createStableWatch(
    source: L3WorkSessionSource,
    taskId: string
  ): Promise<L1TaskDetailWatchState> {
    while (true) {
      const queuedEvents: L2TaskDetailEvent[] = []
      const holder: { state: L1TaskDetailWatchState | null } = { state: null }
      const observation = await this.taskCenter.watchDetail(source, taskId, (event) => {
        const state = holder.state
        if (!state || this.currentWatch !== state || this.disposed) {
          if (queuedEvents.length < MAX_SYNC_EVENT_QUEUE) queuedEvents.push(event)
          return
        }
        this.handleDetailEvent(state, event)
      })
      const state: L1TaskDetailWatchState = {
        source,
        taskId,
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

  private handleDetailEvent(state: L1TaskDetailWatchState, event: L2TaskDetailEvent): void {
    if (this.currentWatch !== state || this.disposed || !this.connection.isCurrent()) return
    if (state.status === 'syncing') {
      if (state.queuedEvents.length >= MAX_SYNC_EVENT_QUEUE) {
        state.queuedEvents.length = 0
        state.overflowed = true
        return
      }
      state.queuedEvents.push(event)
      return
    }

    this.connection.sendPush(L2TaskCenterSocketContracts.detailEvent, {
      source: state.source,
      taskId: state.taskId,
      event
    })
    if (event.type === 'unavailable') this.releaseCurrentWatch()
  }

  private flushQueuedEvents(state: L1TaskDetailWatchState): void {
    if (this.currentWatch !== state) return
    if (state.overflowed) {
      this.connection.close(1011, '任务详情同步队列溢出')
      return
    }
    for (const event of state.queuedEvents.splice(0)) {
      this.connection.sendPush(L2TaskCenterSocketContracts.detailEvent, {
        source: state.source,
        taskId: state.taskId,
        event
      })
      if (event.type === 'unavailable') {
        this.releaseCurrentWatch()
        return
      }
    }
  }

  private async interrupt(request: L4AppSocketRequest): Promise<void> {
    const contract = L2TaskCenterSocketContracts.interrupt
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '任务打断参数无效')
      return
    }
    try {
      await this.taskCenter.interrupt(input.data.source, input.data.taskId)
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.sendTaskError(contract.path, request.head.requestId, error, '打断任务失败')
    }
  }

  private sendTaskError(path: string, requestId: string, error: unknown, fallback: string): void {
    if (error instanceof L2ChatSourceBindingError) {
      this.connection.sendError(path, requestId, 409, '工作会话来源已变化')
      return
    }
    if (error instanceof L2TaskNotFoundError) {
      this.connection.sendError(path, requestId, 404, '任务不存在')
      return
    }
    if (error instanceof L2TaskNotInterruptibleError) {
      this.connection.sendError(path, requestId, 409, '任务当前不可打断')
      return
    }
    if (error instanceof L2TaskDetailUnsupportedError) {
      this.connection.sendError(path, requestId, 409, '任务不支持该详情')
      return
    }
    if (error instanceof L2TaskMessageNotFoundError) {
      this.connection.sendError(path, requestId, 404, '任务消息不存在')
      return
    }

    console.warn('[Pi Desk][TaskCenterSocket] 任务操作失败', {
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : fallback
    })
    this.connection.sendError(path, requestId, 500, fallback)
  }

  private handleSourceEvent(event: L2WorkSessionChatRuntimeEvent): void {
    if (event.type !== 'source_invalidated') return
    if (this.pendingWatch && sameSource(this.pendingWatch.source, event.source)) {
      this.pendingWatch.invalidated = true
    }
    const current = this.currentWatch
    if (!current || !sameSource(current.source, event.source)) return
    this.connection.sendPush(L2TaskCenterSocketContracts.detailEvent, {
      source: current.source,
      taskId: current.taskId,
      event: { type: 'unavailable' }
    })
    this.releaseCurrentWatch()
  }

  private releaseCurrentWatch(): void {
    const current = this.currentWatch
    this.currentWatch = null
    current?.observation.release()
  }
}
