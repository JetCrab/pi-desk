import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = join(
  projectRoot,
  'temp',
  'pi',
  'capability-modes-running-e2e',
  String(process.pid)
)
const agentDir = join(testRoot, 'agent')
const cwd = join(testRoot, 'project')
const workId = 'capability-running-work'
const clientId = '1f9a8e7d-6c5b-4a32-9120-123456789012'
const observerId = '2f9a8e7d-6c5b-4a32-9120-123456789012'
const protocol = 'pi-desk.v1'
let appPort = 0
let providerPort = 0
let appRuntime
let providerServer
let authCookie = ''
let source
let firstRequestStarted
let releaseFirstRequest
let secondRequestReceived
const activeSockets = new Set()
let providerRequestCount = 0
let serverOutput = ''
const providerRequests = []

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function reservePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  )
  return address.port
}

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

function streamChunk(id, text, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'running-fixture',
    choices: [
      {
        index: 0,
        delta: text ? { role: 'assistant', content: text } : {},
        finish_reason: finishReason
      }
    ]
  })}\n\n`
}

async function handleProvider(request, response) {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  providerRequests.push(body)
  providerRequestCount += 1
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  if (providerRequestCount === 1) {
    firstRequestStarted?.()
    firstRequestStarted = null
    response.write(streamChunk('running-a', 'A 正在运行'))
    await new Promise((resolveRelease) => {
      releaseFirstRequest = () => {
        releaseFirstRequest = null
        resolveRelease()
      }
    })
    response.write(streamChunk('running-a', '', 'stop'))
    response.write('data: [DONE]\n\n')
    response.end()
    return
  }
  secondRequestReceived?.()
  secondRequestReceived = null
  response.write(streamChunk('running-b', 'B 按最新模式执行'))
  response.write(streamChunk('running-b', '', 'stop'))
  response.write('data: [DONE]\n\n')
  response.end()
}

function socketUrl(port, id) {
  return `ws://127.0.0.1:${port}/api/ws?clientId=${id}`
}

function openSocket(port, id) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(socketUrl(port, id), protocol, { headers: { Cookie: authCookie } })
    const onError = (error) => {
      clearTimeout(timer)
      rejectSocket(error)
    }
    const timer = setTimeout(() => {
      socket.terminate()
      rejectSocket(new Error('WebSocket 连接超时'))
    }, 20_000)
    socket.once('open', () => {
      clearTimeout(timer)
      socket.off('error', onError)
      activeSockets.add(socket)
      resolveSocket(socket)
    })
    socket.once('error', onError)
  })
}

function receiveWhere(socket, predicate) {
  return new Promise((resolveMessage, rejectMessage) => {
    const onMessage = (data, binary) => {
      if (binary) return
      let message
      try {
        message = JSON.parse(data.toString('utf8'))
      } catch (error) {
        cleanup()
        rejectMessage(error)
        return
      }
      if (!predicate(message)) return
      cleanup()
      resolveMessage(message)
    }
    const onError = (error) => {
      cleanup()
      rejectMessage(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectMessage(new Error('等待 WebSocket 消息超时'))
    }, 30_000)
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
  })
}

async function request(socket, path, body = {}) {
  const requestId = randomUUID()
  const response = receiveWhere(
    socket,
    (message) => message.head?.op === 'resp' && message.head.requestId === requestId
  )
  socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
  const message = await response
  assert.equal(message.head.path, path)
  return message.body
}

