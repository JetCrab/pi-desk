import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

type PiModule = typeof import('@earendil-works/pi-coding-agent')
type PiAiCompatModule = typeof import('@earendil-works/pi-ai/compat')
type WorkerModule = typeof import('../src/server/l4_foundation/pi/l4-pi-chat-worker')
type WorkSessionModule = typeof import('../src/server/l3_modules/work-session/l3-work-session')
type WorkSessionManageModule =
  typeof import('../src/server/l2_biz/work-session/l2-work-session-manage')
type PiWorkSessionRuntimeModule =
  typeof import('../src/server/l4_foundation/pi/l4-pi-work-session-runtime')
type PiWorkSessionRuntime = ReturnType<
  PiWorkSessionRuntimeModule['L4PiWorkSessionRuntime']['create']
>
type WorkSessionInstance = Awaited<ReturnType<WorkSessionModule['WorkSession']['create']>>
type Worker = InstanceType<WorkerModule['L4PiChatWorker']>
type WorkerRuntime = Awaited<ReturnType<Worker['getRuntime']>>
type WorkerEvent = Parameters<Parameters<Worker['subscribe']>[0]>[0]
type SessionManagerInstance = ReturnType<PiModule['SessionManager']['inMemory']>
type FixturePaths = {
  runRoot: string
  agentDir: string
  sessionDir: string
  cwd: string
}
type SavedPiEnvironment = {
  agentDir: string | undefined
  sessionDir: string | undefined
  safeMode: string | undefined
}

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})

async function loadModules(): Promise<[PiModule, WorkerModule]> {
  return Promise.all([
    jiti.import<PiModule>('@earendil-works/pi-coding-agent'),
    jiti.import<WorkerModule>('../src/server/l4_foundation/pi/l4-pi-chat-worker.ts')
  ])
}

async function loadWorkSessionModule(): Promise<WorkSessionModule> {
  return jiti.import<WorkSessionModule>('../src/server/l3_modules/work-session/l3-work-session.ts')
}

function savePiEnvironment(): SavedPiEnvironment {
  return {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
    safeMode: process.env.PI_DESK_SAFE_MODE
  }
}

function setPiEnvironment(paths: FixturePaths): void {
  process.env.PI_CODING_AGENT_DIR = paths.agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = paths.sessionDir
  delete process.env.PI_DESK_SAFE_MODE
}

function restorePiEnvironment(saved: SavedPiEnvironment): void {
  if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = saved.agentDir
  if (saved.sessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
  else process.env.PI_CODING_AGENT_SESSION_DIR = saved.sessionDir
  if (saved.safeMode === undefined) delete process.env.PI_DESK_SAFE_MODE
  else process.env.PI_DESK_SAFE_MODE = saved.safeMode
}

async function prepareFixture(
  taskId: string,
  baseUrl = 'http://127.0.0.1:9/v1'
): Promise<FixturePaths> {
  const runRoot = resolve('temp/pi/l4-pi-session-initialization', `${taskId}-${process.pid}`)
  const paths: FixturePaths = {
    runRoot,
    agentDir: join(runRoot, 'agent'),
    sessionDir: join(runRoot, 'agent', 'sessions'),
    cwd: join(runRoot, 'project')
  }
  await Promise.all([
    mkdir(join(paths.agentDir, 'extensions'), { recursive: true }),
    mkdir(paths.sessionDir, { recursive: true }),
    mkdir(paths.cwd, { recursive: true })
  ])
  await writeFile(
    join(paths.agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'local-fixture',
      defaultModel: 'default-model',
      defaultThinkingLevel: 'off',
      retry: { enabled: false },
      compaction: { enabled: false }
    }),
    'utf8'
  )
  await writeFile(
    join(paths.agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'local-fixture': {
          name: 'Local Test Fixture',
          baseUrl,
          api: 'openai-completions',
          apiKey: 'fixture-only',
          models: [
            {
              id: 'default-model',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 256
            },
            {
              id: 'history-model',
              reasoning: true,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 256
            }
          ]
        }
      }
    }),
    'utf8'
  )
  return paths
}

async function writeExtension(paths: FixturePaths, source: string): Promise<void> {
  await writeFile(join(paths.agentDir, 'extensions', 'initialization-fixture.ts'), source, 'utf8')
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`)
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
  }
}

function recordAt(value: unknown, key: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const result: unknown = Reflect.get(value, key)
  assert.ok(result && typeof result === 'object' && !Array.isArray(result))
  return result as Record<string, unknown>
}

function recordsAt(value: unknown, key: string): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const marker: unknown = Reflect.get(value, key)
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return []
  const records: unknown = Reflect.get(marker, 'instances')
  return Array.isArray(records) ? (records as Array<Record<string, unknown>>) : []
}

function callIfFunction(value: Record<string, unknown>, key: string): void {
  const callback = Reflect.get(value, key)
  if (typeof callback === 'function') Reflect.apply(callback, undefined, [])
}

async function startFakeModelServer(): Promise<{
  server: ReturnType<typeof createServer>
  port: number
  getRequestCount: () => number
  close: () => Promise<void>
}> {
  let requestCount = 0
  const server = createServer((request, response) => {
    request.on('data', () => undefined)
    request.on('end', () => {
      requestCount += 1
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'close'
      })
      const base = {
        id: `chatcmpl-initialization-${requestCount}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'default-model'
      }
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        {
          ...base,
          choices: [
            { index: 0, delta: { content: 'local fallback response' }, finish_reason: null }
          ]
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 }
        }
      ]
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.once('listening', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    server,
    port: address.port,
    getRequestCount: () => requestCount,
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      })
      const probe = createServer()
      await new Promise<void>((resolveListen, rejectListen) => {
        probe.once('error', rejectListen)
        probe.listen(address.port, '127.0.0.1', () => {
          probe.close((error) => (error ? rejectListen(error) : resolveListen()))
        })
      })
    }
  }
}

