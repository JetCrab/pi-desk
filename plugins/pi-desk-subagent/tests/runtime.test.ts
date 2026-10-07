import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Agent } from '@earendil-works/pi-agent-core'
import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type PromptOptions,
  type ModelRuntime,
  type SessionEntry,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent
} from '@earendil-works/pi-ai'
import { getModel } from '@earendil-works/pi-ai/compat'
import type { TaskReportEvent } from '@jetcrab/pi-desk-sdk'
import type { SubagentConfig } from '../src/agent-config'
import type { ResearchDelegateTask, ResearchWorkerOutcome } from '../src/research-runtime'
import {
  createRetryCompatibilityExtension,
  normalizeRetryableAbortedAssistantMessage,
  SubagentRuntime,
  type SubagentParentContext
} from '../src/subagent-runtime'

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => {
        if (event.type === 'done') return event.message
        if (event.type === 'error') return event.error
        throw new Error('Unexpected assistant event')
      }
    )
  }
}

type FakeSessionControl = {
  session: AgentSession
  steers: string[]
  aborted: boolean
  disposed: boolean
  prompted: boolean
  shutdownEvents: string[]
  shutdownHook: () => Promise<void>
  fail: (error: Error) => void
  complete: (text: string) => void
}

function createFakeSession(sessionManager: SessionManager): FakeSessionControl {
  const sessionFile = sessionManager.getSessionFile()
  if (!sessionFile) throw new Error('test session requires file')
  mkdirSync(dirname(sessionFile), { recursive: true })
  let resolvePrompt: (() => void) | undefined
  let rejectPrompt: ((error: Error) => void) | undefined
  const control: FakeSessionControl = {
    session: null as unknown as AgentSession,
    steers: [],
    aborted: false,
    disposed: false,
    prompted: false,
    shutdownEvents: [],
    shutdownHook: async (): Promise<void> => {},
    fail(error: Error): void {
      sessionManager.appendMessage({ ...abortedAssistant(error.message), stopReason: 'error' })
      rejectPrompt?.(error)
    },
    complete(text: string): void {
      sessionManager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'test',
        provider: 'test',
        model: 'test-model',
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: Date.now()
      })
      resolvePrompt?.()
    }
  }
  control.session = {
    sessionId: sessionManager.getSessionId(),
    sessionFile,
    sessionManager,
    model: { provider: 'test', id: 'test-model', name: '测试模型' },
    getContextUsage: () => ({ tokens: 12_000, contextWindow: 128_000 }),
    agent: { subscribe: () => () => undefined },
    isStreaming: true,
    prompt: async (_text: string, options?: PromptOptions): Promise<void> => {
      control.prompted = true
      options?.preflightResult?.('started')
      await new Promise<void>((resolve, reject) => {
        resolvePrompt = resolve
        rejectPrompt = reject
      })
    },
    steer: async (text: string): Promise<void> => {
      control.steers.push(text)
    },
    abort: async (): Promise<void> => {
      control.aborted = true
      sessionManager.appendMessage({
        role: 'assistant',
        content: [],
        api: 'test',
        provider: 'test',
        model: 'test-model',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'aborted',
        timestamp: Date.now()
      })
      rejectPrompt?.(new Error('aborted'))
    },
    extensionRunner: {
      emit: async (event: { type: string }): Promise<void> => {
        assert.equal(control.disposed, false)
        control.shutdownEvents.push(event.type)
        await control.shutdownHook()
      }
    },
    dispose: (): void => {
      assert.equal(control.disposed, false)
      control.disposed = true
    }
  } as unknown as AgentSession
  return control
}

class FakeSubagentRuntime extends SubagentRuntime {
  readonly sessions: FakeSessionControl[] = []
  readonly childConfigs: SubagentConfig[] = []
  creationGate: Promise<void> | undefined

  delegate(
    ownerTaskId: string,
    tasks: readonly ResearchDelegateTask[],
    signal: AbortSignal | undefined,
    onProgress: (completed: number, total: number) => void
  ): Promise<ResearchWorkerOutcome[]> {
    return this.delegateResearchWorkers(ownerTaskId, tasks, signal, onProgress)
  }

  protected override async createChildSession(
    config: SubagentConfig,
    _parent: SubagentParentContext,
    sessionManager: SessionManager
  ): Promise<AgentSession> {
    this.childConfigs.push(config)
    const control = createFakeSession(sessionManager)
    this.sessions.push(control)
    await this.creationGate
    return control.session
  }
}

