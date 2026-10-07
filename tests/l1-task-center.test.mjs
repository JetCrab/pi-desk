import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientId = '87ee3118-8df7-43ce-aad2-9fc4428d91f2'
const protocol = 'pi-desk.v1'
const testRoot = join(projectRoot, 'temp', 'pi', 'task-center-test', String(process.pid))
const agentDir = join(testRoot, 'agent')
const projectDir = join(testRoot, 'project')
const extensionDir = join(agentDir, 'extensions', 'task-center-test')
const logPath = join(projectDir, 'temp', 'pi', 'task-center-test', 'run.log')
const childSessionDir = join(agentDir, 'task-center-child-sessions')
const imageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const password = 'Qq.445566'
let port = 0
let serverRuntime
let serverOutput = ''
let authCookie = ''
let childSessionFile = ''
let childEntryIds = []
const diagnosticDir = join(projectRoot, 'temp/run/task-center', `source-assembly-${process.pid}`)
const startedAt = Date.now()
function recordStage(name) {
  console.info('[任务中心验收]', { name, elapsedMs: Date.now() - startedAt })
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function reservePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
  return address.port
}

async function waitForServer() {
  // 源码启动包含 Pi/tsx 加载和 Next 编译，独立于任务消息的 10 秒等待预算。
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (serverRuntime.child.exitCode !== null || serverRuntime.child.signalCode !== null) {
      throw new Error(`Task Center E2E Server 提前退出：\n${serverOutput}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(15_000)
      })
      if (response.ok) return
    } catch {
      // Server 仍在启动。
    }
    await delay(100)
  }
  throw new Error(`Task Center E2E Server 启动超时：\n${serverOutput}`)
}

async function login() {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pi-Desk-Client-Id': clientId
    },
    body: JSON.stringify({ password })
  })
  const envelope = await response.json()
  assert.equal(response.ok, true, envelope.msg)
  assert.equal(envelope.code, 0, envelope.msg)
  const setCookie = response.headers.get('set-cookie')
  assert.ok(setCookie)
  authCookie = setCookie.split(';', 1)[0]
}

async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: authCookie,
      'X-Pi-Desk-Client-Id': clientId
    },
    body: JSON.stringify(body)
  })
  const envelope = await response.json()
  assert.equal(response.ok, true, `${envelope.msg}\n${serverOutput}`)
  assert.equal(envelope.code, 0, `${envelope.msg}\n${serverOutput}`)
  return envelope.data
}

function receiveWhere(socket, predicate, timeoutMs = 10_000) {
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
    const onMessage = (data, binary) => {
      if (binary) return
      const message = JSON.parse(data.toString('utf8'))
      if (!predicate(message)) return
      cleanup()
      resolveMessage(message)
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectMessage(new Error(`等待 Task Center WebSocket 消息超时\n${serverOutput}`))
    }, timeoutMs)
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

async function request(socket, path, body = {}) {
  const requestId = crypto.randomUUID()
  const response = receiveWhere(
    socket,
    (message) => message.head?.op === 'resp' && message.head.requestId === requestId
  )
  socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
  const message = await response
  assert.equal(message.head.path, path)
  assert.equal(message.body.code, 0, `${message.body.msg}\n${serverOutput}`)
  return message.body.data
}

async function openSocket() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?clientId=${clientId}`, protocol, {
    headers: { Cookie: authCookie }
  })
  await once(socket, 'open')
  return socket
}

async function createChildSession() {
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(projectDir, childSessionDir)
  const timestamp = Date.now()
  const usage = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
  childEntryIds = [
    manager.appendMessage({
      role: 'user',
      content: [
        { type: 'text', text: '子代理问题' },
        { type: 'image', data: imageData, mimeType: 'image/png' }
      ],
      timestamp
    }),
    manager.appendMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '子代理思考' },
        { type: 'text', text: '子代理回答' },
        {
          type: 'toolCall',
          id: 'task-center-tool-call',
          name: 'read',
          arguments: { path: 'README.md', reasoning: '读取文档' }
        }
      ],
      api: 'openai-responses',
      provider: 'test',
      model: 'test-model',
      usage,
      stopReason: 'toolUse',
      timestamp: timestamp + 1
    }),
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'task-center-tool-call',
      toolName: 'read',
      content: [{ type: 'text', text: '任务工具输出' }],
      usage,
      isError: false,
      timestamp: timestamp + 2
    })
  ]
  for (let index = 0; index < 205; index += 1) {
    childEntryIds.push(
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `长子代理处理消息 ${index}` }],
        api: 'openai-responses',
        provider: 'test',
        model: 'test-model',
        usage,
        stopReason: 'stop',
        timestamp: timestamp + 3 + index
      })
    )
  }
  childSessionFile = manager.getSessionFile()
  assert.ok(childSessionFile)
}