const initMarker = '__piDeskSessionInitializationFixture'

const hangingExtension = `
import { bindSessionPlugin } from '@jetcrab/pi-desk-sdk'
const shared = globalThis.${initMarker} ??= { hang: true, instances: [] }
export default function initializationFixture(pi) {
  const state = { hang: shared.hang, started: false, finished: false, shutdownStarted: false }
  shared.instances.push(state)
  const plugin = bindSessionPlugin(pi, 'late-init-fixture')
  pi.on('session_start', async (_event, context) => {
    state.sessionId = context.sessionManager.getSessionId()
    state.getEntries = context.sessionManager.getEntries
    state.started = true
    if (state.hang) await new Promise((resolve) => { state.releaseStart = resolve })
    try {
      state.entryCountAfterRetire = state.getEntries().length
    } catch (error) {
      state.readError = error instanceof Error ? error.message : String(error)
    }
    state.publishErrors = []
    for (const publish of [
      () => plugin.setState({ late: true }),
      () => plugin.push('late', { changed: true })
    ]) {
      try { publish() }
      catch (error) { state.publishErrors.push(error instanceof Error ? error.message : String(error)) }
    }
    state.finished = true
  })
  pi.on('session_shutdown', async () => {
    state.shutdownStarted = true
    if (state.hang) await new Promise((resolve) => { state.releaseShutdown = resolve })
    state.shutdownFinished = true
  })
}
`

test('降级保持L3 WorkSession的workId、sessionId和branchId不变', { timeout: 20_000 }, async () => {
  const savedEnvironment = savePiEnvironment()
  const paths = await prepareFixture('work-session-source-stability')
  let runtime: PiWorkSessionRuntime | undefined
  let workSession: WorkSessionInstance | undefined
  let succeeded = false
  try {
    await writeExtension(
      paths,
      `export default function () { throw new Error('work-session source fixture failure') }`
    )
    setPiEnvironment(paths)
    const { WorkSession } = await loadWorkSessionModule()
    const workId = 'initialization-source-work'
    workSession = await WorkSession.create(workId, paths.cwd)
    runtime = Reflect.get(workSession, 'runtime') as PiWorkSessionRuntime
    const originalSource = {
      workId: workSession.workId,
      sessionId: workSession.sessionId,
      branchId: workSession.branchId
    }

    await workSession.setModel({
      provider: 'local-fixture',
      modelId: 'default-model',
      thinkingLevel: 'off'
    })
    const worker = Reflect.get(runtime, 'chatWorker') as Worker
    const chatRuntime = await worker.getRuntime()
    assert.equal(chatRuntime.extensionMode, 'basic')
    assert.match(chatRuntime.initializationError ?? '', /work-session source fixture failure/)
    assert.deepEqual(
      {
        workId: workSession.workId,
        sessionId: workSession.sessionId,
        branchId: workSession.branchId
      },
      originalSource
    )
    succeeded = true
  } finally {
    await runtime?.dispose()
    restorePiEnvironment(savedEnvironment)
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
  }
})

test('Pi Session 初始化真实恢复历史模型并合并并发打开请求', { timeout: 30_000 }, async () => {
  const savedEnvironment = savePiEnvironment()
  const paths = await prepareFixture('history-and-concurrency')
  const globalState = globalThis as Record<string, unknown>
  delete globalState[initMarker]
  let worker: Worker | undefined
  let newSessionWorker: Worker | undefined
  let succeeded = false
  try {
    await writeExtension(
      paths,
      `const state = globalThis.${initMarker} ??= { factories: 0 }\nexport default function () { state.factories += 1 }\n`
    )
    setPiEnvironment(paths)
    const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
    const manager = SessionManager.create(paths.cwd, paths.sessionDir)
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'historical model fixture' }],
      timestamp: Date.now()
    })
    manager.appendModelChange('local-fixture', 'history-model')
    manager.appendThinkingLevelChange('off')
    const sessionId = manager.getSessionId()
    worker = new L4PiChatWorker(paths.cwd, manager)
    const runtimeEvents: WorkerRuntime[] = []
    worker.subscribe((event) => {
      if (event.type === 'runtime_changed') runtimeEvents.push(event.runtime)
    })

    const concurrent = await Promise.all([
      worker.getRuntime(),
      worker.getRuntime(),
      worker.getRuntime()
    ])
    for (const runtime of concurrent) {
      assert.equal(runtime.extensionMode, 'normal')
      assert.equal(runtime.initializationError, null)
      assert.deepEqual(runtime.model, {
        provider: 'local-fixture',
        modelId: 'history-model',
        thinkingLevel: 'off'
      })
    }
    assert.equal(manager.getSessionId(), sessionId)
    assert.equal(recordAt(globalState, initMarker).factories, 1)
    assert.deepEqual(runtimeEvents.at(-1)?.model, concurrent[0]?.model)

    const freshCwd = join(paths.runRoot, 'fresh-project')
    await mkdir(freshCwd, { recursive: true })
    const freshManager = SessionManager.create(freshCwd, paths.sessionDir)
    newSessionWorker = new L4PiChatWorker(freshCwd, freshManager)
    const freshRuntime = await newSessionWorker.getRuntime()
    assert.deepEqual(freshRuntime.model, {
      provider: 'local-fixture',
      modelId: 'default-model',
      thinkingLevel: 'off'
    })
    assert.equal(recordAt(globalState, initMarker).factories, 2)
    succeeded = true
  } finally {
    await newSessionWorker?.dispose()
    await worker?.dispose()
    restorePiEnvironment(savedEnvironment)
    delete globalState[initMarker]
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
  }
})

