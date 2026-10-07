import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createJiti } from 'jiti'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type {
  L4PiChatWorker,
  L4PiChatWorkerEvent
} from '../src/server/l4_foundation/pi/l4-pi-chat-worker'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${description}`)
    await delay(10)
  }
}

function respond(response: ServerResponse, index: number, toolCount = 0): void {
  const delta = toolCount
    ? {
        tool_calls: Array.from({ length: toolCount }, (_, call) => ({
          index: call,
          id: `session-reload-${call}`,
          type: 'function',
          function: {
            name: 'pidesk',
            arguments: JSON.stringify({ args: ['session', 'reload'] })
          }
        }))
      }
    : { content: `第 ${index} 轮已结束。` }
  const base = {
    id: `reload-response-${index}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fixture'
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  for (const chunk of [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: toolCount ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
  ]) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

async function fixture(toolCount = 1): Promise<{
  worker: L4PiChatWorker
  manager: SessionManager
  bodies: string[]
  responses: ServerResponse[]
  events: L4PiChatWorkerEvent[]
  marker: string
  writePlugin: (version: number) => Promise<void>
  close: (succeeded: boolean) => Promise<void>
}> {
  const root = resolve('temp/run/pidesk-session-reload', `reload-notification-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const saved = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    PI_DESK_SAFE_MODE: process.env.PI_DESK_SAFE_MODE
  }
  const bodies: string[] = []
  const responses: ServerResponse[] = []
  const events: L4PiChatWorkerEvent[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      bodies.push(body)
      responses.push(response)
      if (bodies.length === 1) respond(response, 1, toolCount)
    })
  })
  const [{ SessionManager }, { L4PiChatWorker }, commands] = await Promise.all([
    jiti.import<typeof import('@earendil-works/pi-coding-agent')>(
      '@earendil-works/pi-coding-agent'
    ),
    jiti.import<typeof import('../src/server/l4_foundation/pi/l4-pi-chat-worker')>(
      '../src/server/l4_foundation/pi/l4-pi-chat-worker.ts'
    ),
    jiti.import<typeof import('../src/server/l4_foundation/pidesk/l4-pidesk-runtime')>(
      '../src/server/l4_foundation/pidesk/l4-pidesk-runtime.ts'
    )
  ])
  let worker: InstanceType<typeof L4PiChatWorker> | undefined
  async function close(succeeded: boolean): Promise<void> {
    try {
      await worker?.dispose()
    } finally {
      commands.disposeL4PiDeskCommands()
      server.closeAllConnections()
      if (server.listening) {
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => (error ? rejectClose(error) : resolveClose()))
        })
      }
      assert.equal(server.listening, false)
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (succeeded) await rm(root, { recursive: true, force: true })
      else console.error(`会话重载测试现场：${root}`)
    }
  }
  const marker = join(root, 'lifecycle.log')
  async function writePlugin(version: number): Promise<void> {
    await writeFile(
      join(agentDir, 'extensions', 'reload-fixture.ts'),
      `import { appendFileSync } from 'node:fs'
import { Type } from 'typebox'
export default function (pi) {
  pi.on('session_start', event => {
    appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${version}:`)} + event.reason + '\\n')
  })
  pi.registerTool({
    name: 'reload_fixture_v${version}', label: 'Fixture', description: 'Reload fixture ${version}',
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: '${version}' }], details: {} } }
  })
}
`
    )
  }
  try {
    await mkdir(join(agentDir, 'extensions'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
    delete process.env.PI_DESK_SAFE_MODE
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'reload-fixture',
        defaultModel: 'fixture',
        defaultThinkingLevel: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
        packages: []
      })
    )
    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'reload-fixture': {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: 'openai-completions',
            apiKey: 'fixture',
            models: [
              {
                id: 'fixture',
                reasoning: false,
                input: ['text'],
                contextWindow: 32768,
                maxTokens: 512
              }
            ]
          }
        }
      })
    )
    await writePlugin(1)
    await commands.initializeL4PiDeskCommands(async () => {
      throw new Error('会话命令不应进入插件安装业务')
    }, true)
    const manager = SessionManager.create(cwd, join(agentDir, 'sessions'))
    worker = new L4PiChatWorker(cwd, manager)
    worker.subscribe((event) => events.push(event))
    await worker.getRuntime()
    return { worker, manager, bodies, responses, events, marker, writePlugin, close }
  } catch (error) {
    await close(false)
    throw error
  }
}

