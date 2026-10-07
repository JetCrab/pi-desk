import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import WebSocket from 'ws'

import { assertPortReleased, spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientId = '9cc3c65d-89c2-4b33-ac1f-1829c3344a21'
const observerClientId = '32f6ff76-5b7e-43e3-a3c4-44f80726fa75'
const protocol = 'pi-desk.v1'
const testPassword = 'Qq.445566'
const development = process.env.PI_DESK_E2E_DEVELOPMENT === '1'
// 源码准备包含 tsx/Pi 加载和 Next 首次编译；业务用例仍使用独立的 90 秒预算。
const startupTimeoutMs = development ? 120_000 : 30_000
const shutdownTimeoutMs = 10_000
const testRoot = join(projectRoot, 'temp', 'pi', 'app-websocket-test', String(process.pid))
const agentDir = join(testRoot, 'agent')
const workSessionStorePath = join(agentDir, 'pi-desk', 'work-sessions.json')
const pluginBaselineExtensionDir = join(agentDir, 'extensions', 'plugin-baseline')
const globalPluginPackageDir = join(testRoot, 'global-plugin-package')
const contextPluginPackageDir = join(projectRoot, 'plugins', 'pi-desk-ctx')
const subagentPluginPackageDir = join(projectRoot, 'plugins', 'pi-desk-subagent')
const expectedSubagentTools = ['agent', 'agent_resume', 'agent_steer', 'agent_list', 'agent_stop']
const execFileAsync = promisify(execFile)
const projectA = join(testRoot, 'project-a')
const projectB = join(testRoot, 'project-b')
const projectC = join(testRoot, 'project-c')
const projectD = join(testRoot, 'project-d')
const historyProject = join(testRoot, 'history-project')
const historyWorkId = 'history-work-session'
let port = 0
let serverRuntime
let serverProcess
let serverExit
let serverOutput = ''
let authCookie = ''
let shutdownVerified = false
let historySessionId = ''
let historyEntryIds = []
let searchHistorySessionId = ''
let searchHistoryRootUserEntryId = ''
let searchHistoryUserEntryIds = []
const startedAt = Date.now()
const diagnosticDir = join(projectRoot, 'temp/run/app-websocket', `source-assembly-${process.pid}`)
const stages = []
function recordStage(name) {
  const stage = { name, elapsedMs: Date.now() - startedAt }
  stages.push(stage)
  console.info('[应用 WS 验收]', stage)
}
const historyImageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

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

function socketUrl(path) {
  return `ws://127.0.0.1:${port}${path}`
}

function openSocket(path, protocols) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(socketUrl(path), protocols, {
      headers: { Cookie: authCookie }
    })
    const onError = (error) => {
      clearTimeout(timer)
      socket.off('open', onOpen)
      rejectSocket(error)
    }
    const onOpen = () => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolveSocket(socket)
    }
    const timer = setTimeout(() => {
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.terminate()
      rejectSocket(new Error(`WebSocket 连接超时：${path}`))
    }, 10_000)
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}

function receiveJson(socket) {
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
      cleanup()
      if (isBinary) {
        rejectMessage(new Error('服务端意外返回二进制消息'))
        return
      }
      resolveMessage(JSON.parse(data.toString('utf8')))
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectMessage(new Error('等待 WebSocket 响应超时'))
    }, 10_000)
    socket.once('message', onMessage)
    socket.once('error', onError)
  })
}

function receiveJsonWhere(socket, predicate) {
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
      if (isBinary) {
        cleanup()
        rejectMessage(new Error('服务端意外返回二进制消息'))
        return
      }
      const message = JSON.parse(data.toString('utf8'))
      if (!predicate(message)) return
      cleanup()
      resolveMessage(message)
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectMessage(new Error('等待匹配的 WebSocket 消息超时'))
    }, 10_000)
    socket.on('message', onMessage)
    socket.once('error', onError)
  })
}

function receiveCloseCode(socket) {
  return new Promise((resolveClose, rejectClose) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const onError = (error) => {
      cleanup()
      rejectClose(error)
    }
    const onClose = (code) => {
      cleanup()
      resolveClose(code)
    }
    const timer = setTimeout(() => {
      cleanup()
      rejectClose(new Error('等待 WebSocket 关闭超时'))
    }, 10_000)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return
  const closed = receiveCloseCode(socket)
  socket.close()
  await closed
}

async function socketRequest(socket, path, body = {}) {
  recordStage(`WS开始:${path}`)
  const requestId = crypto.randomUUID()
  const response = receiveJsonWhere(
    socket,
    (message) => message.head?.op === 'resp' && message.head.requestId === requestId
  )
  socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
  const message = await response
  assert.equal(message.head.path, path)
  assert.equal(message.head.requestId, requestId)
  recordStage(`WS完成:${path}`)
  return message.body
}

async function apiResult(path, body) {
  recordStage(`HTTP开始:${path}`)
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
  recordStage(`HTTP完成:${path}`)
  return { response, envelope }
}

async function api(path, body) {
  const { response, envelope } = await apiResult(path, body)
  const failureDetails = `${envelope.msg}\n${serverOutput}`
  assert.equal(response.ok, true, failureDetails)
  assert.equal(envelope.code, 0, failureDetails)
  return envelope.data
}

async function loginForTest() {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pi-Desk-Client-Id': clientId
    },
    body: JSON.stringify({ password: testPassword })
  })
  const responseText = await response.text()
  let envelope
  try {
    envelope = JSON.parse(responseText)
  } catch {
    throw new Error(`测试登录返回非 JSON：${response.status}\n${responseText}\n${serverOutput}`)
  }
  assert.equal(response.ok, true, envelope.msg)
  assert.equal(envelope.code, 0, envelope.msg)
  const setCookie = response.headers.get('set-cookie')
  assert.ok(setCookie, '测试登录必须返回会话 Cookie')
  authCookie = setCookie.split(';', 1)[0]
}

function outputOccurrences(text) {
  return serverOutput.split(text).length - 1
}

async function waitForOutputOccurrence(text, expectedCount) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (outputOccurrences(text) >= expectedCount) return
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throw new Error(`应用测试 Server 提前退出：\n${serverOutput}`)
    }
    await delay(50)
  }
  throw new Error(`等待服务端日志超时：${text}\n${serverOutput}`)
}

async function waitForServer() {
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throw new Error(`应用测试 Server 提前退出：\n${serverOutput}`)
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(15_000)
      })
      if (response.ok) return
    } catch {
      // Server 仍在准备中。
    }
    await delay(100)
  }
  throw new Error(`应用测试 Server 未在时限内启动：\n${serverOutput}`)
}

async function waitForServerExit() {
  let timeout
  try {
    const result = await Promise.race([
      serverExit,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`应用测试 Server 未在时限内退出：\n${serverOutput}`)),
          shutdownTimeoutMs
        )
      })
    ])
    return result
  } finally {
    clearTimeout(timeout)
  }
}

function requestShutdown() {
  if (process.platform === 'win32') {
    assert.equal(serverProcess.send('pi-desk.shutdown'), true)
    return
  }
  assert.equal(serverProcess.kill('SIGTERM'), true)
}

