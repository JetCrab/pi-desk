import assert from 'node:assert/strict'
import { createServer, request as requestHttp, type RequestListener, type Server } from 'node:http'
import { once } from 'node:events'
import { readFile, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { startDebugGateway } from '../src/gateway.js'
import { RunLogger } from '../src/log.js'

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'temp/run/remote-debug-gateway',
  `request-logs-${process.pid}`
)

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('单入口 Gateway 按路径转发 HTTP 和 WebSocket', async () => {
  const front = await listen((request, response) => {
    response.end(`front:${request.url}`)
  })
  const api = await listen((request, response) => {
    response.end(`api:${request.url}`)
  })
  const webSockets = new WebSocketServer({ server: api.server })
  webSockets.on('connection', (socket, request) => {
    socket.on('message', (message) => socket.send(`${request.url}:${message.toString()}`))
  })
  const logPath = join(root, 'forwarding', 'run.log')
  const logger = await RunLogger.create(logPath, 'fixture')
  const gateway = await startDebugGateway({
    entryPort: front.port,
    routes: [
      { path: '/api', targetPort: api.port },
      { path: '/ws', targetPort: api.port }
    ],
    logger
  })

  try {
    assert.equal(
      await fetch(`http://127.0.0.1:${gateway.port}/page`).then((res) => res.text()),
      'front:/page'
    )
    assert.equal(
      await fetch(`http://127.0.0.1:${gateway.port}/api/users?q=1`).then((res) => res.text()),
      'api:/api/users?q=1'
    )

    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`)
    await once(socket, 'open')
    socket.send('ping')
    const [message] = await once(socket, 'message')
    assert.equal(message.toString(), '/ws:ping')
    socket.close()
    await once(socket, 'close')
  } finally {
    await gateway.close()
    await logger.close()
    webSockets.close()
    await closeServer(api.server)
    await closeServer(front.server)
  }

  assert.equal(await canConnect(gateway.port), false)
  const log = await readFile(logPath, 'utf8')
  assert.match(log, new RegExp(`GET /page -> 127\\.0\\.0\\.1:${front.port} 开始`))
  assert.match(
    log,
    new RegExp(
      `GET /api/users\\?q=1 -> 127\\.0\\.0\\.1:${api.port} 完成 status=200 durationMs=\\d+`
    )
  )
  assert.match(log, /GET \/ws -> 127\.0\.0\.1:\d+ 升级发起/)
  assert.match(log, /GET \/ws -> 127\.0\.0\.1:\d+ 上游 TCP 已接通/)
  assert.match(log, /GET \/ws -> 127\.0\.0\.1:\d+ 已关闭 durationMs=\d+/)
  assert.doesNotMatch(log, /握手成功|ping/)
})

test('上游不可达返回502并记录HTTP与WebSocket的目标上下文', async () => {
  const unavailable = await listen((_request, response) => response.end())
  await closeServer(unavailable.server)
  const logPath = join(root, 'unreachable', 'run.log')
  const logger = await RunLogger.create(logPath, 'fixture')
  const gateway = await startDebugGateway({
    entryPort: unavailable.port,
    routes: [],
    logger
  })
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/unavailable`, { method: 'POST' })
    assert.equal(response.status, 502)
    await response.text()
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/socket-unavailable`)
    const closed = new Promise<void>((resolveClose) => socket.once('close', () => resolveClose()))
    await assert.rejects(once(socket, 'open'), /502/)
    await closed
  } finally {
    await gateway.close()
    await logger.close()
  }
  const log = await readFile(logPath, 'utf8')
  assert.match(
    log,
    new RegExp(`HTTP POST /unavailable -> 127\\.0\\.0\\.1:${unavailable.port}: .*ECONNREFUSED`)
  )
  assert.match(log, /POST \/unavailable .* 完成 status=502 durationMs=\d+/)
  assert.match(log, /WebSocket GET \/socket-unavailable .*ECONNREFUSED/)
  assert.match(log, /GET \/socket-unavailable .* 已关闭 durationMs=\d+/)
  assert.doesNotMatch(log, /上游 TCP 已接通/)
})

test('请求上传中断与响应提前关闭明确记录为未完成', async () => {
  let resolveResponseClosed!: () => void
  const responseClosed = new Promise<void>((resolveClosed) => {
    resolveResponseClosed = resolveClosed
  })
  const front = await listen((request, response) => {
    if (request.url === '/partial-response') {
      response.once('close', resolveResponseClosed)
      response.write('partial')
    }
  })
  const logPath = join(root, 'aborted', 'run.log')
  const logger = await RunLogger.create(logPath, 'fixture')
  const gateway = await startDebugGateway({ entryPort: front.port, routes: [], logger })
  try {
    const response = await new Promise<import('node:http').IncomingMessage>(
      (resolveResponse, reject) => {
        requestHttp(`http://127.0.0.1:${gateway.port}/partial-response`, resolveResponse)
          .once('error', reject)
          .end()
      }
    )
    await once(response, 'data')
    response.destroy()
    await responseClosed

    const received = once(front.server, 'request')
    const request = requestHttp(`http://127.0.0.1:${gateway.port}/partial-upload`, {
      method: 'POST',
      headers: { 'Content-Length': '100' }
    })
    request.on('error', () => undefined)
    request.write('partial')
    const [upstreamRequest] = await received
    const aborted = once(upstreamRequest, 'aborted')
    request.destroy()
    await aborted
  } finally {
    await gateway.close()
    await logger.close()
    await closeServer(front.server)
  }
  const log = await readFile(logPath, 'utf8')
  assert.match(log, /GET \/partial-response .* 未完成：响应提前关闭 status=200 durationMs=\d+/)
  assert.match(log, /POST \/partial-upload .* 未完成：请求提前断开 status=未发送 durationMs=\d+/)
  assert.doesNotMatch(log, /完成 status=/)
})

async function listen(listener: RequestListener): Promise<{ server: Server; port: number }> {
  const server = createServer(listener)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { server, port: address.port }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolveConnect(true)
    })
    socket.once('error', () => resolveConnect(false))
  })
}