test(
  '插件import、factory和session_start错误均降级到基础会话并保留诊断',
  { timeout: 45_000 },
  async () => {
    const savedEnvironment = savePiEnvironment()
    const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
    const cases = [
      {
        name: 'import',
        source: `throw new Error('import fixture failure')`
      },
      {
        name: 'factory',
        source: `export default function () { throw new Error('factory fixture failure') }`
      },
      {
        name: 'session-start',
        source: `export default function (pi) { pi.on('session_start', () => { throw new Error('session_start fixture failure') }) }`
      }
    ] as const

    try {
      for (const scenario of cases) {
        const paths = await prepareFixture(`failure-${scenario.name}`)
        let worker: Worker | undefined
        let succeeded = false
        try {
          await writeExtension(paths, scenario.source)
          setPiEnvironment(paths)
          const manager = SessionManager.create(paths.cwd, paths.sessionDir)
          const sessionId = manager.getSessionId()
          worker = new L4PiChatWorker(paths.cwd, manager)
          const runtime = await worker.getRuntime()
          assert.equal(runtime.extensionMode, 'basic', scenario.name)
          assert.ok(runtime.initializationError?.includes('fixture failure'), scenario.name)
          assert.match(runtime.initializationError ?? '', /插件 initialization-fixture/)
          assert.match(runtime.initializationError ?? '', /来源：/)
          assert.match(runtime.initializationError ?? '', /当前步骤耗时：/)
          assert.equal(runtime.model?.provider, 'local-fixture')
          assert.equal(manager.getSessionId(), sessionId)
          assert.ok(Reflect.get(worker, 'session'))
          succeeded = true
        } finally {
          await worker?.dispose()
          if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
        }
      }
    } finally {
      restorePiEnvironment(savedEnvironment)
    }
  }
)

test('默认重载重新启用扩展并清诊断，再次失败仍回到basic', { timeout: 45_000 }, async () => {
  const savedEnvironment = savePiEnvironment()
  const paths = await prepareFixture('reload-recovery')
  const globalState = globalThis as Record<string, unknown>
  delete globalState[initMarker]
  let worker: Worker | undefined
  let succeeded = false
  try {
    await writeExtension(
      paths,
      `const state = globalThis.${initMarker} ??= { fail: true, factories: 0 }\nexport default function () { state.factories += 1; if (state.fail) throw new Error('reload fixture failure') }\n`
    )
    setPiEnvironment(paths)
    const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
    const manager = SessionManager.create(paths.cwd, paths.sessionDir)
    worker = new L4PiChatWorker(paths.cwd, manager)
    const failed = await worker.getRuntime()
    assert.equal(failed.extensionMode, 'basic')
    assert.match(failed.initializationError ?? '', /reload fixture failure/)

    recordAt(globalState, initMarker).fail = false
    await worker.reload()
    const recovered = await worker.getRuntime()
    assert.equal(recovered.extensionMode, 'normal')
    assert.equal(recovered.initializationError, null)

    await worker.reload('basic')
    recordAt(globalState, initMarker).fail = true
    await worker.reload()
    const failedAgain = await worker.getRuntime()
    assert.equal(failedAgain.extensionMode, 'basic')
    assert.match(failedAgain.initializationError ?? '', /reload fixture failure/)
    succeeded = true
  } finally {
    await worker?.dispose()
    restorePiEnvironment(savedEnvironment)
    delete globalState[initMarker]
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
  }
})

test('官方 MCP 在会话启动后连接并随重载和基础模式释放', { timeout: 30_000 }, async () => {
  const savedEnvironment = savePiEnvironment()
  const paths = await prepareFixture('mcp-http-lifecycle')
  const connections = new Set<import('node:http').ServerResponse>()
  let opened = 0
  let worker: Worker | undefined
  let succeeded = false
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      connections.add(response)
      response.on('close', () => connections.delete(response))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.flushHeaders()
      return
    }
    if (request.method === 'DELETE') {
      response.writeHead(204).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'GET, POST, DELETE' }).end()
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      const message = JSON.parse(body) as {
        id?: number | string
        method: string
        params?: { protocolVersion?: string }
      }
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      let result: Record<string, unknown> = {}
      if (message.method === 'initialize') {
        response.setHeader('Mcp-Session-Id', String(++opened))
        result = {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'local-fixture', version: '1.0.0' }
        }
      } else if (message.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'echo',
              description: 'Local echo fixture',
              inputSchema: { type: 'object', properties: {} }
            }
          ]
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.once('listening', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await writeFile(
      join(paths.agentDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: { url: `http://127.0.0.1:${address.port}/mcp`, exposure: 'deferred' }
        }
      })
    )
    setPiEnvironment(paths)
    const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
    const manager = SessionManager.inMemory(paths.cwd)
    worker = new L4PiChatWorker(paths.cwd, manager)
    assert.equal((await worker.getRuntime()).extensionMode, 'normal')
    const sessionId = manager.getSessionId()
    const hasMcpTool = (): boolean => {
      const session = Reflect.get(worker!, 'session') as
        import('@earendil-works/pi-coding-agent').AgentSession | null
      return session?.getAllTools().some((tool) => tool.name === 'mcp__fixture__echo') ?? false
    }
    await waitUntil(() => hasMcpTool() && connections.size === 1, '真实 HTTP MCP 工具已动态登记')
    assert.equal(connections.size, 1)
    const tools = await worker.listNativeTools()
    assert.equal(tools.find((tool) => tool.name === 'mcp__fixture__echo')?.active, false)
    assert.equal(tools.find((tool) => tool.name === 'tool_search')?.active, true)
    assert.equal(
      (await worker.listNativeCommands()).some((command) => command.name === 'mcp'),
      true
    )
    await worker.executeNativeCommand('mcp', '')

    await worker.reload()
    await waitUntil(
      () => opened === 2 && connections.size === 1 && hasMcpTool(),
      'MCP 重载替换连接'
    )
    await worker.reload('basic')
    await waitUntil(() => connections.size === 0, '基础模式关闭 MCP 连接')
    assert.equal((await worker.getRuntime()).extensionMode, 'basic')
    assert.equal(hasMcpTool(), false)
    assert.equal(manager.getSessionId(), sessionId)
    await worker.reload()
    await waitUntil(() => opened === 3 && hasMcpTool(), '正常模式恢复 MCP 连接')
    await worker.dispose()
    await waitUntil(() => connections.size === 0, 'Worker 关闭后 MCP 通知连接已释放')
    succeeded = true
  } finally {
    await worker?.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    })
    const probe = createServer()
    await new Promise<void>((resolveProbe, rejectProbe) => {
      probe.once('error', rejectProbe)
      probe.listen(address.port, '127.0.0.1', () => {
        probe.close((error) => (error ? rejectProbe(error) : resolveProbe()))
      })
    })
    restorePiEnvironment(savedEnvironment)
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
    else console.error(`MCP 连接验证现场：${paths.runRoot}`)
  }
})