const toolExecution: Pick<ExtensionToolContext, 'tools' | 'executeTool'> = {
  tools: [],
  async executeTool(): Promise<never> {
    throw new Error('子代理运行测试不应调用嵌套工具')
  }
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('运行中的父会话刷新可用类型并在下次启动读取最新模型设置', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-desk-subagent-refresh-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const settingsPath = join(agentDir, 'settings.json')
  writeFileSync(
    settingsPath,
    JSON.stringify({
      agents: { dev: { disabled: true }, explore: { model: 'my/old-model', thinking: 'low' } }
    }),
    'utf8'
  )

  const tools = new Map<string, ToolDefinition>()
  let activeTools: string[] = []
  const pi = {
    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool)
    },
    getActiveTools(): string[] {
      return activeTools
    },
    setActiveTools(names: string[]): void {
      activeTools = names
    },
    events: {
      emit(): void {},
      on(): () => void {
        return () => undefined
      }
    },
    on(): () => void {
      return () => undefined
    },
    appendEntry(): string {
      return 'entry'
    },
    sendMessage(): void {}
  } as unknown as ExtensionAPI
  const runtime = new FakeSubagentRuntime(pi, {} as ModelRuntime, agentDir)
  context.after(async () => {
    await runtime.shutdown()
    rmSync(root, { recursive: true, force: true })
  })
  const parentSessionDir = join(root, 'sessions', 'project')
  const ctx = {
    cwd,
    model: undefined,
    thinkingLevel: 'off',
    sessionManager: {
      getSessionId: () => 'parent-session',
      getSessionDir: () => parentSessionDir,
      getSessionFile: () => join(parentSessionDir, 'parent.jsonl'),
      getBranch: () => []
    },
    ...toolExecution,
    isProjectTrusted: () => false
  } as unknown as ExtensionToolContext
  await runtime.startSession(ctx)

  const initialAgent = tools.get('agent')
  assert.ok(initialAgent)
  assert.deepEqual(
    (initialAgent.parameters as { properties: { subagent_type: { enum: string[] } } }).properties
      .subagent_type.enum,
    ['explore', 'research']
  )

  writeFileSync(
    settingsPath,
    JSON.stringify({
      agents: {
        dev: { disabled: true },
        explore: { model: 'my/new-model', thinking: 'high' },
        research: { disabled: true }
      }
    }),
    'utf8'
  )
  runtime.refreshConfigs()

  const refreshedAgent = tools.get('agent')
  assert.ok(refreshedAgent)
  assert.deepEqual(
    (refreshedAgent.parameters as { properties: { subagent_type: { enum: string[] } } }).properties
      .subagent_type.enum,
    ['explore']
  )
  assert.ok(activeTools.includes('agent'))

  await refreshedAgent.execute(
    'refresh-call',
    { subagent_type: 'explore', prompt: '检查最新配置', description: '配置刷新验证' },
    undefined,
    undefined,
    ctx
  )
  assert.equal(runtime.childConfigs[0]?.model, 'my/new-model')
  assert.equal(runtime.childConfigs[0]?.thinking, 'high')
  runtime.sessions[0]?.complete('配置已刷新')
  await nextTick()
  assert.equal(runtime.sessions[0]?.disposed, true)
})

function abortedAssistant(errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'aborted',
    errorMessage,
    timestamp: Date.now()
  }
}

test('可重试的 aborted 流错误交回 AgentSession，主动中断保持 aborted', () => {
  const message = abortedAssistant('OpenAI Responses stream ended before a terminal response event')
  assert.equal(normalizeRetryableAbortedAssistantMessage(message, false)?.stopReason, 'error')
  assert.equal(normalizeRetryableAbortedAssistantMessage(message, true), undefined)
  assert.equal(
    normalizeRetryableAbortedAssistantMessage(abortedAssistant('Request was aborted'), false),
    undefined
  )
})

test('重试兼容扩展等待原生 AgentSession 重试成功后再结束 prompt', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-desk-subagent-retry-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const model = getModel('anthropic', 'claude-sonnet-4-5')
  assert.ok(model)

  let callCount = 0
  const agent = new Agent({
    getApiKey: () => 'test-key',
    initialState: { model, systemPrompt: 'Test', tools: [] },
    streamFn: () => {
      callCount += 1
      const stream = new MockAssistantStream()
      queueMicrotask(() => {
        if (callCount === 1) {
          const message: AssistantMessage = {
            ...abortedAssistant('OpenAI Responses stream ended before a terminal response event'),
            api: model.api,
            provider: model.provider,
            model: model.id
          }
          stream.push({ type: 'start', partial: message })
          stream.push({ type: 'error', reason: 'aborted', error: message })
          return
        }
        const message: AssistantMessage = {
          ...abortedAssistant(''),
          content: [{ type: 'text', text: 'Recovered' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: 'stop',
          errorMessage: undefined
        }
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'done', reason: 'stop', message })
      })
      return stream
    }
  })
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 }
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      {
        name: 'subagent-retry-compatibility-test',
        factory: createRetryCompatibilityExtension(() => false)
      }
    ]
  })
  await resourceLoader.reload()
  const modelRuntime = {
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ source: 'test' }),
    isUsingOAuth: () => false,
    getModel: () => model,
    registerProvider(): void {},
    registerNativeProvider(): void {},
    unregisterProvider(): void {}
  } as unknown as ModelRuntime
  const session = new AgentSession({
    agent,
    sessionManager: SessionManager.inMemory(root),
    settingsManager,
    cwd: root,
    resourceLoader,
    modelRuntime,
    initialActiveToolNames: []
  })
  context.after(() => session.dispose())
  await session.bindExtensions({ mode: 'rpc' })

  const events: string[] = []
  session.subscribe((event) => {
    if (event.type === 'auto_retry_start') events.push(`start:${event.attempt}`)
    if (event.type === 'auto_retry_end') events.push(`end:${event.success}`)
  })
  await session.prompt('Test')

  assert.equal(callCount, 2)
  assert.deepEqual(events, ['start:1', 'end:true'])
})

