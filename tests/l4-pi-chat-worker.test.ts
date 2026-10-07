import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { PromptOptions } from '@earendil-works/pi-coding-agent'
import { createJiti } from 'jiti'

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})

type PiModule = typeof import('@earendil-works/pi-coding-agent')
type ChatWorkerModule = typeof import('../src/server/l4_foundation/pi/l4-pi-chat-worker')
type AgentListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void

type TestExtensionRuntime = {
  sendMessage: (message: unknown, options?: unknown) => void
  sendUserMessage: (content: unknown, options?: unknown) => void
}

async function loadWorkerModules(): Promise<[PiModule, ChatWorkerModule]> {
  return Promise.all([
    jiti.import<PiModule>('@earendil-works/pi-coding-agent'),
    jiti.import<ChatWorkerModule>('../src/server/l4_foundation/pi/l4-pi-chat-worker.ts')
  ])
}

class OrderedAgentSubscriptions {
  private readonly listeners = new Set<AgentListener>()

  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  orderedListeners(): AgentListener[] {
    return [...this.listeners]
  }
}

test('手动压缩后 Worker 重新成为 Pi 持久化监听器的后置监听器', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  const agent = new OrderedAgentSubscriptions()
  const internalListener: AgentListener = () => undefined
  let unsubscribeInternal = agent.subscribe(internalListener)
  const previousWorkerListener: AgentListener = () => undefined
  const unsubscribePreviousWorker = agent.subscribe(previousWorkerListener)

  const session = {
    isIdle: true,
    isBashRunning: false,
    agent,
    async compact(): Promise<void> {
      unsubscribeInternal()
      unsubscribeInternal = agent.subscribe(internalListener)
    },
    clearQueue(): void {},
    abortCompaction(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    dispose(): void {
      unsubscribeInternal()
    }
  }

  Reflect.set(worker, 'session', session)
  Reflect.set(worker, 'unsubscribeAgent', unsubscribePreviousWorker)

  try {
    await worker.compact()

    const listeners = agent.orderedListeners()
    assert.equal(listeners.length, 2)
    assert.equal(listeners[0], internalListener)
    assert.notEqual(listeners[1], previousWorkerListener)
  } finally {
    await worker.dispose()
  }
})

test('忙碌 Worker 拒绝插件重载且不 abort Agent 或 Bash', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()

  for (const isBashRunning of [false, true]) {
    const worker = new L4PiChatWorker('C:/project', SessionManager.inMemory('C:/project'))
    let reloadCount = 0
    let sessionAbortCount = 0
    let agentAbortCount = 0
    const session = {
      sessionId: `busy-reload-session-${isBashRunning ? 'bash' : 'agent'}`,
      isIdle: false,
      isBashRunning,
      agent: {
        subscribe: (): (() => void) => () => undefined,
        async abort(): Promise<void> {
          agentAbortCount += 1
        }
      },
      extensionRunner: { emit: async (): Promise<void> => undefined },
      async reload(): Promise<void> {
        reloadCount += 1
      },
      clearQueue(): void {},
      abortCompaction(): void {},
      async abort(): Promise<void> {
        sessionAbortCount += 1
      },
      dispose(): void {}
    }
    Reflect.set(worker, 'session', session)

    try {
      const busyReason = isBashRunning ? /Bash 正在运行/ : /主 Agent 正在运行/
      await assert.rejects(worker.reload(), busyReason)
      await assert.rejects(worker.reload('basic'), busyReason)
      assert.equal(reloadCount, 0)
      assert.equal(sessionAbortCount, 0)
      assert.equal(agentAbortCount, 0)
    } finally {
      await worker.dispose()
    }
  }

  const originalSafeMode = process.env.PI_DESK_SAFE_MODE
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  const runRoot = resolve('temp/pi/l4-pi-chat-worker-safe-mode', String(process.pid))
  const agentDir = join(runRoot, 'agent', 'config')
  const sessionDir = join(runRoot, 'agent', 'sessions')
  const cwd = resolve('temp/tests/l4-pi-chat-worker-safe-mode', String(process.pid))
  await mkdir(agentDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'safe-fixture', defaultModel: 'safe-model' }),
    'utf8'
  )
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'safe-fixture': {
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'fixture-only',
          api: 'openai-completions',
          models: [
            {
              id: 'safe-model',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 512
            }
          ]
        }
      }
    }),
    'utf8'
  )
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir
  process.env.PI_DESK_SAFE_MODE = '1'
  try {
    const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
    const safeWorker = new L4PiChatWorker(cwd, SessionManager.inMemory(cwd))
    try {
      const runtime = await safeWorker.getRuntime()
      assert.equal(runtime.extensionMode, 'basic')
      assert.deepEqual(runtime.model, {
        provider: 'safe-fixture',
        modelId: 'safe-model',
        thinkingLevel: 'off'
      })
      await assert.rejects(safeWorker.reload('normal'), /服务处于基础模式/)
      await safeWorker.reload()
      assert.equal((await safeWorker.getRuntime()).extensionMode, 'basic')
      assert.ok(Reflect.get(safeWorker, 'session'))
    } finally {
      await safeWorker.dispose()
    }
  } finally {
    if (originalSafeMode === undefined) delete process.env.PI_DESK_SAFE_MODE
    else process.env.PI_DESK_SAFE_MODE = originalSafeMode
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir
    await rm(runRoot, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})

