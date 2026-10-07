import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { getModel } from '@earendil-works/pi-ai/compat'
import { SESSION_PLUGIN_CAPABILITIES_EVENT } from '@jetcrab/pi-desk-sdk/session'
import { collectSubagentCapabilityOptions } from '../src/agent-config.ts'
import { SubagentCapabilities } from '../src/subagent-capabilities.ts'
import { SubagentRuntime } from '../src/subagent-runtime.ts'

async function writeAgent(directory, name, description, tools = 'read, write') {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, `${name}.md`),
    `---\ndescription: ${description}\ntools: ${tools}\n---\n\n${name} prompt\n`,
    'utf8'
  )
}

function modelRuntime(model) {
  return {
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ source: 'test' }),
    isUsingOAuth: () => false,
    getModel: () => model,
    registerProvider() {},
    registerNativeProvider() {},
    unregisterProvider() {}
  }
}

function parentContext(root, cwd, model) {
  const sessionManager = SessionManager.create(cwd, join(root, 'parent-sessions'))
  return {
    cwd,
    sessionId: sessionManager.getSessionId(),
    sessionDir: sessionManager.getSessionDir(),
    sessionFile: sessionManager.getSessionFile(),
    model,
    thinkingLevel: 'off',
    projectTrusted: true,
    sessionManager
  }
}

function createPi(tools, capabilityRegistrations, reports = []) {
  let activeTools = []
  const handlers = new Map()
  return {
    registerTool(tool) {
      tools.set(tool.name, tool)
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = [...names]
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
    events: {
      emit(channel, payload) {
        if (channel === SESSION_PLUGIN_CAPABILITIES_EVENT) capabilityRegistrations.push(payload)
        else reports.push(payload)
      }
    },
    appendEntry() {},
    sendMessage() {},
    handlers
  }
}

function fakeChildSession(sessionManager) {
  const active = ['read', 'write']
  let resolvePrompt
  let rejectPrompt
  const session = {
    sessionId: sessionManager.getSessionId(),
    sessionFile: sessionManager.getSessionFile(),
    sessionManager,
    model: { provider: 'test', id: 'test-model' },
    isStreaming: true,
    getContextUsage: () => ({ tokens: 1, contextWindow: 100 }),
    prompt: async () =>
      new Promise((resolve, reject) => {
        resolvePrompt = resolve
        rejectPrompt = reject
      }),
    steer: async () => {},
    abort: async () => {
      rejectPrompt?.(new Error('aborted'))
      rejectPrompt = undefined
    },
    getActiveToolNames: () => [...active],
    getAllTools: () => [{ name: 'read' }, { name: 'write' }],
    setActiveToolsByName: (names) => {
      active.splice(0, active.length, ...names)
    },
    extensionRunner: {
      emit: async () => undefined
    },
    dispose: () => {}
  }
  return { session, complete: () => resolvePrompt?.() }
}

test('onCapabilitiesChange 实际更新父 Agent schema、promptGuidelines，并保持 list/stop 可用', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-capabilities-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  await writeAgent(join(agentDir, 'agents'), 'explore', '只用于探索。')
  await writeAgent(join(agentDir, 'agents'), 'research', '只用于研究。')
  const tools = new Map()
  const registrations = []
  const pi = createPi(tools, registrations)
  const runtime = new (class extends SubagentRuntime {
    async createChildSession(_config, _parent, sessionManager) {
      await mkdir(join(sessionManager.getSessionDir()), { recursive: true })
      await writeFile(sessionManager.getSessionFile(), '', 'utf8')
      const child = fakeChildSession(sessionManager)
      this.child = child
      return child.session
    }
  })(pi, modelRuntime(undefined), agentDir)
  context.after(() => runtime.shutdown())
  const parent = parentContext(root, cwd, undefined)
  const ctx = {
    cwd,
    sessionManager: parent.sessionManager,
    thinkingLevel: 'off',
    isProjectTrusted: () => true
  }
  await runtime.startSession(ctx)
  assert.equal(registrations.length, 1)
  const registration = registrations[0].registration

  await registration.execute(
    { tools: {}, skills: {}, capabilities: { agents: { allow: ['explore'] } } },
    {}
  )
  let agent = tools.get('agent')
  assert.ok(agent)
  assert.deepEqual(agent.parameters.properties.subagent_type.enum, ['explore'])
  assert.match(agent.promptGuidelines[0], /- explore: 只用于探索。/)
  assert.doesNotMatch(agent.promptGuidelines[0], /- research:/)
  assert.ok(tools.has('agent_list'))
  assert.ok(tools.has('agent_stop'))

  await assert.rejects(
    agent.execute(
      'blocked',
      {
        subagent_type: 'research',
        prompt: '不应启动',
        description: '禁用研究'
      },
      undefined,
      undefined,
      ctx
    ),
    /没有可用的 research Agent/
  )

  const started = await agent.execute(
    'launch',
    { subagent_type: 'explore', prompt: '探索', description: '探索任务' },
    undefined,
    undefined,
    ctx
  )
  const taskId = started.details.taskId
  await registration.execute(
    { tools: {}, skills: {}, capabilities: { agents: { deny: ['explore'] } } },
    {}
  )
  agent = tools.get('agent')
  assert.deepEqual(agent.parameters.properties.subagent_type.enum, ['dev', 'research'])
  await assert.rejects(
    tools.get('agent_steer').execute('steer', { agent_id: taskId, prompt: '禁用期间拒绝' }),
    /不允许 explore Agent/
  )
  const listed = await tools.get('agent_list').execute('list', {})
  assert.match(listed.content[0].text, new RegExp(taskId.slice(0, 8)))
  await tools.get('agent_stop').execute('stop', { agent_id: taskId })

  await assert.rejects(
    tools
      .get('agent_resume')
      .execute('resume', { agent_id: taskId, prompt: '禁用期间恢复' }, undefined, undefined, ctx),
    /没有可用的 explore Agent/
  )
  await runtime.shutdown()
})