test('agent、steer、stop、list 和 resume 复用同一 child Session 身份', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-desk-subagent-runtime-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  mkdirSync(join(agentDir, 'agents'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    join(agentDir, 'agents', 'explore.md'),
    '---\ndescription: Explore\ntools: read, grep, find, ls\n---\n\nExplore prompt\n',
    'utf8'
  )

  const tools = new Map<string, ToolDefinition>()
  const reports: TaskReportEvent[] = []
  const messages: Array<{ content: unknown; options: unknown }> = []
  const pi = {
    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool)
    },
    getActiveTools(): string[] {
      return []
    },
    setActiveTools(): void {},
    events: {
      emit(_channel: string, payload: unknown): void {
        reports.push(payload as TaskReportEvent)
      },
      on(): () => void {
        return () => undefined
      }
    },
    on(): () => void {
      return () => undefined
    },
    appendEntry(): string {
      return 'entry'
    },
    sendMessage(content: unknown, options: unknown): void {
      messages.push({ content, options })
    }
  } as unknown as ExtensionAPI
  const runtime = new FakeSubagentRuntime(pi, {} as ModelRuntime, agentDir)
  const parentSessionDir = join(root, 'sessions', 'project')
  const parentFile = join(parentSessionDir, 'parent.jsonl')
  const ctx = {
    cwd,
    model: undefined,
    thinkingLevel: 'off',
    sessionManager: {
      getSessionId: () => 'parent-session',
      getSessionDir: () => parentSessionDir,
      getSessionFile: () => parentFile,
      getBranch: () => []
    },
    ...toolExecution,
    isProjectTrusted: () => false
  } as unknown as ExtensionToolContext
  await runtime.startSession(ctx)

  const agent = tools.get('agent')
  const steer = tools.get('agent_steer')
  const list = tools.get('agent_list')
  const stop = tools.get('agent_stop')
  const resume = tools.get('agent_resume')
  assert.ok(agent && steer && list && stop && resume)
  assert.equal(agent.exposure, 'model-only')
  assert.equal(resume.exposure, 'model-only')

  const started = await agent.execute(
    'call-agent',
    {
      subagent_type: 'explore',
      prompt: '调查实现',
      description: '调查任务中心'
    },
    undefined,
    undefined,
    ctx
  )
  const launch = started.details as {
    version: number
    kind: string
    taskId: string
    agentType: string
    title: string
    sessionFile: string
    startedAt: number
  }
  assert.equal(started.content[0]?.type, 'text')
  const startedText = started.content[0]?.type === 'text' ? started.content[0].text : ''
  assert.match(startedText, /子代理已在后台启动。/)
  assert.match(startedText, new RegExp(`Agent ID: ${launch.taskId}`))
  assert.match(startedText, /子代理结束后会异步主动通知结果并唤醒主代理。/)
  assert.match(
    startedText,
    /不要为等待结果调用 agent_list 查询状态，也不要通过 bash\/sleep 等方式等待。/
  )
  assert.match(startedText, /可以继续独立工作；没有独立工作时结束当前轮，等待通知。/)
  assert.doesNotMatch(startedText, /调查任务中心/)
  assert.deepEqual(
    { ...launch, startedAt: typeof launch.startedAt },
    {
      version: 1,
      kind: 'launch',
      taskId: launch.taskId,
      agentType: 'explore',
      title: '调查任务中心',
      sessionFile: runtime.sessions[0]!.session.sessionFile,
      startedAt: 'number'
    }
  )
  assert.equal(launch.title, '调查任务中心')
  await assert.rejects(
    resume.execute(
      'call-resume-running',
      { agent_id: launch.taskId, prompt: '不应并发恢复' },
      undefined,
      undefined,
      ctx
    ),
    /仍在运行/
  )
  assert.equal(runtime.sessions.length, 1)
  assert.equal(
    dirname(runtime.sessions[0]!.session.sessionFile!),
    join(parentSessionDir, 'subagents', 'parent-session')
  )
  const launchReport = reports.find((value) => value.type === 'upsert')
  assert.ok(launchReport && launchReport.type === 'upsert')
  assert.deepEqual(launchReport.tasks[0], {
    taskId: launch.taskId,
    taskKind: '子代理',
    taskType: 'explore',
    title: '调查任务中心',
    info: [
      { label: '运行信息', value: '测试模型 · 12,000/128,000 tokens' },
      { label: '消息数', value: '0/0（用户/总数）' },
      { label: '会话文件', value: runtime.sessions[0]!.session.sessionFile! }
    ],
    status: 'running',
    activity: '执行中',
    startedAt: launchReport.tasks[0]?.startedAt,
    endedAt: null,
    detailSource: {
      kind: 'pi-conversation',
      session: runtime.sessions[0]?.session
    },
    interrupt: launchReport.tasks[0]?.interrupt
  })

  await steer.execute(
    'call-steer',
    { agent_id: launch.taskId.slice(0, 8), prompt: '补充检查错误路径' },
    undefined,
    undefined,
    ctx
  )
  assert.deepEqual(runtime.sessions[0]?.steers, ['补充检查错误路径'])

  const listed = await list.execute('call-list', {}, undefined, undefined, ctx)
  assert.match(listed.content[0]?.type === 'text' ? listed.content[0].text : '', /调查任务中心/)

  const stopped = await stop.execute(
    'call-stop',
    { agent_id: launch.taskId },
    undefined,
    undefined,
    ctx
  )
  assert.deepEqual(stopped.details, {
    taskId: launch.taskId,
    agentType: 'explore',
    title: '调查任务中心'
  })
  const stoppedText = stopped.content[0]?.type === 'text' ? stopped.content[0].text : ''
  assert.match(stoppedText, /已请求停止子代理。最终状态以后续结束通知为准。/)
  assert.match(stoppedText, new RegExp(`Agent ID: ${launch.taskId}`))
  await nextTick()
  assert.equal(runtime.sessions[0]?.aborted, true)
  assert.equal(runtime.sessions[0]?.disposed, true)
  assert.equal(messages.length, 1)
  const completion = messages[0]?.content as { details: { status: string } }
  assert.equal(completion.details.status, 'interrupted')
  await assert.rejects(
    steer.execute(
      'call-steer-terminal',
      { agent_id: launch.taskId, prompt: '不应投递到终态子代理' },
      undefined,
      undefined,
      ctx
    ),
    /当前不是 running/
  )

  const resumed = await resume.execute(
    'call-resume',
    { agent_id: launch.taskId, prompt: '继续调查剩余路径' },
    undefined,
    undefined,
    ctx
  )
  const resumedDetails = resumed.details as {
    version: number
    kind: string
    taskId: string
    agentType: string
    title: string
    sessionFile: string
    startedAt: number
  }
  const resumedText = resumed.content[0]?.type === 'text' ? resumed.content[0].text : ''
  assert.match(resumedText, /子代理已恢复运行。/)
  assert.match(resumedText, new RegExp(`Agent ID: ${launch.taskId}`))
  assert.match(resumedText, /子代理结束后会异步主动通知结果并唤醒主代理。/)
  assert.match(
    resumedText,
    /不要为等待结果调用 agent_list 查询状态，也不要通过 bash\/sleep 等方式等待。/
  )
  assert.match(resumedText, /可以继续独立工作；没有独立工作时结束当前轮，等待通知。/)
  assert.deepEqual(
    { ...resumedDetails, startedAt: typeof resumedDetails.startedAt },
    {
      version: 1,
      kind: 'launch',
      taskId: launch.taskId,
      agentType: 'explore',
      title: '调查任务中心',
      sessionFile: runtime.sessions[1]!.session.sessionFile,
      startedAt: 'number'
    }
  )
  assert.equal(resumedDetails.taskId, launch.taskId)
  assert.equal(runtime.sessions.length, 2)
  assert.equal(runtime.sessions[1]?.session.sessionId, launch.taskId)

  const longResult = `BEGIN\n${'完整子代理结果。'.repeat(4_000)}\nEND`
  assert.ok(longResult.length > 20_000)
  runtime.sessions[1]?.complete(longResult)
  await nextTick()

  assert.equal(runtime.sessions[1]?.disposed, true)
  assert.equal(messages.length, 2)
  const completed = messages[1]?.content as {
    content: string
    details: { status: string }
  }
  assert.equal(completed.details.status, 'completed')
  assert.equal(completed.content.endsWith(longResult), true)
  assert.doesNotMatch(completed.content, /结果已截断/)
  assert.deepEqual(messages[1]?.options, { deliverAs: 'steer', triggerTurn: true })

  await runtime.shutdown()
})