async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:${appPort}${path}`, {
    method: 'POST',
    headers: {
      Cookie: authCookie,
      'Content-Type': 'application/json',
      'X-Pi-Desk-Client-Id': clientId
    },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}

async function waitForHttp(url) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error(`等待服务超时：${url}`)
}

async function fixture() {
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  process.env.PI_OFFLINE = '1'
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const session = SessionManager.create(cwd)
  source = { workId, sessionId: session.getSessionId(), branchId: 'v1:main' }
  await put(join(agentDir, 'settings.json'), JSON.stringify({ packages: [] }))
  await put(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'running-fixture': {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          api: 'openai-completions',
          apiKey: 'offline-fixture-key',
          models: [
            {
              id: 'running-fixture',
              name: 'running-fixture',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  await put(
    join(cwd, '.pi', 'settings.json'),
    JSON.stringify({
      defaultProvider: 'running-fixture',
      defaultModel: 'running-fixture',
      defaultThinkingLevel: 'off'
    })
  )
  session.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '运行态能力测试初始消息' }],
    timestamp: Date.now()
  })
  session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '已准备运行态能力测试。' }],
    api: 'openai-completions',
    provider: 'running-fixture',
    model: 'running-fixture',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  })
  await put(
    join(agentDir, 'pi-desk', 'work-sessions.json'),
    JSON.stringify({
      workSessions: [{ workId, cwd, sessionId: session.getSessionId() }],
      pinnedCount: 0
    })
  )
  const listed = await SessionManager.list(cwd)
  assert.ok(
    listed.some((item) => item.id === session.getSessionId()),
    `fixture 会话未落盘：${session.getSessionFile()}`
  )
}

function waitForCallback(name) {
  return new Promise((resolveCallback, rejectCallback) => {
    const timer = setTimeout(() => {
      rejectCallback(new Error(`等待 Provider ${name} 请求超时`))
    }, 30_000)
    const resolveOnce = () => {
      clearTimeout(timer)
      resolveCallback()
    }
    if (name === 'first') firstRequestStarted = resolveOnce
    else secondRequestReceived = resolveOnce
  })
}

function terminateSockets() {
  for (const socket of activeSockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate()
    }
  }
  activeSockets.clear()
}

try {
  providerPort = await reservePort()
  providerServer = createServer((request, response) => void handleProvider(request, response))
  providerServer.listen(providerPort, '127.0.0.1')
  await once(providerServer, 'listening')
  await fixture()
  appPort = await reservePort()
  appRuntime = spawnE2eServer({
    projectRoot,
    agentDir,
    port: appPort,
    development: true,
    onOutput: (text) => {
      serverOutput = (serverOutput + text).slice(-100_000)
    }
  })
  await waitForHttp(`http://127.0.0.1:${appPort}/api/health`).catch((error) => {
    throw new Error(`${error.message}\n${serverOutput}`)
  })

  const login = await fetch(`http://127.0.0.1:${appPort}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
    body: JSON.stringify({ password: 'Qq.445566' })
  })
  assert.equal(login.status, 200)
  authCookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  assert.ok(authCookie)

  const socket = await openSocket(appPort, clientId)
  const observer = await openSocket(appPort, observerId)
  const bootstrap = await request(socket, 'work-sessions/list')
  await request(observer, 'work-sessions/list')
  const workSession = bootstrap.data.workSessions.find((item) => item.workId === workId)
  assert.ok(workSession)
  source = {
    workId: workSession.workId,
    sessionId: workSession.sessionId,
    branchId: workSession.branchId
  }
  const subscribe = { subscriptions: [{ source, cursor: null }] }
  const subscribeResponse = await request(socket, 'chat/subscribe', subscribe)
  assert.equal(subscribeResponse.code, 0, JSON.stringify(subscribeResponse))
  const observerSubscribeResponse = await request(observer, 'chat/subscribe', subscribe)
  assert.equal(observerSubscribeResponse.code, 0, JSON.stringify(observerSubscribeResponse))

  const modeKey = 'running-mode'
  const mode = {
    [modeKey]: { name: '运行限制', tools: { allow: ['read'] } }
  }
  assert.equal((await api('/api/capability-modes/replace', { modes: mode })).body.code, 0)

  const firstRunning = waitForCallback('first')
  const messageStartPromise = receiveWhere(
    socket,
    (message) =>
      message.head?.path === 'chat/source-event' && message.body?.event?.type === 'message_start'
  )
  const firstSend = request(socket, 'chat/send', {
    source,
    mode: 'auto',
    text: '任务 A：保持运行并等待模式切换。',
    images: []
  })
  await firstRunning
  const messageStart = await messageStartPromise
  assert.equal(messageStart.body.source.workId, workId)
  if (process.env.PI_DESK_CAPABILITY_FORCE_FAILURE === '1') {
    throw new Error('受控失败：验证运行中 E2E 清理路径')
  }

  const runtimeUpdate = receiveWhere(
    socket,
    (message) =>
      message.head?.path === 'chat/source-event' && message.body?.event?.type === 'runtime_update'
  )
  const observerRuntimeUpdate = receiveWhere(
    observer,
    (message) =>
      message.head?.path === 'chat/source-event' && message.body?.event?.type === 'runtime_update'
  )
  await request(socket, 'chat/capability-mode-set', { source, capabilityMode: modeKey })
  for (const event of [await runtimeUpdate, await observerRuntimeUpdate]) {
    assert.equal(event.body.event.runtime.capabilityMode, modeKey)
  }
  const queueRuntimeUpdate = receiveWhere(
    socket,
    (message) =>
      message.head?.path === 'chat/source-event' && message.body?.event?.type === 'runtime_update'
  )
  const observerQueueRuntimeUpdate = receiveWhere(
    observer,
    (message) =>
      message.head?.path === 'chat/source-event' && message.body?.event?.type === 'runtime_update'
  )
  const secondRunning = waitForCallback('second')
  const followUp = await request(socket, 'chat/send', {
    source,
    mode: 'follow_up',
    text: '任务 B：必须原样排队。',
    images: []
  })
  assert.equal(followUp.code, 0)
  const queueEvents = [await queueRuntimeUpdate, await observerQueueRuntimeUpdate]
  for (const event of queueEvents) {
    assert.equal(event.body.source.workId, workId)
    assert.equal(event.body.event.runtime.capabilityMode, modeKey)
    assert.equal(event.body.event.runtime.queues.followUp.length, 1)
    assert.deepEqual(event.body.event.runtime.queues.followUp[0].text, '任务 B：必须原样排队。')
    assert.deepEqual(Object.keys(event.body.event.runtime.queues.followUp[0]).sort(), [
      'images',
      'tempId',
      'text'
    ])
  }

  const oldSourceResponse = await request(socket, 'chat/capability-mode-set', {
    source: { ...source, branchId: 'v1:missing' },
    capabilityMode: modeKey
  })
  assert.equal(oldSourceResponse.code, 409)

  releaseFirstRequest?.()
  await firstSend
  await secondRunning
  assert.equal(providerRequests.length, 2)
  const secondToolNames = (providerRequests[1].tools ?? []).map(
    (item) => item.function?.name ?? item.name
  )
  assert.equal(secondToolNames.includes('write'), false)
  assert.equal(secondToolNames.includes('read'), true)
  const deletedModePush = receiveWhere(
    observer,
    (message) =>
      message.head?.path === 'chat/source-event' &&
      message.body?.event?.type === 'runtime_update' &&
      message.body.event.runtime.capabilityMode === null
  )
  assert.equal((await api('/api/capability-modes/replace', { modes: {} })).body.code, 0)
  assert.equal((await deletedModePush).body.event.runtime.capabilityMode, null)
  const deleteRuntime = await request(socket, 'chat/capability-mode-set', {
    source,
    capabilityMode: modeKey
  })
  assert.equal(deleteRuntime.code, 400, JSON.stringify(deleteRuntime))
  assert.equal(deleteRuntime.msg, '能力模式已不存在，请重新选择')

  socket.close()
  observer.close()
  console.log(
    JSON.stringify({
      ok: true,
      assertions: [
        'A 流式运行期间切换模式',
        'B follow-up 原样入队且无模式字段',
        '双页面 runtime 同步',
        '旧 Source 拒绝',
        'B Provider 请求按最新工具规则收紧',
        '删除使用中模式回全开'
      ]
    })
  )
} finally {
  releaseFirstRequest?.()
  terminateSockets()
  try {
    if (appRuntime) await stopE2eServerTree(appRuntime)
  } finally {
    if (providerServer) {
      providerServer.closeAllConnections?.()
      if (providerServer.listening) {
        const closed = once(providerServer, 'close').catch(() => undefined)
        providerServer.close()
        await closed
      }
    }
    await rm(testRoot, { recursive: true, force: true })
  }
}