test('真实 createChildSession Child 随父能力回调收紧恢复且保留角色上限', async (context) => {
  const model = getModel('anthropic', 'claude-sonnet-4-5')
  assert.ok(model)
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-real-child-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, 'settings.json'),
    JSON.stringify({ agents: { explore: { model: `${model.provider}/${model.id}` } } }),
    'utf8'
  )
  await mkdir(join(agentDir, 'skills', 'allowed'), { recursive: true })
  await mkdir(join(agentDir, 'skills', 'blocked'), { recursive: true })
  await writeFile(
    join(agentDir, 'skills', 'allowed', 'SKILL.md'),
    '---\nname: allowed\ndescription: allowed\n---\n\n允许 Skill\n',
    'utf8'
  )
  await writeFile(
    join(agentDir, 'skills', 'blocked', 'SKILL.md'),
    '---\nname: blocked\ndescription: blocked\n---\n\n禁用 Skill\n',
    'utf8'
  )
  const tools = new Map()
  const registrations = []
  const pi = createPi(tools, registrations)
  const children = []
  const runtime = new (class extends SubagentRuntime {
    async createChildSession(config, parent, sessionManager) {
      const session = await super.createChildSession(config, parent, sessionManager)
      let rejectPrompt
      session.prompt = async () =>
        new Promise((_resolvePrompt, reject) => {
          rejectPrompt = reject
        })
      const originalAbort = session.abort.bind(session)
      session.abort = async () => {
        rejectPrompt?.(new Error('controlled child stop'))
        rejectPrompt = undefined
        await originalAbort()
      }
      children.push(session)
      return session
    }
  })(pi, modelRuntime(model), agentDir)
  context.after(() => runtime.shutdown())
  const parent = parentContext(root, cwd, model)
  const ctx = {
    cwd,
    sessionManager: parent.sessionManager,
    thinkingLevel: 'off',
    isProjectTrusted: () => true
  }
  await runtime.startSession(ctx)
  const registration = registrations[0].registration
  await registration.execute(
    {
      tools: { allow: ['read'] },
      skills: { allow: ['allowed'] },
      capabilities: { agents: { allow: ['explore'] } }
    },
    {}
  )
  const started = await tools
    .get('agent')
    .execute(
      'real-child-launch',
      { subagent_type: 'explore', prompt: '真实子会话能力测试', description: '真实 Child' },
      undefined,
      undefined,
      ctx
    )
  const child = children[0]
  assert.ok(child)
  const childSessionId = child.sessionId
  assert.equal(started.details.taskId, childSessionId)
  assert.deepEqual(child.getActiveToolNames(), ['read'])
  assert.equal(
    child.getAllTools().some((tool) => tool.name === 'write'),
    false
  )
  assert.deepEqual(
    child.resourceLoader.getSkills().skills.map((skill) => skill.name),
    ['allowed']
  )
  assert.match(child.systemPrompt, /当前子代理角色/)

  await registration.execute(
    {
      tools: { allow: ['grep'] },
      skills: { allow: ['blocked'] },
      capabilities: { agents: { allow: ['explore'] } }
    },
    {}
  )
  assert.equal(children[0], child)
  assert.equal(child.sessionId, childSessionId)
  assert.deepEqual(child.getActiveToolNames(), ['grep'])
  assert.deepEqual(
    child.resourceLoader.getSkills().skills.map((skill) => skill.name),
    ['blocked']
  )

  await registration.execute(
    {
      tools: { allow: ['read', 'grep', 'find', 'ls', 'write'] },
      skills: {},
      capabilities: { agents: { allow: ['explore'] } }
    },
    {}
  )
  assert.equal(children[0], child)
  assert.equal(child.sessionId, childSessionId)
  assert.deepEqual(child.getActiveToolNames(), ['read', 'grep', 'find', 'ls'])
  await runtime.shutdown()
})

