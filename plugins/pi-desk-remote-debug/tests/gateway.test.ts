import assert from 'node:assert/strict'
import { createServer, type RequestListener, type Server } from 'node:http'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { startDebugGateway } from '../src/gateway.js'
import { RunLogger } from '../src/log.js'

const root = resolve('temp', 'pi', 'remote-debug-gateway-test', String(process.pid))

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
  const logger = await RunLogger.create(join(root, 'run.log'), 'fixture')
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
