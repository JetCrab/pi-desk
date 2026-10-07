import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createJiti } from 'jiti'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { Agent } from '@earendil-works/pi-agent-core'
import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createEventBus
} from '@earendil-works/pi-coding-agent'
import { getModel } from '@earendil-works/pi-ai/compat'
import { bindSessionPlugin } from '@jetcrab/pi-desk-sdk/session'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
const { L4PiCapabilityRuntime } = await jiti.import(
  '../src/server/l4_foundation/pi/l4-pi-capability-runtime.ts'
)

const model = getModel('anthropic', 'claude-sonnet-4-5')
assert.ok(model)

function tool(name) {
  return {
    name,
    label: name,
    description: `${name} fixture tool`,
    promptSnippet: `${name} prompt`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: `${name} executed` }], details: {} })
  }
}

async function createSession(root, readMode, readToolName = () => 'fixture_tool') {
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  await mkdir(join(cwd, '.pi', 'skills', 'allowed'), { recursive: true })
  await mkdir(join(cwd, '.pi', 'skills', 'blocked'), { recursive: true })
  await writeFile(
    join(cwd, '.pi', 'skills', 'allowed', 'SKILL.md'),
    '---\nname: allowed\ndescription: allowed\n---\n',
    'utf8'
  )
  await writeFile(
    join(cwd, '.pi', 'skills', 'blocked', 'SKILL.md'),
    '---\nname: blocked\ndescription: blocked\n---\n',
    'utf8'
  )
  await mkdir(join(agentDir, 'sessions'), { recursive: true })

  const capability = new L4PiCapabilityRuntime(readMode)
  const pluginCalls = []
  const lateTools = []
  const inputCalls = []
  let registerTool
  const extensionFactories = [
    {
      name: 'capability-fixture',
      factory: (pi) => {
        registerTool = (definition) => pi.registerTool(definition)
        bindSessionPlugin(pi, 'fixture').onCapabilitiesChange((rules) => {
          pluginCalls.push(rules)
        })
        pi.registerTool(tool(readToolName()))
        pi.on('session_start', () => {
          const dynamic = tool('late_tool')
          lateTools.push(dynamic)
          pi.registerTool(dynamic)
        })
      }
    }
  ]
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false }
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus: capability.eventBus(createEventBus()),
    extensionFactories,
    extensionsOverride: (loaded) => ({
      ...loaded,
      extensions: [
        ...loaded.extensions,
        capability.createHostExtension((event) => {
          inputCalls.push(event.text)
          return { action: 'handled' }
        })
      ]
    }),
    noPromptTemplates: true,
    noThemes: true
  })
  await resourceLoader.reload()
  const sessionManager = SessionManager.inMemory(cwd)
  const modelRuntime = {
    getModel: () => model,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ source: 'test' }),
    isUsingOAuth: () => false,
    registerProvider() {},
    registerNativeProvider() {},
    unregisterProvider() {}
  }
  const agent = new Agent({
    initialState: { model, systemPrompt: 'capability fixture', tools: [] },
    streamFn: () => {
      throw new Error('prompt is not part of this integration test')
    }
  })
  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd,
    resourceLoader: capability.resources(resourceLoader),
    modelRuntime,
    initialActiveToolNames: ['read', 'write']
  })
  capability.attach(session)
  await session.bindExtensions({ mode: 'rpc' })
  await capability.apply()
  return {
    session,
    capability,
    pluginCalls,
    lateTools,
    inputCalls,
    registerTool: (definition) => registerTool(definition),
    resourceLoader: session.resourceLoader
  }
}

function limitedMode() {
  return {
    name: 'limited',
    tools: { allow: ['read', 'fixture_tool'] },
    skills: { allow: ['allowed'] },
    plugins: { fixture: { group: { allow: ['selected'] } } }
  }
}

test('真实 AgentSession 应用动态能力规则、工具 guard、Skills 视图和 reload/dispose', async (context) => {
  const root = resolve('temp/pi/l4-pi-capability-runtime', randomUUID())
  context.after(() => rm(root, { recursive: true, force: true }))
  let mode = limitedMode()
  const runtime = await createSession(root, () => mode)
  context.after(() => {
    runtime.capability.dispose()
    runtime.session.dispose()
  })

  assert.equal(runtime.pluginCalls.length, 1)
  assert.deepEqual(runtime.pluginCalls[0], {
    tools: { allow: ['read', 'fixture_tool'] },
    skills: { allow: ['allowed'] },
    capabilities: { group: { allow: ['selected'] } }
  })
  assert.deepEqual(runtime.session.getActiveToolNames(), ['read', 'fixture_tool'])
  assert.equal(runtime.session.getActiveToolNames().includes('write'), false)
  assert.deepEqual(
    await runtime.session.extensionRunner.emitInput('host input probe', undefined, 'rpc'),
    { action: 'handled' }
  )
  assert.deepEqual(runtime.inputCalls, ['host input probe'])
  assert.match(runtime.session.systemPrompt, /fixture_tool/)
  assert.equal(runtime.session.systemPrompt.includes('write'), false)
  assert.deepEqual(
    runtime.resourceLoader.getSkills().skills.map((skill) => skill.name),
    ['allowed']
  )
  assert.match(runtime.session._expandSkillCommand('/skill:allowed 参数'), /<skill name="allowed"/)
  assert.equal(runtime.session._expandSkillCommand('/skill:blocked'), '/skill:blocked')
  assert.ok(runtime.lateTools.length >= 1)

  const blocked = await runtime.session.extensionRunner.emitToolCall({
    type: 'tool_call',
    toolCallId: 'blocked-call',
    toolName: 'write',
    input: {}
  })
  assert.deepEqual(blocked, {
    block: true,
    reason: '当前能力模式不允许工具：write'
  })

  mode = {
    name: 'restored',
    tools: { allow: ['write', 'late_tool'] },
    skills: { allow: ['blocked'] }
  }
  await runtime.capability.apply()
  assert.deepEqual([...runtime.session.getActiveToolNames()].sort(), ['late_tool', 'write'])
  assert.equal(runtime.session.systemPrompt.includes('write'), true)
  assert.equal(runtime.session.systemPrompt.includes('fixture_tool prompt'), false)
  assert.deepEqual(
    runtime.resourceLoader.getSkills().skills.map((skill) => skill.name),
    ['blocked']
  )
  assert.match(runtime.session._expandSkillCommand('/skill:blocked'), /<skill name="blocked"/)
  assert.equal(runtime.pluginCalls.length, 2)
  assert.deepEqual(runtime.pluginCalls[1], {
    tools: { allow: ['write', 'late_tool'] },
    skills: { allow: ['blocked'] },
    capabilities: {}
  })

  const allowed = await runtime.session.extensionRunner.emitToolCall({
    type: 'tool_call',
    toolCallId: 'allowed-call',
    toolName: 'write',
    input: {}
  })
  assert.equal(allowed, undefined)

  await runtime.session.reload()
  await runtime.capability.apply()
  assert.equal(runtime.pluginCalls.length, 3)
  assert.equal(runtime.session.getActiveToolNames().includes('write'), true)
  assert.equal(runtime.session.getActiveToolNames().includes('read'), false)

  const beforeDetachCalls = runtime.pluginCalls.length
  runtime.capability.detach()
  mode = limitedMode()
  await runtime.capability.apply()
  assert.equal(runtime.pluginCalls.length, beforeDetachCalls)
  runtime.capability.dispose()
  await runtime.capability.apply()
  assert.equal(runtime.pluginCalls.length, beforeDetachCalls)
})

