import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RemoteDebugRoute } from './config.js'
import type { RunLogger } from './log.js'

export interface DebugGatewayHandle {
  readonly port: number
  close(): Promise<void>
}

export async function startDebugGateway(input: {
  entryPort: number
  routes: readonly RemoteDebugRoute[]
  logger: RunLogger
}): Promise<DebugGatewayHandle> {
  const sockets = new Set<Duplex>()
  const server = createServer((request, response) => {
    const targetPort = resolveGatewayTargetPort(request.url, input.entryPort, input.routes)
    proxyHttpRequest(request, response, targetPort, input.logger)
  })
  server.on('upgrade', (request, socket, head) => {
    const targetPort = resolveGatewayTargetPort(request.url, input.entryPort, input.routes)
    proxyWebSocket(request, socket, head, targetPort, sockets, input.logger)
  })
  server.on('connection', (socket) => trackSocket(sockets, socket))
  server.on('clientError', (error, socket) => {
    input.logger.line('gateway:error', error.message)
    socket.destroy()
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Debug Gateway 未返回监听端口')
  }
  input.logger.line('gateway', `监听 127.0.0.1:${address.port}`)
  for (const route of input.routes) {
    input.logger.line('gateway', `${route.path} -> 127.0.0.1:${route.targetPort}`)
  }
  input.logger.line('gateway', `其他路径 -> 127.0.0.1:${input.entryPort}`)

  let closePromise: Promise<void> | null = null
  return {
    port: address.port,
    close(): Promise<void> {
      if (closePromise) return closePromise
      closePromise = new Promise<void>((resolveClose) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => {
          input.logger.line('gateway', '已停止')
          resolveClose()
        })
      })
      return closePromise
    }
  }
}

export function resolveGatewayTargetPort(
  rawUrl: string | undefined,
  entryPort: number,
  routes: readonly RemoteDebugRoute[]
): number {
  const path = new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname
  return routes.find((route) => matchesRoute(path, route.path))?.targetPort ?? entryPort
}

function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  targetPort: number,
  logger: RunLogger
): void {
  const upstream = requestHttp({
    hostname: '127.0.0.1',
    port: targetPort,
    method: request.method,
    path: request.url,
    headers: forwardedHeaders(request, targetPort)
  })
  upstream.once('response', (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      upstreamResponse.headers
    )
    upstreamResponse.pipe(response)
  })
  upstream.once('error', (error) => {
    handleHttpProxyError(error, request, response, logger)
  })
  request.once('aborted', () => upstream.destroy())
  response.once('close', () => {
    if (!response.writableEnded) upstream.destroy()
  })
  request.pipe(upstream)
}

function proxyWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetPort: number,
  sockets: Set<Duplex>,
  logger: RunLogger
): void {
  socket.pause()
  const upstream = connect({ host: '127.0.0.1', port: targetPort })
  trackSocket(sockets, upstream)
  upstream.once('connect', () => {
    upstream.write(serializeUpgradeRequest(request, targetPort))
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
    socket.resume()
  })
  upstream.once('error', (error) => {
    logger.line('gateway:error', `${request.url ?? '/'}: ${error.message}`)
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    }
  })
  socket.once('error', () => upstream.destroy())
  socket.once('close', () => upstream.destroy())
  upstream.once('close', () => {
    if (!upstream.readableEnded) socket.destroy()
  })
}

function serializeUpgradeRequest(request: IncomingMessage, targetPort: number): string {
  const headers = forwardedHeaders(request, targetPort)
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`]
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else {
      lines.push(`${name}: ${value}`)
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

function forwardedHeaders(request: IncomingMessage, targetPort: number): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {
    ...request.headers,
    host: `127.0.0.1:${targetPort}`,
    'x-forwarded-host': request.headers.host ?? '',
    'x-forwarded-proto': 'http'
  }
  const remoteAddress = request.socket.remoteAddress
  if (remoteAddress) {
    const existing = request.headers['x-forwarded-for']
    headers['x-forwarded-for'] = existing ? `${existing}, ${remoteAddress}` : remoteAddress
  }
  return headers
}

function matchesRoute(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function handleHttpProxyError(
  error: Error,
  request: IncomingMessage,
  response: ServerResponse,
  logger: RunLogger
): void {
  logger.line('gateway:error', `${request.url ?? '/'}: ${error.message}`)
  if (response.headersSent) {
    response.destroy(error)
    return
  }
  response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('Remote Debug Gateway: 本机目标暂不可用')
}

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
}
