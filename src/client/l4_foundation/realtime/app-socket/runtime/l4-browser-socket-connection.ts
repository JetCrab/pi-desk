'use client'

import { createL4BrowserUuid } from '@client/l4_foundation/lib/l4-browser-uuid'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import type { L4AppSocketRequestContract } from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  L4_APP_WEBSOCKET_ENDPOINT,
  L4_APP_WEBSOCKET_PROTOCOL,
  L4AppSocketPushSchema,
  L4AppSocketRequestSchema,
  L4AppSocketResponseSchema
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

interface PendingRequest {
  readonly path: string
  readonly contract: L4AppSocketRequestContract<unknown, unknown>
  readonly resolve: (data: unknown) => void
  readonly reject: (cause: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

export interface L4BrowserSocketCloseInfo {
  code: number
  reason: string
}

class L4AppSocketTransportError extends Error {
  constructor(
    readonly rawMessage: string,
    key: string,
    params?: Record<string, string | number>
  ) {
    super(
      l4LocalizedErrorMessage({ msg: rawMessage, i18n: { key, ...(params ? { params } : {}) } })
    )
    this.name = 'L4AppSocketTransportError'
  }
}

class L4AppSocketRequestError extends Error {
  constructor(
    readonly code: number,
    readonly rawMessage: string,
    message: string
  ) {
    super(message)
    this.name = 'L4AppSocketRequestError'
  }
}

function socketUrl(clientId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${L4_APP_WEBSOCKET_ENDPOINT}?clientId=${encodeURIComponent(clientId)}`
}

export class L4BrowserSocketConnection {
  private readonly socket: WebSocket
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly closedPromise: Promise<L4BrowserSocketCloseInfo>
  private resolveClosed!: (info: L4BrowserSocketCloseInfo) => void
  private opened = false
  private disposed = false
  private removeAbortListener: (() => void) | null = null

  constructor(
    clientId: string,
    private readonly onPush: (contractPath: string, body: unknown) => void
  ) {
    this.socket = new WebSocket(socketUrl(clientId), L4_APP_WEBSOCKET_PROTOCOL)
    this.closedPromise = new Promise<L4BrowserSocketCloseInfo>((resolve) => {
      this.resolveClosed = resolve
    })
    this.socket.addEventListener('message', this.handleMessage)
    this.socket.addEventListener('close', this.handleClose, { once: true })
  }

  open(signal: AbortSignal): Promise<void> {
    if (this.opened && this.socket.readyState === WebSocket.OPEN) return Promise.resolve()
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

    return new Promise<void>((resolve, reject) => {
      const cleanupOpeningListeners = (): void => {
        this.socket.removeEventListener('open', handleOpen)
        this.socket.removeEventListener('error', handleOpeningError)
      }
      const handleAbort = (): void => this.close(1000, '页面已卸载')
      const handleOpen = (): void => {
        cleanupOpeningListeners()
        this.removeAbortListener?.()
        this.removeAbortListener = null
        this.opened = true
        resolve()
      }
      const handleOpeningError = (): void => {
        cleanupOpeningListeners()
        this.close(1000, 'WebSocket 连接失败')
        reject(new L4AppSocketTransportError('WebSocket 连接失败', 'common:socketConnectFailed'))
      }

      signal.addEventListener('abort', handleAbort, { once: true })
      this.removeAbortListener = () => signal.removeEventListener('abort', handleAbort)
      this.socket.addEventListener('open', handleOpen, { once: true })
      this.socket.addEventListener('error', handleOpeningError, { once: true })
      void this.closedPromise.then(() => {
        cleanupOpeningListeners()
        if (!this.opened)
          reject(new L4AppSocketTransportError('WebSocket 连接已断开', 'common:socketDisconnected'))
      })
    })
  }

  isOpen(): boolean {
    return !this.disposed && this.socket.readyState === WebSocket.OPEN
  }

  request<TInput, TOutput>(
    contract: L4AppSocketRequestContract<TInput, TOutput>,
    input: TInput
  ): Promise<TOutput> {
    if (!this.isOpen())
      return Promise.reject(
        new L4AppSocketTransportError('WebSocket 尚未连接', 'common:socketNotConnected')
      )

    const requestId = createL4BrowserUuid()
    const request = L4AppSocketRequestSchema.parse({
      head: { op: 'req', path: contract.path, requestId },
      body: contract.inputSchema.parse(input)
    })

    return new Promise<TOutput>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(
          new L4AppSocketTransportError(
            `WebSocket 请求超时：${contract.path}`,
            'common:socketRequestTimeout',
            { path: contract.path }
          )
        )
      }, contract.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(requestId, {
        path: contract.path,
        contract: contract as L4AppSocketRequestContract<unknown, unknown>,
        resolve: (data) => resolve(data as TOutput),
        reject,
        timeout
      })

      try {
        this.socket.send(JSON.stringify(request))
      } catch (error) {
        this.pendingRequests.delete(requestId)
        clearTimeout(timeout)
        reject(
          error instanceof Error
            ? error
            : new L4AppSocketTransportError('WebSocket 请求发送失败', 'common:socketSendFailed')
        )
      }
    })
  }

  waitForClose(): Promise<L4BrowserSocketCloseInfo> {
    return this.closedPromise
  }

  close(code = 1000, reason = '客户端关闭连接'): void {
    if (this.disposed || this.socket.readyState === WebSocket.CLOSED) return
    try {
      this.socket.close(code, reason)
    } catch {
      // 浏览器会继续触发 close/error，统一由连接生命周期清理。
    }
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (typeof event.data !== 'string') {
      this.close(1003, '仅支持文本 JSON 消息')
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(event.data)
    } catch {
      this.close(1007, 'JSON 格式无效')
      return
    }

    const response = L4AppSocketResponseSchema.safeParse(payload)
    if (response.success) {
      const requestId = response.data.head.requestId
      const pending = this.pendingRequests.get(requestId)
      if (!pending) return

      this.pendingRequests.delete(requestId)
      clearTimeout(pending.timeout)
      if (response.data.head.path !== pending.path) {
        pending.reject(
          new L4AppSocketTransportError(
            'WebSocket 响应 path 与请求不一致',
            'common:socketResponseMismatch'
          )
        )
        this.close(1008, '响应 path 与 requestId 不匹配')
        return
      }

      if (response.data.body.code !== 0) {
        pending.reject(
          new L4AppSocketRequestError(
            response.data.body.code,
            response.data.body.msg,
            l4LocalizedErrorMessage(response.data.body)
          )
        )
        return
      }

      const output = pending.contract.outputSchema.safeParse(response.data.body.data)
      if (!output.success) {
        pending.reject(
          new L4AppSocketTransportError('WebSocket 响应数据无效', 'common:socketResponseInvalid')
        )
        this.close(1008, '服务端响应数据无效')
        return
      }
      pending.resolve(output.data)
      return
    }

    const push = L4AppSocketPushSchema.safeParse(payload)
    if (!push.success) {
      this.close(1008, '服务端消息信封无效')
      return
    }

    try {
      this.onPush(push.data.head.path, push.data.body)
    } catch {
      this.close(1008, '服务端推送数据无效')
    }
  }

  private readonly handleClose = (event: CloseEvent): void => {
    const info = { code: event.code, reason: event.reason }
    this.dispose()
    this.resolveClosed(info)
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeAbortListener?.()
    this.removeAbortListener = null
    this.socket.removeEventListener('message', this.handleMessage)
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(
        new L4AppSocketTransportError('WebSocket 连接已断开', 'common:socketDisconnected')
      )
    }
    this.pendingRequests.clear()
  }
}
