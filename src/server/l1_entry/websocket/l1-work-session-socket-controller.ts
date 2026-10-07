import 'server-only'

import { L2WorkSessionSocketContracts } from '@common/l2_biz/work-session/l2-work-session-realtime-contract'
import { L3AppRuntimeSocketContracts } from '@common/l3_modules/app-runtime/l3-app-runtime-websocket-contract'
import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  WorkSessionNotFoundError,
  type WorkSessionManage
} from '@server/l2_biz/work-session/l2-work-session-manage'
import type { L2AppRuntime } from '@server/l2_biz/app-runtime/l2-app-runtime'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L1AppSocketRoute } from './l1-app-socket-route'

type WorkSessionConnectionStatus = 'new' | 'initializing' | 'ready'

export class L1WorkSessionSocketController {
  readonly routes: readonly L1AppSocketRoute[]

  private status: WorkSessionConnectionStatus = 'new'
  private dirty = false
  private disposed = false
  private unsubscribeWorkSessions: (() => void) | null = null
  private unsubscribeAppRuntime: (() => void) | null = null

  constructor(
    private readonly connection: L4AppSocketConnection,
    private readonly manage: WorkSessionManage,
    private readonly appRuntime: L2AppRuntime
  ) {
    this.routes = Object.freeze([
      {
        path: L2WorkSessionSocketContracts.list.path,
        access: 'bootstrap',
        handle: (request) => this.initialize(request)
      },
      {
        path: L2WorkSessionSocketContracts.acknowledgeCompleted.path,
        access: 'ready',
        handle: (request) => this.acknowledgeCompleted(request)
      }
    ])
  }

  isReady(): boolean {
    return this.status === 'ready' && !this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.status = 'new'
    this.unsubscribeWorkSessions?.()
    this.unsubscribeWorkSessions = null
    this.unsubscribeAppRuntime?.()
    this.unsubscribeAppRuntime = null
  }

  private async initialize(request: L4AppSocketRequest): Promise<void> {
    const contract = L2WorkSessionSocketContracts.list
    if (this.status === 'initializing') {
      this.connection.sendError(contract.path, request.head.requestId, 409, '工作会话正在初始化', {
        key: 'errors:sessionsInitializing'
      })
      return
    }

    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        400,
        '工作会话初始化参数无效',
        { key: 'errors:sessionsInitializeInvalid' }
      )
      return
    }

    this.status = 'initializing'
    this.dirty = false
    this.unsubscribeWorkSessions?.()
    this.unsubscribeWorkSessions = this.manage.subscribeUpdates((update) => {
      if (this.disposed || !this.connection.isCurrent()) return
      if (this.status === 'initializing') {
        this.dirty = true
        return
      }
      if (this.status === 'ready') {
        this.connection.sendPush(L2WorkSessionSocketContracts.update, update)
      }
    })
    this.unsubscribeAppRuntime?.()
    this.unsubscribeAppRuntime = this.appRuntime.subscribe((event) => {
      if (this.disposed || !this.connection.isCurrent()) return
      if (this.status === 'initializing') {
        this.dirty = true
        return
      }
      if (this.status === 'ready') {
        this.connection.sendPush(L3AppRuntimeSocketContracts.update, event)
      }
    })

    try {
      let workSessionSnapshot
      let appRuntimeSnapshot
      do {
        this.dirty = false
        workSessionSnapshot = await this.manage.listWorkSessions()
        appRuntimeSnapshot = this.appRuntime.readSnapshot()
        if (this.disposed || !this.connection.isCurrent()) return
      } while (this.dirty)

      const snapshot = {
        ...workSessionSnapshot,
        appRuntime: appRuntimeSnapshot
      }
      // ready 与响应发送保持在同一个同步步骤，避免初始化后漏掉 update。
      this.status = 'ready'
      this.connection.sendSuccess(contract, request.head.requestId, snapshot)
      console.info('[Pi Desk][WorkSessionSocket] 工作会话初始化完成', {
        clientId: this.connection.clientId,
        connectionId: this.connection.connectionId,
        workSessionCount: snapshot.workSessions.length,
        notificationCount: snapshot.appRuntime.notifications.length,
        pluginStateCount: Object.keys(snapshot.appRuntime.plugins).length
      })
    } catch (error) {
      this.status = 'new'
      this.unsubscribeWorkSessions?.()
      this.unsubscribeWorkSessions = null
      this.unsubscribeAppRuntime?.()
      this.unsubscribeAppRuntime = null
      console.error('[Pi Desk][WorkSessionSocket] 工作会话初始化失败', {
        clientId: this.connection.clientId,
        connectionId: this.connection.connectionId,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
      this.connection.sendError(contract.path, request.head.requestId, 500, '工作会话初始化失败', {
        key: 'errors:sessionsInitializeFailed'
      })
    }
  }

  private async acknowledgeCompleted(request: L4AppSocketRequest): Promise<void> {
    const contract = L2WorkSessionSocketContracts.acknowledgeCompleted
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        400,
        '工作会话完成确认参数无效',
        { key: 'errors:completionAckInvalid' }
      )
      return
    }

    try {
      await this.manage.acknowledgeCompleted(input.data.workId)
      this.connection.sendSuccess(contract, request.head.requestId, { workId: input.data.workId })
    } catch (error) {
      const notFound = error instanceof WorkSessionNotFoundError
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        notFound ? 404 : 500,
        notFound ? '工作会话不存在' : '确认工作会话完成状态失败',
        { key: notFound ? 'errors:sessionMissing' : 'errors:completionAckFailed' }
      )
    }
  }
}