test('正常模式重载失败保留历史并恢复可发送的基础会话', { timeout: 45_000 }, async (t) => {
  const savedEnvironment = savePiEnvironment()
  const provider = await startFakeModelServer()
  const cases = [
    {
      name: 'factory',
      source: `export default function () { throw new Error('reload factory broken') }`
    },
    {
      name: 'start',
      source: `export default function (pi) { pi.on('session_start', () => { throw new Error('reload start broken') }) }`
    }
  ]
  t.mock.method(console, 'error', () => undefined)
  let expectedRequests = 0
  try {
    for (const scenario of cases) {
      const paths = await prepareFixture(
        `normal-reload-${scenario.name}`,
        `http://127.0.0.1:${provider.port}/v1`
      )
      let worker: Worker | undefined
      let succeeded = false
      try {
        setPiEnvironment(paths)
        await writeExtension(paths, 'export default function () {}')
        const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
        const manager = SessionManager.create(paths.cwd, paths.sessionDir)
        manager.appendMessage({ role: 'user', content: 'existing history', timestamp: Date.now() })
        worker = new L4PiChatWorker(paths.cwd, manager)
        assert.equal((await worker.getRuntime()).extensionMode, 'normal')
        const sessionId = manager.getSessionId()
        const entryIds = manager.getBranch().map((entry) => entry.id)

        await writeExtension(paths, scenario.source)
        await worker.reload()
        const runtime = await worker.getRuntime()
        assert.equal(runtime.extensionMode, 'basic', scenario.name)
        assert.match(runtime.initializationError ?? '', /reload (factory|start) broken/)
        assert.equal(manager.getSessionId(), sessionId)
        assert.deepEqual(
          manager.getBranch().map((entry) => entry.id),
          entryIds
        )
        assert.equal(
          (await worker.listNativeCommands()).some((command) => command.name === 'mcp'),
          false
        )

        await worker.send({ mode: 'auto', text: 'continue after reload failure', images: [] })
        await waitUntil(
          () =>
            manager
              .getEntries()
              .some((entry) => entry.type === 'message' && entry.message.role === 'assistant') &&
            worker?.readPluginReloadBlockReason() === null,
          '重载失败后基础模型已完成回答'
        )
        expectedRequests += 1
        assert.equal(provider.getRequestCount(), expectedRequests)

        await writeExtension(paths, 'export default function () {}')
        await worker.reload()
        assert.equal((await worker.getRuntime()).extensionMode, 'normal')
        assert.equal((await worker.getRuntime()).initializationError, null)
        succeeded = true
      } finally {
        await worker?.dispose()
        if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
        else console.error(`正常重载恢复现场：${paths.runRoot}`)
      }
    }
  } finally {
    await provider.close()
    restorePiEnvironment(savedEnvironment)
  }
})