test(
  '真实 Pi Worker normal-basic-normal 保留 durable 父链与 Native 隔离',
  { timeout: 25_000 },
  async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR
    const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
    const runId = `native-cache-refresh-${process.pid}`
    const runRoot = resolve('temp/pi/l4-native-cache-refresh', runId)
    const agentDir = join(runRoot, 'agent', 'config')
    const sessionDir = join(runRoot, 'agent', 'sessions')
    const cwd = resolve('temp/tests/l4-pi-native-cache-refresh', runId)
    const extensionPath = join(agentDir, 'extensions', 'native-reload-fixture.ts')
    const markerName = '__piDeskSessionModeNativeMarker'
    const globalState = globalThis as Record<string, unknown>
    delete globalState[markerName]
    const requestBodies: string[] = []
    const { createServer } = await import('node:http')
    const provider = createServer(async (request, response) => {
      const bodyChunks: Buffer[] = []
      for await (const chunk of request) bodyChunks.push(Buffer.from(chunk))
      requestBodies.push(Buffer.concat(bodyChunks).toString())
      const answer = `local answer ${requestBodies.length}`
      const chunks: Array<{
        delta: Record<string, string>
        finish_reason: string | null
      }> = [
        { delta: { role: 'assistant' }, finish_reason: null },
        { delta: { content: answer }, finish_reason: null },
        { delta: {}, finish_reason: 'stop' }
      ]
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      for (const chunk of chunks) {
        response.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-native-${requestBodies.length}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'native-reload-model',
            choices: [{ index: 0, ...chunk }]
          })}\n\n`
        )
      }
      response.end('data: [DONE]\n\n')
    })
    let worker: InstanceType<ChatWorkerModule['L4PiChatWorker']> | undefined
    let unsubscribe: (() => void) | undefined
    const commits: Array<{ tempId: string; entryId: string }> = []
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        provider.once('error', rejectListen)
        provider.listen(0, '127.0.0.1', () => {
          provider.off('error', rejectListen)
          resolveListen()
        })
      })
      const address = provider.address()
      assert.ok(address && typeof address !== 'string')
      const extensionSource = (generation: string, toolName: string): string => `
import { bindSessionPlugin } from '@jetcrab/pi-desk-sdk'
export default function (pi) {
  const marker = globalThis.${markerName} ??= { factories: 0 }
  marker.factories += 1
  const plugin = bindSessionPlugin(pi, 'native-reload-fixture')
  plugin.setState({ generation: '${generation}' })
  plugin.registerMethod('generation', async () => ({ generation: '${generation}' }))
  pi.registerTool({
    name: '${toolName}',
    label: '${toolName}',
    description: 'Native reload fixture tool',
    promptSnippet: '${toolName} fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: '${generation}' }], details: {} })
  })
}
`
      await mkdir(join(agentDir, 'extensions'), { recursive: true })
      await mkdir(sessionDir, { recursive: true })
      await mkdir(cwd, { recursive: true })
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'native-loopback',
          defaultModel: 'native-reload-model',
          defaultThinkingLevel: 'off',
          retry: { enabled: false },
          compaction: { enabled: false }
        }),
        'utf8'
      )
      await writeFile(
        join(agentDir, 'models.json'),
        JSON.stringify({
          providers: {
            'native-loopback': {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'local-only',
              api: 'openai-completions',
              models: [
                {
                  id: 'native-reload-model',
                  reasoning: false,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 512
                }
              ]
            }
          }
        }),
        'utf8'
      )
      await writeFile(extensionPath, extensionSource('old', 'native_old'), 'utf8')

      process.env.PI_CODING_AGENT_DIR = agentDir
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir
      const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
      const manager = SessionManager.create(cwd, sessionDir)
      worker = new L4PiChatWorker(cwd, manager, undefined, {
        mode: () => 'test-limited',
        rules: () => ({ name: 'test-limited', tools: { allow: ['read'] }, skills: {} })
      })
      unsubscribe = worker.subscribe((event) => {
        if (event.type === 'message_commit') {
          commits.push({ tempId: event.tempId, entryId: event.entryId })
        }
      })

      const preSessionModels = await worker.listModels()
      assert.ok(
        preSessionModels.models.some(
          (model) => model.provider === 'native-loopback' && model.modelId === 'native-reload-model'
        )
      )
      assert.equal(Reflect.get(worker, 'session'), null)
      assert.equal(globalState[markerName], undefined)

      const readFactoryCount = (): number => {
        const marker: unknown = Reflect.get(globalState, markerName)
        assert.ok(
          marker &&
            typeof marker === 'object' &&
            'factories' in marker &&
            typeof marker.factories === 'number'
        )
        return marker.factories
      }
      const waitForAssistantCount = async (expected: number): Promise<void> => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const count = manager
            .getEntries()
            .filter(
              (entry) => entry.type === 'message' && entry.message.role === 'assistant'
            ).length
          if (count >= expected && worker?.readPluginReloadBlockReason() === null) return
          await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
        }
        assert.fail(`Timed out waiting for ${expected} durable assistant messages`)
      }

      await worker.reload('basic')
      assert.equal((await worker.getRuntime()).extensionMode, 'basic')
      assert.ok(Reflect.get(worker, 'session'))
      assert.equal(globalState[markerName], undefined)
      const firstBasicTools = await worker.listNativeTools()
      assert.ok(firstBasicTools.some((tool) => tool.name === 'read' && tool.active))
      assert.ok(firstBasicTools.some((tool) => tool.name === 'write' && !tool.active))
      assert.equal(
        firstBasicTools.some((tool) => tool.name === 'native_old'),
        false
      )

      await worker.reload('normal')
      assert.equal((await worker.getRuntime()).extensionMode, 'normal')
      assert.equal(readFactoryCount(), 1)
      const normalSessionModels = await worker.listModels()
      assert.ok(
        normalSessionModels.models.some(
          (model) => model.provider === 'native-loopback' && model.modelId === 'native-reload-model'
        )
      )

      const first = await worker.send({ mode: 'auto', text: 'first loopback turn', images: [] })
      await waitForAssistantCount(1)
      const firstCommit = commits.filter((commit) => commit.tempId === first.tempId)
      assert.equal(firstCommit.length, 1)
      const firstAssistant = manager
        .getEntries()
        .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')
        .at(-1)
      assert.ok(firstAssistant && firstAssistant.type === 'message')
      assert.ok((await worker.getRuntime()).plugins['native-reload-fixture'])
      assert.deepEqual(
        await worker.invokePluginMethod(
          'native-reload-fixture',
          'generation',
          {},
          {
            workId: 'work-1',
            sessionId: manager.getSessionId(),
            branchId: 'v1:main'
          }
        ),
        { generation: 'old' }
      )
      const normalTools = await worker.listNativeTools()
      assert.ok(normalTools.some((tool) => tool.name === 'native_old'))
      assert.ok(normalTools.some((tool) => tool.name === 'read' && tool.active))
      assert.equal(readFactoryCount(), 1)
      const sessionId = manager.getSessionId()

      await worker.reload('basic')
      assert.equal(manager.getSessionId(), sessionId)
      assert.equal((await worker.getRuntime()).extensionMode, 'basic')
      assert.equal(readFactoryCount(), 1)
      assert.equal((await worker.getRuntime()).plugins['native-reload-fixture'], undefined)
      await assert.rejects(
        worker.invokePluginMethod(
          'native-reload-fixture',
          'generation',
          {},
          {
            workId: 'work-1',
            sessionId,
            branchId: 'v1:main'
          }
        )
      )
      const basicTools = await worker.listNativeTools()
      assert.ok(basicTools.some((tool) => tool.name === 'read' && tool.active))
      assert.ok(basicTools.some((tool) => tool.name === 'write' && !tool.active))
      assert.equal(
        basicTools.some((tool) => tool.name === 'native_old'),
        false
      )

      const second = await worker.send({ mode: 'auto', text: 'second basic turn', images: [] })
      await waitForAssistantCount(2)
      const secondCommit = commits.filter((commit) => commit.tempId === second.tempId)
      assert.equal(secondCommit.length, 1)
      assert.equal(readFactoryCount(), 1)

      await writeFile(extensionPath, extensionSource('new', 'native_new'), 'utf8')
      await worker.reload('normal')
      assert.equal(manager.getSessionId(), sessionId)
      assert.equal((await worker.getRuntime()).extensionMode, 'normal')
      assert.deepEqual((await worker.getRuntime()).plugins['native-reload-fixture'], {
        generation: 'new'
      })
      assert.equal(readFactoryCount(), 2)
      assert.deepEqual(
        await worker.invokePluginMethod(
          'native-reload-fixture',
          'generation',
          {},
          {
            workId: 'work-1',
            sessionId,
            branchId: 'v1:main'
          }
        ),
        { generation: 'new' }
      )
      const normalToolsAfterSwitch = await worker.listNativeTools()
      assert.equal(
        normalToolsAfterSwitch.some((tool) => tool.name === 'native_old'),
        false
      )
      assert.ok(normalToolsAfterSwitch.some((tool) => tool.name === 'native_new' && !tool.active))

      const third = await worker.send({ mode: 'auto', text: 'third normal turn', images: [] })
      await waitForAssistantCount(3)
      const thirdCommit = commits.filter((commit) => commit.tempId === third.tempId)
      assert.equal(thirdCommit.length, 1)
      assert.equal(new Set(commits.map((commit) => commit.entryId)).size, commits.length)
      assert.notEqual(firstCommit[0]?.entryId, secondCommit[0]?.entryId)
      assert.notEqual(secondCommit[0]?.entryId, thirdCommit[0]?.entryId)

      const entries = manager.getEntries()
      const userEntries = entries.filter(
        (entry) => entry.type === 'message' && entry.message.role === 'user'
      )
      const assistants = entries.filter(
        (entry) => entry.type === 'message' && entry.message.role === 'assistant'
      )
      assert.equal(userEntries.length, 3)
      assert.equal(assistants.length, 3)
      assert.equal(userEntries[1]?.parentId, assistants[0]?.id)
      assert.equal(assistants[1]?.parentId, userEntries[1]?.id)
      assert.equal(userEntries[2]?.parentId, assistants[1]?.id)
      assert.equal(assistants[2]?.parentId, userEntries[2]?.id)

      const sessionFile = manager.getSessionFile()
      assert.ok(sessionFile)
      const durableRecords = (await readFile(sessionFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id?: string; parentId?: string })
      const durableById = new Map(durableRecords.map((entry) => [entry.id, entry.parentId]))
      for (const entry of [...userEntries, ...assistants]) {
        assert.equal(durableById.get(entry.id), entry.parentId)
      }
      assert.equal(requestBodies.length, 3)
    } finally {
      unsubscribe?.()
      await worker?.dispose()
      if (provider.listening) {
        provider.closeAllConnections()
        await new Promise<void>((resolveClose, rejectClose) => {
          provider.close((error) => (error ? rejectClose(error) : resolveClose()))
        })
      }
      assert.equal(provider.listening, false)
      delete globalState[markerName]
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir
      if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir
      await rm(runRoot, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  }
)

test('Pi 配置重载调用 AgentSession.reload 并刷新运行态', async (t) => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  const agent = new OrderedAgentSubscriptions()
  const internalListener: AgentListener = () => undefined
  let unsubscribeInternal = agent.subscribe(internalListener)
  const previousWorkerListener: AgentListener = () => undefined
  const unsubscribePreviousWorker = agent.subscribe(previousWorkerListener)
  let reloadCount = 0
  const extensionRuntime: TestExtensionRuntime = {
    sendMessage: () => undefined,
    sendUserMessage: () => undefined
  }
  const session = {
    sessionId: 'reload-session',
    isIdle: true,
    isBashRunning: false,
    model: null,
    thinkingLevel: 'off',
    agent,
    resourceLoader: {
      getExtensions: () => ({ runtime: extensionRuntime })
    },
    extensionRunner: {
      emit: async (): Promise<void> => undefined
    },
    getContextUsage: () => null,
    async reload(): Promise<void> {
      reloadCount += 1
      unsubscribeInternal()
      unsubscribeInternal = agent.subscribe(internalListener)
    },
    clearQueue(): void {},
    abortCompaction(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)
  Reflect.set(worker, 'unsubscribeAgent', unsubscribePreviousWorker)
  const eventTypes: string[] = []
  const unsubscribe = worker.subscribe((event) => eventTypes.push(event.type))

  try {
    t.mock.method(Reflect.get(worker, 'initialization'), 'start', async () => session)
    await worker.reload()

    assert.equal(reloadCount, 1)
    assert.ok(eventTypes.includes('runtime_changed'))
    const listeners = agent.orderedListeners()
    assert.equal(listeners.length, 2)
    assert.equal(listeners[0], internalListener)
    assert.notEqual(listeners[1], previousWorkerListener)
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})

test('压缩期间扩展消息按顺序延迟，重载后仍由闸门接管', async (t) => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  const agent = new OrderedAgentSubscriptions()
  const sent: string[] = []
  let runtime: TestExtensionRuntime = {
    sendMessage: (message) => sent.push(`message:${String(message)}`),
    sendUserMessage: (content) => sent.push(`user:${String(content)}`)
  }
  const session = {
    sessionId: 'gate-session',
    isIdle: true,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    model: null,
    thinkingLevel: 'off',
    agent,
    resourceLoader: {
      getExtensions: () => ({ runtime })
    },
    extensionRunner: {
      emit: async (): Promise<void> => undefined
    },
    getContextUsage: () => null,
    async reload(): Promise<void> {},
    clearQueue(): void {},
    abortCompaction(): void {},
    abortRetry(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)
  const gate = Reflect.get(worker, 'messageGate')
  const handleSessionEvent = Reflect.get(worker, 'handleSessionEvent')
  const unsubscribe = worker.subscribe(() => undefined)

  try {
    Reflect.apply(gate.pause, gate, [])
    Reflect.apply(gate.installExtensionRuntime, gate, [runtime])
    runtime.sendMessage('one', { triggerTurn: true })
    runtime.sendUserMessage('two', { deliverAs: 'steer' })
    assert.deepEqual(sent, [])

    Reflect.apply(handleSessionEvent, worker, [
      {
        type: 'compaction_end',
        reason: 'manual',
        result: undefined,
        aborted: true,
        willRetry: false
      }
    ])
    await Reflect.apply(gate.resume, gate, [])
    assert.deepEqual(sent, ['message:one', 'user:two'])

    const reloaded: string[] = []
    runtime = {
      sendMessage: (message) => reloaded.push(`message:${String(message)}`),
      sendUserMessage: (content) => reloaded.push(`user:${String(content)}`)
    }
    t.mock.method(Reflect.get(worker, 'initialization'), 'start', async () => session)
    await worker.reload()
    Reflect.apply(gate.pause, gate, [])
    runtime.sendMessage('after-reload', { triggerTurn: true })
    assert.deepEqual(reloaded, [])
    await Reflect.apply(gate.resume, gate, [])
    assert.deepEqual(reloaded, ['message:after-reload'])
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})

test('压缩结束先等待网页输入 preflight，再按接收顺序恢复扩展和用户消息', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  const order: string[] = []
  let releasePreflight!: () => void
  const preflightReady = new Promise<void>((resolve) => {
    releasePreflight = resolve
  })
  const runtime: TestExtensionRuntime = {
    sendMessage: (message) => order.push(`extension:${String(message)}`),
    sendUserMessage: (content) => order.push(`extension-user:${String(content)}`)
  }
  let compacting = false
  const session = {
    sessionId: 'preflight-session',
    get isIdle(): boolean {
      return !this.isStreaming && !compacting
    },
    isStreaming: false,
    get isCompacting(): boolean {
      return compacting
    },
    isBashRunning: false,
    model: null,
    thinkingLevel: 'off',
    agent: {},
    resourceLoader: {
      getExtensions: () => ({ runtime }),
      getSkills: () => ({ skills: [] })
    },
    promptTemplates: [],
    extensionRunner: {
      emit: async (): Promise<void> => undefined
    },
    getContextUsage: () => null,
    clearQueue(): void {},
    abortCompaction(): void {},
    abortRetry(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    async prompt(text: string, options: PromptOptions): Promise<void> {
      order.push(`web:${text}`)
      compacting = true
      Reflect.apply(handleSessionEvent, worker, [{ type: 'compaction_start', reason: 'threshold' }])
      runtime.sendMessage('during-compaction', { triggerTurn: true, deliverAs: 'steer' })
      Reflect.apply(handleSessionEvent, worker, [
        {
          type: 'compaction_end',
          reason: 'threshold',
          result: undefined,
          aborted: true,
          willRetry: false
        }
      ])
      compacting = false
      await Promise.resolve()
      assert.deepEqual(order, ['web:网页输入'])
      releasePreflight()
      Reflect.apply(validateFinalInput, worker, [
        text,
        undefined,
        session.isStreaming ? options.streamingBehavior : undefined
      ])
      options.preflightResult?.('started')
    },
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)
  const gate = Reflect.get(worker, 'messageGate')
  const handleSessionEvent = Reflect.get(worker, 'handleSessionEvent')
  const validateFinalInput = Reflect.get(worker, 'validateFinalInput')
  const unsubscribe = worker.subscribe(() => undefined)

  try {
    Reflect.apply(gate.installExtensionRuntime, gate, [runtime])
    await worker.send({ mode: 'auto', text: '网页输入', images: [] })
    await preflightReady
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(order, ['web:网页输入', 'extension:during-compaction'])
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})

test('Pi 接纳前拒绝输入且不回调时，撤回临时消息并继续处理后续输入', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const worker = new L4PiChatWorker('C:/project', SessionManager.inMemory('C:/project'))
  const prompts: string[] = []
  const discarded: string[] = []
  const session = {
    sessionId: 'rejected-preflight-session',
    extensionRunner: { emit: async (): Promise<void> => undefined },
    isIdle: true,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    model: null,
    thinkingLevel: 'off',
    getContextUsage: () => null,
    clearQueue(): void {},
    abortCompaction(): void {},
    async abort(): Promise<void> {},
    dispose(): void {},
    async prompt(text: string, options: PromptOptions): Promise<void> {
      prompts.push(text)
      if (prompts.length === 1) throw new Error('测试：Pi 接纳前拒绝')
      options.preflightResult?.('handled')
    }
  }
  Reflect.set(worker, 'session', session)
  let finish!: () => void
  let timer!: ReturnType<typeof setTimeout>
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve
    timer = setTimeout(() => reject(new Error('后续输入被接纳等待阻塞')), 3_000)
  })
  const unsubscribe = worker.subscribe((event) => {
    if (event.type !== 'message_discard') return
    discarded.push(event.tempId)
    if (discarded.length === 2) finish()
  })
  try {
    const first = await worker.send({ mode: 'auto', text: '被拒绝的输入', images: [] })
    const second = await worker.send({ mode: 'auto', text: '后续输入', images: [] })
    await done
    assert.deepEqual(prompts, ['被拒绝的输入', '后续输入'])
    assert.deepEqual(discarded, [first.tempId, second.tempId])
  } finally {
    clearTimeout(timer)
    unsubscribe()
    await worker.dispose()
  }
})

test('空闲 Follow-up 仍被拒绝，压缩期间 Follow-up 放行为下一轮 Prompt', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  let promptCount = 0
  let promptMode: string | undefined
  let promptWasPreparedAsNextTurn = false
  let gateReleased = false
  const session = {
    sessionId: 'follow-up-session',
    isIdle: true,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    model: null,
    thinkingLevel: 'off',
    agent: {},
    resourceLoader: {
      getSkills: () => ({ skills: [] }),
      getExtensions: () => ({
        runtime: {
          sendMessage: () => undefined,
          sendUserMessage: () => undefined
        }
      })
    },
    promptTemplates: [],
    extensionRunner: {
      emit: async (): Promise<void> => undefined
    },
    getContextUsage: () => null,
    clearQueue(): void {},
    abortCompaction(): void {},
    abortRetry(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    async prompt(text: string, options: PromptOptions): Promise<void> {
      promptCount += 1
      promptMode = options.streamingBehavior
      Reflect.apply(validateFinalInput, worker, [text, undefined, undefined])
      promptWasPreparedAsNextTurn = Reflect.get(worker, 'pendingPrompt') !== null
      options.preflightResult?.('started')
    },
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)
  const gate = Reflect.get(worker, 'messageGate')
  const validateFinalInput = Reflect.get(worker, 'validateFinalInput')
  const unsubscribe = worker.subscribe(() => undefined)

  try {
    await assert.rejects(
      () => worker.send({ mode: 'follow_up', text: '空闲 follow-up', images: [] }),
      /空闲，不能添加 Follow-up/
    )

    Reflect.apply(gate.pause, gate, [])
    const accepted = await worker.send({ mode: 'follow_up', text: '压缩 follow-up', images: [] })
    assert.match(accepted.tempId, /^[0-9a-f-]{36}$/)
    gateReleased = true
    session.isStreaming = false
    await Reflect.apply(gate.resume, gate, [])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(promptCount, 1)
    assert.equal(promptMode, 'followUp')
    assert.equal(promptWasPreparedAsNextTurn, true)
  } finally {
    if (!gateReleased) Reflect.apply(gate.resume, gate, [])
    unsubscribe()
    await worker.dispose()
  }
})

test('无待投递消息的手动压缩恢复完成态，不创建中间输入接纳窗口', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  const eventTypes: string[] = []
  const session = {
    sessionId: 'manual-idle-session',
    isIdle: true,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    model: null,
    thinkingLevel: 'off',
    agent: new OrderedAgentSubscriptions(),
    extensionRunner: {
      emit: async (): Promise<void> => undefined
    },
    getContextUsage: () => null,
    clearQueue(): void {},
    abortCompaction(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    async compact(): Promise<void> {
      Reflect.apply(handleSessionEvent, worker, [{ type: 'compaction_start', reason: 'manual' }])
      Reflect.apply(handleSessionEvent, worker, [
        {
          type: 'compaction_end',
          reason: 'manual',
          result: undefined,
          aborted: true,
          willRetry: false
        }
      ])
    },
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)
  const handleSessionEvent = Reflect.get(worker, 'handleSessionEvent')
  const unsubscribe = worker.subscribe((event) => eventTypes.push(event.type))

  try {
    await worker.compact()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(eventTypes.includes('agent_started'))
    assert.ok(eventTypes.includes('main_operation_finished'))
    assert.equal(eventTypes.includes('agent_settled'), false)
    assert.equal(worker.readPluginReloadBlockReason(), null)
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})

test('手动压缩恢复待投递消息并启动 Agent 时不产生中间完成态', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  const eventTypes: string[] = []
  let compacting = false
  let streaming = false
  const session = {
    sessionId: 'manual-queued-session',
    get isIdle(): boolean {
      return !compacting && !streaming
    },
    get isStreaming(): boolean {
      return streaming
    },
    get isCompacting(): boolean {
      return compacting
    },
    isBashRunning: false,
    model: null,
    thinkingLevel: 'off',
    agent: new OrderedAgentSubscriptions(),
    resourceLoader: {
      getSkills: () => ({ skills: [] }),
      getExtensions: () => ({
        runtime: {
          sendMessage: () => undefined,
          sendUserMessage: () => undefined
        }
      })
    },
    promptTemplates: [],
    extensionRunner: {
      emit: async (): Promise<void> => undefined
    },
    getContextUsage: () => null,
    clearQueue(): void {},
    abortCompaction(): void {},
    abortRetry(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    async compact(): Promise<void> {
      compacting = true
      Reflect.apply(handleSessionEvent, worker, [{ type: 'compaction_start', reason: 'manual' }])
      await worker.send({ mode: 'auto', text: '压缩后继续执行', images: [] })
      compacting = false
      Reflect.apply(handleSessionEvent, worker, [
        {
          type: 'compaction_end',
          reason: 'manual',
          result: undefined,
          aborted: true,
          willRetry: false
        }
      ])
    },
    async prompt(text: string, options: PromptOptions): Promise<void> {
      assert.equal(text, '压缩后继续执行')
      streaming = true
      Reflect.apply(handleAgentEvent, worker, [{ type: 'agent_start' }])
      Reflect.apply(validateFinalInput, worker, [text, undefined, options.streamingBehavior])
      Reflect.apply(handleSessionEvent, worker, [
        {
          type: 'queue_update',
          steering: ['压缩后继续执行'],
          followUp: []
        }
      ])
      options.preflightResult?.('queued')
    },
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)
  const handleAgentEvent = Reflect.get(worker, 'handleAgentEvent')
  const handleSessionEvent = Reflect.get(worker, 'handleSessionEvent')
  const validateFinalInput = Reflect.get(worker, 'validateFinalInput')
  const unsubscribe = worker.subscribe((event) => eventTypes.push(event.type))

  try {
    await worker.compact()
    for (let index = 0; index < 5 && !eventTypes.includes('agent_started'); index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.ok(eventTypes.includes('agent_started'))
    assert.equal(eventTypes.includes('main_operation_finished'), false)
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})

test('闸门投递异常不会阻塞后续消息，释放后取消消息不会执行', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  const sent: string[] = []
  const runtime: TestExtensionRuntime = {
    sendMessage: (message) => {
      if (message === '失败') throw new Error('模拟扩展失败')
      sent.push(String(message))
    },
    sendUserMessage: (content) => sent.push(String(content))
  }
  const gate = Reflect.get(worker, 'messageGate')
  const unsubscribe = worker.subscribe(() => undefined)

  try {
    Reflect.apply(gate.installExtensionRuntime, gate, [runtime])
    Reflect.apply(gate.pause, gate, [])
    runtime.sendMessage('失败')
    runtime.sendUserMessage('成功')
    await Reflect.apply(gate.resume, gate, [])
    assert.deepEqual(sent, ['成功'])

    Reflect.apply(gate.pause, gate, [])
    runtime.sendMessage('取消')
    Reflect.apply(gate.dispose, gate, [])
    await Reflect.apply(gate.resume, gate, [])
    assert.deepEqual(sent, ['成功'])
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})

test('interrupt 和 dispose 清除压缩期间暂存输入，不会在恢复时重放', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  const prompts: string[] = []
  const session = {
    sessionId: 'discard-session',
    isIdle: true,
    isStreaming: false,
    isCompacting: true,
    isBashRunning: false,
    model: null,
    agent: {
      abort: (): Promise<void> => Promise.resolve()
    },
    abortRetry(): void {},
    abortCompaction(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    clearQueue(): void {},
    async prompt(text: string): Promise<void> {
      prompts.push(text)
    },
    extensionRunner: {
      emit: async (): Promise<void> => undefined
    },
    getContextUsage: () => null,
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)
  const gate = Reflect.get(worker, 'messageGate')
  const handleSessionEvent = Reflect.get(worker, 'handleSessionEvent')
  const unsubscribe = worker.subscribe(() => undefined)

  try {
    Reflect.apply(gate.pause, gate, [])
    await worker.send({ mode: 'auto', text: '不要执行', images: [] })
    await worker.interrupt()
    session.isCompacting = false
    Reflect.apply(handleSessionEvent, worker, [
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: undefined,
        aborted: true,
        willRetry: false
      }
    ])
    await Reflect.apply(gate.resume, gate, [])
    assert.deepEqual(prompts, [])

    await worker.send({ mode: 'auto', text: 'dispose 后不要执行', images: [] })
    await worker.dispose()
    assert.deepEqual(prompts, [])
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})

test('读取会话配置不执行上下文转换且只返回当前启用工具', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const sourceMessages = [
    {
      role: 'user',
      content: [{ type: 'text', text: '用户问题' }],
      timestamp: 1
    }
  ]
  const transformedMessages = [
    ...sourceMessages,
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '思考内容' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'read',
          arguments: { path: 'README.md' }
        }
      ],
      timestamp: 2
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: '读取完成' }],
      isError: false,
      timestamp: 3
    }
  ]
  let transformCalls = 0
  let convertCalls = 0
  const worker = new L4PiChatWorker('C:/project', manager)
  const session = {
    sessionId: 'context-session',
    isIdle: true,
    isBashRunning: false,
    systemPrompt: '系统提示词',
    sessionManager: {
      buildSessionContext: () => ({ messages: sourceMessages })
    },
    agent: {
      async transformContext(messages: unknown[]) {
        transformCalls += 1
        assert.deepEqual(messages, sourceMessages)
        return transformedMessages
      },
      async convertToLlm(messages: unknown[]) {
        convertCalls += 1
        assert.deepEqual(messages, transformedMessages)
        return [
          ...messages,
          {
            role: 'user',
            content: [{ type: 'image', mimeType: 'image/jpeg', data: 'ignored' }],
            timestamp: 4
          }
        ]
      }
    },
    getActiveToolNames: () => ['read'],
    getAllTools: () => [
      {
        name: 'read',
        description: '读取文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } } }
      },
      {
        name: 'bash',
        description: '执行命令',
        parameters: { type: 'object' }
      }
    ],
    clearQueue(): void {},
    abortCompaction(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)

  try {
    assert.deepEqual(await worker.readModelContext(), {
      systemPrompt: '系统提示词',
      tools: [
        {
          name: 'read',
          description: '读取文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } } }
        }
      ]
    })
    assert.equal(transformCalls, 0)
    assert.equal(convertCalls, 0)
  } finally {
    await worker.dispose()
  }
})

test('Session 普通 message_end 不重复同步 durable entry', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '已持久化消息' }],
    timestamp: 1
  })
  const appendedEntryIds: string[] = []
  const worker = new L4PiChatWorker('C:/project', manager, (entry) => {
    appendedEntryIds.push(entry.id)
  })
  const handleSessionEvent = Reflect.get(worker, 'handleSessionEvent')
  assert.equal(typeof handleSessionEvent, 'function')

  try {
    Reflect.apply(handleSessionEvent, worker, [
      {
        type: 'message_end',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '当前消息' }],
          timestamp: 2
        }
      }
    ])

    assert.deepEqual(appendedEntryIds, [])
  } finally {
    await worker.dispose()
  }
})

test('超长流式工具参数每轮 Agent 只中止一次并跳过超长 message_update', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  let agentAbortCount = 0
  const session = {
    agent: {
      abort(): Promise<void> {
        agentAbortCount += 1
        return Promise.resolve()
      }
    },
    clearQueue(): void {},
    abortCompaction(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    extensionRunner: {
      emit(): Promise<void> {
        return Promise.resolve()
      }
    },
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)
  const handleAgentEvent = Reflect.get(worker, 'handleAgentEvent')
  assert.equal(typeof handleAgentEvent, 'function')
  const eventTypes: string[] = []
  const unsubscribe = worker.subscribe((event) => eventTypes.push(event.type))
  const oversizedPartialJson = 'x'.repeat(256 * 1024 + 1)
  const oversizedMessage = {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'read',
        partialJson: oversizedPartialJson
      }
    ]
  }

  try {
    Reflect.apply(handleAgentEvent, worker, [{ type: 'agent_start' }])
    Reflect.apply(handleAgentEvent, worker, [
      {
        type: 'message_start',
        message: { role: 'assistant', content: [{ type: 'text', text: '开始' }] }
      }
    ])
    Reflect.apply(handleAgentEvent, worker, [{ type: 'message_update', message: oversizedMessage }])
    Reflect.apply(handleAgentEvent, worker, [{ type: 'message_update', message: oversizedMessage }])

    assert.equal(agentAbortCount, 1)
    Reflect.apply(handleAgentEvent, worker, [{ type: 'agent_start' }])
    assert.deepEqual(eventTypes, ['agent_started', 'message_start', 'agent_started'])

    Reflect.apply(handleAgentEvent, worker, [{ type: 'message_update', message: oversizedMessage }])
    assert.equal(agentAbortCount, 2)
    Reflect.apply(handleAgentEvent, worker, [{ type: 'agent_start' }])
    assert.deepEqual(eventTypes, [
      'agent_started',
      'message_start',
      'agent_started',
      'agent_started'
    ])
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})

test('getRuntime初始化Pi扩展并恢复模型，后续发送复用同一Session', { timeout: 30_000 }, async () => {
  const marker = '__piDeskLazySessionExtension'
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  const runRoot = resolve('temp/pi/l4-pi-chat-worker-lazy-init', String(process.pid))
  const agentDir = join(runRoot, 'agent', 'config')
  const sessionDir = join(runRoot, 'agent', 'sessions')
  const cwd = resolve('temp/tests/l4-pi-chat-worker-lazy-init', String(process.pid))
  const extensionPath = join(agentDir, 'extensions', 'lazy-fixture.ts')
  const globalState = globalThis as Record<string, unknown>
  delete globalState[marker]

  await mkdir(join(agentDir, 'extensions'), { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'lazy-fixture',
      defaultModel: 'lazy-fixture-model',
      defaultThinkingLevel: 'off',
      retry: { enabled: false },
      compaction: { enabled: false }
    }),
    'utf8'
  )
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'lazy-fixture': {
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'fixture-only',
          api: 'openai-completions',
          models: [
            {
              id: 'lazy-fixture-model',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 512
            }
          ]
        }
      }
    }),
    'utf8'
  )
  await writeFile(
    extensionPath,
    `export default function (pi) {
  const state = globalThis.${marker} ??= { factories: 0, inputs: 0 }
  state.factories += 1
  pi.on('input', () => {
    state.inputs += 1
    return { action: 'handled' }
  })
}
`,
    'utf8'
  )

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir
  let worker: InstanceType<ChatWorkerModule['L4PiChatWorker']> | undefined
  try {
    const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
    const manager = SessionManager.create(cwd, sessionDir)
    worker = new L4PiChatWorker(cwd, manager)

    const runtime = await worker.getRuntime()
    assert.equal(runtime.extensionMode, 'normal')
    assert.equal(runtime.initializationError, null)
    assert.deepEqual(runtime.model, {
      provider: 'lazy-fixture',
      modelId: 'lazy-fixture-model',
      thinkingLevel: 'off'
    })
    assert.ok(Reflect.get(worker, 'session'))
    const initializedState = globalState[marker] as
      { factories: number; inputs: number } | undefined
    assert.deepEqual(initializedState, { factories: 1, inputs: 0 })

    const accepted = await worker.send({
      mode: 'auto',
      text: 'handled by local extension',
      images: []
    })
    assert.match(accepted.tempId, /^[0-9a-f-]{36}$/)
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const state = globalState[marker] as { factories: number; inputs: number } | undefined
      if ((state?.inputs ?? 0) > 0) break
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
    }
    const state = globalState[marker] as { factories: number; inputs: number } | undefined
    assert.equal(state?.factories, 1)
    assert.equal(state?.inputs, 1)
    assert.ok(Reflect.get(worker, 'session'))
  } finally {
    await worker?.dispose()
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir
    delete globalState[marker]
    await rm(runRoot, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})

test('正常大小流式工具参数不触发 Agent 中止', async () => {
  const [{ SessionManager }, { L4PiChatWorker }] = await loadWorkerModules()
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  let agentAbortCount = 0
  const session = {
    agent: {
      abort(): Promise<void> {
        agentAbortCount += 1
        return Promise.resolve()
      }
    },
    clearQueue(): void {},
    abortCompaction(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    extensionRunner: {
      emit(): Promise<void> {
        return Promise.resolve()
      }
    },
    dispose(): void {}
  }
  Reflect.set(worker, 'session', session)
  const handleAgentEvent = Reflect.get(worker, 'handleAgentEvent')
  assert.equal(typeof handleAgentEvent, 'function')
  const eventTypes: string[] = []
  const unsubscribe = worker.subscribe((event) => eventTypes.push(event.type))

  try {
    Reflect.apply(handleAgentEvent, worker, [{ type: 'agent_start' }])
    Reflect.apply(handleAgentEvent, worker, [
      {
        type: 'message_start',
        message: { role: 'assistant', content: [{ type: 'text', text: '开始' }] }
      }
    ])
    Reflect.apply(handleAgentEvent, worker, [
      {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'read',
              partialJson: 'x'.repeat(256 * 1024),
              arguments: { path: 'README.md' }
            }
          ]
        }
      }
    ])

    assert.equal(agentAbortCount, 0)
    Reflect.apply(handleAgentEvent, worker, [{ type: 'agent_start' }])
    assert.deepEqual(eventTypes, [
      'agent_started',
      'message_start',
      'message_update',
      'agent_started'
    ])
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})
