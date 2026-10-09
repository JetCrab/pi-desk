import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnE2eServer, stopE2eServerTree } from './l4-e2e-server-runtime.mjs'

const host = '/opt/pi-desk/node_modules/@jetcrab/pi-desk'
const load = createRequire(join(host, 'package.json'))
const WebSocket = load('ws')
const agentDir = process.env.PI_CODING_AGENT_DIR
const cwd = '/workspace/project'
const base = 'http://127.0.0.1:6233'
const clientId = randomUUID()
const pending = new Map()
const frames = []
let socket
let runtime
let provider
let call
let output = ''
const contentText = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('\n')

async function until(check, label) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`Docker 验收超时：${label}\n${output.slice(-8000)}`)
}

function request(path, body = {}) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`请求超时：${path}`))
    }, 15000)
    pending.set(requestId, { resolve, reject, timer })
    socket.send(JSON.stringify({ head: { op: 'req', path, requestId }, body }))
  })
}

async function connect() {
  socket = new WebSocket(`${base.replace('http', 'ws')}/api/ws?clientId=${clientId}`, 'pi-desk.v1')
  socket.on('error', () => {})
  socket.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString())
    frames.push(message)
    const item = pending.get(message.head.requestId)
    if (!item || message.head.op !== 'resp') return
    clearTimeout(item.timer)
    pending.delete(message.head.requestId)
    if (message.body.code === 0) item.resolve(message.body.data)
    else item.reject(new Error(`${message.head.path}: ${message.body.msg}`))
  })
  await once(socket, 'open')
  return request('work-sessions/list')
}

async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Pi-Desk-Client-Id': clientId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  })
  const result = await response.json()
  assert.equal(result.code, 0, `${path}: ${JSON.stringify(result)}`)
  return result.data
}

async function verifyPersisted() {
  const saved = JSON.parse(await readFile('/data/home/docker-smoke.json', 'utf8'))
  const sessions = await connect()
  const session = sessions.workSessions.find((item) => item.workId === saved.workId)
  assert.equal(session.sessionId, saved.sessionId)
  assert.equal(session.messageCounts.total, saved.messageCount)
  assert.equal(await readFile(join(cwd, 'agent.txt'), 'utf8'), 'DOCKER_AGENT_OK\n')
  const tools = await request('pi/tools/list', {
    source: {
      workId: session.workId,
      sessionId: session.sessionId,
      branchId: session.branchId
    }
  })
  assert.ok(tools.tools.some((tool) => tool.name === 'docker_fixture'))
  console.info('容器重建后会话、消息、文件和插件均保留。')
}

function modelResponse(response, tool) {
  const envelope = {
    id: randomUUID(),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fixture'
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: tool.id,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.args) }
          }
        ]
      }
    : { content: 'Docker 会话验收完成。' }
  for (const chunk of [
    { ...envelope, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...envelope, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...envelope,
      choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
  ])
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end('data: [DONE]\n\n')
}