test('排队超时与插件工厂超时分别给出可定位诊断', { timeout: 150_000 }, async () => {
  const saved = savePiEnvironment()
  const paths = await prepareFixture('timeout-diagnostics')
  const globalState = globalThis as Record<string, unknown>
  const marker = '__piDeskLoadDiagnosticFixture'
  const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
  const { runL4PiPackageRootExclusive } = await jiti.import<
    typeof import('../src/server/l4_foundation/pi/l4-pi-package-root-gate')
  >('../src/server/l4_foundation/pi/l4-pi-package-root-gate.ts')
  let worker: Worker | undefined
  let releaseQueue: (() => void) | undefined
  let retired: Promise<unknown> | undefined
  let succeeded = false
  try {
    setPiEnvironment(paths)
    await writeExtension(paths, 'export default function () {}')
    const blocker = runL4PiPackageRootExclusive(
      () =>
        new Promise<void>((done) => {
          releaseQueue = done
        })
    )
    await waitUntil(() => Boolean(releaseQueue), '测试资源门已持有')
    const queuedStartedAt = performance.now()
    worker = new L4PiChatWorker(paths.cwd, SessionManager.inMemory(paths.cwd))
    const queuedInitialization = Reflect.get(worker, 'initialization')
    const queued = await worker.getRuntime()
    assert.ok(performance.now() - queuedStartedAt >= 60_000)
    assert.equal(queued.extensionMode, 'basic')
    assert.match(queued.initializationError ?? '', /等待插件资源队列/)
    assert.doesNotMatch(queued.initializationError ?? '', /插件 initialization-fixture/)
    assert.match(queued.initializationError ?? '', /当前步骤耗时：\d+ 毫秒/)
    retired = Reflect.get(queuedInitialization, 'execution') as Promise<unknown>
    releaseQueue!()
    await blocker
    await retired.catch(() => undefined)
    assert.equal((await worker.getRuntime()).initializationError, queued.initializationError)
    await worker.dispose()
    worker = undefined

    await writeExtension(
      paths,
      `const state = globalThis.${marker} = {}; export default async function () {
      state.started = true;
      await new Promise(resolve => { state.release = resolve });
      state.finished = true;
    }`
    )
    worker = new L4PiChatWorker(paths.cwd, SessionManager.inMemory(paths.cwd))
    const pluginInitialization = Reflect.get(worker, 'initialization')
    const opening = worker.getRuntime()
    await waitUntil(
      () => globalState[marker] !== undefined && recordAt(globalState, marker).started === true,
      '真实插件工厂已挂起'
    )
    const stalled = await opening
    assert.equal(stalled.extensionMode, 'basic')
    assert.match(stalled.initializationError ?? '', /插件 initialization-fixture/)
    assert.match(stalled.initializationError ?? '', /步骤：执行插件工厂/)
    assert.match(stalled.initializationError ?? '', /初始化超时（60 秒）/)
    assert.doesNotMatch(stalled.initializationError ?? '', /等待插件资源队列/)
    retired = Reflect.get(pluginInitialization, 'execution') as Promise<unknown>
    callIfFunction(recordAt(globalState, marker), 'release')
    await retired.catch(() => undefined)
    assert.equal((await worker.getRuntime()).initializationError, stalled.initializationError)
    succeeded = true
  } finally {
    releaseQueue?.()
    if (globalState[marker]) callIfFunction(recordAt(globalState, marker), 'release')
    await retired?.catch(() => undefined)
    await worker?.dispose()
    restorePiEnvironment(saved)
    delete globalState[marker]
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
  }
})

