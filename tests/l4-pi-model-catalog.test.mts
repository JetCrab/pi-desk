import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import {
  createAgentSessionFromServices,
  SessionManager,
  ModelRuntime,
  SettingsManager,
  type AgentSession
} from '@earendil-works/pi-coding-agent'
const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

test('虚拟模型进入会话目录，未知窗口不伪造且查询不触发路由', async () => {
  const root = resolve('temp/pi/l4-pi-model-catalog', `virtual-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const saved = process.env.PI_CODING_AGENT_DIR
  const savedSessions = process.env.PI_CODING_AGENT_SESSION_DIR
  let passed = false
  try {
    await mkdir(agentDir, { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
    const modelsPath = join(agentDir, 'models.json')
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:9/v1',
            apiKey: 'fixture-only',
            models: [
              {
                id: 'physical',
                name: 'Physical',
                contextWindow: 32768,
                maxTokens: 1024,
                input: ['text'],
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              }
            ]
          }
        }
      })
    )
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath })
    const physical = runtime.getModel('fixture', 'physical')
    assert.ok(physical)
    let routes = 0
    runtime.registerVirtualModel({
      provider: 'fixture',
      id: 'auto',
      name: 'Automatic',
      thinkingLevels: ['off', 'high'],
      route: () => {
        routes += 1
        return { model: physical, thinkingLevel: 'off' }
      }
    })
    const { readL4PiModelCatalog } = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-model-catalog')
    >('../src/server/l4_foundation/pi/l4-pi-model-catalog.ts')
    const settingsManager = SettingsManager.inMemory({})
    const catalog = await readL4PiModelCatalog(
      {
        modelRuntime: runtime,
        settingsManager,
        sessionManager: { getCwd: () => root }
      } as unknown as AgentSession,
      root
    )
    assert.equal(catalog.models.find((model) => model.modelId === 'auto')?.kind, 'virtual')
    assert.equal(catalog.models.find((model) => model.modelId === 'auto')?.contextWindow, null)
    assert.deepEqual(catalog.models.find((model) => model.modelId === 'auto')?.thinkingLevels, [
      'off',
      'high'
    ])
    assert.equal(catalog.models.find((model) => model.modelId === 'physical')?.kind, 'physical')
    assert.equal(routes, 0)

    await mkdir(join(agentDir, 'extensions'), { recursive: true })
    await writeFile(
      join(agentDir, 'extensions', 'router.ts'),
      `export default function(pi) {
      pi.registerVirtualModel({ provider: 'fixture', id: 'auto', name: 'Automatic', thinkingLevels: ['off', 'high'], route() { throw new Error('目录恢复不能触发路由') } })
    }`
    )
    const { L4PiSessionResources } = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-session-resources')
    >('../src/server/l4_foundation/pi/l4-pi-session-resources.ts')
    const services = await new L4PiSessionResources().createServices(root, {})
    assert.ok(services.modelRuntime.getModel('fixture', 'auto'))
    const manager = SessionManager.inMemory(root)
    manager.appendModelChange('fixture', 'auto')
    manager.appendThinkingLevelChange('high')
    manager.appendMessage({
      role: 'assistant',
      provider: 'fixture',
      model: 'physical',
      api: 'openai-completions',
      content: [{ type: 'text', text: 'physical response' }],
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
    })
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager })
    try {
      await session.bindExtensions({ mode: 'rpc' })
      assert.equal(session.model?.id, 'auto')
      assert.equal(session.thinkingLevel, 'high')
    } finally {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      session.dispose()
    }
    passed = true
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = saved
    if (savedSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = savedSessions
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`虚拟模型目录现场：${root}`)
  }
})
