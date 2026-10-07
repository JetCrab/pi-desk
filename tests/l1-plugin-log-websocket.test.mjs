import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { reservePort, waitForHttp } from './l4-browser-cdp-runtime.mjs'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = join(projectRoot, 'temp', 'pi', 'plugin-log-websocket', String(process.pid))
const agentDir = join(testRoot, 'agent')
const logPath = join(testRoot, 'logs', 'build.log')
const clientId = 'b89b8646-2c3e-4fef-ac33-bd8d47179721'
const protocol = 'pi-desk.v1'
let serverOutput = ''

function receiveWhere(socket, predicate) {
  return new Promise((resolveMessage, rejectMessage) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    const onError = (error) => {
      cleanup()
      rejectMessage(error)
    }
    const onMessage = (data, isBinary) => {
      if (isBinary) return
      const message = JSON.parse(data.toString('utf8'))
      if (!predicate(message)) return
      cleanup()
      resolveMessage(message)
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectMessage(new Error(`等待日志 WebSocket 消息超时\n${serverOutput}`))
    }, 10_000)
    socket.on('message', onMessage)
    socket.once('error', onError)
  })
}

async function request(socket, path, body = {}) {
  const requestId = crypto.randomUUID()
  const response = receiveWhere(
    socket,
    (message) => message.head?.op === 'resp' && message.head.requestId === requestId
  )
  socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
  return (await response).body
}

async function login(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pi-Desk-Client-Id': clientId
    },
    body: JSON.stringify({ password: 'Qq.445566' })
  })
  const envelope = await response.json()
  assert.equal(response.ok, true, envelope.msg)
  const cookie = response.headers.get('set-cookie')
  assert.ok(cookie)
  return cookie.split(';', 1)[0]
}

test('插件日志通过应用 WebSocket 观察、追加并解除观察', { timeout: 60_000 }, async () => {
  await prepareIsolatedPiDirectory(agentDir)
  await mkdir(dirname(logPath), { recursive: true })
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [] }), 'utf8')
  await writeFile(logPath, '开始构建\n', 'utf8')
  const port = await reservePort()
  const runtime = spawnE2eServer({
    projectRoot,
    agentDir,
    port,
    development: true,
    onOutput: (output) => {
      serverOutput += output
    }
  })
  let socket
  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/health`, 30_000, 'Pi Desk', () => serverOutput)
    const cookie = await login(port)
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?clientId=${clientId}`, protocol, {
      headers: { Cookie: cookie }
    })
    await once(socket, 'open')
    assert.equal((await request(socket, 'work-sessions/list')).code, 0)

    assert.deepEqual(
      await request(socket, 'plugins/logs/watch', {
        pluginName: 'fixture-plugin',
        path: 'relative/build.log'
      }),
      { code: 400, msg: '日志路径必须是服务端绝对路径', data: null }
    )
    assert.deepEqual(
      await request(socket, 'plugins/logs/watch', {
        pluginName: 'fixture-plugin',
        path: logPath
      }),
      {
        code: 0,
        msg: '',
        data: { snapshot: { text: '开始构建\n', truncated: false } }
      }
    )

    const appended = receiveWhere(
      socket,
      (message) =>
        message.head?.op === 'push' &&
        message.head.path === 'plugins/logs/event' &&
        message.body?.path === logPath &&
        message.body?.event?.type === 'text_append'
    )
    await appendFile(logPath, '上传完成\n', 'utf8')
    assert.deepEqual((await appended).body, {
      pluginName: 'fixture-plugin',
      path: logPath,
      event: { type: 'text_append', text: '上传完成\n' }
    })

    assert.deepEqual(
      await request(socket, 'plugins/logs/unwatch', {
        pluginName: 'fixture-plugin',
        path: logPath
      }),
      { code: 0, msg: '', data: {} }
    )
  } finally {
    socket?.close()
    await stopE2eServerTree(runtime)
    await rm(testRoot, { recursive: true, force: true })
  }
})
