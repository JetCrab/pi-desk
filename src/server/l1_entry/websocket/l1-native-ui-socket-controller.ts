import 'server-only'

import { L3PiUiSocketContracts } from '@common/l3_modules/plugin-host/l3-plugin-native-ui-contract'
import type { L3WorkSessionSource } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import type { WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import { L2ChatSourceBindingError } from '@server/l2_biz/work-session/l2-work-session-chat-runtime'
import { L4PiUiResponseError } from '@server/l4_foundation/pi/l4-pi-ui-runtime'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L1AppSocketRoute } from './l1-app-socket-route'

function sourceKey(source: L3WorkSessionSource): string {
  return JSON.stringify([source.workId, source.sessionId, source.branchId])
}

export class L1NativeUiSocketController {
  readonly routes: readonly L1AppSocketRoute[]
  private readonly subscriptions = new Map<string, () => void>()
  private readonly releaseSources: () => void
  private disposed = false

  constructor(
    private readonly connection: L4AppSocketConnection,
    private readonly manage: WorkSessionManage
  ) {
    this.releaseSources = manage.subscribeMessageEvents((event) => {
      if (event.type === 'source_invalidated') this.release(sourceKey(event.source))
    })
    this.routes = [
      {
        path: L3PiUiSocketContracts.subscribe.path,
        access: 'ready',
        handle: async (request) => this.subscribe(request)
      },
      {
        path: L3PiUiSocketContracts.unsubscribe.path,
        access: 'ready',
        handle: async (request) => this.unsubscribe(request)
      },
      {
        path: L3PiUiSocketContracts.respond.path,
        access: 'ready',
        handle: async (request) => this.respond(request)
      }
    ]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.releaseSources()
    for (const key of this.subscriptions.keys()) this.release(key)
  }

  private subscribe(request: L4AppSocketRequest): void {
    if (this.disposed || !this.connection.isCurrent()) return
    const contract = L3PiUiSocketContracts.subscribe
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) return this.invalid(request)
    try {
      const { source } = input.data
      const owner = this.manage.getNativeUi(source)
      const key = sourceKey(source)
      this.release(key)
      // 注册、读取快照和回执同步完成；之后的完整状态更新不会越过基线。
      this.subscriptions.set(
        key,
        owner.subscribe((event) => {
          if (!this.disposed && this.connection.isCurrent()) {
            this.connection.sendPush(L3PiUiSocketContracts.event, { source, event })
          }
        })
      )
      this.connection.sendSuccess(contract, request.head.requestId, owner.snapshot())
    } catch (error) {
      this.fail(request, error)
    }
  }

  private unsubscribe(request: L4AppSocketRequest): void {
    if (this.disposed || !this.connection.isCurrent()) return
    const contract = L3PiUiSocketContracts.unsubscribe
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) return this.invalid(request)
    this.release(sourceKey(input.data.source))
    this.connection.sendSuccess(contract, request.head.requestId, {})
  }

  private respond(request: L4AppSocketRequest): void {
    if (this.disposed || !this.connection.isCurrent()) return
    const contract = L3PiUiSocketContracts.respond
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) return this.invalid(request)
    try {
      this.manage.getNativeUi(input.data.source).respond(input.data.response)
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.fail(request, error)
    }
  }

  private release(key: string): void {
    this.subscriptions.get(key)?.()
    this.subscriptions.delete(key)
  }

  private invalid(request: L4AppSocketRequest): void {
    this.connection.sendError(request.head.path, request.head.requestId, 400, '插件交互参数无效')
  }

  private fail(request: L4AppSocketRequest, error: unknown): void {
    const code =
      error instanceof L2ChatSourceBindingError
        ? 409
        : error instanceof L4PiUiResponseError
          ? error.code
          : 500
    const message =
      error instanceof L2ChatSourceBindingError
        ? '工作会话来源已变化'
        : error instanceof Error
          ? error.message
          : '插件交互失败'
    if (code === 500)
      console.error('[Pi Desk][NativeUI] 请求失败', { path: request.head.path, message })
    this.connection.sendError(request.head.path, request.head.requestId, code, message)
  }
}