test('挂起初始化撤销旧访问，基础聊天接管且限制退役任务数量', { timeout: 90_000 }, async () => {
  const savedEnvironment = savePiEnvironment()
  const provider = await startFakeModelServer()
  const paths = await prepareFixture('retired-limit', `http://127.0.0.1:${provider.port}/v1`)
  const globalState = globalThis as Record<string, unknown>
  delete globalState[initMarker]
  const workers: Worker[] = []
  const managers: SessionManagerInstance[] = []
  const eventLists: WorkerEvent[][] = []
  let unregisterOldResourceCleanup: (() => void) | undefined
  let unregisterNewResourceCleanup: (() => void) | undefined
  let oldResourceCleanupCount = 0
  let newResourceCleanupCount = 0
  let succeeded = false
  try {
    await writeExtension(paths, hangingExtension)
    setPiEnvironment(paths)
    const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
    const { registerSessionResourceCleanup } = await jiti.import<PiAiCompatModule>(
      '@earendil-works/pi-ai/compat'
    )
    for (let index = 0; index < 4; index += 1) {
      const cwd = join(paths.runRoot, `project-${index}`)
      await mkdir(cwd, { recursive: true })
      const manager = SessionManager.create(cwd, paths.sessionDir)
      manager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: `retired fixture ${index}` }],
        timestamp: Date.now()
      })
      managers.push(manager)
      const worker = new L4PiChatWorker(cwd, manager)
      workers.push(worker)
      const events: WorkerEvent[] = []
      eventLists.push(events)
      worker.subscribe((event) => events.push(event))
    }

    const firstRepeatedOpening = Promise.all([workers[0]!.getRuntime(), workers[0]!.getRuntime()])
    await waitUntil(
      () => recordsAt(globalState, initMarker)[0]?.started === true,
      '首个真实Pi插件session_start已挂起'
    )
    const remainingOpenings = workers
      .slice(1)
      .map((worker) => Promise.all([worker.getRuntime(), worker.getRuntime()]))
    const repeatedOpening = [firstRepeatedOpening, ...remainingOpenings]
    const initialSessionIds = managers.map((manager) => manager.getSessionId())
    const firstSessionId = initialSessionIds[0]
    assert.ok(firstSessionId)
    unregisterOldResourceCleanup = registerSessionResourceCleanup((sessionId) => {
      if (sessionId === firstSessionId) oldResourceCleanupCount += 1
    })
    const initializations = workers.map((worker) => Reflect.get(worker, 'initialization'))
    const guardedManagers = initializations.map((initialization) =>
      Reflect.get(initialization, 'manager')
    )
    const staleAppend = Reflect.get(guardedManagers[0], 'appendMessage')
    assert.equal(typeof staleAppend, 'function')

    const runtimes = await Promise.all(repeatedOpening)
    assert.equal(oldResourceCleanupCount, 1)
    for (let index = 0; index < runtimes.length; index += 1) {
      const runtime = runtimes[index]?.[0]
      assert.equal(runtime?.extensionMode, 'basic')
      assert.match(runtime?.initializationError ?? '', /超时（60 秒）/)
      assert.equal(managers[index]?.getSessionId(), initialSessionIds[index])
      assert.deepEqual(runtimes[index]?.[1], runtime)
    }
    const initialInstances = recordsAt(globalState, initMarker)
    assert.equal(initialInstances.length, initialSessionIds.length)
    assert.deepEqual(
      new Set(initialInstances.map((instance) => instance.sessionId)),
      new Set(initialSessionIds)
    )

    const fifthCwd = join(paths.runRoot, 'project-4')
    await mkdir(fifthCwd, { recursive: true })
    const fifthManager = SessionManager.create(fifthCwd, paths.sessionDir)
    managers.push(fifthManager)
    const fifthWorker = new L4PiChatWorker(fifthCwd, fifthManager)
    workers.push(fifthWorker)
    eventLists.push([])
    const cappedRuntime = await fifthWorker.getRuntime()
    assert.equal(cappedRuntime.extensionMode, 'basic')
    assert.match(cappedRuntime.initializationError ?? '', /插件初始化或关闭任务过多/)
    assert.equal(recordsAt(globalState, initMarker).length, initialSessionIds.length)

    unregisterNewResourceCleanup = registerSessionResourceCleanup((sessionId) => {
      if (sessionId === firstSessionId) newResourceCleanupCount += 1
    })
    const firstManager = managers[0]
    const firstSessionFile = firstManager?.getSessionFile()
    assert.ok(firstManager && firstSessionFile)
    assert.throws(
      () =>
        Reflect.apply(staleAppend, guardedManagers[0], [
          {
            role: 'user',
            content: [{ type: 'text', text: 'late append must be rejected' }],
            timestamp: Date.now()
          }
        ]),
      /会话实例已失效/
    )
    const assistantCountBeforeSend = firstManager
      .getEntries()
      .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').length
    await workers[0]?.send({
      mode: 'auto',
      text: 'continue in basic mode',
      images: []
    })
    await waitUntil(
      () =>
        firstManager
          .getEntries()
          .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')
          .length > assistantCountBeforeSend && workers[0]?.readPluginReloadBlockReason() === null,
      '基础模式本地模型assistant完成',
      20_000
    )
    assert.equal(provider.getRequestCount(), 1)
    const basicRuntimeBeforeRelease = await workers[0]?.getRuntime()
    assert.equal(basicRuntimeBeforeRelease?.extensionMode, 'basic')
    assert.equal(basicRuntimeBeforeRelease?.plugins['late-init-fixture'], undefined)
    assert.equal(
      (await workers[0]?.listModels())?.models.some((model) => model.modelId === 'default-model'),
      true
    )
    await waitUntil(() => existsSync(firstSessionFile), 'Pi assistant JSONL已落盘')
    const persistedAfterSend = await readFile(firstSessionFile, 'utf8')
    const leafAfterSend = firstManager.getLeafId()

    const instances = recordsAt(globalState, initMarker)
    for (const instance of instances) callIfFunction(instance, 'releaseStart')
    await waitUntil(
      () => instances.every((instance) => instance.finished === true),
      '旧初始化回调迟到完成'
    )
    for (const instance of instances) {
      assert.match(String(instance.readError), /会话实例已失效/)
      assert.ok(Array.isArray(instance.publishErrors))
      assert.equal(instance.publishErrors.length, 2)
      assert.ok(
        instance.publishErrors.every(
          (error) => typeof error === 'string' && /ctx is stale/.test(error)
        ),
        JSON.stringify(instance.publishErrors)
      )
    }
    await waitUntil(
      () => instances.every((instance) => instance.shutdownStarted === true),
      '旧session_shutdown清理已启动'
    )
    for (const instance of instances) callIfFunction(instance, 'releaseShutdown')
    await waitUntil(
      () => instances.every((instance) => instance.shutdownFinished === true),
      '旧关闭钩子收敛'
    )

    assert.equal(await readFile(firstSessionFile, 'utf8'), persistedAfterSend)
    assert.equal(firstManager.getLeafId(), leafAfterSend)
    assert.equal(oldResourceCleanupCount, 1)
    assert.equal(newResourceCleanupCount, 0)
    const lateRuntime = await workers[0]?.getRuntime()
    assert.deepEqual(lateRuntime, basicRuntimeBeforeRelease)
    assert.equal(lateRuntime?.plugins['late-init-fixture'], undefined)
    assert.equal(
      eventLists[0]?.some((event) => event.type === 'plugin_push'),
      false
    )
    recordAt(globalState, initMarker).hang = false
    const sixthCwd = join(paths.runRoot, 'project-5')
    await mkdir(sixthCwd, { recursive: true })
    const sixthManager = SessionManager.create(sixthCwd, paths.sessionDir)
    managers.push(sixthManager)
    const sixthWorker = new L4PiChatWorker(sixthCwd, sixthManager)
    workers.push(sixthWorker)
    eventLists.push([])
    const postCleanupRuntime = await sixthWorker.getRuntime()
    assert.equal(postCleanupRuntime.extensionMode, 'normal')
    assert.equal(recordsAt(globalState, initMarker).length, initialSessionIds.length + 1)
    assert.equal(provider.getRequestCount(), 1)
    await workers[0]?.dispose()
    assert.equal(oldResourceCleanupCount, 2)
    assert.equal(newResourceCleanupCount, 1)
    unregisterNewResourceCleanup()
    unregisterNewResourceCleanup = undefined
    unregisterOldResourceCleanup()
    unregisterOldResourceCleanup = undefined
    succeeded = true
  } finally {
    for (const instance of recordsAt(globalState, initMarker)) {
      callIfFunction(instance, 'releaseStart')
      callIfFunction(instance, 'releaseShutdown')
    }
    for (const worker of workers.reverse()) await worker.dispose().catch(() => undefined)
    unregisterNewResourceCleanup?.()
    unregisterOldResourceCleanup?.()
    await provider.close()
    restorePiEnvironment(savedEnvironment)
    delete globalState[initMarker]
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
  }
})