test('Root research 等待全部平级 Worker 且 Worker 不直接通知主代理', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-desk-subagent-research-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  mkdirSync(cwd, { recursive: true })

  const tools = new Map<string, ToolDefinition>()
  const reports: TaskReportEvent[] = []
  const messages: Array<{ content: unknown; options: unknown }> = []
  const entries: Array<{ customType: string; data: unknown }> = []
  const pi = {
    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool)
    },
    getActiveTools(): string[] {
      return []
    },
    setActiveTools(): void {},
    events: {
      emit(_channel: string, payload: unknown): void {
        reports.push(payload as TaskReportEvent)
      },
      on(): () => void {
        return () => undefined
      }
    },
    on(): () => void {
      return () => undefined
    },
    appendEntry(customType: string, data: unknown): void {
      entries.push({ customType, data })
    },
    sendMessage(content: unknown, options: unknown): void {
      messages.push({ content, options })
    }
  } as unknown as ExtensionAPI
  const runtime = new FakeSubagentRuntime(pi, {} as ModelRuntime, agentDir)
  const parentSessionDir = join(root, 'sessions', 'project')
  const parentFile = join(parentSessionDir, 'parent.jsonl')
  const ctx = {
    cwd,
    model: undefined,
    thinkingLevel: 'off',
    sessionManager: {
      getSessionId: () => 'main-session',
      getSessionDir: () => parentSessionDir,
      getSessionFile: () => parentFile,
      getBranch: () => []
    },
    ...toolExecution,
    isProjectTrusted: () => false
  } as unknown as ExtensionToolContext
  await runtime.startSession(ctx)

  const agent = tools.get('agent')
  assert.ok(agent)
  const started = await agent.execute(
    'call-research',
    {
      subagent_type: 'research',
      prompt: '调研两个独立对象',
      description: '协调外部调研'
    },
    undefined,
    undefined,
    ctx
  )
  const rootTaskId = (started.details as { taskId: string }).taskId
  const progress: Array<[number, number]> = []
  let settled = false
  const delegated = runtime
    .delegate(
      rootTaskId,
      [
        { title: '调研对象 A', prompt: '只研究对象 A' },
        { title: '调研对象 B', prompt: '只研究对象 B' }
      ],
      undefined,
      (completed, total) => progress.push([completed, total])
    )
    .then((outcomes) => {
      settled = true
      return outcomes
    })

  await nextTick()
  assert.equal(runtime.sessions.length, 3)
  assert.equal(settled, false)
  const list = tools.get('agent_list')!
  const listed = await list.execute('research-list', {}, undefined, undefined, ctx)
  assert.deepEqual(
    (listed.details as { agents: Array<{ taskId: string }> }).agents.map((record) => record.taskId),
    [rootTaskId]
  )
  await assert.rejects(
    list.execute(
      'research-worker-query',
      { agent_id: runtime.sessions[1]!.session.sessionId },
      undefined,
      undefined,
      ctx
    ),
    /未知 Agent ID/
  )
  const childDirectory = join(parentSessionDir, 'subagents', 'main-session')
  assert.deepEqual(
    runtime.sessions.map((control) => dirname(control.session.sessionFile!)),
    [childDirectory, childDirectory, childDirectory]
  )
  assert.deepEqual(
    runtime.sessions
      .slice(1)
      .map((control) => control.session.sessionManager.getHeader()?.parentSession),
    [parentFile, parentFile]
  )
  assert.equal(
    entries.filter((entry) => entry.customType === 'pi-desk-subagent:launch:v1').length,
    2
  )

  runtime.sessions[1]!.complete('对象 A 结论')
  await nextTick()
  assert.equal(settled, false)
  assert.deepEqual(progress, [[1, 2]])
  assert.equal(messages.length, 0)

  runtime.sessions[2]!.complete('对象 B 结论')
  const outcomes = await delegated
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.title, outcome.status, outcome.result]),
    [
      ['调研对象 A', 'completed', '对象 A 结论'],
      ['调研对象 B', 'completed', '对象 B 结论']
    ]
  )
  assert.deepEqual(progress, [
    [1, 2],
    [2, 2]
  ])
  assert.equal(messages.length, 0)
  assert.equal(
    entries.filter((entry) => entry.customType === 'pi-desk-subagent:state:v1').length,
    2
  )
  const taskTypes = reports.flatMap((report) =>
    report.type === 'upsert' ? report.tasks.map((task) => task.taskType) : []
  )
  assert.equal(taskTypes.filter((taskType) => taskType === 'research-worker').length >= 2, true)

  const controller = new AbortController()
  const interrupted = runtime.delegate(
    rootTaskId,
    [
      { title: '调研对象 C', prompt: '只研究对象 C' },
      { title: '调研对象 D', prompt: '只研究对象 D' }
    ],
    controller.signal,
    () => undefined
  )
  await nextTick()
  controller.abort()
  const interruptedOutcomes = await interrupted
  assert.deepEqual(
    interruptedOutcomes.map((outcome) => outcome.status),
    ['interrupted', 'interrupted']
  )
  assert.equal(runtime.sessions[3]?.aborted, true)
  assert.equal(runtime.sessions[4]?.aborted, true)
  assert.equal(messages.length, 0)

  runtime.sessions[0]!.complete('Root 汇总结论')
  await nextTick()
  assert.equal(messages.length, 1)
  await runtime.shutdown()
})

