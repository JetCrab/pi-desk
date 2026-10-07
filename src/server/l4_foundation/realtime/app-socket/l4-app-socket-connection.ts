import 'server-only'

import { randomUUID } from 'node:crypto'
import type { L4ErrorTranslation } from '@common/l4_foundation/locale/l4-error-translation'
import type {
  L4AppSocketPushContract,
  L4AppSocketRequest,
  L4AppSocketRequestContract
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import {
  L4_APP_SOCKET_REPLACED_CLOSE_CODE,
  L4AppSocketPushSchema,
  L4AppSocketRequestSchema,
  L4AppSocketResponseSchema
} from '@common/l4_foundation/realtime/l4-app-websocket-contract'
import { WebSocket, type RawData } from 'ws'

const MAX_BUFFERED_AMOUNT_BYTES = 32 * 1024 * 1024
const MAX_IN_FLIGHT_REQUESTS = 32
const HEARTBEAT_INTERVAL_MS = 30_000

export interface L4AppSocketCloseInfo {
  code: number
  reason: string
}

export type L4AppSocketRequestHandler = (request: L4AppSocketRequest) => Promise<void>

function decodeTextMessage(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

export class L4AppSocketConnection {
  readonly connectionId = randomUUID()

  private readonly inFlightRequestIds = new Set<string>()
  private readonly closedPromise: Promise<L4AppSocketCloseInfo>
  private resolveClosed!: (info: L4AppSocketCloseInfo) => void
  private requestHandler: L4AppSocketRequestHandler | null = null
  private closeListener: ((info: L4AppSocketCloseInfo) => void) | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private alive = true
  private current = true
  private started = false
  private disposed = false

  constructor(
    readonly clientId: string,
    private readonly socket: WebSocket
  ) {
    this.closedPromise = new Promise<L4AppSocketCloseInfo>((resolve) => {
      this.resolveClosed = resolve
    })
  }

  start(
    requestHandler: L4AppSocketRequestHandler,
    onClose: (info: L4AppSocketCloseInfo) => void
  ): void {
    if (this.started) throw new Error('AppSocket connection has already started')
    this.started = true
    this.requestHandler = requestHandler
    this.closeListener = onClose
    this.heartbeat = setInterval(this.handleHeartbeat, HEARTBEAT_INTERVAL_MS)

    this.socket.on('pong', this.handlePong)
    this.socket.on('message', this.handleMessage)
    this.socket.on('close', this.handleClose)
    this.socket.on('error', this.handleError)
  }

  isCurrent(): boolean {
    return this.current && !this.disposed
  }

  sendSuccess<TInput, TOutput>(
    contract: L4AppSocketRequestContract<TInput, TOutput>,
    requestId: string,
    output: TOutput
  ): void {
    this.sendJson(
      L4AppSocketResponseSchema.parse({
        head: { op: 'resp', path: contract.path, requestId },
        body: { code: 0, msg: '', data: contract.outputSchema.parse(output) }
      })
    )
  }

  sendError(
    path: string,
    requestId: string,
    code: number,
    msg: string,
    i18n?: L4ErrorTranslation
  ): void {
    this.sendJson(
      L4AppSocketResponseSchema.parse({
        head: { op: 'resp', path, requestId },
        body: { code, msg, data: null, ...(i18n ? { i18n } : {}) }
      })
    )
  }

  sendPush<TBody>(contract: L4AppSocketPushContract<TBody>, body: TBody): void {
    this.sendJson(
      L4AppSocketPushSchema.parse({
        head: { op: 'push', path: contract.path },
        body: contract.bodySchema.parse(body)
      })
    )
  }

  supersede(): void {
    if (this.disposed || !this.current) return
    this.current = false
    this.socket.close(L4_APP_SOCKET_REPLACED_CLOSE_CODE, '连接已被替换')
  }

  close(code = 1000, reason = '连接已关闭'): void {
    if (this.disposed) return
    this.current = false
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(code, reason)
      return
    }
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate()
  }

  terminate(): void {
    if (this.disposed) return
    this.current = false
    this.socket.terminate()
  }

  waitForClose(): Promise<L4AppSocketCloseInfo> {
    return this.closedPromise
  }

  private readonly handleHeartbeat = (): void => {
    if (!this.alive) {
      this.terminate()
      return
    }
    this.alive = false
    this.socket.ping()
  }

  private readonly handlePong = (): void => {
    this.alive = true
  }

  private readonly handleMessage = (data: RawData, isBinary: boolean): void => {
    if (!this.current) return
    if (isBinary) {
      this.socket.close(1003, '仅支持文本 JSON 消息')
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(decodeTextMessage(data))
    } catch {
      this.socket.close(1007, 'JSON 格式无效')
      return
    }

    const parsed = L4AppSocketRequestSchema.safeParse(payload)
    if (!parsed.success) {
      this.socket.close(1008, '消息信封或方向无效')
      return
    }

    const requestId = parsed.data.head.requestId
    if (this.inFlightRequestIds.has(requestId)) {
      this.sendError(parsed.data.head.path, requestId, 409, 'requestId 正在处理中', {
        key: 'common:duplicateRequest'
      })
      return
    }
    if (this.inFlightRequestIds.size >= MAX_IN_FLIGHT_REQUESTS) {
      this.sendError(parsed.data.head.path, requestId, 429, '当前连接并发请求过多', {
        key: 'common:tooManyRequests'
      })
      return
    }

    const handler = this.requestHandler
    if (!handler) {
      this.sendError(parsed.data.head.path, requestId, 503, '应用 WebSocket 尚未就绪', {
        key: 'common:socketUnavailable'
      })
      return
    }

    this.inFlightRequestIds.add(requestId)
    void handler(parsed.data)
      .catch((error: unknown) => {
        console.error('[Pi Desk][AppSocketConnection] 请求处理失败', {
          clientId: this.clientId,
          connectionId: this.connectionId,
          path: parsed.data.head.path,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        this.sendError(parsed.data.head.path, requestId, 500, '服务端请求处理失败', {
          key: 'common:serverRequestFailed'
        })
      })
      .finally(() => {
        this.inFlightRequestIds.delete(requestId)
      })
  }

  private readonly handleClose = (code: number, reason: Buffer): void => {
    const info = { code, reason: reason.toString('utf8') }
    const listener = this.closeListener
    this.dispose()
    try {
      listener?.(info)
    } catch (error) {
      console.error('[Pi Desk][AppSocketConnection] 关闭监听器执行失败', {
        clientId: this.clientId,
        connectionId: this.connectionId,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
    } finally {
      this.resolveClosed(info)
    }
  }

  private readonly handleError = (error: Error): void => {
    console.error('[Pi Desk][AppSocketConnection] 连接错误', {
      clientId: this.clientId,
      connectionId: this.connectionId,
      errorName: error.name,
      message: error.message
    })
  }

  private sendJson(payload: unknown): void {
    if (!this.isCurrent() || this.socket.readyState !== WebSocket.OPEN) return
    if (this.socket.bufferedAmount > MAX_BUFFERED_AMOUNT_BYTES) {
      this.terminate()
      return
    }

    try {
      this.socket.send(JSON.stringify(payload))
    } catch {
      this.terminate()
    }
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.current = false
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.inFlightRequestIds.clear()
    this.requestHandler = null
    this.closeListener = null
    this.socket.off('pong', this.handlePong)
    this.socket.off('message', this.handleMessage)
    this.socket.off('close', this.handleClose)
    this.socket.off('error', this.handleError)
  }
}