test('session_start失败后旧session_shutdown悬挂不阻塞基础发送', { timeout: 30_000 }, async () => {
  const savedEnvironment = savePiEnvironment()
  const provider = await startFakeModelServer()
  const paths = await prepareFixture('shutdown-hang', `http://127.0.0.1:${provider.port}/v1`)
  const globalState = globalThis as Record<string, unknown>
  delete globalState[initMarker]
  let worker: Worker | undefined
  let releaseShutdown: (() => void) | undefined
  let succeeded = false
  try {
    await writeExtension(
      paths,
      `const shared = globalThis.${initMarker} ??= { shutdownStarted: false }\nexport default function (pi) {\n  pi.on('session_start', () => { throw new Error('session_start shutdown fixture failure') })\n  pi.on('session_shutdown', async () => { shared.shutdownStarted = true; await new Promise((resolve) => { shared.releaseShutdown = resolve }) })\n}\n`
    )
    setPiEnvironment(paths)
    const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
    const manager = SessionManager.create(paths.cwd, paths.sessionDir)
    const sessionId = manager.getSessionId()
    worker = new L4PiChatWorker(paths.cwd, manager)
    const events: WorkerEvent[] = []
    worker.subscribe((event) => events.push(event))
    const startedAt = Date.now()
    const runtime = await worker.getRuntime()
    assert.equal(runtime.extensionMode, 'basic')
    assert.match(runtime.initializationError ?? '', /session_start shutdown fixture failure/)
    await waitUntil(
      () => recordAt(globalState, initMarker).shutdownStarted === true,
      '旧关闭钩子启动'
    )
    assert.ok(Date.now() - startedAt < 10_000)
    assert.equal(manager.getSessionId(), sessionId)

    const assistantCountBeforeSend = manager
      .getEntries()
      .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').length
    await worker.send({
      mode: 'auto',
      text: 'basic send while old shutdown hangs',
      images: []
    })
    await waitUntil(
      () =>
        manager
          .getEntries()
          .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')
          .length > assistantCountBeforeSend && worker?.readPluginReloadBlockReason() === null,
      '基础模式assistant发送完成'
    )
    assert.equal(provider.getRequestCount(), 1)
    assert.ok(
      events.some(
        (event) => event.type === 'runtime_changed' && event.runtime.extensionMode === 'basic'
      )
    )
    releaseShutdown = Reflect.get(recordAt(globalState, initMarker), 'releaseShutdown') as
      (() => void) | undefined
    releaseShutdown?.()
    succeeded = true
  } finally {
    releaseShutdown ??= Reflect.get(recordAt(globalState, initMarker), 'releaseShutdown') as
      (() => void) | undefined
    releaseShutdown?.()
    await worker?.dispose()
    await provider.close()
    restorePiEnvironment(savedEnvironment)
    delete globalState[initMarker]
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
  }
})

test('基础会话自身初始化失败时拒绝请求和订阅且不递归降级', { timeout: 20_000 }, async () => {
  const savedEnvironment = savePiEnvironment()
  const paths = await prepareFixture('basic-failure')
  let worker: Worker | undefined
  let manage: InstanceType<WorkSessionManageModule['WorkSessionManage']> | undefined
  let succeeded = false
  try {
    await writeFile(join(paths.agentDir, 'settings.json'), '{ invalid settings json', 'utf8')
    await writeExtension(
      paths,
      `export default function () { throw new Error('must not start basic twice') }`
    )
    setPiEnvironment(paths)
    const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
    worker = new L4PiChatWorker(paths.cwd, SessionManager.create(paths.cwd, paths.sessionDir))
    await assert.rejects(worker.getRuntime())
    assert.equal(Reflect.get(worker, 'extensionMode'), 'basic')
    assert.equal(Reflect.get(worker, 'session'), null)
    assert.equal(Reflect.get(worker, 'initializePromise'), null)

    const { WorkSessionManage } = await jiti.import<WorkSessionManageModule>(
      '../src/server/l2_biz/work-session/l2-work-session-manage.ts'
    )
    manage = new WorkSessionManage(join(paths.runRoot, 'work-sessions.json'))
    const item = await manage.createWorkSession(paths.cwd)
    await assert.rejects(
      manage.prepareChatSourceSyncs([
        {
          source: { workId: item.workId, sessionId: item.sessionId, branchId: item.branchId },
          cursor: null
        }
      ]),
      /Expected property name/
    )
    succeeded = true
  } finally {
    if (manage) {
      for (const item of (await manage.listWorkSessions()).workSessions) {
        await manage.removeWorkSession(item.workId)
      }
    }
    await worker?.dispose()
    restorePiEnvironment(savedEnvironment)
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
  }
})