for (const outcome of [
  'completed',
  'failed',
  'stopped',
  'parent-shutdown',
  'closing-parent'
] as const) {
  test(`子代理 ${outcome} 等待扩展关闭后再结束，恢复时使用新生命周期`, async (context) => {
    const testRoot = fileURLToPath(new URL('../../../temp/pi/subagent-lifecycle/', import.meta.url))
    mkdirSync(testRoot, { recursive: true })
    const root = mkdtempSync(join(testRoot, 'run-'))
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'project')
    mkdirSync(join(agentDir, 'agents'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      join(agentDir, 'agents', 'test.md'),
      '---\ndescription: 测试收尾\ntools: read\n---\n\n执行指定测试。\n',
      'utf8'
    )

    const tools = new Map<string, ToolDefinition>()
    const completions: Array<{ details: { status: string } }> = []
    const pi = {
      registerTool(tool: ToolDefinition): void {
        tools.set(tool.name, tool)
      },
      getActiveTools(): string[] {
        return []
      },
      setActiveTools(): void {},
      events: {
        emit(): void {},
        on(): () => void {
          return () => undefined
        }
      },
      on(): () => void {
        return () => undefined
      },
      appendEntry(): string {
        return 'entry'
      },
      sendMessage(message: { details: { status: string } }): void {
        assert.equal(runtime.sessions.at(-1)?.disposed, true)
        completions.push(message)
      }
    } as unknown as ExtensionAPI
    const runtime = new FakeSubagentRuntime(pi, {} as ModelRuntime, agentDir)
    const parent = SessionManager.create(cwd, join(agentDir, 'sessions'))
    const ctx = {
      cwd,
      sessionManager: parent,
      ...toolExecution,
      isProjectTrusted: () => false
    } as unknown as ExtensionToolContext
    let releaseShutdown = (): void => {}
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })
    context.after(async () => {
      releaseShutdown()
      await runtime.shutdown()
      rmSync(root, { recursive: true, force: true })
    })
    await runtime.startSession(ctx)

    async function execute(name: string, params: Record<string, unknown>): Promise<unknown> {
      const tool = tools.get(name)
      assert.ok(tool)
      const result = await tool.execute('lifecycle-call', params, undefined, undefined, ctx)
      return result.details
    }
    const launch = (await execute('agent', {
      subagent_type: 'test',
      description: '验证测试生命周期',
      prompt: '执行测试并返回结论'
    })) as { taskId: string }
    const control = runtime.sessions[0]!
    control.shutdownHook = async (): Promise<void> => {
      await shutdownGate
      // 关闭期间扩展仍需要有效的 Session API 来收尾。
      assert.equal(control.disposed, false)
    }

    let parentClosed = false
    let closing: Promise<void> | undefined
    if (outcome === 'completed') {
      control.complete('验证通过')
    } else if (outcome === 'failed') {
      control.fail(new Error('测试执行失败'))
    } else if (outcome === 'stopped') {
      await execute('agent_stop', { agent_id: launch.taskId })
    } else {
      if (outcome === 'closing-parent') {
        control.complete('验证通过')
        await nextTick()
      }
      closing = runtime.shutdown().then(() => {
        parentClosed = true
      })
    }
    await nextTick()

    assert.deepEqual(control.shutdownEvents, ['session_shutdown'])
    assert.equal(control.disposed, false)
    assert.equal(parentClosed, false)
    assert.equal(completions.length, 0)
    if (outcome !== 'parent-shutdown' && outcome !== 'closing-parent') {
      await assert.rejects(
        execute('agent_resume', { agent_id: launch.taskId, prompt: '继续验证' }),
        /仍在运行/
      )
    }

    releaseShutdown()
    await closing
    await nextTick()
    assert.equal(control.disposed, true)
    assert.deepEqual(control.shutdownEvents, ['session_shutdown'])
    if (outcome === 'parent-shutdown' || outcome === 'closing-parent') {
      assert.equal(parentClosed, true)
      assert.equal(completions.length, 0)
      return
    }
    assert.equal(completions.length, 1)
    assert.equal(completions[0]?.details.status, outcome === 'stopped' ? 'interrupted' : outcome)

    await execute('agent_resume', { agent_id: launch.taskId, prompt: '继续验证' })
    const resumed = runtime.sessions[1]!
    assert.equal(resumed.session.sessionId, launch.taskId)
    resumed.complete('复测通过')
    await nextTick()
    assert.deepEqual(resumed.shutdownEvents, ['session_shutdown'])
    assert.equal(resumed.disposed, true)
    assert.equal(completions.length, 2)
  })
}