test('真实 Child 按角色装配官方新工具，虚拟模型注册不共享会话运行时', async (context) => {
  const root = resolve('temp/pi/subagent-builtins', `role-${process.pid}-${Date.now()}`)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(join(agentDir, 'extensions'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'fixture',
          models: [
            {
              id: 'base',
              name: 'Base',
              reasoning: false,
              input: ['text'],
              contextWindow: 32768,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
  )
  await writeFile(
    join(agentDir, 'extensions', 'router.ts'),
    `export default function(pi) { pi.registerVirtualModel({provider:'fixture',id:'auto',name:'Auto',route(_request,ctx){return {model:ctx.modelRegistry.find('fixture','base'),thinkingLevel:'off'}}}) }`
  )
  const models = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json')
  })
  const pi = createPi(new Map(), [])
  const runtime = new (class extends SubagentRuntime {
    open(config, parent, manager) {
      return super.createChildSession(config, parent, manager)
    }
  })(pi, models, agentDir)
  const parent = parentContext(root, cwd, models.getModel('fixture', 'base'))
  const config = {
    name: 'fixture',
    description: 'Fixture',
    systemPrompt: 'Fixture role',
    model: 'fixture/auto',
    tools: ['read', 'codemode', 'tool_search']
  }
  const children = []
  context.after(async () => {
    for (const child of children) {
      await child.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      child.dispose()
    }
    await runtime.shutdown()
  })
  const first = await runtime.open(config, parent, SessionManager.inMemory(cwd))
  children.push(first)
  const second = await runtime.open(config, parent, SessionManager.inMemory(cwd))
  children.push(second)
  assert.notEqual(first.modelRuntime, second.modelRuntime)
  assert.notEqual(first.modelRuntime, models)
  assert.equal(first.model.id, 'auto')
  assert.ok(first.getAllTools().some((tool) => tool.name === 'codemode'))
  assert.ok(first.getAllTools().some((tool) => tool.name === 'tool_search'))
  assert.ok(!first.getAllTools().some((tool) => tool.name === 'write'))
  const limited = await runtime.open(
    { ...config, tools: ['read'] },
    parent,
    SessionManager.inMemory(cwd)
  )
  children.push(limited)
  assert.ok(
    !limited.getAllTools().some((tool) => tool.name === 'codemode' || tool.name === 'tool_search')
  )
})

test('SubagentCapabilities 真实过滤 Child active tools、Skills 视图和 tool_call guard，并可恢复', () => {
  let rules = { tools: { allow: ['read'] }, skills: { allow: ['allowed'] }, capabilities: {} }
  const active = ['read', 'write']
  const session = {
    getActiveToolNames: () => [...active],
    getAllTools: () => [{ name: 'read' }, { name: 'write' }],
    setActiveToolsByName: (names) => active.splice(0, active.length, ...names),
    resourceLoader: {
      getSkills: () => ({ skills: [{ name: 'allowed' }, { name: 'blocked' }], diagnostics: [] })
    }
  }
  const capability = new SubagentCapabilities(() => rules)
  capability.attach(session)
  assert.deepEqual(active, ['read'])
  const view = capability.resources(session.resourceLoader, () => ['child prompt'])
  assert.deepEqual(
    view.getSkills().skills.map((skill) => skill.name),
    ['allowed']
  )

  rules = { tools: { allow: ['write'] }, skills: { allow: ['blocked'] }, capabilities: {} }
  capability.refresh()
  assert.deepEqual(active, ['write'])
  assert.deepEqual(
    view.getSkills().skills.map((skill) => skill.name),
    ['blocked']
  )

  const handlers = new Map()
  capability.extension({ on: (event, handler) => handlers.set(event, handler) })
  assert.deepEqual(handlers.get('tool_call')({ toolName: 'read' }), {
    block: true,
    reason: '当前能力模式不允许工具：read'
  })
  assert.equal(handlers.get('tool_call')({ toolName: 'write' }), undefined)
})

async function dynamicCapabilitySession(context, messages = []) {
  const directory = resolve(import.meta.dirname, '../../../temp/tests/subagent-capabilities')
  await mkdir(directory, { recursive: true })
  const root = await mkdtemp(join(directory, 'dynamic-tools-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  let rules = { tools: {}, skills: {}, capabilities: {} }
  let pi
  const executed = []
  const capability = new SubagentCapabilities(() => rules)
  const settingsManager = SettingsManager.inMemory()
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (api) => {
        pi = api
        capability.extension(api)
      }
    ]
  })
  const resourceLoader = capability.resources(loader, () => [])
  await resourceLoader.reload()
  const model = getModel('anthropic', 'claude-sonnet-4-5')
  const sessionManager = SessionManager.inMemory(cwd)
  for (const message of messages) {
    sessionManager.appendMessage(message)
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: modelRuntime(model),
    resourceLoader,
    settingsManager,
    sessionManager,
    tools: ['read', 'write', 'dynamic_tool', 'withdrawn_tool', 'callable_tool']
  })
  context.after(async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' })
    session.dispose()
  })
  const originalSetTools = session.setActiveToolsByName
  capability.attach(session)
  await session.bindExtensions({ mode: 'rpc' })
  return {
    session,
    capability,
    originalSetTools,
    setRules(tools) {
      rules = { tools, skills: {}, capabilities: {} }
    },
    register(name, exposure = 'direct') {
      pi.registerTool({
        name,
        label: name,
        description: name,
        exposure,
        parameters: Type.Object({}),
        async execute() {
          executed.push(name)
          return { content: [{ type: 'text', text: name }], details: undefined }
        }
      })
    },
    executed
  }
}

