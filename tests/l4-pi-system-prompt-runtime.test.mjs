import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise(setImmediate)
  }
}

async function fixture(context, style = 'structured') {
  const root = resolve('temp/pi/l4-pi-system-prompt-runtime', `request-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const savedEnvironment = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    PI_DESK_SAFE_MODE: process.env.PI_DESK_SAFE_MODE
  }
  const previousStore = globalThis.__piDeskCapabilityModesStore
  const previousMarker = globalThis.__piDeskSystemPromptFixture
  const marker = { hooks: 0, notices: [], style }
  globalThis.__piDeskSystemPromptFixture = marker
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  delete process.env.PI_DESK_SAFE_MODE
  const requests = []
  let holdNext = false
  let releaseHeld = () => {}
  let passed = false
  const release = () => {
    const finish = releaseHeld
    releaseHeld = () => {}
    finish()
  }
  const provider = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push(JSON.parse(body))
    const finish = () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      for (const [delta, finishReason] of [
        [{ role: 'assistant', content: '本地测试回答' }, null],
        [{}, 'stop']
      ]) {
        response.write(
          `data: ${JSON.stringify({ id: `prompt-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
        )
      }
      response.end('data: [DONE]\n\n')
    }
    if (holdNext) {
      holdNext = false
      releaseHeld = finish
    } else finish()
  })
  let worker
  const runtimes = []
  const cleanup = []
  context.after(async () => {
    release()
    for (const dispose of cleanup) await dispose()
    for (const runtime of runtimes) await runtime.dispose()
    await worker?.dispose()
    provider.closeAllConnections()
    await new Promise((resolveClose) => provider.close(resolveClose))
    assert.equal(provider.listening, false)
    const probe = createServer()
    await new Promise((resolveListen, rejectListen) => {
      probe.once('error', rejectListen)
      probe.listen(port, '127.0.0.1', () => probe.close(resolveListen))
    })
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (previousStore === undefined) delete globalThis.__piDeskCapabilityModesStore
    else globalThis.__piDeskCapabilityModesStore = previousStore
    if (previousMarker === undefined) delete globalThis.__piDeskSystemPromptFixture
    else globalThis.__piDeskSystemPromptFixture = previousMarker
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error('提示词测试现场：', root)
  })
  await new Promise((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen))
  const port = provider.address().port
  await mkdir(join(agentDir, 'extensions'), { recursive: true })
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), 'NATIVE_APPEND_BASE')
  await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT_BASE_RULES')
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'fixture',
      defaultModel: 'fixture',
      retry: { enabled: false },
      compaction: { enabled: false }
    })
  )
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'fixture-only',
          models: [
            {
              id: 'fixture',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 256
            }
          ]
        }
      }
    })
  )
  await writeFile(
    join(agentDir, 'extensions', 'prompt-fixture.ts'),
    `import { bindSessionPlugin } from '@jetcrab/pi-desk-sdk/session'
export default function(pi) {
  const state = globalThis.__piDeskSystemPromptFixture
  state.pi ??= pi
  bindSessionPlugin(pi, 'prompt-fixture').onCapabilitiesChange(async (rules, context) => {
    state.sessionId ??= context.sessionManager.getSessionId()
    if (state.sessionId !== context.sessionManager.getSessionId()) return
    state.notices.push(rules)
    await state.onNotice?.(rules)
  })
  pi.on('before_agent_start', (event) => {
    state.hooks += 1
    if (state.style === 'full') return { systemPrompt: 'FULL_PLUGIN_BASE' }
    if (state.style === 'force') event.systemPromptOptions.forceSystemPrompt = 'FORCED_PLUGIN_BASE'
    else {
      event.systemPromptOptions.appendSystemPrompt += '\\n\\nOTHER_PLUGIN_BASE'
      event.systemPromptOptions.sections.other_plugin = 'STRUCTURED_PLUGIN_SECTION'
    }
  })
}`
  )
  const [{ SessionManager }, { L4PiChatWorker }, { L4CapabilityModesStore }] = await Promise.all([
    jiti.import('@earendil-works/pi-coding-agent'),
    jiti.import('../src/server/l4_foundation/pi/l4-pi-chat-worker.ts'),
    jiti.import('../src/server/l4_foundation/capability-modes/l4-capability-modes-store.ts')
  ])
  const store = new L4CapabilityModesStore(agentDir)
  globalThis.__piDeskCapabilityModesStore = store
  await store.replaceGlobalPrompt('HOST_APPEND_FIRST')
  const manager = SessionManager.create(cwd, join(agentDir, 'sessions'))
  worker = new L4PiChatWorker(cwd, manager)
  return {
    root,
    agentDir,
    cwd,
    worker,
    manager,
    store,
    marker,
    requests,
    runtimes,
    cleanup,
    async session() {
      await worker.getRuntime()
      return Reflect.get(worker, 'session')
    },
    hold() {
      holdNext = true
    },
    release,
    success() {
      passed = true
    },
    waitRequests(count) {
      return waitUntil(() => requests.length === count, `Provider 请求 ${count}`)
    }
  }
}

function occurrences(text, fragment) {
  return text.split(fragment).length - 1
}

for (const source of ['global', 'custom']) {
  test(
    `直接编辑 ${source} Markdown 后真实父任务与子代理创建恢复采用同一追加正文`,
    { timeout: 30_000 },
    async (context) => {
      const f = await fixture(context)
      let worker = f.worker
      let path = join(f.agentDir, 'config', 'system-prompts', 'global-append.md')
      let original = 'HOST_APPEND_FIRST'
      if (source === 'custom') {
        const key = 'external-custom'
        original = 'EXTERNAL_CUSTOM_ORIGINAL'
        await f.store.replace(
          { [key]: { name: 'External Custom', promptSource: 'custom' } },
          { [key]: original }
        )
        await f.store.replaceDefault({ cwd: null, defaultMode: key })
        const { L4PiWorkSessionRuntime } = await jiti.import(
          '../src/server/l4_foundation/pi/l4-pi-work-session-runtime.ts'
        )
        const runtime = L4PiWorkSessionRuntime.create(f.cwd)
        f.runtimes.push(runtime)
        await runtime.readModelContext()
        worker = Reflect.get(runtime, 'chatWorker')
        path = join(
          f.agentDir,
          'config',
          'system-prompts',
          'modes',
          `${createHash('sha256').update(key).digest('hex')}.md`
        )
      } else {
        await f.session()
      }
      const parentSession = Reflect.get(worker, 'session')
      const { SubagentRuntime } = await jiti.import(
        '../plugins/pi-desk-subagent/src/subagent-runtime.ts'
      )
      const { SessionManager } = await jiti.import('@earendil-works/pi-coding-agent')
      const children = new Set()
      const childRuntime = new (class extends SubagentRuntime {
        open(config, parent, manager) {
          return super.createChildSession(config, parent, manager)
        }
      })(f.marker.pi, parentSession.modelRuntime, f.agentDir)
      f.cleanup.push(async () => {
        for (const child of children) {
          await child.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
          child.dispose()
        }
        await childRuntime.shutdown()
      })
      await worker.applyCapabilityMode()
      const capability = Reflect.get(Reflect.get(worker, 'initialization'), 'capabilities')
      const fullApply = context.mock.method(capability, 'apply')
      const readPrompt = context.mock.method(f.store, 'resolvePrompt')
      const baselineNotices = f.marker.notices.length
      const baselineTools = parentSession.getActiveToolNames()
      await parentSession.prompt('未修改正文的独立父任务')
      assert.equal(f.marker.notices.length, baselineNotices)
      const parent = {
        cwd: f.cwd,
        sessionId: parentSession.sessionId,
        sessionDir: parentSession.sessionManager.getSessionDir(),
        sessionFile: parentSession.sessionFile,
        model: parentSession.model,
        thinkingLevel: 'off',
        projectTrusted: false
      }
      const role = {
        name: 'explore',
        description: 'External edit fixture',
        systemPrompt: 'EXTERNAL_EDIT_CHILD_ROLE',
        tools: ['read']
      }
      let childFile
      for (const [index, append] of [`EXTERNAL_${source.toUpperCase()}_LATEST`, ''].entries()) {
        const notices = f.marker.notices.length
        if (index === 0) {
          f.hold()
          const requestCount = f.requests.length
          const activeRun = parentSession.prompt('外部编辑期间保持已运行任务快照')
          await f.waitRequests(requestCount + 1)
          const activePrompt = parentSession.systemPrompt
          await writeFile(path, append)
          assert.equal(parentSession.systemPrompt, activePrompt)
          assert.equal(f.marker.notices.length, notices)
          f.release()
          await activeRun
        } else {
          await writeFile(path, append)
        }
        const reads = readPrompt.mock.callCount()
        await parentSession.prompt(`外部正文父任务 ${index}`)
        assert.equal(readPrompt.mock.callCount(), reads + 1)
        const parentRequest = f.requests.at(-1)
        const parentPrompt = parentRequest.messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n')
        assert.doesNotMatch(parentPrompt, new RegExp(original))
        if (append) assert.equal(occurrences(parentPrompt, append), 1)
        assert.deepEqual(parentSession.getActiveToolNames(), baselineTools)
        const child = await childRuntime.open(
          role,
          parent,
          childFile
            ? SessionManager.open(childFile)
            : SessionManager.create(f.cwd, join(f.agentDir, 'sessions', 'external-edit-children'))
        )
        children.add(child)
        await child.prompt(index === 0 ? '外部正文创建子会话' : '空追加恢复子会话')
        const childPrompt = f.requests
          .at(-1)
          .messages.filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n')
        assert.match(childPrompt, /EXTERNAL_EDIT_CHILD_ROLE/)
        assert.doesNotMatch(childPrompt, new RegExp(original))
        assert.equal(f.marker.notices.length, notices + 1)
        assert.equal(f.marker.notices.at(-1).appendSystemPrompt, append)
        if (append) assert.equal(occurrences(childPrompt, append), 1)
        else assert.doesNotMatch(childPrompt, /EXTERNAL_(GLOBAL|CUSTOM)_LATEST|HOST_APPEND_FIRST/)
        assert.equal(readPrompt.mock.callCount(), reads + 1)
        childFile = child.sessionFile
        await child.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
        child.dispose()
        children.delete(child)
        await parentSession.prompt('相同正文不重复通知')
        assert.equal(f.marker.notices.length, notices + 1)
      }
      assert.equal(fullApply.mock.callCount(), 0)
      f.success()
    }
  )
}

test(
  '真实 AgentSession 结构化基线、连续任务和运行中保存保持独立快照，预览零副作用',
  { timeout: 30_000 },
  async (context) => {
    const f = await fixture(context)
    await assert.rejects(f.worker.readModelContext('DRAFT_BEFORE_READY'), /预览暂不可用/)
    assert.equal(f.marker.hooks, 0)
    assert.equal(f.marker.notices.length, 0)
    assert.equal(f.worker.isInitialized, false)
    const session = await f.session()
    const file = session.sessionFile
    const beforeFirstPreview = await readFile(file, 'utf8').catch(() => '')
    const activeTools = session.getActiveToolNames()
    const initialPreview = await f.worker.readModelContext('UNSAVED_DRAFT')
    assert.match(initialPreview.baseSystemPrompt, /NATIVE_APPEND_BASE/)
    assert.match(initialPreview.baseSystemPrompt, /PROJECT_BASE_RULES/)
    assert.doesNotMatch(initialPreview.baseSystemPrompt, /HOST_APPEND_FIRST/)
    assert.equal(initialPreview.systemPrompt, `${initialPreview.baseSystemPrompt}\n\nUNSAVED_DRAFT`)
    assert.equal(f.marker.hooks, 0)
    assert.equal(f.requests.length, 0)
    assert.equal(await readFile(file, 'utf8').catch(() => ''), beforeFirstPreview)
    assert.deepEqual(session.getActiveToolNames(), activeTools)

    f.hold()
    const first = session.prompt('第一个任务')
    await f.waitRequests(1)
    const firstPrompt = session.systemPrompt
    assert.equal(occurrences(firstPrompt, 'HOST_APPEND_FIRST'), 1)
    assert.match(firstPrompt, /OTHER_PLUGIN_BASE/)
    assert.match(firstPrompt, /STRUCTURED_PLUGIN_SECTION/)
    assert.match(firstPrompt, /PROJECT_BASE_RULES/)
    await f.store.replaceGlobalPrompt('HOST_APPEND_SECOND')
    await f.worker.applyCapabilityMode()
    assert.equal(session.systemPrompt, firstPrompt)
    assert.equal(f.marker.notices.at(-1).appendSystemPrompt, 'HOST_APPEND_SECOND')
    const beforePreview = await readFile(file, 'utf8').catch(() => '')
    const noticeCount = f.marker.notices.length
    const empty = await f.worker.readModelContext('')
    assert.equal(empty.systemPrompt, empty.baseSystemPrompt)
    assert.doesNotMatch(empty.baseSystemPrompt, /HOST_APPEND_FIRST|HOST_APPEND_SECOND/)
    assert.match(empty.baseSystemPrompt, /OTHER_PLUGIN_BASE/)
    const draft = await f.worker.readModelContext('UNSAVED_RUNNING_DRAFT')
    assert.equal(occurrences(draft.systemPrompt, 'UNSAVED_RUNNING_DRAFT'), 1)
    assert.equal(f.marker.hooks, 1)
    assert.equal(f.requests.length, 1)
    assert.equal(f.marker.notices.length, noticeCount)
    assert.equal(await readFile(file, 'utf8').catch(() => ''), beforePreview)
    assert.deepEqual(session.getActiveToolNames(), activeTools)
    f.release()
    await first
    f.hold()
    const second = session.prompt('第二个任务')
    await f.waitRequests(2)
    assert.equal(occurrences(session.systemPrompt, 'HOST_APPEND_SECOND'), 1)
    assert.doesNotMatch(session.systemPrompt, /HOST_APPEND_FIRST/)
    assert.equal(occurrences(session.systemPrompt, 'OTHER_PLUGIN_BASE'), 1)
    assert.equal((await f.worker.readModelContext()).baseSystemPrompt, undefined)
    f.release()
    await second
    assert.equal(f.marker.hooks, 2)
    // Pi 1.2 按原生系统 section 保存历史；宿主不另写配置或自定义正文条目。
    const saved = await readFile(file, 'utf8')
    assert.match(saved, /HOST_APPEND_FIRST/)
    assert.match(saved, /HOST_APPEND_SECOND/)
    const entries = saved
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(
      entries.some((entry) => entry.type === 'custom'),
      false
    )
    await f.worker.reload('basic')
    const reloadedPreview = await f.worker.readModelContext('')
    assert.doesNotMatch(reloadedPreview.baseSystemPrompt, /OTHER_PLUGIN_BASE|HOST_APPEND_/)
    const basic = Reflect.get(f.worker, 'session')
    f.hold()
    const basicRun = basic.prompt('基础会话任务')
    await f.waitRequests(3)
    assert.equal(occurrences(basic.systemPrompt, 'HOST_APPEND_SECOND'), 1)
    assert.match(basic.systemPrompt, /NATIVE_APPEND_BASE/)
    f.release()
    await basicRun
    assert.equal(f.marker.hooks, 2)
    f.success()
  }
)

for (const style of ['full', 'force']) {
  test(
    `真实 AgentSession 保留插件 ${style} 正文且连续追加不重复`,
    { timeout: 30_000 },
    async (context) => {
      const f = await fixture(context, style)
      const session = await f.session()
      for (let index = 1; index <= 2; index += 1) {
        f.hold()
        const run = session.prompt(`强制正文任务 ${index}`)
        await f.waitRequests(index)
        const expected = style === 'full' ? 'FULL_PLUGIN_BASE' : 'FORCED_PLUGIN_BASE'
        assert.equal(session.systemPrompt, `${expected}\n\nHOST_APPEND_FIRST`)
        const preview = await f.worker.readModelContext('DRAFT')
        assert.equal(preview.baseSystemPrompt, expected)
        assert.equal(preview.systemPrompt, `${expected}\n\nDRAFT`)
        const system = f.requests[index - 1].messages.find((message) => message.role === 'system')
        assert.equal(system.content, `${expected}\n\nHOST_APPEND_FIRST`)
        f.release()
        await run
      }
      await f.store.replaceGlobalPrompt('')
      f.hold()
      const emptyRun = session.prompt('空追加任务')
      await f.waitRequests(3)
      assert.equal(
        session.systemPrompt,
        style === 'full' ? 'FULL_PLUGIN_BASE' : 'FORCED_PLUGIN_BASE'
      )
      f.release()
      await emptyRun
      assert.equal(f.marker.hooks, 3)
      f.success()
    }
  )
}

test(
  '真实 Runtime 默认只首次解析，手动选择、分支和Worker重载保留，删除回全开并通知最新全局正文',
  { timeout: 30_000 },
  async (context) => {
    const f = await fixture(context)
    const { L4PiWorkSessionRuntime } = await jiti.import(
      '../src/server/l4_foundation/pi/l4-pi-work-session-runtime.ts'
    )
    await f.store.replace(
      {
        quiet: { name: 'Quiet', promptSource: 'none' },
        custom: { name: 'Custom', promptSource: 'custom' }
      },
      { custom: 'CUSTOM_APPEND' }
    )
    await f.store.replaceDefault({ cwd: null, defaultMode: 'custom' })
    const runtime = L4PiWorkSessionRuntime.create(f.cwd)
    f.runtimes.push(runtime)
    await runtime.readModelContext()
    const worker = Reflect.get(runtime, 'chatWorker')
    assert.equal((await worker.getRuntime()).capabilityMode, 'custom')
    await runtime.setCapabilityMode('quiet')
    await f.store.replaceDefault({ cwd: f.cwd, defaultMode: 'custom' })
    assert.equal((await worker.getRuntime()).capabilityMode, 'quiet')
    await runtime.reload('basic')
    assert.equal((await worker.getRuntime()).capabilityMode, 'quiet')
    const session = Reflect.get(worker, 'session')
    await session.prompt('创建分支历史')
    const user = session.sessionManager
      .getEntries()
      .find((entry) => entry.type === 'message' && entry.message.role === 'user')
    await runtime.branch(user.id)
    assert.equal((await worker.getRuntime()).capabilityMode, 'quiet')
    await f.store.replace({ custom: { name: 'Custom', promptSource: 'custom' } })
    await Reflect.get(runtime, 'capabilityTail')
    assert.equal((await worker.getRuntime()).capabilityMode, null)
    await runtime.reload('normal')
    await f.store.replaceGlobalPrompt('LATEST_GLOBAL_APPEND')
    await Reflect.get(runtime, 'capabilityTail')
    assert.equal(f.marker.notices.at(-1).appendSystemPrompt, 'LATEST_GLOBAL_APPEND')
    const sessionId = runtime.sessionId
    await runtime.dispose()
    const restored = await L4PiWorkSessionRuntime.open(f.cwd, sessionId)
    f.runtimes.push(restored)
    await restored.readModelContext()
    assert.equal((await Reflect.get(restored, 'chatWorker').getRuntime()).capabilityMode, 'custom')
    f.success()
  }
)