async function verifyRuntime(version) {
  await mkdir(agentDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  provider = createServer((req, response) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        const { messages } = JSON.parse(body)
        let tool
        if (call && messages.some((message) => contentText(message.content) === call.id)) {
          const result = messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === call.id
          )
          if (result) call.result = contentText(result.content)
          if (!call.sent) {
            call.sent = true
            tool = call
          }
        }
        modelResponse(response, tool)
      } catch (error) {
        response.writeHead(500)
        response.end(String(error))
      }
    })
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: [],
      defaultProvider: 'docker-fixture',
      defaultModel: 'fixture',
      defaultThinkingLevel: 'off',
      retry: { enabled: false },
      compaction: { enabled: false }
    })
  )
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'docker-fixture': {
          baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [
            {
              id: 'fixture',
              input: ['text'],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100000,
              maxTokens: 512
            }
          ]
        }
      }
    })
  )
  await mkdir('/workspace/plugin', { recursive: true })
  await writeFile(
    '/workspace/plugin/package.json',
    JSON.stringify({
      name: 'docker-fixture',
      version: '1.0.0',
      type: 'module',
      pi: { extensions: ['./index.mjs'] }
    })
  )
  await writeFile(
    '/workspace/plugin/index.mjs',
    `export default function(pi) {
    pi.registerTool({ name: 'docker_fixture', label: 'Fixture', description: 'Container runtime fixture',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: 'PLUGIN_OK' }] } }
    })
  }\n`
  )
  runtime = spawnE2eServer({
    projectRoot: host,
    agentDir,
    port: 6233,
    managed: true,
    piPackageDir: process.env.PI_DESK_PI_PACKAGE_DIR,
    environment: { PI_OFFLINE: '1' },
    onOutput(chunk) {
      output = `${output}${chunk}`.slice(-2 * 1024 * 1024)
    }
  })
  await until(async () => {
    assert.equal(runtime.child.exitCode, null, output)
    try {
      const result = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }).then(
        (r) => r.json()
      )
      return result.code === 0 && result.data.version === version
    } catch {
      return false
    }
  }, '生产服务启动')
  await connect()
  await api('/api/plugins/add', { source: '/workspace/plugin' })
  await until(async () => {
    const snapshot = await api('/api/plugins/list', {})
    const plugin = snapshot.plugins.find(
      (item) => resolve(agentDir, item.source) === '/workspace/plugin'
    )
    assert.ok(!plugin?.error && plugin?.operation?.phase !== 'failed', JSON.stringify(plugin))
    return ['ready', 'available'].includes(plugin?.status) && !plugin.operation
  }, '插件安装与隔离检查')
  const { workSession } = await api('/api/work-sessions/add', { cwd })
  const { workId, sessionId, branchId } = workSession
  const source = { workId, sessionId, branchId }
  await request('chat/subscribe', { subscriptions: [{ source, cursor: null }] })
  async function invoke(name, args) {
    call = { id: randomUUID(), name, args, sent: false }
    await request('chat/send', { source, mode: 'auto', text: call.id, images: [] })
    await until(() => call.result !== undefined, `工具 ${name}`)
    await until(async () => {
      const current = (await request('work-sessions/list')).workSessions.find(
        (item) => item.workId === workId
      )
      return ['idle', 'completed'].includes(current?.status)
    }, '聊天回合完成')
    return call.result
  }
  assert.match(await invoke('docker_fixture', {}), /PLUGIN_OK/)
  await invoke('write', { path: join(cwd, 'agent.txt'), content: 'DOCKER_AGENT_OK\n' })
  assert.match(await invoke('read', { path: join(cwd, 'agent.txt') }), /DOCKER_AGENT_OK/)
  assert.match(
    await invoke('bash', { command: 'git init -q; rg DOCKER_AGENT_OK agent.txt', timeout: 10 }),
    /DOCKER_AGENT_OK/
  )
  const text = await api('/api/project-files/get', {
    cwd,
    workId,
    path: 'agent.txt',
    imagePreviewMode: 'original'
  })
  assert.equal(text.content, 'DOCKER_AGENT_OK\n')
  const git = await api('/api/project-git/get', { cwd, workId })
  assert.match(JSON.stringify(git), /agent.txt/)
  await load('sharp')({ create: { width: 32, height: 32, channels: 3, background: '#556677' } })
    .png()
    .toFile(join(cwd, 'fixture.png'))
  const image = await api('/api/project-files/get', {
    cwd,
    workId,
    path: 'fixture.png',
    imagePreviewMode: 'compressed'
  })
  assert.equal(image.kind, 'image')
  await request('terminals/list')
  const terminal = await request('terminals/create', { cwd })
  await request('terminals/watch', { terminalId: terminal.terminalId })
  await request('terminals/input', {
    terminalId: terminal.terminalId,
    data: "printf '\\nPTY_%s\\n' READY\r"
  })
  await until(
    () =>
      frames.some(
        (frame) =>
          frame.head.path === 'terminals/event' && JSON.stringify(frame).includes('PTY_READY')
      ),
    '原生终端'
  )
  await request('terminals/remove', { terminalId: terminal.terminalId })
  const current = (await request('work-sessions/list')).workSessions.find(
    (item) => item.workId === workId
  )
  await writeFile(
    '/data/home/docker-smoke.json',
    JSON.stringify({ workId, sessionId, messageCount: current.messageCounts.total })
  )
  for (const command of ['git', 'bash', 'ssh', 'curl', 'python3', 'pnpm', 'rg', 'fd']) {
    execFileSync('sh', ['-c', `command -v ${command}`])
  }
  console.info('容器聊天工具、插件安装、文件、Git、Sharp 和原生终端验收通过。')
}

try {
  assert.equal(process.getuid(), 1000)
  if (process.argv[2] === '--persisted') await verifyPersisted()
  else await verifyRuntime(process.argv[2])
} catch (error) {
  console.error(output)
  console.error(error)
  process.exitCode = 1
} finally {
  socket?.terminate()
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(new Error('验收结束'))
  }
  pending.clear()
  if (runtime) await stopE2eServerTree(runtime)
  if (provider) {
    provider.closeAllConnections()
    await new Promise((done) => provider.close(done))
  }
}