test('dispose在插件初始化中途撤销实例且不创建基础替代实例', { timeout: 20_000 }, async (t) => {
  const savedEnvironment = savePiEnvironment()
  const paths = await prepareFixture('dispose-during-initialization')
  const errors = t.mock.method(console, 'error', () => undefined)
  const globalState = globalThis as Record<string, unknown>
  delete globalState[initMarker]
  let worker: Worker | undefined
  let succeeded = false
  try {
    await writeExtension(paths, hangingExtension)
    setPiEnvironment(paths)
    const [{ SessionManager }, { L4PiChatWorker }] = await loadModules()
    worker = new L4PiChatWorker(paths.cwd, SessionManager.create(paths.cwd, paths.sessionDir))
    const pending = worker.getRuntime()
    await waitUntil(
      () =>
        recordsAt(globalState, initMarker).length === 1 &&
        recordsAt(globalState, initMarker)[0]?.started === true,
      '正常Session启动钩子'
    )
    const disposing = worker.dispose()
    await assert.rejects(pending, /会话实例已失效/)
    await disposing
    assert.equal(errors.mock.callCount(), 0)
    assert.equal(recordsAt(globalState, initMarker).length, 1)
    assert.equal(Reflect.get(worker, 'session'), null)

    const instance = recordsAt(globalState, initMarker)[0]
    callIfFunction(instance!, 'releaseStart')
    await waitUntil(() => instance?.finished === true, '被撤销的初始化回调结束')
    assert.match(String(instance?.readError), /会话实例已失效/)
    assert.ok(Array.isArray(instance?.publishErrors))
    assert.equal(instance.publishErrors.length, 2)
    assert.ok(
      instance.publishErrors.every(
        (error) => typeof error === 'string' && /ctx is stale/.test(error)
      ),
      JSON.stringify(instance.publishErrors)
    )
    await waitUntil(() => instance?.shutdownStarted === true, '被撤销实例关闭钩子启动')
    callIfFunction(instance!, 'releaseShutdown')
    await waitUntil(() => instance?.shutdownFinished === true, '被撤销实例关闭钩子结束')
    succeeded = true
  } finally {
    for (const instance of recordsAt(globalState, initMarker)) {
      callIfFunction(instance, 'releaseStart')
      callIfFunction(instance, 'releaseShutdown')
    }
    await worker?.dispose()
    restorePiEnvironment(savedEnvironment)
    delete globalState[initMarker]
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
  }
})

test('删除初始化中的会话正常结束订阅且不影响同批有效会话', { timeout: 30_000 }, async (t) => {
  const savedEnvironment = savePiEnvironment()
  const paths = await prepareFixture('delete-during-subscription')
  const globalState = globalThis as Record<string, unknown>
  globalState[initMarker] = { hang: false, instances: [] }
  const errors = t.mock.method(console, 'error', () => undefined)
  let manage: InstanceType<WorkSessionManageModule['WorkSessionManage']> | undefined
  let succeeded = false
  try {
    await writeExtension(paths, hangingExtension)
    setPiEnvironment(paths)
    const { WorkSessionManage } = await jiti.import<WorkSessionManageModule>(
      '../src/server/l2_biz/work-session/l2-work-session-manage.ts'
    )
    manage = new WorkSessionManage(join(paths.runRoot, 'work-sessions.json'))
    const kept = await manage.createWorkSession(paths.cwd)
    const sourceFor = (
      item: typeof kept
    ): { workId: string; sessionId: string; branchId: string } => ({
      workId: item.workId,
      sessionId: item.sessionId,
      branchId: item.branchId
    })
    const keptSubscription = { source: sourceFor(kept), cursor: null }
    await manage.prepareChatSourceSyncs([keptSubscription])

    recordAt(globalState, initMarker).hang = true
    const deleted = await manage.createWorkSession(paths.cwd)
    const deletedSubscription = { source: sourceFor(deleted), cursor: null }
    const pending = Promise.allSettled([
      manage.prepareChatSourceSyncs([deletedSubscription]),
      manage.prepareChatSourceSyncs([deletedSubscription, keptSubscription])
    ])
    await waitUntil(
      () => recordsAt(globalState, initMarker)[1]?.started === true,
      '待删除会话已进入真实插件初始化'
    )
    assert.equal(await manage.removeWorkSession(deleted.workId), true)
    const [single, batch] = await pending
    assert.ok(single && single.status === 'fulfilled')
    assert.deepEqual(single.value, [])
    assert.ok(batch && batch.status === 'fulfilled')
    assert.deepEqual(
      batch.value.map((sync) => sync.source),
      [keptSubscription.source]
    )
    assert.equal(batch.value[0]?.event.runtime.initializationError, null)
    assert.equal(errors.mock.callCount(), 0)
    assert.deepEqual(
      (await manage.listWorkSessions()).workSessions.map((item) => item.workId),
      [kept.workId]
    )
    await assert.rejects(manage.prepareChatSourceSyncs([deletedSubscription]), {
      name: 'L2ChatSourceBindingError'
    })

    const retired = recordsAt(globalState, initMarker)[1]!
    callIfFunction(retired, 'releaseStart')
    await waitUntil(() => retired.shutdownStarted === true, '删除后旧实例开始清理')
    callIfFunction(retired, 'releaseShutdown')
    await waitUntil(() => retired.shutdownFinished === true, '删除后旧实例完成清理')
    assert.match(String(retired.readError), /会话实例已失效/)
    const [resynced] = await manage.prepareChatSourceSyncs([keptSubscription])
    assert.equal(resynced?.event.runtime.extensionMode, 'normal')
    assert.equal(resynced?.event.runtime.initializationError, null)
    succeeded = true
  } finally {
    for (const instance of recordsAt(globalState, initMarker)) {
      callIfFunction(instance, 'releaseStart')
      callIfFunction(instance, 'releaseShutdown')
    }
    if (manage) {
      for (const item of (await manage.listWorkSessions()).workSessions) {
        await manage.removeWorkSession(item.workId)
      }
    }
    restorePiEnvironment(savedEnvironment)
    delete globalState[initMarker]
    if (succeeded) await rm(paths.runRoot, { recursive: true, force: true })
  }
})
