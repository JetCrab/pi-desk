import 'server-only'

import {
  L2ChatSocketContracts,
  type L2ChatSourceEvent
} from '@common/l2_biz/chat/l2-chat-websocket-contract'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import type { L4AppSocketRequest } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  L2ChatLifecycleBlockedError,
  L2ChatSourceBindingError,
  type L2WorkSessionChatRuntimeEvent
} from '@server/l2_biz/work-session/l2-work-session-chat-runtime'
import { L4_PI_CHAT_MAX_APPLICATION_JSON_BYTES } from '@server/l4_foundation/pi/l4-pi-chat-input'
import type { WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import type { L4AppSocketConnection } from '@server/l4_foundation/realtime/app-socket/l4-app-socket'
import type { L1AppSocketRoute } from './l1-app-socket-route'

const MAX_SNAPSHOT_EVENT_QUEUE = 128

interface L1ChatQueuedSourceEvent {
  version: number
  event: L2ChatSourceEvent
}

interface L1ChatConnectionSubscription {
  source: L2ChatSource
  status: 'syncing' | 'ready'
  queuedEvents: L1ChatQueuedSourceEvent[]
  overflowed: boolean
}

function sameSource(left: L2ChatSource, right: L2ChatSource): boolean {
  return (
    left.workId === right.workId &&
    left.sessionId === right.sessionId &&
    left.branchId === right.branchId
  )
}

export class L1ChatSocketController {
  readonly routes: readonly L1AppSocketRoute[]

  private readonly subscriptionsByWorkId = new Map<string, L1ChatConnectionSubscription>()
  private readonly unsubscribeMessages: () => void
  private operationTail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly connection: L4AppSocketConnection,
    private readonly manage: WorkSessionManage
  ) {
    this.routes = Object.freeze([
      {
        path: L2ChatSocketContracts.subscribe.path,
        access: 'ready',
        handle: (request) => this.enqueueSubscribe(request)
      },
      {
        path: L2ChatSocketContracts.send.path,
        access: 'ready',
        handle: (request) => this.send(request)
      },
      {
        path: L2ChatSocketContracts.interrupt.path,
        access: 'ready',
        handle: (request) => this.interrupt(request)
      },
      {
        path: L2ChatSocketContracts.compact.path,
        access: 'ready',
        handle: (request) => this.compact(request)
      },
      {
        path: L2ChatSocketContracts.reload.path,
        access: 'ready',
        handle: (request) => this.reload(request)
      },
      {
        path: L2ChatSocketContracts.presentationSet.path,
        access: 'ready',
        handle: (request) => this.setPresentation(request)
      },
      {
        path: L2ChatSocketContracts.queueRestore.path,
        access: 'ready',
        handle: (request) => this.restoreQueue(request)
      },
      {
        path: L2ChatSocketContracts.modelSet.path,
        access: 'ready',
        handle: (request) => this.setModel(request)
      },
      {
        path: L2ChatSocketContracts.capabilityModeSet.path,
        access: 'ready',
        handle: (request) => this.setCapabilityMode(request)
      }
    ])
    this.unsubscribeMessages = this.manage.subscribeMessageEvents((event) =>
      this.handleRuntimeEvent(event)
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeMessages()
    this.subscriptionsByWorkId.clear()
  }

  private enqueueSubscribe(request: L4AppSocketRequest): Promise<void> {
    const operation = (): Promise<void> => this.subscribe(request)
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async subscribe(request: L4AppSocketRequest): Promise<void> {
    const contract = L2ChatSocketContracts.subscribe
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '聊天订阅参数无效', {
        key: 'errors:chatSubscribeInvalid'
      })
      return
    }

    const previous = new Map<string, L1ChatConnectionSubscription | undefined>()
    for (const subscription of input.data.subscriptions) {
      previous.set(
        subscription.source.workId,
        this.subscriptionsByWorkId.get(subscription.source.workId)
      )
      this.subscriptionsByWorkId.set(subscription.source.workId, {
        source: subscription.source,
        status: 'syncing',
        queuedEvents: [],
        overflowed: false
      })
    }

    let syncs: Awaited<ReturnType<WorkSessionManage['prepareChatSourceSyncs']>>
    try {
      syncs = await this.manage.prepareChatSourceSyncs(input.data.subscriptions)
    } catch (error) {
      this.restoreSubscriptions(previous)
      const bindingError = error instanceof L2ChatSourceBindingError
      if (!bindingError) {
        console.error('[Pi Desk][ChatSocket] 聊天 Source 订阅初始化失败', {
          clientId: this.connection.clientId,
          connectionId: this.connection.connectionId,
          requestId: request.head.requestId,
          sources: input.data.subscriptions.map((subscription) => subscription.source),
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined
        })
      }
      const failureMessage = error instanceof Error ? error.message.slice(0, 32_000) : null
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        bindingError ? 409 : 500,
        bindingError ? '聊天订阅绑定已过期' : failureMessage || '聊天订阅初始化失败',
        bindingError
          ? { key: 'errors:chatSubscribeExpired' }
          : failureMessage
            ? undefined
            : { key: 'errors:chatSubscribeFailed' }
      )
      return
    }

    if (this.disposed || !this.connection.isCurrent()) return
    this.connection.sendSuccess(contract, request.head.requestId, {})

    try {
      for (const sync of syncs) {
        await this.finishSync(sync.source, sync.event, sync.watermark)
      }
      console.info('[Pi Desk][ChatSocket] 聊天 Source 订阅完成', {
        clientId: this.connection.clientId,
        connectionId: this.connection.connectionId,
        sourceCount: syncs.length
      })
    } catch (error) {
      console.error('[Pi Desk][ChatSocket] 聊天 Source 同步失败', {
        clientId: this.connection.clientId,
        connectionId: this.connection.connectionId,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
      this.connection.close(1011, '聊天消息同步失败')
    }
  }

  private async send(request: L4AppSocketRequest): Promise<void> {
    const contract = L2ChatSocketContracts.send
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '聊天发送参数无效', {
        key: 'errors:chatSendInvalid'
      })
      return
    }
    if (
      Buffer.byteLength(JSON.stringify({ head: request.head, body: input.data }), 'utf8') >
      L4_PI_CHAT_MAX_APPLICATION_JSON_BYTES
    ) {
      this.connection.sendError(
        contract.path,
        request.head.requestId,
        413,
        '聊天发送内容超过 31MB',
        { key: 'errors:chatSendTooLarge' }
      )
      return
    }

    try {
      console.info('[Pi Desk][ChatSocket] 聊天发送开始', {
        clientId: this.connection.clientId,
        requestId: request.head.requestId,
        workId: input.data.source.workId,
        sessionId: input.data.source.sessionId,
        branchId: input.data.source.branchId,
        mode: input.data.mode
      })
      const output = await this.manage.sendChat(input.data)
      console.info('[Pi Desk][ChatSocket] 聊天发送已接纳', {
        clientId: this.connection.clientId,
        requestId: request.head.requestId,
        workId: input.data.source.workId,
        tempId: output.tempId
      })
      this.connection.sendSuccess(contract, request.head.requestId, output)
    } catch (error) {
      this.sendCommandError(contract.path, request.head.requestId, error, '发送聊天消息失败')
    }
  }

  private async interrupt(request: L4AppSocketRequest): Promise<void> {
    const contract = L2ChatSocketContracts.interrupt
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '聊天打断参数无效', {
        key: 'errors:chatInterruptInvalid'
      })
      return
    }

    try {
      await this.manage.interruptChat(input.data.source)
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.sendCommandError(contract.path, request.head.requestId, error, '打断当前响应失败')
    }
  }

  private async compact(request: L4AppSocketRequest): Promise<void> {
    const contract = L2ChatSocketContracts.compact
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '上下文压缩参数无效', {
        key: 'errors:chatCompactInvalid'
      })
      return
    }

    try {
      console.info('[Pi Desk][ChatSocket] 手动上下文压缩开始', {
        clientId: this.connection.clientId,
        requestId: request.head.requestId,
        workId: input.data.source.workId,
        sessionId: input.data.source.sessionId,
        branchId: input.data.source.branchId
      })
      await this.manage.compactChat(input.data.source)
      console.info('[Pi Desk][ChatSocket] 手动上下文压缩完成', {
        clientId: this.connection.clientId,
        requestId: request.head.requestId,
        workId: input.data.source.workId
      })
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.sendCommandError(contract.path, request.head.requestId, error, '压缩上下文失败')
    }
  }

  private async reload(request: L4AppSocketRequest): Promise<void> {
    const contract = L2ChatSocketContracts.reload
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, 'Pi 配置重载参数无效', {
        key: 'errors:chatReloadInvalid'
      })
      return
    }

    try {
      console.info('[Pi Desk][ChatSocket] Pi 配置重载开始', {
        clientId: this.connection.clientId,
        requestId: request.head.requestId,
        workId: input.data.source.workId,
        sessionId: input.data.source.sessionId,
        branchId: input.data.source.branchId
      })
      await this.manage.reloadChat(input.data.source, input.data.mode)
      console.info('[Pi Desk][ChatSocket] Pi 配置重载完成', {
        clientId: this.connection.clientId,
        requestId: request.head.requestId,
        workId: input.data.source.workId
      })
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.sendCommandError(contract.path, request.head.requestId, error, '重载 Pi 配置失败')
    }
  }

  private async setPresentation(request: L4AppSocketRequest): Promise<void> {
    const contract = L2ChatSocketContracts.presentationSet
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '消息展示模式参数无效')
      return
    }
    try {
      await this.manage.setChatPresentation(input.data.source, input.data.mode)
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.sendCommandError(contract.path, request.head.requestId, error, '切换消息展示失败')
    }
  }

  private async restoreQueue(request: L4AppSocketRequest): Promise<void> {
    const contract = L2ChatSocketContracts.queueRestore
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '恢复队列参数无效', {
        key: 'errors:chatRestoreInvalid'
      })
      return
    }

    try {
      const output = await this.manage.restoreChatQueue(input.data.source)
      const responseBytes = Buffer.byteLength(
        JSON.stringify({
          head: { op: 'resp', path: contract.path, requestId: request.head.requestId },
          body: { code: 0, msg: '', data: output }
        }),
        'utf8'
      )
      if (responseBytes > L4_PI_CHAT_MAX_APPLICATION_JSON_BYTES) {
        console.error('[Pi Desk][ChatSocket] 队列恢复响应突破应用上限', {
          workId: input.data.source.workId,
          responseBytes
        })
        this.connection.sendError(
          contract.path,
          request.head.requestId,
          500,
          '恢复内容超过传输上限',
          { key: 'errors:chatRestoreTooLarge' }
        )
        return
      }
      this.connection.sendSuccess(contract, request.head.requestId, output)
    } catch (error) {
      this.sendCommandError(contract.path, request.head.requestId, error, '恢复全部排队消息失败')
    }
  }

  private async setModel(request: L4AppSocketRequest): Promise<void> {
    const contract = L2ChatSocketContracts.modelSet
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '模型设置参数无效', {
        key: 'errors:chatModelInvalid'
      })
      return
    }

    try {
      await this.manage.setChatModel(input.data)
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.sendCommandError(contract.path, request.head.requestId, error, '设置模型失败')
    }
  }

  private async setCapabilityMode(request: L4AppSocketRequest): Promise<void> {
    const contract = L2ChatSocketContracts.capabilityModeSet
    const input = contract.inputSchema.safeParse(request.body)
    if (!input.success) {
      this.connection.sendError(contract.path, request.head.requestId, 400, '能力模式参数无效', {
        key: 'errors:chatModeInvalid'
      })
      return
    }
    try {
      await this.manage.setChatCapabilityMode(input.data)
      this.connection.sendSuccess(contract, request.head.requestId, {})
    } catch (error) {
      this.sendCommandError(contract.path, request.head.requestId, error, '切换能力模式失败')
    }
  }

  private sendCommandError(
    path: string,
    requestId: string,
    error: unknown,
    fallback: string
  ): void {
    if (
      error instanceof L2ChatSourceBindingError ||
      (error instanceof Error && error.name === 'L2ChatSourceBindingError')
    ) {
      this.connection.sendError(path, requestId, 409, '聊天 Source 已过期', {
        key: 'errors:sourceExpired'
      })
      return
    }
    if (
      error instanceof L2ChatLifecycleBlockedError ||
      (error instanceof Error && error.name === 'L2ChatLifecycleBlockedError')
    ) {
      this.connection.sendError(path, requestId, 409, '工作会话正在替换或切换分支', {
        key: 'errors:chatSourceBusy'
      })
      return
    }

    const message = error instanceof Error && error.message ? error.message : fallback
    console.warn('[Pi Desk][ChatSocket] 聊天命令执行失败', {
      path,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      message
    })
    this.connection.sendError(path, requestId, 400, message)
  }

  private async finishSync(
    source: L2ChatSource,
    initialEvent: L2ChatSourceEvent,
    initialWatermark: number
  ): Promise<void> {
    let event = initialEvent
    let watermark = initialWatermark

    while (true) {
      const subscription = this.subscriptionsByWorkId.get(source.workId)
      if (!subscription || !sameSource(subscription.source, source)) return

      if (subscription.overflowed) {
        subscription.overflowed = false
        subscription.queuedEvents = []
        const [rebuilt] = await this.manage.prepareChatSourceSyncs([{ source, cursor: null }])
        if (!rebuilt) return
        event = rebuilt.event
        watermark = rebuilt.watermark
        continue
      }

      this.connection.sendPush(L2ChatSocketContracts.sourceEvent, { source, event })

      while (true) {
        const batch = subscription.queuedEvents.filter((queued) => queued.version > watermark)
        subscription.queuedEvents = []
        for (const queued of batch) {
          this.connection.sendPush(L2ChatSocketContracts.sourceEvent, {
            source,
            event: queued.event
          })
          watermark = queued.version
        }

        if (subscription.overflowed) break
        if (subscription.queuedEvents.length > 0) continue
        subscription.status = 'ready'
        return
      }
    }
  }

  private handleRuntimeEvent(event: L2WorkSessionChatRuntimeEvent): void {
    if (this.disposed || !this.connection.isCurrent()) return
    const subscription = this.subscriptionsByWorkId.get(event.source.workId)
    if (!subscription || !sameSource(subscription.source, event.source)) return

    if (event.type === 'source_invalidated') {
      this.subscriptionsByWorkId.delete(event.source.workId)
      return
    }

    if (subscription.status === 'syncing') {
      if (subscription.overflowed) return
      if (subscription.queuedEvents.length >= MAX_SNAPSHOT_EVENT_QUEUE) {
        subscription.queuedEvents = []
        subscription.overflowed = true
        return
      }
      subscription.queuedEvents.push({ version: event.version, event: event.event })
      return
    }

    this.connection.sendPush(L2ChatSocketContracts.sourceEvent, {
      source: event.source,
      event: event.event
    })
  }

  private restoreSubscriptions(
    previous: ReadonlyMap<string, L1ChatConnectionSubscription | undefined>
  ): void {
    for (const [workId, subscription] of previous) {
      if (subscription) this.subscriptionsByWorkId.set(workId, subscription)
      else this.subscriptionsByWorkId.delete(workId)
    }
  }
}