test('重载后保留 Pi 新激活的工具且不重新激活被显式关闭的工具', async (context) => {
  const root = resolve('temp/pi/l4-pi-capability-runtime', randomUUID())
  context.after(() => rm(root, { recursive: true, force: true }))
  let name = 'version_one'
  const runtime = await createSession(
    root,
    () => undefined,
    () => name
  )
  context.after(() => {
    runtime.capability.dispose()
    runtime.session.dispose()
  })
  assert.ok(runtime.session.getActiveToolNames().includes('version_one'))
  name = 'version_two'
  await runtime.session.reload()
  assert.ok(runtime.session.getActiveToolNames().includes('version_two'))
  assert.ok(!runtime.session.getAllTools().some((entry) => entry.name === 'version_one'))

  await runtime.capability.apply()
  assert.ok(runtime.session.getActiveToolNames().includes('version_two'))
  runtime.session.setActiveToolsByName(
    runtime.session.getActiveToolNames().filter((toolName) => toolName !== 'version_two')
  )
  await runtime.capability.apply()
  assert.ok(!runtime.session.getActiveToolNames().includes('version_two'))
})

test('模式隐藏的工具被正式撤回后，不因恢复模式变为直接声明', async (context) => {
  const root = resolve('temp/pi/l4-pi-capability-runtime', randomUUID())
  context.after(() => rm(root, { recursive: true, force: true }))
  let mode = { name: 'limited', tools: { deny: ['fixture_tool'] } }
  const runtime = await createSession(root, () => mode)
  context.after(() => {
    runtime.capability.dispose()
    runtime.session.dispose()
  })
  runtime.registerTool({ ...tool('fixture_tool'), exposure: 'hidden' })
  await runtime.capability.apply()
  runtime.registerTool({ ...tool('fixture_tool'), exposure: 'codemode' })
  mode = undefined
  await runtime.capability.apply()
  assert.equal(
    runtime.session.getAllTools().find((entry) => entry.name === 'fixture_tool')?.exposure,
    'codemode'
  )
  assert.ok(!runtime.session.getActiveToolNames().includes('fixture_tool'))
})

test('分支声明替代旧掩码选择，无声明的空分支保留 SDK 当前选择', async (context) => {
  const root = resolve('temp/pi/l4-pi-capability-runtime', randomUUID())
  context.after(() => rm(root, { recursive: true, force: true }))
  let mode = { name: 'read-only', tools: { allow: ['read'] } }
  const runtime = await createSession(root, () => mode)
  context.after(() => {
    runtime.capability.dispose()
    runtime.session.dispose()
  })
  const manager = runtime.session.sessionManager
  const first = manager.appendMessage({ role: 'user', content: 'first', timestamp: Date.now() })
  manager.appendMessage({
    role: 'system',
    content: 'fixture tool declaration',
    timestamp: Date.now(),
    toolsAdded: [{ name: 'read', description: 'Fixture read', parameters: tool('read').parameters }]
  })
  const target = manager.appendCustomEntry('tree-fixture', {})
  manager.appendCustomEntry('later', {})
  await runtime.session.navigateTree(target, { summarize: false })
  runtime.capability.restoreBranchSelection()
  mode = undefined
  await runtime.capability.apply()
  assert.deepEqual(runtime.session.getActiveToolNames(), ['read'])
  assert.ok(runtime.session.getAllTools().some((item) => item.name === 'write'))

  runtime.session.setActiveToolsByName(['read', 'write'])
  mode = { name: 'read-only', tools: { allow: ['read'] } }
  await runtime.capability.apply()
  await runtime.session.navigateTree(first, { summarize: false })
  runtime.capability.restoreBranchSelection()
  mode = undefined
  await runtime.capability.apply()
  assert.deepEqual(runtime.session.getActiveToolNames(), ['read', 'write'])
})
