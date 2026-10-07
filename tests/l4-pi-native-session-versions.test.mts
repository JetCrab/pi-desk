import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

type PiModule = typeof import('@earendil-works/pi-coding-agent')
type ChatWorkerModule = typeof import('../src/server/l4_foundation/pi/l4-pi-chat-worker')
type CompatModule = typeof import('@earendil-works/pi-ai/compat')

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})

async function loadPiModules(): Promise<[PiModule, ChatWorkerModule]> {
  return Promise.all([
    jiti.import<PiModule>('@earendil-works/pi-coding-agent'),
    jiti.import<ChatWorkerModule>('../src/server/l4_foundation/pi/l4-pi-chat-worker.ts')
  ])
}

test('多个会话复用代码且运行态独立，显式重载只切换目标会话', async () => {
  const runId = `native-cache-refresh-helper-${process.pid}`
  const runRoot = resolve('temp/pi/l4-native-cache-refresh', runId)
  const agentDir = join(runRoot, 'agent', 'config')
  const sessionDir = join(runRoot, 'agent', 'sessions')
  const extensionPath = join(agentDir, 'extensions', 'native-cache-fixture.js')
  const cwd = resolve('temp/tests/l4-pi-native-cache-refresh', runId)
  const markerName = '__piDeskNativeCacheRefreshMarker'
  const globalState = globalThis as Record<string, unknown>
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR
  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR
  const originalSafeMode = process.env.PI_DESK_SAFE_MODE
  let workerV1: InstanceType<ChatWorkerModule['L4PiChatWorker']> | undefined
  let workerV2: InstanceType<ChatWorkerModule['L4PiChatWorker']> | undefined
  let fauxProvider: ReturnType<CompatModule['registerFauxProvider']> | undefined
  delete globalState[markerName]

  try {
    await mkdir(join(agentDir, 'extensions'), { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await mkdir(cwd, { recursive: true })
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir
    delete process.env.PI_DESK_SAFE_MODE

    const extensionSource = (version: 'v1' | 'v2', toolName: string): string => `
import { bindSessionPlugin } from '@jetcrab/pi-desk-sdk'
export default function (pi) {
  const marker = globalThis.${markerName} ??= { factories: 0 }
  marker.factories += 1
  const plugin = bindSessionPlugin(pi, 'native-cache-fixture')
  plugin.setState({ version: '${version}' })
  plugin.registerMethod('version', async () => ({ version: '${version}' }))
  pi.registerTool({
    name: '${toolName}',
    label: '${toolName}',
    description: 'Native cache refresh fixture',
    promptSnippet: '${toolName} fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: '${version}' }], details: {} })
  })
}
`
    await writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'native-loopback',
        defaultModel: 'native-cache-model',
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
            baseUrl: 'http://127.0.0.1:9/v1',
            apiKey: 'local-only',
            api: 'openai-completions',
            models: [
              {
                id: 'native-cache-model',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 128
              }
            ]
          }
        }
      }),
      'utf8'
    )
    await writeFile(extensionPath, extensionSource('v1', 'native_cache_v1'), 'utf8')

    const [piModule, { L4PiChatWorker }] = await loadPiModules()
    const compat = await jiti.import<CompatModule>('@earendil-works/pi-ai/compat')
    fauxProvider = compat.registerFauxProvider({
      api: 'openai-completions',
      provider: 'native-cache-refresh-test',
      models: [{ id: 'cache-refresh-provider-model' }]
    })
    workerV1 = new L4PiChatWorker(cwd, piModule.SessionManager.inMemory(cwd))
    const v1Tools = await workerV1.listNativeTools()
    assert.ok(v1Tools.some((tool) => tool.name === 'native_cache_v1'))
    assert.deepEqual((await workerV1.getRuntime()).plugins['native-cache-fixture'], {
      version: 'v1'
    })
    const providerBeforeRefresh = compat.getApiProvider(fauxProvider.api)
    assert.ok(providerBeforeRefresh)

    await writeFile(extensionPath, extensionSource('v2', 'native_cache_v2'), 'utf8')

    assert.equal((globalState[markerName] as { factories: number }).factories, 1)
    assert.equal(compat.getApiProvider(fauxProvider.api), providerBeforeRefresh)

    const managerV2 = piModule.SessionManager.inMemory(cwd)
    workerV2 = new L4PiChatWorker(cwd, managerV2)
    const v2Tools = await workerV2.listNativeTools()
    assert.ok(v2Tools.some((tool) => tool.name === 'native_cache_v1'))
    assert.equal(
      v2Tools.some((tool) => tool.name === 'native_cache_v2'),
      false
    )
    assert.deepEqual((await workerV2.getRuntime()).plugins['native-cache-fixture'], {
      version: 'v1'
    })
    assert.deepEqual(
      await workerV2.invokePluginMethod(
        'native-cache-fixture',
        'version',
        {},
        {
          workId: 'work-1',
          sessionId: managerV2.getSessionId(),
          branchId: 'v1:main'
        }
      ),
      { version: 'v1' }
    )
    assert.equal((globalState[markerName] as { factories: number }).factories, 2)
    assert.deepEqual((await workerV1.getRuntime()).plugins['native-cache-fixture'], {
      version: 'v1'
    })
    assert.ok((await workerV1.listNativeTools()).some((tool) => tool.name === 'native_cache_v1'))
    await workerV1.reload()
    assert.deepEqual((await workerV1.getRuntime()).plugins['native-cache-fixture'], {
      version: 'v2'
    })
    assert.equal((globalState[markerName] as { factories: number }).factories, 3)
    assert.deepEqual((await workerV2.getRuntime()).plugins['native-cache-fixture'], {
      version: 'v1'
    })
    assert.ok((await workerV1.listNativeTools()).some((tool) => tool.name === 'native_cache_v2'))
    assert.ok((await workerV2.listNativeTools()).some((tool) => tool.name === 'native_cache_v1'))
  } finally {
    await workerV2?.dispose()
    await workerV1?.dispose()
    fauxProvider?.unregister()
    delete globalState[markerName]
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir
    if (originalSafeMode === undefined) delete process.env.PI_DESK_SAFE_MODE
    else process.env.PI_DESK_SAFE_MODE = originalSafeMode
    await rm(runRoot, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
})
