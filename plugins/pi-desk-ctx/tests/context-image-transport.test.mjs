import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  alias: {
    '@earendil-works/pi-coding-agent': resolve(
      'node_modules/@earendil-works/pi-coding-agent/dist/index.js'
    ),
    '@earendil-works/pi-agent-core': resolve(
      'node_modules/@earendil-works/pi-agent-core/dist/index.js'
    ),
    '@earendil-works/pi-ai': resolve('node_modules/@earendil-works/pi-ai/dist/index.js'),
    typebox: require.resolve('typebox')
  }
})
const { registerContextIgnore } = await jiti.import(
  new URL('../src/index.ts', import.meta.url).pathname
)
const { defaultContextIgnoreSettings } = await jiti.import(
  new URL('../src/context-settings.ts', import.meta.url).pathname
)

test('真实Pi会话中新图超限在HTTP发送前取消；关闭后可正常发送', { timeout: 30000 }, async () => {
  const root = resolve('temp/pi/ctx-image-transport', `abort-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const previousAgent = process.env.PI_CODING_AGENT_DIR
  const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR
  let requests = 0
  let port
  let successful = false
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
    }
    requests += 1
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_fixture',
          object: 'response',
          status: 'completed',
          model: 'fixture',
          output: [],
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 }
        }
      })}\n\n`
    )
  })
  try {
    await mkdir(join(agentDir, 'sessions'), { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    port = server.address().port
    const modelsPath = join(agentDir, 'models.json')
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-responses',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: 'fixture-only',
            models: [
              { id: 'fixture', input: ['text', 'image'], contextWindow: 100000, maxTokens: 100 }
            ]
          }
        }
      })
    )
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath,
      allowModelNetwork: false
    })
    for (const enabled of [true, false]) {
      const settings = defaultContextIgnoreSettings()
      settings.imageBudget = { ...settings.imageBudget, enabled, triggerBytes: 64, targetBytes: 32 }
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
        cacheWarming: 'off',
        images: { autoResize: false },
        httpIdleTimeoutMs: 5000
      })
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        extensionFactories: [
          (pi) => registerContextIgnore(pi, { loadSettings: async () => settings })
        ]
      })
      await resourceLoader.reload()
      const { session } = await createAgentSession({
        cwd: root,
        agentDir,
        modelRuntime,
        model: modelRuntime.getModel('fixture', 'fixture'),
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(root),
        tools: [],
        thinkingLevel: 'off'
      })
      try {
        await session.bindExtensions({ mode: 'rpc' })
        await session.prompt('检查测试图片', {
          images: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9YQAAAABJRU5ErkJggg=='
            }
          ]
        })
        assert.equal(requests, enabled ? 0 : 1)
        const last = session.messages.findLast((message) => message.role === 'assistant')
        if (enabled) {
          assert.match(last?.errorMessage ?? '', /aborted/i)
        } else {
          assert.equal(last?.stopReason, 'stop', last?.errorMessage)
        }
      } finally {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
        session.dispose()
      }
    }
    successful = true
  } finally {
    server.closeAllConnections()
    await new Promise((resolveClose) => server.close(resolveClose))
    if (port !== undefined) {
      const probe = createServer()
      probe.listen(port, '127.0.0.1')
      await once(probe, 'listening')
      await new Promise((resolveClose) => probe.close(resolveClose))
    }
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgent
    if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions
    if (successful) await rm(root, { recursive: true, force: true })
    else console.error(`图片中止回归现场：${root}`)
  }
})