test('SubagentCapabilities 保留 SDK 动态注册激活且不扩大角色工具上限', async (context) => {
  const { session, capability, register, setRules } = await dynamicCapabilitySession(context)
  register('dynamic_tool')
  assert.deepEqual(session.getActiveToolNames(), ['read', 'write', 'dynamic_tool'])
  capability.refresh()
  assert.deepEqual(session.getActiveToolNames(), ['read', 'write', 'dynamic_tool'])
  register('outside_role')
  assert.equal(
    session.getAllTools().some((tool) => tool.name === 'outside_role'),
    false
  )
  setRules({ deny: ['dynamic_tool'] })
  capability.refresh()
  assert.deepEqual(session.getActiveToolNames(), ['read', 'write'])
  setRules({})
  capability.refresh()
  assert.deepEqual(session.getActiveToolNames(), ['read', 'write', 'dynamic_tool'])
})

test('SubagentCapabilities 模式隐藏可恢复而显式停用不复活', async (context) => {
  const { session, capability, setRules } = await dynamicCapabilitySession(context)
  setRules({ allow: ['read'] })
  capability.refresh()
  assert.deepEqual(session.getActiveToolNames(), ['read'])
  session.setActiveToolsByName(['read'])
  setRules({})
  capability.refresh()
  assert.deepEqual(session.getActiveToolNames(), ['read', 'write'])

  session.setActiveToolsByName(['read'])
  setRules({ deny: ['write'] })
  capability.refresh()
  setRules({})
  capability.refresh()
  assert.deepEqual(session.getActiveToolNames(), ['read'])

  session.setActiveToolsByName(['read', 'write'])
  setRules({ allow: ['read'] })
  capability.refresh()
  setRules({})
  session.setActiveToolsByName(['read'])
  assert.deepEqual(session.getActiveToolNames(), ['read', 'write'])
})