test('历史子代理摘要注册延迟 infoLoader 并从 child JSONL 重建信息', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-desk-subagent-history-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const sessionDir = join(root, 'sessions')
  mkdirSync(join(agentDir, 'agents'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const childManager = SessionManager.create(cwd, sessionDir, { id: 'history-task' })
  childManager.appendModelChange('test', 'test-model')
  childManager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '历史问题' }],
    timestamp: 199
  })
  childManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '历史完成' }],
    api: 'test',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 200
  })
  const childSessionFile = childManager.getSessionFile()
  assert.ok(childSessionFile)

  const taskId = 'history-task'
  const branch = [
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'history-tool-call',
        toolName: 'agent',
        content: [{ type: 'text', text: '已启动' }],
        details: {
          version: 1,
          kind: 'launch',
          taskId,
          agentType: 'explore',
          title: '历史任务',
          sessionFile: childSessionFile,
          startedAt: 100
        }
      }
    },
    {
      type: 'custom_message',
      customType: 'pi-desk-subagent:completion:v1',
      content: '完成',
      details: {
        version: 1,
        kind: 'terminal',
        taskId,
        status: 'completed',
        endedAt: 300,
        sessionFile: childSessionFile
      },
      display: false
    }
  ] as unknown as SessionEntry[]
  const reports: TaskReportEvent[] = []
  const pi = {
    registerTool(): void {},
    getActiveTools(): string[] {
      return []
    },
    setActiveTools(): void {},
    events: {
      emit(_channel: string, payload: unknown): void {
        reports.push(payload as TaskReportEvent)
      },
      on(): () => void {
        return () => undefined
      }
    },
    on(): () => void {
      return () => undefined
    }
  } as unknown as ExtensionAPI
  let configuredModel: { id: string; name: string; contextWindow: number } | undefined = {
    id: 'test-model',
    name: '历史测试模型',
    contextWindow: 128_000
  }
  const modelRuntime = {
    getModel(): typeof configuredModel {
      return configuredModel
    }
  } as unknown as ModelRuntime
  const runtime = new SubagentRuntime(pi, modelRuntime, agentDir)
  const ctx = {
    cwd,
    model: undefined,
    thinkingLevel: 'off',
    sessionManager: {
      getSessionId: () => 'parent-session',
      getSessionDir: () => join(root, 'parent-sessions'),
      getSessionFile: () => join(root, 'parent.jsonl'),
      getBranch: () => branch
    },
    isProjectTrusted: () => false
  } as unknown as ExtensionContext

  await runtime.startSession(ctx)
  const report = reports.find((value) => value.type === 'upsert')
  assert.ok(report && report.type === 'upsert')
  const task = report.tasks[0]
  assert.deepEqual(task.info, [])
  assert.equal(typeof task.infoLoader, 'function')
  assert.deepEqual(await task.infoLoader?.(), [
    { label: '运行信息', value: '历史测试模型 · 120/128,000 tokens' },
    { label: '消息数', value: '1/2（用户/总数）' },
    { label: '会话文件', value: childSessionFile }
  ])
  configuredModel.name = ''
  assert.equal((await task.infoLoader?.())?.[0]?.value, 'test-model · 120/128,000 tokens')
  configuredModel = undefined
  assert.equal((await task.infoLoader?.())?.[0]?.value, 'test-model')
  await runtime.shutdown()
})