async function createExtension() {
  await mkdir(extensionDir, { recursive: true })
  await writeFile(
    join(extensionDir, 'index.ts'),
    `const channel = 'pi-desk:task-report:v1'
const textTask = {
  taskId: 'text-task',
  taskKind: '服务',
  taskType: 'development',
  title: '启动测试服务',
  info: [{ label: '运行地址', value: '127.0.0.1/test' }],
  status: 'running',
  activity: '正在监听测试日志',
  startedAt: Date.now(),
  endedAt: null,
  detailSource: { kind: 'text-file', path: ${JSON.stringify(logPath)} },
  interrupt: null
}
const conversationTask = {
  taskId: 'conversation-task',
  title: '审查任务中心协议',
  status: 'completed',
  activity: '执行完成',
  startedAt: Date.now() - 2000,
  endedAt: Date.now() - 1000,
  detailSource: { kind: 'pi-conversation', sessionFile: ${JSON.stringify(childSessionFile)} },
  interrupt: null
}
export default function taskCenterTest(pi) {
  const emit = () => pi.events.emit(channel, { type: 'upsert', tasks: [textTask, conversationTask] })
  textTask.interrupt = async () => {
    textTask.status = 'stopped'
    textTask.activity = '已停止'
    textTask.endedAt = Date.now()
    textTask.interrupt = null
    emit()
  }
  pi.on('session_start', emit)
}
`,
    'utf8'
  )
}

before(async () => {
  await mkdir(diagnosticDir, { recursive: true })
  recordStage('准备Fixture')
  await mkdir(projectDir, { recursive: true })
  await mkdir(dirname(logPath), { recursive: true })
  await writeFile(logPath, '服务启动\n', 'utf8')
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await createChildSession()
  await createExtension()
  port = await reservePort()
  serverRuntime = spawnE2eServer({
    projectRoot,
    agentDir,
    port,
    development: true,
    nextDirectory: join(projectRoot, 'temp/cache/realtime-startup/next'),
    onOutput: (output) => {
      serverOutput += output
    }
  })
  recordStage('等待源码服务')
  await waitForServer()
  recordStage('源码服务就绪')
  await login()
})

after(async () => {
  try {
    if (serverRuntime) await stopE2eServerTree(serverRuntime)
  } finally {
    await writeFile(join(diagnosticDir, 'server.log'), serverOutput)
    await rm(testRoot, { recursive: true, force: true })
  }
})

test('Task Center Summary、详情、日志、打断、消息和图片闭环', async () => {
  const created = await api('/api/work-sessions/add', { cwd: projectDir })
  const workSession = created.workSession
  const source = {
    workId: workSession.workId,
    sessionId: workSession.sessionId,
    branchId: workSession.branchId
  }
  const socket = await openSocket()
  try {
    await request(socket, 'work-sessions/list', {})
    const syncPush = receiveWhere(
      socket,
      (message) =>
        message.head?.path === 'chat/source-event' &&
        message.body?.source?.workId === source.workId &&
        message.body?.event?.type === 'session_sync'
    )
    await request(socket, 'chat/subscribe', { subscriptions: [{ source, cursor: null }] })
    const sync = await syncPush
    const tasks = sync.body.event.runtime.plugins['task-center'].tasks
    assert.deepEqual(
      tasks.map((task) => ({
        taskId: task.taskId,
        taskKind: task.taskKind,
        taskType: task.taskType,
        info: task.info,
        status: task.status
      })),
      [
        {
          taskId: 'text-task',
          taskKind: '服务',
          taskType: 'development',
          info: [{ label: '运行地址', value: '127.0.0.1/test' }],
          status: 'running'
        },
        {
          taskId: 'conversation-task',
          taskKind: null,
          taskType: null,
          info: [],
          status: 'completed'
        }
      ]
    )

    const textDetail = await request(socket, 'task-center/detail-watch', {
      source,
      taskId: 'text-task'
    })
    assert.equal(textDetail.snapshot.body.kind, 'text')
    assert.match(textDetail.snapshot.body.text, /服务启动/)
    assert.equal(textDetail.snapshot.canInterrupt, true)

    const appendPush = receiveWhere(
      socket,
      (message) =>
        message.head?.path === 'task-center/detail-event' &&
        message.body?.taskId === 'text-task' &&
        message.body?.event?.type === 'text_append'
    )
    await appendFile(logPath, '收到请求\n', 'utf8')
    assert.match((await appendPush).body.event.text, /收到请求/)

    const runtimeUpdate = receiveWhere(
      socket,
      (message) =>
        message.head?.path === 'chat/source-event' &&
        message.body?.event?.type === 'runtime_update' &&
        message.body.event.runtime.plugins['task-center']?.tasks?.some(
          (task) => task.taskId === 'text-task' && task.status === 'stopped'
        )
    )
    await request(socket, 'task-center/interrupt', { source, taskId: 'text-task' })
    await runtimeUpdate

    const conversation = await request(socket, 'task-center/detail-watch', {
      source,
      taskId: 'conversation-task'
    })
    assert.equal(conversation.snapshot.body.kind, 'conversation')
    assert.equal(conversation.snapshot.body.truncated, false)
    assert.equal(conversation.snapshot.body.messages.length, 208)
    assert.deepEqual(
      conversation.snapshot.body.messages.map((message) => message.location.entryId),
      childEntryIds
    )
    assert.deepEqual(conversation.snapshot.body.messages[1].summary, {
      text: '子代理回答',
      errorMessage: null
    })
    assert.equal(conversation.snapshot.body.messages[1].detail, undefined)

    const detail = await api('/api/task-center/messages/get', {
      source,
      taskId: 'conversation-task',
      entryId: childEntryIds[2]
    })
    assert.equal(conversation.snapshot.body.messages[2].fixed.viewKey, 'pi-desk/read')
    assert.deepEqual(detail.detail, { content: '任务工具输出' })

    const image = await api('/api/task-center/images/get', {
      source,
      taskId: 'conversation-task',
      entryId: childEntryIds[0],
      imageIndex: 0
    })
    assert.equal(image.mimeType, 'image/png')
    assert.equal(image.data, imageData)
  } finally {
    socket.close()
  }
})