test('SubagentCapabilities SDK 撤回隐藏工具后不残留旧选择', async (context) => {
  const { session, capability, register, setRules } = await dynamicCapabilitySession(context)
  register('withdrawn_tool')
  session.setActiveToolsByName(['read', 'withdrawn_tool'])
  setRules({ deny: ['withdrawn_tool'] })
  capability.refresh()
  register('withdrawn_tool', 'hidden')
  capability.refresh()
  register('withdrawn_tool', 'codemode')
  setRules({})
  capability.refresh()
  assert.deepEqual(session.getActiveToolNames(), ['read', 'write'])
})

test('SubagentCapabilities reload 移除旧工具并释放旧选择', async (context) => {
  const { session, capability, register, setRules } = await dynamicCapabilitySession(context)
  register('withdrawn_tool')
  session.setActiveToolsByName(['read', 'withdrawn_tool'])
  setRules({ deny: ['withdrawn_tool'] })
  capability.refresh()
  await session.reload({ beforeSessionStart: async () => capability.attach(session) })
  assert.equal(
    session.getAllTools().some((tool) => tool.name === 'withdrawn_tool'),
    false
  )
  setRules({})
  capability.refresh()
  assert.deepEqual(session.getActiveToolNames(), ['read', 'write'])
})

test('SubagentCapabilities 非 active 可调用工具仍经过 guard，dispose 恢复 SDK 方法', async (context) => {
  const { session, capability, register, setRules, executed, originalSetTools } =
    await dynamicCapabilitySession(context, [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'capability-test', name: 'dynamic_tool', arguments: {} }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        stopReason: 'toolUse',
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
    ])
  register('dynamic_tool')
  register('callable_tool', 'codemode')
  assert.equal(session.getActiveToolNames().includes('callable_tool'), false)
  const ctx = session.extensionRunner.createToolContext('capability-test', undefined)
  const result = await ctx.executeTool('callable_tool', {})
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.deepEqual(executed, ['callable_tool'])

  setRules({ deny: ['callable_tool'] })
  capability.refresh()
  const blocked = await ctx.executeTool('callable_tool', {})
  assert.equal(blocked.isError, true)
  assert.match(blocked.result.content[0].text, /当前能力模式不允许工具：callable_tool/)
  assert.deepEqual(executed, ['callable_tool'])

  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' })
  assert.equal(session.setActiveToolsByName, originalSetTools)
  capability.refresh()
  session.setActiveToolsByName(['write'])
  assert.deepEqual(session.getActiveToolNames(), ['write'])
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' })
  assert.equal(session.setActiveToolsByName, originalSetTools)
})

test('collectSubagentCapabilityOptions 合并 cwd/global 候选、去重并省略冲突描述', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desk-subagent-capability-options-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const cwdA = join(root, 'project-a')
  const cwdB = join(root, 'project-b')
  await writeAgent(join(agentDir, 'agents'), 'shared', '全局描述')
  await mkdir(join(cwdA, '.pi', 'agents'), { recursive: true })
  await writeAgent(join(cwdA, '.pi', 'agents'), 'shared', '项目描述')
  await writeAgent(join(cwdB, '.pi', 'agents'), 'cwd-only', '仅第二工作区')
  const options = collectSubagentCapabilityOptions([cwdA, cwdA, cwdB], undefined, agentDir)
  const shared = options.find((option) => option.value === 'shared')
  assert.deepEqual(shared, { value: 'shared' })
  assert.equal(options.filter((option) => option.value === 'shared').length, 1)
  assert.deepEqual(
    options.find((option) => option.value === 'cwd-only'),
    {
      value: 'cwd-only',
      description: '仅第二工作区'
    }
  )
  assert.ok(options.some((option) => option.value === 'explore'))
})