async function treeFixture(context: test.TestContext) {
  const testRoot = fileURLToPath(new URL('../../../temp/tests/subagent-tree/', import.meta.url))
  mkdirSync(testRoot, { recursive: true })
  const root = mkdtempSync(join(testRoot, 'tree-tasks-'))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  mkdirSync(cwd, { recursive: true })
  const tools = new Map<string, ToolDefinition>()
  const reports: TaskReportEvent[] = []
  const messages: unknown[] = []
  const entries: Array<{ customType: string; data: unknown }> = []
  let registrations = 0
  const pi = {
    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool)
    },
    getActiveTools: () => [],
    setActiveTools(): void {},
    on(): () => void {
      registrations += 1
      return () => undefined
    },
    events: {
      on(): () => void {
        registrations += 1
        return () => undefined
      },
      emit(_channel: string, payload: unknown): void {
        reports.push(payload as TaskReportEvent)
      }
    },
    appendEntry(customType: string, data: unknown): string {
      entries.push({ customType, data })
      return 'entry'
    },
    sendMessage(message: unknown): void {
      messages.push(message)
    }
  } as unknown as ExtensionAPI
  const runtime = new FakeSubagentRuntime(pi, {} as ModelRuntime, agentDir)
  const releases: Array<() => void> = []
  const parent = SessionManager.create(cwd, join(root, 'sessions'))
  const ctx = {
    cwd,
    sessionManager: parent,
    ...toolExecution,
    isProjectTrusted: () => false
  } as unknown as ExtensionToolContext
  await runtime.startSession(ctx)
  context.after(async () => {
    for (const release of releases) release()
    await nextTick()
    for (const control of runtime.sessions) {
      if (!control.disposed) control.complete('清理测试会话')
    }
    await runtime.shutdown()
    rmSync(root, { recursive: true, force: true })
  })
  async function execute(name: string, params: Record<string, unknown> = {}) {
    const tool = tools.get(name)
    assert.ok(tool)
    return tool.execute('tree-call', params, undefined, undefined, ctx)
  }
  const start = () =>
    execute('agent', {
      subagent_type: 'explore',
      description: '分支任务',
      prompt: '检查分支任务'
    })
  return {
    runtime,
    ctx,
    start,
    execute,
    reports,
    messages,
    entries,
    releases,
    registrations: () => registrations
  }
}

test('agent_list 只返回最近启动的20条普通子代理，指定ID查询不受截断影响', async (context) => {
  const f = await treeFixture(context)
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const launches: Array<{ taskId: string; startedAt: number }> = []
  const empty = await f.execute('agent_list')
  assert.equal(
    empty.content[0]?.type === 'text' ? empty.content[0].text.split('\n')[0] : '',
    '下面是最近执行的0条记录。'
  )
  for (let index = 0; index < 23; index += 1) {
    now += 100
    const result = await f.execute('agent', {
      subagent_type: 'explore',
      description: `列表任务 ${index}`,
      prompt: '检查列表'
    })
    launches.push(result.details as { taskId: string; startedAt: number })
    f.runtime.sessions.at(-1)!.complete('列表任务完成')
    await nextTick()
  }
  const list = await f.execute('agent_list')
  const agents = (list.details as { agents: Array<{ taskId: string }> }).agents
  assert.deepEqual(
    agents.map((record) => record.taskId),
    launches
      .slice(3)
      .reverse()
      .map((record) => record.taskId)
  )
  assert.equal(
    list.content[0]?.type === 'text' ? list.content[0].text.split('\n')[0] : '',
    '下面是最近执行的20条记录。'
  )
  for (const query of ['', ' \t\r\n ']) {
    assert.deepEqual(await f.execute('agent_list', { agent_id: query }), list)
  }
  const oldest = launches[0]!.taskId
  for (const query of [oldest, oldest.slice(0, -1), ` ${oldest} `]) {
    const result = await f.execute('agent_list', { agent_id: query })
    assert.deepEqual(
      (result.details as { agents: Array<{ taskId: string; status: string }> }).agents.map(
        (record) => [record.taskId, record.status]
      ),
      [[oldest, 'completed']]
    )
  }
  await assert.rejects(f.execute('agent_list', { agent_id: 'unknown-agent' }), /未知 Agent ID/)
  await assert.rejects(f.execute('agent_list', { agent_id: oldest.slice(0, 2) }), /前缀不唯一/)
  now += 100
  await f.execute('agent_resume', { agent_id: oldest, prompt: '继续列表任务' })
  const resumed = await f.execute('agent_list')
  assert.equal(
    (resumed.details as { agents: Array<{ taskId: string; status: string }> }).agents[0]?.taskId,
    oldest
  )
  assert.equal(
    (resumed.details as { agents: Array<{ status: string }> }).agents[0]?.status,
    'running'
  )
})