test(
  '会话重载先接纳，等待当前轮和队列结束，加载新版插件后通知并唤醒',
  { timeout: 40_000 },
  async (t) => {
    const context = await fixture(2)
    const { worker, manager, bodies, responses, marker, events } = context
    let succeeded = false
    const readBlockReason = worker.readPluginReloadBlockReason.bind(worker)
    let checks = 0
    t.mock.method(worker, 'readPluginReloadBlockReason', () => {
      checks += 1
      return readBlockReason()
    })
    try {
      const sessionId = manager.getSessionId()
      await worker.send({ text: '重载当前会话', images: [], mode: 'auto' })
      await waitFor(() => bodies.length === 2 && checks > 0, '接纳结果返回且空闲检查运行')
      const receipts = manager
        .getEntries()
        .flatMap((entry) =>
          entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []
        )
      assert.equal(receipts.length, 2)
      assert.equal(receipts.filter((message) => message.isError).length, 1)
      assert.match(JSON.stringify(receipts.find((message) => !message.isError)), /async.*结束本轮/)
      assert.match(JSON.stringify(receipts.find((message) => message.isError)), /已有重载请求/)
      assert.equal(await readFile(marker, 'utf8'), '1:startup\n')
      const originalIds = manager.getBranch().map((entry) => entry.id)

      await context.writePlugin(2)
      await worker.send({ text: '重载前排队的消息', images: [], mode: 'follow_up' })
      respond(responses[1], 2)
      await waitFor(() => bodies.length === 3, '排队消息被模型接管')
      const checksBefore = checks
      await waitFor(() => checks > checksBefore, '排队消息处理期间仍等待空闲')
      assert.match(bodies[2], /重载前排队的消息/)
      assert.equal(await readFile(marker, 'utf8'), '1:startup\n')
      assert.equal(
        manager.getEntries().filter((entry) => entry.type === 'custom_message').length,
        0
      )

      respond(responses[2], 3)
      await waitFor(() => bodies.length === 4, '重载结果自动唤醒模型')
      assert.match(bodies[3], /Pi 配置已重载完成/)
      assert.match(bodies[3], /reload_fixture_v2/)
      const tools = await worker.listNativeTools()
      assert.ok(tools.some((tool) => tool.name === 'reload_fixture_v2'))
      assert.ok(!tools.some((tool) => tool.name === 'reload_fixture_v1'))
      assert.equal(await readFile(marker, 'utf8'), '1:startup\n2:reload\n')
      assert.equal(manager.getSessionId(), sessionId)
      assert.deepEqual(
        manager
          .getBranch()
          .slice(0, originalIds.length)
          .map((entry) => entry.id),
        originalIds
      )
      const completions = manager.getEntries().filter((entry) => entry.type === 'custom_message')
      assert.equal(completions.length, 1)
      assert.equal(completions[0].customType, 'pi-desk:command-result')
      assert.equal(completions[0].display, true)
      assert.deepEqual(completions[0].details, { toolCallId: 'session-reload-0' })
      assert.ok(
        events.some(
          (event) => event.type === 'message_commit' && event.entryId === completions[0].id
        )
      )
      assert.match(await readFile(manager.getSessionFile()!, 'utf8'), /Pi 配置已重载完成/)
      respond(responses[3], 4)
      await waitFor(() => readBlockReason() === null, '完成通知回复结束')
      succeeded = true
    } finally {
      await context.close(succeeded)
    }
  }
)

test('重载失败向原会话报告原因而不声称成功', { timeout: 30_000 }, async (t) => {
  const context = await fixture()
  const { worker, manager, bodies, responses } = context
  let succeeded = false
  const reload = t.mock.method(worker, 'reload', async () => {
    throw new Error('fixture 配置读取失败')
  })
  try {
    await worker.send({ text: '重载失败通知验证', images: [], mode: 'auto' })
    await waitFor(() => bodies.length === 2, '接纳重载')
    respond(responses[1], 2)
    await waitFor(() => bodies.length === 3, '失败通知自动唤醒')
    assert.equal(reload.mock.callCount(), 1)
    const completion = manager.getEntries().find((entry) => entry.type === 'custom_message')
    assert.ok(completion && completion.type === 'custom_message')
    assert.match(String(completion.content), /重载失败.*\n原因：fixture 配置读取失败/)
    assert.doesNotMatch(String(completion.content), /已重载完成/)
    respond(responses[2], 3)
    await waitFor(() => worker.readPluginReloadBlockReason() === null, '失败通知回复结束')
    succeeded = true
  } finally {
    await context.close(succeeded)
  }
})

test('等待中的重载随 Worker 释放取消，不操作或唤醒失效会话', { timeout: 30_000 }, async (t) => {
  const context = await fixture()
  const { worker, manager, bodies } = context
  let succeeded = false
  const reload = t.mock.method(worker, 'reload', async () => undefined)
  try {
    await worker.send({ text: '会话释放验证', images: [], mode: 'auto' })
    await waitFor(() => bodies.length === 2, '重载请求已接纳')
    await worker.dispose()
    await waitFor(() => Reflect.get(worker, 'reloadRequested') === false, '重载等待释放')
    assert.equal(reload.mock.callCount(), 0)
    assert.equal(bodies.length, 2)
    assert.equal(manager.getEntries().filter((entry) => entry.type === 'custom_message').length, 0)
    succeeded = true
  } finally {
    await context.close(succeeded)
  }
})