async function runPnpm(args) {
  const options = { cwd: projectRoot, windowsHide: true }
  if (process.platform === 'win32') {
    await execFileAsync('cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], options)
    return
  }
  await execFileAsync('pnpm', args, options)
}

async function buildPluginPackages() {
  await Promise.all(
    ['@jetcrab/pi-desk-ctx', '@jetcrab/pi-desk-subagent'].map((packageName) =>
      runPnpm(['--filter', packageName, 'build'])
    )
  )
}

async function createGlobalPluginFixture() {
  await mkdir(join(globalPluginPackageDir, 'browser'), { recursive: true })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: [globalPluginPackageDir, contextPluginPackageDir, subagentPluginPackageDir]
    }),
    'utf8'
  )
  await writeFile(
    join(globalPluginPackageDir, 'package.json'),
    JSON.stringify({
      name: 'global-plugin-e2e-fixture',
      type: 'module',
      pi: { extensions: [] },
      piDesk: { entry: './entry.mjs', global: './global.mjs' }
    }),
    'utf8'
  )
  await writeFile(
    join(globalPluginPackageDir, 'browser', 'entry.js'),
    `export const marker = 'browser-fixture-loaded'
export default function browserEntry(plugin) {
  plugin.onPush(() => undefined)
  plugin.notifications.onEvent('open-result', ({ notificationId, data }) => {
    globalThis.__piDeskNotificationEvent = { notificationId, data }
  })
  const load = () => import('./view.js').then((module) => module.default)
  plugin.registerContribution('application', 'fixture-application', {
    label: 'Fixture 应用',
    title: 'Fixture Application',
    icon: { type: 'builtin', name: 'plugin' },
    chrome: 'host',
    resolve({ workSessions }) { return workSessions.length > 0 },
    load
  })
  plugin.registerContribution('composer-panel', 'fixture-panel', {
    label: 'Fixture Panel',
    load
  })
  plugin.registerContribution('settings-page', 'fixture-settings', {
    label: 'Fixture 设置',
    load
  })
  plugin.registerContribution('message-view', 'fixture-message', {
    viewKey: 'global-fixture/message',
    priority: 100,
    load
  })
}
`,
    'utf8'
  )
  await writeFile(
    join(globalPluginPackageDir, 'browser', 'view.js'),
    `export default { mount() {} }
`,
    'utf8'
  )
  await writeFile(
    join(globalPluginPackageDir, 'entry.mjs'),
    `export default {
  name: 'global-fixture',
  setup(plugin) {
    plugin.setState({ status: 'ready', value: 1 })
    plugin.registerMethod('echo', async (input) => ({ value: input.value }))
    plugin.registerMethod('global-state-set', async (input) => {
      plugin.setState(input.state)
      return {}
    })
    plugin.registerMethod('notification-publish', async (input) => ({
      notificationId: plugin.notifications.publish({
        level: input.level,
        title: input.title,
        description: input.description,
        event: input.event
      })
    }))
    plugin.registerMethod('notification-update', async (input) => {
      plugin.notifications.update(input.notificationId, input.changes)
      return {}
    })
    plugin.registerMethod('notification-delete', async (input) => {
      plugin.notifications.delete(input.notificationId)
      return {}
    })
    plugin.registerMethod('push-global', async (input) => {
      plugin.pushGlobal('state', { value: input.value })
      return {}
    })
    plugin.registerMethod('push-session', async (input) => {
      plugin.pushSession(input.source, 'state', { value: input.value })
      return {}
    })
    plugin.registerBrowserEntry('./browser/entry.js')
  }
}
`,
    'utf8'
  )
  await writeFile(
    join(globalPluginPackageDir, 'global.mjs'),
    `export default function legacyEntryMustNotLoad() {
  throw new Error('piDesk.global must not load when piDesk.entry exists')
}
`,
    'utf8'
  )
}

async function createPluginBaselineExtensionFixture() {
  await mkdir(pluginBaselineExtensionDir, { recursive: true })
  await writeFile(
    join(pluginBaselineExtensionDir, 'index.ts'),
    `import { bindSessionPlugin } from '@jetcrab/pi-desk-sdk'

const expectedTools = ${JSON.stringify(expectedSubagentTools)}

export default function pluginBaseline(pi) {
  const plugin = bindSessionPlugin(pi, 'baseline-fixture')
  const unregister = plugin.registerMethod('inspect', async () => {
    const availableTools = new Set(pi.getAllTools().map((tool) => tool.name))
    plugin.setState({ phase: 'inspected' })
    return { tools: expectedTools.filter((tool) => availableTools.has(tool)) }
  })
  pi.registerCommand('baseline-command', {
    description: 'M3 Native Command Fixture',
    async handler(args) {
      if (args === 'fail') throw new Error('baseline command failure')
      plugin.setState({ phase: args ? \`command:\${args}\` : 'command' })
    }
  })
  pi.on('session_start', () => {
    plugin.setState({ phase: 'ready' })
  })
  pi.on('session_shutdown', () => {
    unregister()
    plugin.setState(null)
  })
}
`,
    'utf8'
  )
}