function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('树导航等待活子代理关闭；导航取消后原分支保持可用和长期注册', async (context) => {
  const f = await treeFixture(context)
  await f.start()
  const control = f.runtime.sessions[0]!
  const gate = deferred()
  control.shutdownHook = () => gate.promise
  f.releases.push(gate.resolve)
  const registrationCount = f.registrations()
  const signal = new AbortController()
  let finished = false
  const stopping = f.runtime.beforeTree(signal.signal).then((result) => {
    finished = true
    return result
  })
  await nextTick()
  assert.equal(control.aborted, true)
  assert.equal(control.disposed, false)
  assert.equal(finished, false)
  signal.abort()
  gate.resolve()
  assert.deepEqual(await stopping, { cancel: true })
  assert.equal(control.disposed, true)
  assert.equal(f.messages.length, 0)
  assert.equal(f.entries.length, 1)
  const listed = await f.execute('agent_list')
  assert.match(listed.content[0]?.type === 'text' ? listed.content[0].text : '', /interrupted/)
  await f.start()
  f.runtime.sessions[1]!.complete('继续当前分支')
  await nextTick()
  assert.equal(f.messages.length, 1)
  await f.runtime.beforeTree(new AbortController().signal)
  await f.runtime.startSession(f.ctx)
  assert.equal(f.registrations(), registrationCount)
  assert.equal((await f.execute('agent_list')).content[0]?.type, 'text')
  assert.equal(f.reports.at(-1)?.type, 'upsert')
})

test('已取消树导航不停止任务；停止失败保留查询和人工控制', async (context) => {
  const f = await treeFixture(context)
  const launch = (await f.start()).details as { taskId: string }
  const control = f.runtime.sessions[0]!
  const cancelled = new AbortController()
  cancelled.abort()
  assert.deepEqual(await f.runtime.beforeTree(cancelled.signal), { cancel: true })
  assert.equal(control.aborted, false)
  const abort = control.session.abort.bind(control.session)
  control.session.abort = async () => {
    throw new Error('停止失败')
  }
  await assert.rejects(f.runtime.beforeTree(new AbortController().signal), /停止失败/)
  const listed = await f.execute('agent_list')
  assert.match(listed.content[0]?.type === 'text' ? listed.content[0].text : '', /running/)
  assert.equal(control.disposed, false)
  assert.equal(f.entries.length, 0)
  await f.execute('agent_steer', { agent_id: launch.taskId, prompt: '仍可控制' })
  assert.deepEqual(control.steers, ['仍可控制'])
  control.session.abort = abort
  await f.execute('agent_stop', { agent_id: launch.taskId })
  await nextTick()
  assert.equal(control.disposed, true)
})

for (const operation of ['agent', 'agent_resume'] as const) {
  test(`树导航等待 ${operation} 迟到创建关闭，绝不启动模型或污染新分支`, async (context) => {
    const f = await treeFixture(context)
    let taskId = ''
    if (operation === 'agent_resume') {
      taskId = ((await f.start()).details as { taskId: string }).taskId
      f.runtime.sessions[0]!.complete('旧任务完成')
      await nextTick()
    }
    const gate = deferred()
    f.releases.push(gate.resolve)
    f.runtime.creationGate = gate.promise
    const messagesBefore = f.messages.length
    const creating =
      operation === 'agent'
        ? f.start()
        : f.execute('agent_resume', {
            agent_id: taskId,
            prompt: '恢复旧任务'
          })
    const rejected = assert.rejects(creating, /当前父会话已变化/)
    let navigated = false
    const stopping = f.runtime.beforeTree(new AbortController().signal).then(() => {
      navigated = true
    })
    await nextTick()
    assert.equal(navigated, false)
    gate.resolve()
    await rejected
    await stopping
    const stale = f.runtime.sessions.at(-1)!
    assert.equal(stale.disposed, true)
    assert.equal(stale.aborted, false)
    assert.equal(stale.prompted, false)
    await f.runtime.startSession(f.ctx)
    assert.equal(f.messages.length, messagesBefore)
    const list = await f.execute('agent_list')
    assert.match(list.content[0]?.type === 'text' ? list.content[0].text : '', /没有子代理/)
    f.runtime.creationGate = undefined
    await f.start()
    f.runtime.sessions.at(-1)!.complete('新分支任务完成')
    await nextTick()
    assert.equal(f.messages.length, messagesBefore + 1)
  })
}