async function createSlashCommandResourceFixtures() {
  const promptsDir = join(agentDir, 'prompts')
  const skillDir = join(agentDir, 'skills', 'baseline-skill')
  await Promise.all([mkdir(promptsDir, { recursive: true }), mkdir(skillDir, { recursive: true })])
  await Promise.all([
    writeFile(
      join(promptsDir, 'baseline-prompt.md'),
      `---
description: M3 Prompt Fixture
---

执行 Prompt Fixture。
`,
      'utf8'
    ),
    writeFile(
      join(promptsDir, 'baseline-command.md'),
      `---
description: Shadowed Prompt Fixture
---

该模板会被同名 Extension Command 遮蔽。
`,
      'utf8'
    ),
    writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: baseline-skill
description: M3 Skill Fixture
---

# Baseline Skill
`,
      'utf8'
    )
  ])
}

async function createHistoryFixture() {
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.create(historyProject)
  const timestamp = Date.now()
  const usage = {
    input: 1_200,
    output: 345,
    cacheRead: 6_000,
    cacheWrite: 50,
    totalTokens: 7_595,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0012, cacheWrite: 0, total: 0.0042 }
  }

  historyEntryIds = [
    manager.appendMessage({
      role: 'user',
      content: [
        { type: 'text', text: '历史问题' },
        { type: 'image', data: historyImageData, mimeType: 'image/png' }
      ],
      timestamp
    }),
    manager.appendMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '历史思考' },
        { type: 'text', text: '历史回答' },
        {
          type: 'toolCall',
          id: 'test-tool-call',
          name: 'read',
          arguments: {
            reasoning: '确认历史聊天投影',
            path: 'src/client/l2_biz/workbench/l2-workbench-chat-view.tsx'
          }
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
      toolCallId: 'test-tool-call',
      toolName: 'read',
      content: [{ type: 'text', text: '工具输出' }],
      usage,
      isError: false,
      timestamp: timestamp + 2
    }),
    manager.appendMessage({
      role: 'bashExecution',
      command: 'echo test',
      output: 'test',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: timestamp + 3
    }),
    manager.appendCustomMessageEntry('test-visible', '自定义提示', true)
  ]
  manager.appendCustomMessageEntry('test-hidden', '隐藏消息', false)
  manager.appendCustomMessageEntry('background-task-notification', '后台任务仍在运行', false, {
    id: 'history-background-task',
    status: 'running'
  })
  manager.appendSessionInfo('预加载会话')
  historySessionId = manager.getSessionId()

  const searchManager = SessionManager.create(historyProject)
  const rootUserId = searchManager.appendMessage({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `共同问题：如何找到具体会话。${'这是用于验证标题预览截断的补充内容。'.repeat(20)}`
      }
    ],
    timestamp: timestamp + 10
  })
  searchHistoryRootUserEntryId = rootUserId
  searchManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '共同回答' }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp + 11
  })
  searchManager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '旧分支关键词，不应出现在当前结果' }],
    timestamp: timestamp + 12
  })
  searchManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '旧分支回答' }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp + 13
  })
  searchManager.branch(rootUserId)
  searchHistoryUserEntryIds = [
    searchManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '目标关键词：展示第一条匹配用户消息' }],
      timestamp: timestamp + 14
    })
  ]
  searchManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '第一条当前分支回答' }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp + 15
  })
  searchHistoryUserEntryIds.push(
    searchManager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '再次使用目标关键词确认具体会话' }],
      timestamp: timestamp + 16
    })
  )
  searchManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '第二条当前分支回答' }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop',
    timestamp: timestamp + 17
  })
  searchManager.appendSessionInfo('用户消息搜索会话')
  searchHistorySessionId = searchManager.getSessionId()

  const storeDirectory = join(agentDir, 'pi-desk')
  await mkdir(storeDirectory, { recursive: true })
  await writeFile(
    workSessionStorePath,
    `${JSON.stringify(
      [{ workId: historyWorkId, cwd: historyProject, sessionId: historySessionId }],
      null,
      2
    )}\n`,
    'utf8'
  )
}

before(async () => {
  await mkdir(diagnosticDir, { recursive: true })
  recordStage('准备Fixture')
  await buildPluginPackages()
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(projectA, { recursive: true }),
    mkdir(projectB, { recursive: true }),
    mkdir(projectC, { recursive: true }),
    mkdir(projectD, { recursive: true }),
    mkdir(historyProject, { recursive: true })
  ])
  await createGlobalPluginFixture()
  await createPluginBaselineExtensionFixture()
  await createSlashCommandResourceFixtures()
  await createHistoryFixture()
  port = await reservePort()
  serverRuntime = spawnE2eServer({
    projectRoot,
    agentDir,
    port,
    development,
    nextDirectory: join(projectRoot, 'temp/cache/realtime-startup/next'),
    onOutput: (data) => {
      serverOutput += data
    }
  })
  serverProcess = serverRuntime.child
  serverExit = serverRuntime.exit
  recordStage('等待源码服务')
  await waitForServer()
  recordStage('源码服务就绪')
  await api('/api/auth-settings/replace', {
    password: testPassword
  })
  await loginForTest()
  if (development) {
    recordStage('准备首页编译')
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Cookie: authCookie },
      signal: AbortSignal.timeout(120_000)
    })
    const content = await page.text()
    assert.equal(page.status, 200, `${content}\n${serverOutput}`)
    recordStage('首页编译完成')
  }
  recordStage('等待Fixture插件就绪')
  const preparationSocket = await openSocket(`/api/ws?clientId=${clientId}`, protocol)
  try {
    assert.equal((await socketRequest(preparationSocket, 'work-sessions/list')).code, 0)
    assert.equal((await socketRequest(preparationSocket, 'plugins/browser-entries/list')).code, 0)
  } finally {
    await closeSocket(preparationSocket)
  }
  recordStage('Fixture插件已就绪')
})

after(async () => {
  try {
    if (serverRuntime && !shutdownVerified) {
      await stopE2eServerTree(serverRuntime)
      throw new Error('应用测试未完成优雅关闭')
    }
  } finally {
    await writeFile(join(diagnosticDir, 'server.log'), serverOutput)
    await writeFile(join(diagnosticDir, 'stages.json'), JSON.stringify(stages, null, 2))
    await rm(testRoot, { recursive: true, force: true })
  }
})

test('应用 WebSocket 初始化、WorkSession 推送与优雅关闭', { timeout: 90_000 }, async () => {
  recordStage('开始业务验收')
  const pageResponse = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { Cookie: authCookie }
  })
  assert.equal(
    pageResponse.ok,
    true,
    `${pageResponse.status}\n${await pageResponse.text()}\n${serverOutput}`
  )

  const replacedSocket = await openSocket(`/api/ws?clientId=${clientId}`, protocol)
  assert.equal(replacedSocket.protocol, protocol)
  assert.match(replacedSocket.extensions, /permessage-deflate/)
  assert.equal((await socketRequest(replacedSocket, 'work-sessions/list')).code, 0)

  const replacedClose = receiveCloseCode(replacedSocket)
  const socket = await openSocket(`/api/ws?clientId=${clientId}`, protocol)
  assert.equal(await replacedClose, 4001)
  assert.equal(socket.protocol, protocol)

  const historySource = {
    workId: historyWorkId,
    sessionId: historySessionId,
    branchId: 'v1:main'
  }
  assert.deepEqual(
    await socketRequest(socket, 'chat/subscribe', {
      subscriptions: [{ source: historySource, cursor: null }]
    }),
    {
      code: 409,
      msg: '工作会话尚未初始化',
      data: null,
      i18n: { key: 'errors:sessionsNotReady' }
    }
  )

  const listResponse = await socketRequest(socket, 'work-sessions/list')
  assert.equal(listResponse.code, 0)
  assert.equal(listResponse.data.workSessions.length, 1)
  assert.equal(listResponse.data.pinnedCount, 0)
  assert.deepEqual(listResponse.data.appRuntime, {
    mode: 'normal',
    notifications: [],
    plugins: {
      'global-fixture': { status: 'ready', value: 1 }
    },
    capabilityModes: {}
  })

  const appRuntimeObserver = await openSocket(
    `/api/ws?clientId=33f0ca70-af57-4142-83f8-30c638573929`,
    protocol
  )
  const observerBootstrap = await socketRequest(appRuntimeObserver, 'work-sessions/list')
  assert.deepEqual(observerBootstrap.data.appRuntime, listResponse.data.appRuntime)

  const statePush = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.path === 'app-runtime/update' &&
      message.body?.type === 'update' &&
      message.body?.key === 'plugins'
  )
  const observerStatePush = receiveJsonWhere(
    appRuntimeObserver,
    (message) =>
      message.head?.path === 'app-runtime/update' &&
      message.body?.type === 'update' &&
      message.body?.key === 'plugins'
  )
  assert.equal(
    (
      await socketRequest(socket, 'plugins/invoke', {
        pluginName: 'global-fixture',
        method: 'global-state-set',
        scope: 'global',
        input: { state: { status: 'running', value: 2 } }
      })
    ).code,
    0
  )
  for (const message of [await statePush, await observerStatePush]) {
    assert.deepEqual(message.body, {
      type: 'update',
      key: 'plugins',
      update: {
        pluginName: 'global-fixture',
        state: { status: 'running', value: 2 }
      }
    })
  }

  const notificationPush = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.path === 'app-runtime/update' &&
      message.body?.key === 'notifications' &&
      message.body?.update?.type === 'add'
  )
  const observerNotificationPush = receiveJsonWhere(
    appRuntimeObserver,
    (message) =>
      message.head?.path === 'app-runtime/update' &&
      message.body?.key === 'notifications' &&
      message.body?.update?.type === 'add'
  )
  const publishResponse = await socketRequest(socket, 'plugins/invoke', {
    pluginName: 'global-fixture',
    method: 'notification-publish',
    scope: 'global',
    input: {
      level: 'success',
      title: '构建完成',
      description: 'production',
      event: { name: 'open-result', data: { runId: 'run-1' } }
    }
  })
  assert.equal(publishResponse.code, 0)
  const notificationId = publishResponse.data.notificationId
  assert.equal(typeof notificationId, 'string')
  for (const message of [await notificationPush, await observerNotificationPush]) {
    assert.equal(message.body.update.notification.notificationId, notificationId)
    assert.deepEqual(message.body.update.notification.event, {
      type: 'plugin',
      pluginName: 'global-fixture',
      name: 'open-result',
      data: { runId: 'run-1' }
    })
  }

  const notificationUpdatePush = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.path === 'app-runtime/update' &&
      message.body?.key === 'notifications' &&
      message.body?.update?.type === 'update'
  )
  assert.equal(
    (
      await socketRequest(socket, 'plugins/invoke', {
        pluginName: 'global-fixture',
        method: 'notification-update',
        scope: 'global',
        input: {
          notificationId,
          changes: { level: 'warning', title: '需要确认' }
        }
      })
    ).code,
    0
  )
  assert.deepEqual((await notificationUpdatePush).body, {
    type: 'update',
    key: 'notifications',
    update: {
      type: 'update',
      notificationId,
      changes: { level: 'warning', title: '需要确认' }
    }
  })

  const deletePush = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.path === 'app-runtime/update' &&
      message.body?.key === 'notifications' &&
      message.body?.update?.type === 'delete'
  )
  const observerDeletePush = receiveJsonWhere(
    appRuntimeObserver,
    (message) =>
      message.head?.path === 'app-runtime/update' &&
      message.body?.key === 'notifications' &&
      message.body?.update?.type === 'delete'
  )
  assert.deepEqual(
    await socketRequest(appRuntimeObserver, 'app-runtime/apply', {
      key: 'notifications',
      update: { type: 'delete', notificationId }
    }),
    { code: 0, msg: '', data: {} }
  )
  for (const message of [await deletePush, await observerDeletePush]) {
    assert.deepEqual(message.body, {
      type: 'update',
      key: 'notifications',
      update: { type: 'delete', notificationId }
    })
  }
  assert.deepEqual(
    await socketRequest(socket, 'app-runtime/apply', {
      key: 'notifications',
      update: { type: 'delete', notificationId }
    }),
    { code: 404, msg: 'App Runtime 目标不存在', data: null }
  )
  await closeSocket(appRuntimeObserver)

  assert.deepEqual(
    await socketRequest(socket, 'plugins/invoke', {
      pluginName: 'global-fixture',
      method: 'echo',
      scope: 'global',
      input: { value: 'ready-before-chat-session' }
    }),
    {
      code: 0,
      msg: '',
      data: { value: 'ready-before-chat-session' }
    },
    serverOutput
  )

  const pluginLogPath = join(projectA, 'temp', 'pi', 'plugin-log-test', 'build.log')
  await mkdir(dirname(pluginLogPath), { recursive: true })
  await writeFile(pluginLogPath, '开始构建\n', 'utf8')
  assert.deepEqual(
    await socketRequest(socket, 'plugins/logs/watch', {
      pluginName: 'global-fixture',
      path: 'relative/build.log'
    }),
    {
      code: 400,
      msg: '日志路径必须是服务端绝对路径',
      data: null
    }
  )
  assert.deepEqual(
    await socketRequest(socket, 'plugins/logs/watch', {
      pluginName: 'global-fixture',
      path: pluginLogPath
    }),
    {
      code: 0,
      msg: '',
      data: { snapshot: { text: '开始构建\n', truncated: false } }
    }
  )
  const pluginLogAppend = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.op === 'push' &&
      message.head.path === 'plugins/logs/event' &&
      message.body?.pluginName === 'global-fixture' &&
      message.body?.path === pluginLogPath &&
      message.body?.event?.type === 'text_append'
  )
  await appendFile(pluginLogPath, '上传完成\n', 'utf8')
  assert.deepEqual((await pluginLogAppend).body.event, {
    type: 'text_append',
    text: '上传完成\n'
  })
  assert.deepEqual(
    await socketRequest(socket, 'plugins/logs/unwatch', {
      pluginName: 'global-fixture',
      path: pluginLogPath
    }),
    { code: 0, msg: '', data: {} }
  )

  const browserEntriesResponse = await socketRequest(socket, 'plugins/browser-entries/list', {})
  assert.equal(browserEntriesResponse.code, 0, serverOutput)
  assert.deepEqual(browserEntriesResponse.data.entries.map((entry) => entry.pluginName).sort(), [
    'context-ignore',
    'global-fixture',
    'subagent'
  ])
  const browserEntry = browserEntriesResponse.data.entries.find(
    (entry) => entry.pluginName === 'global-fixture'
  )
  assert.ok(browserEntry)
  assert.match(
    browserEntry.url,
    /^\/api\/plugins\/browser-resources\/[A-Za-z0-9_-]{32}\/entry\.js$/
  )
  const subagentBrowserEntry = browserEntriesResponse.data.entries.find(
    (entry) => entry.pluginName === 'subagent'
  )
  assert.ok(subagentBrowserEntry)
  assert.match(
    subagentBrowserEntry.url,
    /^\/api\/plugins\/browser-resources\/[A-Za-z0-9_-]{32}\/entry\.js$/
  )

  const unauthenticatedEntry = await fetch(`http://127.0.0.1:${port}${browserEntry.url}`)
  assert.equal(unauthenticatedEntry.status, 401)
  const entryResponse = await fetch(`http://127.0.0.1:${port}${browserEntry.url}`, {
    headers: { Cookie: authCookie }
  })
  assert.equal(entryResponse.status, 200)
  assert.match(entryResponse.headers.get('content-type') ?? '', /^text\/javascript/)
  assert.equal(entryResponse.headers.get('cache-control'), 'no-cache')
  const entryEtag = entryResponse.headers.get('etag')
  assert.ok(entryEtag)
  assert.match(await entryResponse.text(), /browser-fixture-loaded/)
  const cachedEntryResponse = await fetch(`http://127.0.0.1:${port}${browserEntry.url}`, {
    headers: { Cookie: authCookie, 'If-None-Match': entryEtag }
  })
  assert.equal(cachedEntryResponse.status, 304)
  const viewUrl = browserEntry.url.replace(/entry\.js$/, 'view.js')
  const viewResponse = await fetch(`http://127.0.0.1:${port}${viewUrl}`, {
    headers: { Cookie: authCookie }
  })
  assert.equal(viewResponse.status, 200)
  assert.match(await viewResponse.text(), /mount/)
  const missingEntryResponse = await fetch(
    `http://127.0.0.1:${port}/api/plugins/browser-resources/${'x'.repeat(32)}/entry.js`,
    { headers: { Cookie: authCookie } }
  )
  assert.equal(missingEntryResponse.status, 404)

  const hostRuntimeUrl = `http://127.0.0.1:${port}/api/plugins/host-runtime/v1/base.js`
  assert.equal((await fetch(hostRuntimeUrl)).status, 401)
  const hostRuntimeResponse = await fetch(hostRuntimeUrl, {
    headers: { Cookie: authCookie }
  })
  assert.equal(hostRuntimeResponse.status, 200)
  assert.match(hostRuntimeResponse.headers.get('content-type') ?? '', /^text\/javascript/)
  assert.equal(hostRuntimeResponse.headers.get('cache-control'), 'no-cache')
  const hostRuntimeEtag = hostRuntimeResponse.headers.get('etag')
  assert.ok(hostRuntimeEtag)
  assert.match(await hostRuntimeResponse.text(), /pi-desk-ui-root/)
  assert.equal(
    (
      await fetch(hostRuntimeUrl, {
        headers: { Cookie: authCookie, 'If-None-Match': hostRuntimeEtag }
      })
    ).status,
    304
  )
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/plugins/host-runtime/v2/base.js`, {
        headers: { Cookie: authCookie }
      })
    ).status,
    404
  )

  const migratedWorkSessionStore = JSON.parse(await readFile(workSessionStorePath, 'utf8'))
  assert.deepEqual(Object.keys(migratedWorkSessionStore), ['workSessions', 'pinnedCount'])
  assert.equal(migratedWorkSessionStore.workSessions.length, 1)
  assert.equal(migratedWorkSessionStore.pinnedCount, 0)
  const historyWorkSession = listResponse.data.workSessions[0]
  assert.equal(historyWorkSession.workId, historyWorkId)
  assert.equal(historyWorkSession.sessionId, historySessionId)
  assert.equal(historyWorkSession.branchId, 'v1:main')
  assert.equal(historyWorkSession.sessionTitle, '预加载会话')
  assert.equal(historyWorkSession.status, 'idle')
  assert.deepEqual(historyWorkSession.messageCounts, { user: 1, total: 5 })
  assert.equal(Number.isSafeInteger(historyWorkSession.lastMessageUpdatedAt), true)

  const fullSyncPush = receiveJsonWhere(
    socket,
    (message) => message.head?.op === 'push' && message.head.path === 'chat/source-event'
  )
  assert.deepEqual(
    await socketRequest(socket, 'chat/subscribe', {
      subscriptions: [{ source: historySource, cursor: null }]
    }),
    { code: 0, msg: '', data: {} }
  )
  const fullSync = await fullSyncPush
  assert.deepEqual(fullSync.body.source, historySource)
  assert.equal(fullSync.body.event.type, 'session_sync')
  assert.equal(fullSync.body.event.mode, 'full')
  assert.equal(fullSync.body.event.baseCursor, null)
  assert.deepEqual(
    fullSync.body.event.messages.map((message) => message.fixed.type),
    ['user', 'assistant', 'tool', 'bash', 'custom']
  )
  assert.deepEqual(
    fullSync.body.event.messages.map((message) => message.location.entryId),
    historyEntryIds
  )
  assert.deepEqual(fullSync.body.event.temporaryMessages, [])
  assert.deepEqual(fullSync.body.event.runtime.queues, { steering: [], followUp: [] })
  assert.deepEqual(fullSync.body.event.runtime.plugins['baseline-fixture'], {
    phase: 'ready'
  })
  const contextIgnoreState = fullSync.body.event.runtime.plugins['context-ignore']
  assert.deepEqual(Object.keys(contextIgnoreState).sort(), [
    'effectiveTokens',
    'ignoredTokens',
    'potentialTokens'
  ])
  assert.equal(typeof contextIgnoreState.ignoredTokens, 'number')
  assert.equal(typeof contextIgnoreState.potentialTokens, 'number')
  assert.equal(
    contextIgnoreState.effectiveTokens === null ||
      typeof contextIgnoreState.effectiveTokens === 'number',
    true
  )
  assert.equal(
    fullSync.body.event.runtime.model === null ||
      typeof fullSync.body.event.runtime.model.modelId === 'string',
    true
  )

  const pluginRuntimePush = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.op === 'push' &&
      message.head.path === 'chat/source-event' &&
      message.body?.event?.type === 'runtime_update' &&
      message.body.event.runtime.plugins?.['baseline-fixture']?.phase === 'inspected'
  )
  assert.deepEqual(
    await socketRequest(socket, 'plugins/invoke', {
      pluginName: 'baseline-fixture',
      method: 'inspect',
      scope: 'session',
      source: historySource,
      input: {}
    }),
    { code: 0, msg: '', data: { tools: expectedSubagentTools } }
  )
  const inspectedPluginRuntime = (await pluginRuntimePush).body.event.runtime.plugins
  assert.deepEqual(inspectedPluginRuntime['baseline-fixture'], { phase: 'inspected' })
  assert.deepEqual(inspectedPluginRuntime['context-ignore'], contextIgnoreState)

  const commandsResponse = await socketRequest(socket, 'pi/commands/list', {
    source: historySource
  })
  assert.equal(commandsResponse.code, 0)
  assert.ok(
    commandsResponse.data.commands.some(
      (command) =>
        command.name === 'baseline-command' &&
        command.description === 'M3 Native Command Fixture' &&
        command.source === 'extension'
    )
  )
  assert.ok(
    commandsResponse.data.commands.some(
      (command) =>
        command.name === 'baseline-prompt' &&
        command.description === 'M3 Prompt Fixture' &&
        command.source === 'prompt'
    )
  )
  assert.ok(
    commandsResponse.data.commands.some(
      (command) =>
        command.name === 'skill:baseline-skill' &&
        command.description === 'M3 Skill Fixture' &&
        command.source === 'skill'
    )
  )
  assert.equal(
    commandsResponse.data.commands.some(
      (command) => command.name === 'baseline-command' && command.source === 'prompt'
    ),
    false
  )
  const commandRuntimePush = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.op === 'push' &&
      message.head.path === 'chat/source-event' &&
      message.body?.event?.type === 'runtime_update' &&
      message.body.event.runtime.plugins?.['baseline-fixture']?.phase === 'command:ok'
  )
  assert.deepEqual(
    await socketRequest(socket, 'pi/commands/execute', {
      source: historySource,
      command: 'baseline-command',
      args: 'ok'
    }),
    { code: 0, msg: '', data: {} }
  )
  assert.deepEqual((await commandRuntimePush).body.event.runtime.plugins['baseline-fixture'], {
    phase: 'command:ok'
  })
  assert.deepEqual(
    await socketRequest(socket, 'pi/commands/execute', {
      source: historySource,
      command: 'missing-command'
    }),
    { code: 404, msg: 'Pi 命令不存在', data: null }
  )
  const failedCommand = await socketRequest(socket, 'pi/commands/execute', {
    source: historySource,
    command: 'baseline-command',
    args: 'fail'
  })
  assert.equal(failedCommand.code, 500)
  assert.match(failedCommand.msg, /baseline command failure/)

  const toolsResponse = await socketRequest(socket, 'pi/tools/list', {
    source: historySource
  })
  assert.equal(toolsResponse.code, 0)
  for (const toolName of expectedSubagentTools) {
    const tool = toolsResponse.data.tools.find((item) => item.name === toolName)
    assert.ok(tool, `缺少 Tool Metadata：${toolName}`)
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(tool.active, true)
  }
  assert.deepEqual(await socketRequest(socket, 'pi/tools/execute'), {
    code: 404,
    msg: '未知 WebSocket 路径',
    data: null,
    i18n: { key: 'errors:socketUnknownPath' }
  })

  assert.deepEqual(fullSync.body.event.messages[0], {
    location: {
      index: 0,
      entryId: historyEntryIds[0]
    },
    fixed: {
      timestampMs: fullSync.body.event.messages[0].fixed.timestampMs,
      type: 'user',
      viewKey: 'pi-desk/user',
      hasDetail: false
    },
    summary: {
      text: '历史问题',
      images: [{ mimeType: 'image/png', width: 1, height: 1 }]
    }
  })
  assert.equal(
    fullSync.body.event.messages.every((message) =>
      Number.isSafeInteger(message.fixed.timestampMs)
    ),
    true
  )
  assert.deepEqual(fullSync.body.event.messages[1].fixed.usage, {
    inputTokens: 1_200,
    outputTokens: 345,
    cacheReadTokens: 6_000,
    costUsd: 0.0042
  })
  assert.deepEqual(fullSync.body.event.messages[1].summary, {
    text: '历史回答',
    errorMessage: null
  })
  assert.deepEqual(fullSync.body.event.messages[2].fixed, {
    timestampMs: fullSync.body.event.messages[2].fixed.timestampMs,
    type: 'tool',
    viewKey: 'pi-desk/read',
    status: 'completed',
    hasDetail: true,
    usage: {
      inputTokens: 1_200,
      outputTokens: 345,
      cacheReadTokens: 6_000,
      costUsd: 0.0042
    }
  })
  assert.equal(fullSync.body.event.messages[2].detail, undefined)
  assert.deepEqual(fullSync.body.event.messages[2].summary, {
    name: 'read',
    reasoning: '确认历史聊天投影',
    inputPreview: 'src/client/l2_biz/workbench/l2-workbench-chat-view.tsx',
    activity: null,
    path: 'src/client/l2_biz/workbench/l2-workbench-chat-view.tsx'
  })

  const assistantDetail = await api('/api/chat/messages/get', {
    sessionId: historySessionId,
    branchId: 'v1:main',
    entryId: historyEntryIds[1]
  })
  assert.deepEqual(assistantDetail, {
    index: 1,
    entryId: historyEntryIds[1],
    detail: {
      thinking: '历史思考'
    }
  })
  const toolDetail = await api('/api/chat/messages/get', {
    sessionId: historySessionId,
    branchId: 'v1:main',
    entryId: historyEntryIds[2]
  })
  assert.deepEqual(toolDetail, {
    index: 2,
    entryId: historyEntryIds[2],
    detail: { content: '工具输出' }
  })
  assert.deepEqual(
    await api('/api/chat/images/get', {
      sessionId: historySessionId,
      branchId: 'v1:main',
      entryId: historyEntryIds[0],
      imageIndex: 0
    }),
    { mimeType: 'image/png', data: historyImageData }
  )
  const modelCatalog = await api('/api/pi/models/list', { workId: historyWorkId })
  assert.equal(Array.isArray(modelCatalog.models), true)
  assert.equal(Array.isArray(modelCatalog.presets), true)
  assert.equal(
    modelCatalog.models.every(
      (model) =>
        typeof model.provider === 'string' &&
        typeof model.modelId === 'string' &&
        Array.isArray(model.thinkingLevels)
    ),
    true
  )

  assert.deepEqual(await socketRequest(socket, 'chat/interrupt', { source: historySource }), {
    code: 0,
    msg: '',
    data: {}
  })
  assert.deepEqual(await socketRequest(socket, 'chat/queue-restore', { source: historySource }), {
    code: 0,
    msg: '',
    data: { text: '', images: [] }
  })
  const emptySend = await socketRequest(socket, 'chat/send', {
    source: historySource,
    mode: 'auto',
    text: '   ',
    images: []
  })
  assert.equal(emptySend.code, 400)
  const idleFollowUp = await socketRequest(socket, 'chat/send', {
    source: historySource,
    mode: 'follow_up',
    text: '空闲时不能排入 Follow-up',
    images: []
  })
  assert.notEqual(idleFollowUp.code, 0)
  assert.equal(idleFollowUp.data, null)
  const missingModel = await socketRequest(socket, 'chat/model-set', {
    source: historySource,
    model: { provider: 'missing', modelId: 'missing', thinkingLevel: 'off' }
  })
  assert.notEqual(missingModel.code, 0)
  assert.equal(missingModel.data, null)

  const reprojectedPush = receiveJsonWhere(
    socket,
    (message) => message.head?.op === 'push' && message.head.path === 'chat/source-event'
  )
  assert.equal(
    (
      await socketRequest(socket, 'chat/subscribe', {
        subscriptions: [
          {
            source: historySource,
            cursor: { index: 4, entryId: historyEntryIds[4] }
          }
        ]
      })
    ).code,
    0
  )
  // 预加载记录在后台 Declaration 就绪后重投影，旧 cursor 不能证明已接收新版视图。
  const reprojectedSync = await reprojectedPush
  assert.equal(reprojectedSync.body.event.mode, 'full')
  assert.deepEqual(
    reprojectedSync.body.event.messages.map((message) => message.location.entryId),
    historyEntryIds
  )

  const fallbackPush = receiveJsonWhere(
    socket,
    (message) => message.head?.op === 'push' && message.head.path === 'chat/source-event'
  )
  assert.equal(
    (
      await socketRequest(socket, 'chat/subscribe', {
        subscriptions: [
          {
            source: historySource,
            cursor: { index: 1, entryId: 'wrong-entry' }
          }
        ]
      })
    ).code,
    0
  )
  const fallbackSync = await fallbackPush
  assert.equal(fallbackSync.body.event.mode, 'full')
  assert.equal(fallbackSync.body.event.messages.length, 5)

  assert.deepEqual(await socketRequest(socket, 'chat/command'), {
    code: 404,
    msg: '未知 WebSocket 路径',
    data: null,
    i18n: { key: 'errors:socketUnknownPath' }
  })

  const observerSocket = await openSocket(`/api/ws?clientId=${observerClientId}`, protocol)
  const observerList = await socketRequest(observerSocket, 'work-sessions/list')
  assert.equal(observerList.code, 0)
  assert.equal(observerList.data.workSessions.length, 1)
  assert.equal(observerList.data.pinnedCount, 0)

  const globalPluginPush = receiveJsonWhere(
    socket,
    (message) => message.head?.op === 'push' && message.head.path === 'plugins/push'
  )
  const observerGlobalPluginPush = receiveJsonWhere(
    observerSocket,
    (message) => message.head?.op === 'push' && message.head.path === 'plugins/push'
  )
  assert.deepEqual(
    await socketRequest(socket, 'plugins/invoke', {
      pluginName: 'global-fixture',
      method: 'push-global',
      scope: 'global',
      input: { value: 'global-ready' }
    }),
    { code: 0, msg: '', data: {} }
  )
  const expectedGlobalPluginPush = {
    head: { op: 'push', path: 'plugins/push' },
    body: {
      pluginName: 'global-fixture',
      target: { scope: 'global' },
      event: 'state',
      data: { value: 'global-ready' }
    }
  }
  assert.deepEqual(await globalPluginPush, expectedGlobalPluginPush)
  assert.deepEqual(await observerGlobalPluginPush, expectedGlobalPluginPush)

  const sessionPluginPush = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.op === 'push' &&
      message.head.path === 'plugins/push' &&
      message.body?.target?.scope === 'session'
  )
  const observerSessionPluginPush = receiveJsonWhere(
    observerSocket,
    (message) =>
      message.head?.op === 'push' &&
      message.head.path === 'plugins/push' &&
      message.body?.target?.scope === 'session'
  )
  assert.deepEqual(
    await socketRequest(socket, 'plugins/invoke', {
      pluginName: 'global-fixture',
      method: 'push-session',
      scope: 'global',
      input: { value: 'session-ready', source: historySource }
    }),
    { code: 0, msg: '', data: {} }
  )
  const expectedSessionPluginPush = {
    head: { op: 'push', path: 'plugins/push' },
    body: {
      pluginName: 'global-fixture',
      target: { scope: 'session', source: historySource },
      event: 'state',
      data: { value: 'session-ready' }
    }
  }
  assert.deepEqual(await sessionPluginPush, expectedSessionPluginPush)
  assert.deepEqual(await observerSessionPluginPush, expectedSessionPluginPush)

  const addAPush = receiveJson(socket)
  const observerAddAPush = receiveJson(observerSocket)
  const addA = await api('/api/work-sessions/add', { cwd: projectA })
  const addAUpdate = await addAPush
  const observerAddAUpdate = await observerAddAPush
  assert.equal(addAUpdate.head.path, 'work-sessions/update')
  assert.deepEqual(observerAddAUpdate, addAUpdate)
  assert.equal(addAUpdate.body.type, 'snapshot')
  assert.equal(addAUpdate.body.workSessions.length, 2)
  assert.equal(addAUpdate.body.pinnedCount, 0)
  assert.deepEqual(addAUpdate.body.workSessions.at(0), addA.workSession)
  assert.equal(addA.workSession.projectName, 'project-a')
  assert.equal(addA.workSession.status, 'idle')
  assert.deepEqual(addA.workSession.messageCounts, { user: 0, total: 0 })
  assert.equal(addA.workSession.lastMessageUpdatedAt, null)

  const addBPush = receiveJson(socket)
  const observerAddBPush = receiveJson(observerSocket)
  const addB = await api('/api/work-sessions/add', { cwd: projectB })
  const addBUpdate = await addBPush
  assert.deepEqual(await observerAddBPush, addBUpdate)
  assert.equal(addBUpdate.body.type, 'snapshot')
  assert.equal(addBUpdate.body.pinnedCount, 0)
  assert.deepEqual(
    addBUpdate.body.workSessions.map((item) => item.workId),
    [addB.workSession.workId, addA.workSession.workId, historyWorkId]
  )

  const sortPush = receiveJson(socket)
  const observerSortPush = receiveJson(observerSocket)
  const sorted = await api('/api/work-sessions/sort', {
    workIds: [addB.workSession.workId, historyWorkId, addA.workSession.workId],
    pinnedCount: 2
  })
  const sortUpdate = await sortPush
  assert.deepEqual(await observerSortPush, sortUpdate)
  assert.equal(sortUpdate.body.type, 'snapshot')
  assert.equal(sortUpdate.body.pinnedCount, 2)
  assert.equal(sorted.pinnedCount, 2)
  assert.deepEqual(
    sortUpdate.body.workSessions.map((item) => item.workId),
    [addB.workSession.workId, historyWorkId, addA.workSession.workId]
  )
  assert.deepEqual(sortUpdate.body.workSessions, sorted.workSessions)
  const persistedArrangement = JSON.parse(await readFile(workSessionStorePath, 'utf8'))
  assert.equal(persistedArrangement.pinnedCount, 2)
  assert.deepEqual(
    persistedArrangement.workSessions.map((item) => item.workId),
    [addB.workSession.workId, historyWorkId, addA.workSession.workId]
  )
  await closeSocket(observerSocket)

  const addCPush = receiveJson(socket)
  const addC = await api('/api/work-sessions/add', { cwd: projectC })
  const addCUpdate = await addCPush
  assert.equal(addCUpdate.body.type, 'snapshot')
  assert.equal(addCUpdate.body.pinnedCount, 2)
  assert.deepEqual(
    addCUpdate.body.workSessions.map((item) => item.workId),
    [addB.workSession.workId, historyWorkId, addC.workSession.workId, addA.workSession.workId]
  )

  const deleteCPush = receiveJson(socket)
  const afterDeleteC = await api('/api/work-sessions/del', { workId: addC.workSession.workId })
  assert.equal(afterDeleteC.pinnedCount, 2)
  assert.deepEqual((await deleteCPush).body, {
    type: 'delete',
    workId: addC.workSession.workId
  })

  const replacePush = receiveJson(socket)
  await api('/api/work-sessions/replace', {
    workId: addA.workSession.workId,
    cwd: addC.workSession.cwd,
    sessionId: addC.workSession.sessionId
  })
  const replaceUpdate = await replacePush
  assert.equal(replaceUpdate.body.type, 'update')
  assert.equal(replaceUpdate.body.workId, addA.workSession.workId)
  assert.equal(replaceUpdate.body.changes.cwd, addC.workSession.cwd)
  assert.equal(replaceUpdate.body.changes.sessionId, addC.workSession.sessionId)
  assert.equal(replaceUpdate.body.changes.projectName, 'project-c')

  const emptyReplacePush = receiveJson(socket)
  const emptyReplacement = await api('/api/work-sessions/replace', {
    workId: addA.workSession.workId
  })
  const emptyReplaceUpdate = await emptyReplacePush
  const emptyWorkSession = emptyReplacement.workSessions.find(
    (item) => item.workId === addA.workSession.workId
  )
  assert.ok(emptyWorkSession)
  assert.equal(emptyReplaceUpdate.body.type, 'update')
  assert.equal(emptyReplaceUpdate.body.workId, addA.workSession.workId)
  assert.equal(emptyReplaceUpdate.body.changes.sessionId, emptyWorkSession.sessionId)
  assert.notEqual(emptyWorkSession.sessionId, addC.workSession.sessionId)
  assert.equal(emptyWorkSession.cwd, addC.workSession.cwd)
  assert.equal(emptyWorkSession.projectName, 'project-c')
  assert.equal(emptyWorkSession.sessionTitle, null)
  assert.equal(emptyWorkSession.status, 'idle')
  assert.deepEqual(emptyWorkSession.messageCounts, { user: 0, total: 0 })
  assert.equal(emptyWorkSession.lastMessageUpdatedAt, null)

  const deleteBPush = receiveJson(socket)
  const afterDeleteB = await api('/api/work-sessions/del', { workId: addB.workSession.workId })
  assert.equal(afterDeleteB.pinnedCount, 1)
  assert.deepEqual((await deleteBPush).body, {
    type: 'delete',
    workId: addB.workSession.workId
  })

  const ackResponse = await socketRequest(socket, 'work-sessions/ack-completed', {
    workId: addA.workSession.workId
  })
  assert.deepEqual(ackResponse, {
    code: 0,
    msg: '',
    data: { workId: addA.workSession.workId }
  })

  const directories = await api('/api/pi/directories/list', { forceRefresh: true })
  assert.deepEqual(Object.keys(directories), ['directories'])
  assert.ok(directories.directories.every((item) => Number.isSafeInteger(item.updatedAt)))
  assert.ok(directories.directories.some((item) => item.cwd === projectC))

  assert.deepEqual(
    await api('/api/pi/directory-ignores/replace', { cwd: projectC, ignored: true }),
    {}
  )
  const filteredDirectories = await api('/api/pi/directories/list', { forceRefresh: false })
  assert.deepEqual(Object.keys(filteredDirectories), ['directories'])
  assert.equal(
    filteredDirectories.directories.some((item) => item.cwd === projectC),
    false
  )

  const ignoredDirectories = await api('/api/pi/directory-ignores/list', {
    forceRefresh: false
  })
  assert.deepEqual(Object.keys(ignoredDirectories), ['directories'])
  assert.ok(ignoredDirectories.directories.some((item) => item.cwd === projectC))

  const browsedDirectories = await api('/api/pi/directory-entries/list', { cwd: testRoot })
  assert.equal(browsedDirectories.cwd, testRoot)
  assert.equal(browsedDirectories.parentCwd, dirname(testRoot))
  assert.equal(
    browsedDirectories.directories.some((item) => item.cwd === projectC),
    false
  )
  assert.ok(browsedDirectories.directories.some((item) => item.cwd === projectD))

  const rootDirectories = await api('/api/pi/directory-entries/list', { cwd: null })
  assert.equal(rootDirectories.cwd, null)
  assert.equal(rootDirectories.parentCwd, null)
  assert.ok(rootDirectories.directories.length > 0)

  assert.deepEqual(
    await api('/api/pi/directory-ignores/replace', { cwd: projectC, ignored: false }),
    {}
  )
  const restoredDirectories = await api('/api/pi/directories/list', { forceRefresh: false })
  assert.ok(restoredDirectories.directories.some((item) => item.cwd === projectC))
  const restoredIgnoredDirectories = await api('/api/pi/directory-ignores/list', {
    forceRefresh: false
  })
  assert.equal(
    restoredIgnoredDirectories.directories.some((item) => item.cwd === projectC),
    false
  )

  const invalidBrowseDirectory = await apiResult('/api/pi/directory-entries/list', {
    cwd: join(testRoot, 'missing-project')
  })
  assert.equal(
    invalidBrowseDirectory.response.status,
    400,
    JSON.stringify(invalidBrowseDirectory.envelope)
  )
  assert.deepEqual(invalidBrowseDirectory.envelope, {
    code: 400,
    msg: '目录不存在或不是目录',
    data: null,
    i18n: { key: 'errors:directoryMissing' }
  })

  const invalidDirectory = await apiResult('/api/work-sessions/add', {
    cwd: join(testRoot, 'missing-project')
  })
  assert.equal(invalidDirectory.response.status, 400, JSON.stringify(invalidDirectory.envelope))
  assert.deepEqual(invalidDirectory.envelope, {
    code: 400,
    msg: '项目目录不存在或不是目录',
    data: null,
    i18n: { key: 'errors:workSessionDirectoryMissing' }
  })

  const addDPush = receiveJson(socket)
  const addD = await api('/api/work-sessions/add', { cwd: projectD })
  const addDUpdate = await addDPush
  assert.equal(addDUpdate.body.type, 'snapshot')
  assert.equal(addDUpdate.body.pinnedCount, 1)
  const directoriesAfterAdd = await api('/api/pi/directories/list', { forceRefresh: false })
  assert.ok(directoriesAfterAdd.directories.some((item) => item.cwd === projectD))
  const deleteDPush = receiveJson(socket)
  await api('/api/work-sessions/del', { workId: addD.workSession.workId })
  assert.deepEqual((await deleteDPush).body, {
    type: 'delete',
    workId: addD.workSession.workId
  })

  const sessions = await api('/api/pi/sessions/list', { cwd: projectC })
  assert.ok(sessions.sessions.some((item) => item.sessionId === addC.workSession.sessionId))
  assert.ok(sessions.sessions.some((item) => item.sessionId === emptyWorkSession.sessionId))
  assert.ok(sessions.sessions.every((item) => Number.isSafeInteger(item.createdAt)))
  assert.ok(sessions.sessions.every((item) => Number.isSafeInteger(item.updatedAt)))
  assert.ok(sessions.sessions.every((item) => Number.isSafeInteger(item.userMessageCount)))
  assert.ok(sessions.sessions.every((item) => item.firstMessage.length <= 160))
  assert.ok(
    sessions.sessions.every((item) => item.matches === null),
    JSON.stringify(sessions.sessions)
  )

  const searchedHistory = await api('/api/pi/sessions/list', {
    cwd: historyProject,
    query: '目标关键词',
    forceRefresh: true
  })
  assert.equal(searchedHistory.sessions.length, 1)
  const searchedSession = searchedHistory.sessions[0]
  assert.equal(searchedSession.sessionId, searchHistorySessionId)
  assert.equal(searchedSession.messageCount, 5)
  assert.equal(searchedSession.userMessageCount, 3)
  assert.equal(searchedSession.firstMessage.length, 160)
  assert.equal(searchedSession.firstMessage.endsWith('…'), true)
  const userMatch = searchedSession.matches.find((item) => item.scope === 'user')
  assert.equal(userMatch.count, 2)
  assert.equal(userMatch.entryId, searchHistoryUserEntryIds[1])
  assert.ok(userMatch.preview.includes('目标关键词'))

  const titleHistory = await api('/api/pi/sessions/list', {
    cwd: historyProject,
    query: '用户消息搜索会话'
  })
  assert.equal(titleHistory.sessions.length, 1)
  assert.equal(titleHistory.sessions[0].matches[0].scope, 'title')

  const assistantKeyword = '第一条当前分支回答'
  const defaultAssistantHistory = await api('/api/pi/sessions/list', {
    cwd: historyProject,
    query: assistantKeyword
  })
  assert.deepEqual(defaultAssistantHistory.sessions, [])
  const assistantHistory = await api('/api/pi/sessions/list', {
    cwd: historyProject,
    query: assistantKeyword,
    searchIn: ['assistant']
  })
  assert.equal(assistantHistory.sessions.length, 1)
  const assistantMatch = assistantHistory.sessions[0].matches[0]
  assert.equal(assistantMatch.scope, 'assistant')
  assert.equal(assistantMatch.count, 1)
  assert.ok(assistantMatch.preview.includes(assistantKeyword))

  const sessionIdQuery = searchHistorySessionId.slice(-12)
  const defaultSessionIdHistory = await api('/api/pi/sessions/list', {
    cwd: historyProject,
    query: sessionIdQuery
  })
  assert.deepEqual(defaultSessionIdHistory.sessions, [])
  const sessionIdHistory = await api('/api/pi/sessions/list', {
    cwd: historyProject,
    query: sessionIdQuery,
    searchIn: ['sessionId']
  })
  assert.equal(sessionIdHistory.sessions.length, 1)
  assert.equal(sessionIdHistory.sessions[0].matches[0].scope, 'sessionId')

  const abandonedHistory = await api('/api/pi/sessions/list', {
    cwd: historyProject,
    query: '旧分支关键词'
  })
  assert.deepEqual(abandonedHistory.sessions, [])

  const matchedUserMessages = await api('/api/pi/session-user-messages/list', {
    cwd: historyProject,
    sessionId: searchHistorySessionId,
    query: '目标关键词',
    page: { index: 1, size: 1 }
  })
  assert.deepEqual(matchedUserMessages.page, { index: 1, size: 1, total: 2 })
  assert.equal(matchedUserMessages.messages.length, 1)
  assert.equal(matchedUserMessages.messages[0].entryId, searchHistoryUserEntryIds[1])

  const allUserMessages = await api('/api/pi/session-user-messages/list', {
    cwd: historyProject,
    sessionId: searchHistorySessionId,
    page: { index: 1, size: 20 }
  })
  assert.equal(allUserMessages.page.total, 3)
  assert.deepEqual(
    allUserMessages.messages.map((message) => message.entryId),
    [searchHistoryUserEntryIds[1], searchHistoryUserEntryIds[0], searchHistoryRootUserEntryId]
  )

  const missingHistory = await apiResult('/api/pi/session-user-messages/list', {
    cwd: historyProject,
    sessionId: 'missing-session',
    page: { index: 1, size: 20 }
  })
  assert.equal(missingHistory.response.status, 404)
  assert.deepEqual(missingHistory.envelope, {
    code: 404,
    msg: 'Pi 会话不存在',
    data: null,
    i18n: { key: 'errors:piSessionMissing' }
  })

  const directBashStart = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.op === 'push' &&
      message.head.path === 'chat/source-event' &&
      message.body?.event?.type === 'message_start' &&
      message.body.event.snapshot?.fixed?.type === 'bash'
  )
  const directBashUpdate = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.op === 'push' &&
      message.head.path === 'chat/source-event' &&
      message.body?.event?.type === 'message_update'
  )
  const directBashCommit = receiveJsonWhere(
    socket,
    (message) =>
      message.head?.op === 'push' &&
      message.head.path === 'chat/source-event' &&
      message.body?.event?.type === 'message_commit'
  )
  const directBash = await socketRequest(socket, 'pi/bash/execute', {
    source: historySource,
    command: 'printf native-bash',
    excludeFromContext: false
  })
  assert.deepEqual(directBash, {
    code: 0,
    msg: '',
    data: {
      output: 'native-bash',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      fullOutputPath: null
    }
  })
  const bashStartEvent = (await directBashStart).body.event
  const bashUpdateEvent = (await directBashUpdate).body.event
  const bashCommitEvent = (await directBashCommit).body.event
  assert.equal(bashStartEvent.snapshot.fixed.viewKey, 'pi-desk/bash')
  assert.equal(bashStartEvent.snapshot.summary.command, 'printf native-bash')
  assert.equal(bashUpdateEvent.location.tempId, bashStartEvent.snapshot.location.tempId)
  assert.equal(bashCommitEvent.location.tempId, bashStartEvent.snapshot.location.tempId)
  assert.equal(typeof bashCommitEvent.durable.entryId, 'string')

  const directBashStartMarker = '[Pi Desk][PiChatWorker] Direct Bash 已开始'
  const expectedStartCount = outputOccurrences(directBashStartMarker) + 1
  const longBash = socketRequest(socket, 'pi/bash/execute', {
    source: historySource,
    command: 'node -e "setTimeout(() => {}, 10000)"',
    excludeFromContext: true
  })
  await waitForOutputOccurrence(directBashStartMarker, expectedStartCount)
  assert.deepEqual(
    await socketRequest(socket, 'pi/bash/execute', {
      source: historySource,
      command: 'printf duplicate-bash',
      excludeFromContext: false
    }),
    { code: 409, msg: '当前工作会话已有 Bash 正在执行', data: null }
  )
  assert.deepEqual(await socketRequest(socket, 'pi/bash/abort', { source: historySource }), {
    code: 0,
    msg: '',
    data: {}
  })
  const abortedBash = await longBash
  assert.equal(abortedBash.code, 0)
  assert.equal(abortedBash.data.cancelled, true)
  assert.equal(abortedBash.data.exitCode, null)

  assert.deepEqual(await socketRequest(socket, 'unknown/path'), {
    code: 404,
    msg: '未知 WebSocket 路径',
    data: null,
    i18n: { key: 'errors:socketUnknownPath' }
  })
  await closeSocket(socket)

  const invalidJsonSocket = await openSocket(`/api/ws?clientId=${clientId}`, protocol)
  const invalidJsonClose = receiveCloseCode(invalidJsonSocket)
  invalidJsonSocket.send('{')
  assert.equal(await invalidJsonClose, 1007)

  const binarySocket = await openSocket(`/api/ws?clientId=${clientId}`, protocol)
  const binaryClose = receiveCloseCode(binarySocket)
  binarySocket.send(Buffer.from('binary'), { binary: true })
  assert.equal(await binaryClose, 1003)

  const directionSocket = await openSocket(`/api/ws?clientId=${clientId}`, protocol)
  const directionClose = receiveCloseCode(directionSocket)
  directionSocket.send(
    JSON.stringify({
      head: {
        op: 'resp',
        path: 'chat/command',
        requestId: 'a7dca6a9-36fd-4b29-9425-1f024bd4bb4d'
      },
      body: { code: 503, msg: '聊天功能尚未接入', data: null }
    })
  )
  assert.equal(await directionClose, 1008)

  const oversizedSocket = await openSocket(`/api/ws?clientId=${clientId}`, protocol)
  const oversizedClose = receiveCloseCode(oversizedSocket)
  oversizedSocket.send(
    JSON.stringify({
      head: {
        op: 'req',
        path: 'work-sessions/list',
        requestId: '123e4567-e89b-42d3-a456-426614174000'
      },
      body: 'x'.repeat(33 * 1024 * 1024)
    })
  )
  assert.equal(await oversizedClose, 1009)

  const shutdownSocket = await openSocket(`/api/ws?clientId=${clientId}`, protocol)
  const shutdownClose = receiveCloseCode(shutdownSocket)
  requestShutdown()
  assert.equal(await shutdownClose, 1001)

  const [exitCode, signal] = await waitForServerExit()
  assert.equal(exitCode, 0)
  assert.equal(signal, null)
  await assertPortReleased(port)
  shutdownVerified = true
})
