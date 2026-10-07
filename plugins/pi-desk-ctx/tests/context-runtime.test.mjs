import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const workspaceNodeModules = join(process.cwd(), 'node_modules')

function packageEntry(packageName) {
  const path = join(workspaceNodeModules, ...packageName.split('/'), 'dist/index.js')
  if (!existsSync(path)) {
    throw new Error(`请从包含 ${packageName} 的项目根目录运行测试：${path}`)
  }
  return path
}

const codingAgentEntry = packageEntry('@earendil-works/pi-coding-agent')
const agentCoreEntry = packageEntry('@earendil-works/pi-agent-core')
const aiEntry = packageEntry('@earendil-works/pi-ai')
const { createJiti } = require(require.resolve('jiti', { paths: [process.cwd()] }))
const jiti = createJiti(import.meta.url, {
  alias: {
    '@earendil-works/pi-coding-agent': codingAgentEntry,
    '@earendil-works/pi-agent-core': agentCoreEntry,
    '@earendil-works/pi-ai': aiEntry,
    typebox: require.resolve('typebox', { paths: [process.cwd()] })
  },
  tsconfigPaths: true
})
const { registerContextIgnore } = await jiti.import(
  new URL('../src/index.ts', import.meta.url).pathname
)
const { analyzeContext, calibrateProviderTokens } = await jiti.import(
  new URL('../src/context-analysis.ts', import.meta.url).pathname
)

function messageEntry(id, parentId, message) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    message
  }
}

function user(content, timestamp) {
  return { role: 'user', content, timestamp }
}

function assistant(timestamp, stopReason, totalTokens, content = [{ type: 'text', text: '结论' }]) {
  return {
    role: 'assistant',
    content,
    timestamp,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens
    },
    stopReason,
    ...(stopReason === 'aborted' ? { errorMessage: 'Operation aborted' } : {})
  }
}

function pendingState() {
  return {
    enabled: true,
    mode: 'user-turns',
    cutoffTimestamp: 150,
    pendingUsageRefreshAfterTimestamp: 200,
    estimatedContextTokens: 120_000,
    keepTurns: 3,
    updatedAt: 1
  }
}

function stateEntry(data) {
  return {
    type: 'custom',
    customType: 'context-ignore-state',
    data,
    id: 'state-1',
    parentId: null,
    timestamp: new Date(1).toISOString()
  }
}

function defaultSettings() {
  return {
    enabled: true,
    profiles: [
      {
        maxContextTokens: 600_000,
        checkpointTokens: 480_000,
        keepRecentUserTurns: 3,
        processTokenBudget: 40_000,
        rules: [
          { currentTokensAtLeast: 400_000, projectedTokensAtMost: 50_000 },
          { currentTokensAtLeast: 500_000, projectedTokensAtMost: 150_000 }
        ]
      },
      {
        checkpointTokens: 800_000,
        keepRecentUserTurns: 3,
        processTokenBudget: 40_000,
        rules: [{ currentTokensAtLeast: 800_000, projectedTokensAtMost: 150_000 }]
      }
    ]
  }
}

function createHarness(branch, contextUsage, settings = defaultSettings(), cwd = process.cwd()) {
  const handlers = new Map()
  const emittedEvents = []
  const appendedEntries = []
  const tools = new Map()
  const toolRegistrations = []
  let settingsLoadCount = 0
  const sentMessages = []
  const sentUserMessages = []
  const pi = {
    on(name, handler) {
      const current = handlers.get(name) ?? []
      current.push(handler)
      handlers.set(name, current)
    },
    events: {
      on() {
        return () => {}
      },
      emit(channel, data) {
        emittedEvents.push({ channel, data })
      }
    },
    registerTool(tool) {
      toolRegistrations.push(tool.name)
      tools.set(tool.name, tool)
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data })
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options })
    },
    sendUserMessage(message, options) {
      sentUserMessages.push({ message, options })
    }
  }
  registerContextIgnore(pi, {
    loadSettings: async () => {
      settingsLoadCount += 1
      return settings
    }
  })

  const ctx = {
    cwd,
    model: { contextWindow: 600_000 },
    getContextUsage() {
      return contextUsage.current
    },
    isIdle() {
      return true
    },
    sessionManager: {
      getBranch() {
        return branch
      },
      buildContextEntries() {
        return branch
      },
      getSessionId() {
        return 'context-runtime-test'
      }
    }
  }
  return {
    handlers,
    emittedEvents,
    appendedEntries,
    tools,
    sentMessages,
    sentUserMessages,
    toolRegistrations,
    get settingsLoadCount() {
      return settingsLoadCount
    },
    ctx
  }
}

function latestPluginState(emittedEvents) {
  return emittedEvents.filter((event) => event.channel === 'pi-desk:session-plugins').at(-1)?.data[
    'context-ignore'
  ]
}

function sessionMethodRegistration(emittedEvents, method) {
  return emittedEvents
    .filter((event) => event.channel === 'pi-desk:session-plugin-methods:v1')
    .map((event) => event.data)
    .find(
      (event) =>
        event.type === 'register' &&
        event.registration.pluginName === 'context-ignore' &&
        event.registration.method === method
    )?.registration
}

test('手动 ignore 方法应用当前候选并立即发布有效上下文预计', async () => {
  const messages = [
    user('第一轮', 100),
    assistant(120, 'stop', 20_000, [
      { type: 'thinking', thinking: '旧过程'.repeat(5_000) },
      { type: 'text', text: '第一轮结论' }
    ]),
    user('第二轮', 200),
    assistant(220, 'stop', 30_000),
    user('第三轮', 300),
    assistant(320, 'stop', 40_000),
    user('第四轮', 400),
    assistant(420, 'stop', 100_000)
  ]
  const branch = messages.map((message, index) =>
    messageEntry(`message-${index}`, index === 0 ? null : `message-${index - 1}`, message)
  )
  const contextUsage = {
    current: { tokens: 100_000, contextWindow: 600_000, percent: 16 }
  }
  const { handlers, emittedEvents, appendedEntries, ctx } = createHarness(branch, contextUsage)
  await handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx)

  const registration = sessionMethodRegistration(emittedEvents, 'ignore')
  assert.ok(registration)
  assert.deepEqual(
    await registration.execute(
      {},
      {
        source: {
          workId: 'work-1',
          sessionId: 'context-runtime-test',
          branchId: 'v1:main'
        },
        extensionContext: ctx
      }
    ),
    {}
  )

  const persisted = appendedEntries.at(-1)
  assert.equal(persisted?.customType, 'context-ignore-state')
  assert.equal(persisted?.data.enabled, true)
  assert.equal(persisted?.data.keepTurns, 3)
  assert.equal(persisted?.data.estimatedContextTokens < 100_000, true)
  assert.equal(latestPluginState(emittedEvents).ignoredTokens > 0, true)
  assert.equal(latestPluginState(emittedEvents).effectiveTokens < 100_000, true)
})

test('等待有效 usage 时按有效上下文校准并发布预计值', async () => {
  const messages = [
    user('开始', 100),
    assistant(120, 'toolUse', 10_000, [
      { type: 'thinking', thinking: '旧过程'.repeat(200) },
      { type: 'text', text: '旧结论' }
    ]),
    user('继续', 180),
    assistant(200, 'stop', 698_493)
  ]
  const branch = [
    stateEntry(pendingState()),
    messageEntry('user-1', 'state-1', messages[0]),
    messageEntry('assistant-1', 'user-1', messages[1]),
    messageEntry('user-2', 'assistant-1', messages[2]),
    messageEntry('assistant-2', 'user-2', messages[3])
  ]
  const contextUsage = {
    current: { tokens: 698_493, contextWindow: 600_000, percent: 116 }
  }
  const { handlers, emittedEvents, ctx } = createHarness(branch, contextUsage)

  await handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx)

  const analysis = analyzeContext(messages, pendingState(), { cwd: process.cwd() })
  const expectedIgnoredTokens = calibrateProviderTokens(
    analysis.providerIgnoredTokens,
    analysis.providerEffectiveTokens,
    120_000
  )
  assert.deepEqual(latestPluginState(emittedEvents), {
    ignoredTokens: expectedIgnoredTokens,
    potentialTokens: 0,
    effectiveTokens: 120_000
  })
  assert.notEqual(expectedIgnoredTokens, 698_493)
})

test('aborted 零 usage 不结束等待并取消重复 overflow 压缩', async () => {
  const branch = [
    stateEntry(pendingState()),
    messageEntry('user-1', 'state-1', user('继续', 100)),
    messageEntry('assistant-1', 'user-1', assistant(200, 'stop', 698_493)),
    messageEntry('user-2', 'assistant-1', user('确认', 250)),
    messageEntry('assistant-2', 'user-2', assistant(300, 'aborted', 0))
  ]
  const contextUsage = {
    current: { tokens: 698_493, contextWindow: 600_000, percent: 116 }
  }
  const { handlers, appendedEntries, ctx } = createHarness(branch, contextUsage)
  await handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx)

  await handlers.get('agent_settled')[0]({ type: 'agent_settled' }, ctx)
  assert.equal(appendedEntries.length, 0)

  const originalInfo = console.info
  console.info = () => undefined
  try {
    const result = await handlers.get('session_before_compact')[0](
      {
        reason: 'overflow',
        willRetry: false,
        preparation: {
          tokensBefore: 698_493,
          settings: { reserveTokens: 25_000 }
        }
      },
      ctx
    )
    assert.deepEqual(result, { cancel: true })
  } finally {
    console.info = originalInfo
  }
})

test('正数有效 usage 清除等待状态', async () => {
  const branch = [
    stateEntry(pendingState()),
    messageEntry('user-1', 'state-1', user('继续', 100)),
    messageEntry('assistant-1', 'user-1', assistant(200, 'stop', 698_493)),
    messageEntry('user-2', 'assistant-1', user('确认', 250)),
    messageEntry('assistant-2', 'user-2', assistant(300, 'stop', 121_500))
  ]
  const contextUsage = {
    current: { tokens: 121_500, contextWindow: 600_000, percent: 20 }
  }
  const { handlers, emittedEvents, appendedEntries, ctx } = createHarness(branch, contextUsage)
  await handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx)

  await handlers.get('agent_settled')[0]({ type: 'agent_settled' }, ctx)

  assert.equal(appendedEntries.length, 1)
  assert.equal(appendedEntries[0].customType, 'context-ignore-state')
  assert.equal('pendingUsageRefreshAfterTimestamp' in appendedEntries[0].data, false)
  assert.equal('estimatedContextTokens' in appendedEntries[0].data, false)
  assert.deepEqual(latestPluginState(emittedEvents), {
    ignoredTokens: 0,
    potentialTokens: 0,
    effectiveTokens: 121_500
  })
})

test('树导航恢复目标分支与空分支，保留 ignore 注册和会话配置直到 shutdown', async () => {
  const branch = [stateEntry(pendingState())]
  const contextUsage = { current: { tokens: 500_000 } }
  const harness = createHarness(
    branch,
    contextUsage,
    defaultSettings(),
    join(process.cwd(), 'temp', 'pi', 'ctx-tree-restore', String(process.pid), 'agent')
  )
  const { handlers, emittedEvents, appendedEntries, tools, toolRegistrations, ctx } = harness
  await handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx)
  const registration = sessionMethodRegistration(emittedEvents, 'ignore')
  assert.ok(registration)
  assert.equal(latestPluginState(emittedEvents).effectiveTokens, 120_000)

  branch.splice(
    0,
    branch.length,
    stateEntry({ enabled: false, keepTurns: 3, estimatedContextTokens: 240_000, updatedAt: 1 }),
    ...branchFromMessages(longSessionMessages())
  )
  const sessionTree = handlers.get('session_tree')?.[0]
  assert.equal(typeof sessionTree, 'function')
  await sessionTree({ type: 'session_tree' }, ctx)
  assert.equal(latestPluginState(emittedEvents).ignoredTokens, 0)
  assert.equal(latestPluginState(emittedEvents).effectiveTokens, 240_000)
  assert.equal(appendedEntries.length, 0)
  assert.deepEqual(await registration.execute({}, { extensionContext: ctx }), {})
  assert.equal(appendedEntries.at(-1)?.data.estimatedContextTokens < 240_000, true)

  branch.splice(0)
  contextUsage.current = { tokens: 42 }
  await sessionTree({ type: 'session_tree' }, ctx)
  assert.deepEqual(latestPluginState(emittedEvents), {
    ignoredTokens: 0,
    potentialTokens: 0,
    effectiveTokens: 42
  })
  assert.equal(harness.settingsLoadCount, 1)
  assert.deepEqual(toolRegistrations, ['history_tool_result', 'ctx'])
  const methodEvents = () =>
    emittedEvents
      .filter((event) => event.channel === 'pi-desk:session-plugin-methods:v1')
      .map((event) => event.data)
  assert.deepEqual(
    methodEvents().map((event) => event.type),
    ['register']
  )

  await handlers.get('session_shutdown')[0]({ type: 'session_shutdown' }, ctx)
  assert.equal(latestPluginState(emittedEvents), null)
  assert.deepEqual(
    methodEvents().map((event) => event.type),
    ['register', 'unregister']
  )
  assert.equal(methodEvents().at(-1).registration, registration)
  assert.equal(
    (await tools.get('ctx').execute('after-shutdown', {}, undefined, undefined, ctx)).content[0]
      .text,
    'ctx 当前未获授权，请忽略并继续执行。'
  )
})

test('树导航清理旧历史引用并恢复目标分支技能路径', async () => {
  const messages = [
    user('旧任务', 100),
    assistant(120, 'toolUse', 100_000, [
      { type: 'toolCall', id: 'old-read', name: 'read', arguments: { path: 'source.ts' } }
    ]),
    {
      role: 'toolResult',
      toolCallId: 'old-read',
      toolName: 'read',
      content: [{ type: 'text', text: '旧工具内容' }],
      isError: false,
      timestamp: 130
    },
    user('当前任务', 200),
    assistant(220, 'stop', 100_000)
  ]
  const branch = [stateEntry(pendingState()), ...branchFromMessages(messages)]
  const { handlers, tools, ctx } = createHarness(
    branch,
    { current: { tokens: 120_000 } },
    defaultSettings(),
    join(process.cwd(), 'temp', 'pi', 'ctx-tree-restore', String(process.pid), 'agent')
  )
  await handlers.get('session_start')[0]({ type: 'session_start' }, ctx)
  await handlers.get('context')[0]({ type: 'context', messages }, ctx)
  const historyTool = tools.get('history_tool_result')
  assert.equal(
    (await historyTool.execute('before-tree', { ref: 1 }, undefined, undefined, ctx)).details
      .toolCallId,
    'old-read'
  )

  branch.splice(
    0,
    1,
    stateEntry({ ...pendingState(), skillFilePaths: [join(ctx.cwd, 'source.ts')] })
  )
  const sessionTree = handlers.get('session_tree')?.[0]
  assert.equal(typeof sessionTree, 'function')
  await sessionTree({ type: 'session_tree' }, ctx)
  await assert.rejects(
    historyTool.execute('after-tree', { ref: 1 }, undefined, undefined, ctx),
    /不存在历史工具引用/
  )
  const protectedContext = await handlers.get('context')[0]({ type: 'context', messages }, ctx)
  assert.equal(
    protectedContext.messages.some(
      (message) => message.role === 'toolResult' && message.toolCallId === 'old-read'
    ),
    true
  )

  branch.splice(0, 1, stateEntry(pendingState()))
  await sessionTree({ type: 'session_tree' }, ctx)
  const unprotectedContext = await handlers.get('context')[0]({ type: 'context', messages }, ctx)
  assert.equal(
    unprotectedContext.messages.some(
      (message) => message.role === 'toolResult' && message.toolCallId === 'old-read'
    ),
    false
  )
})

test('树导航撤销旧检查点授权并重置旧任务的自动续写次数', async () => {
  const messages = longSessionMessages('toolUse')
  const branch = branchFromMessages(messages)
  const { handlers, tools, sentMessages, sentUserMessages, appendedEntries, ctx } = createHarness(
    branch,
    { current: { tokens: 500_000 } },
    absoluteRuleSettings(400_000, 450_000),
    join(process.cwd(), 'temp', 'pi', 'ctx-tree-restore', String(process.pid), 'agent')
  )
  await handlers.get('session_start')[0]({ type: 'session_start' }, ctx)
  await handlers.get('turn_end')[0]({ type: 'turn_end', message: messages.at(-1) }, ctx)
  assert.equal(sentMessages.length, 1)
  const lengthEvent = { type: 'agent_end', messages: [assistant(500, 'length', 500_000)] }
  await handlers.get('agent_end')[0](lengthEvent, ctx)
  assert.equal(sentUserMessages.length, 1)

  branch.splice(0)
  const sessionTree = handlers.get('session_tree')?.[0]
  assert.equal(typeof sessionTree, 'function')
  await sessionTree({ type: 'session_tree' }, ctx)
  assert.equal(
    (await tools.get('ctx').execute('after-tree', {}, undefined, undefined, ctx)).content[0].text,
    'ctx 当前未获授权，请忽略并继续执行。'
  )
  assert.equal(appendedEntries.length, 0)
  await handlers.get('agent_end')[0](lengthEvent, ctx)
  assert.equal(sentUserMessages.length, 2)
})

function longSessionMessages(lastStopReason = 'stop') {
  return [
    user('第一轮', 100),
    assistant(120, 'toolUse', 100_000, [
      { type: 'thinking', thinking: '旧过程'.repeat(60_000) },
      { type: 'text', text: '第一轮结论' }
    ]),
    user('第二轮', 200),
    assistant(220, 'stop', 200_000),
    user('第三轮', 300),
    assistant(320, 'stop', 300_000),
    user('第四轮', 400),
    assistant(420, lastStopReason, 500_000)
  ]
}

function branchFromMessages(messages) {
  return messages.map((message, index) =>
    messageEntry(`long-${index}`, index === 0 ? null : `long-${index - 1}`, message)
  )
}

function absoluteRuleSettings(currentTokensAtLeast, checkpointTokens = 480_000) {
  return {
    enabled: true,
    profiles: [
      {
        maxContextTokens: 600_000,
        checkpointTokens,
        keepRecentUserTurns: 3,
        processTokenBudget: 40_000,
        rules: [{ currentTokensAtLeast }]
      },
      {
        keepRecentUserTurns: 3,
        processTokenBudget: 40_000,
        rules: []
      }
    ]
  }
}

test('压缩后无用户消息时仍发布可忽略量，达到原门槛才请求检查点', async () => {
  const messages = longSessionMessages('toolUse').filter((message) => message.role !== 'user')
  const branch = [
    {
      type: 'compaction',
      id: 'compaction',
      parentId: null,
      timestamp: new Date(450).toISOString(),
      summary: '上一阶段摘要',
      tokensBefore: 875_000,
      firstKeptEntryId: 'long-0'
    },
    ...branchFromMessages(messages)
  ]
  const contextUsage = { current: { tokens: 780_000, contextWindow: 900_000, percent: 86 } }
  const { handlers, emittedEvents, appendedEntries, sentMessages, tools, ctx } = createHarness(
    branch,
    contextUsage
  )
  ctx.model.contextWindow = 900_000
  await handlers.get('session_start')[0]({ type: 'session_start' }, ctx)
  assert.equal(latestPluginState(emittedEvents).potentialTokens > 0, true)
  assert.equal(latestPluginState(emittedEvents).ignoredTokens, 0)
  assert.equal(latestPluginState(emittedEvents).effectiveTokens, 780_000)

  await handlers.get('turn_end')[0]({ type: 'turn_end', message: messages.at(-1) }, ctx)
  assert.equal(sentMessages.length, 0)
  assert.equal(appendedEntries.length, 0)

  contextUsage.current = { tokens: 810_000, contextWindow: 900_000, percent: 90 }
  await handlers.get('turn_end')[0]({ type: 'turn_end', message: messages.at(-1) }, ctx)
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].message.customType, 'context-ignore-checkpoint-request')
  assert.equal(appendedEntries.length, 0)

  const result = await tools.get('ctx').execute('ctx-call', {}, undefined, undefined, ctx)
  assert.equal(result.content[0].text, '已处理，继续当前任务。')
  assert.equal(appendedEntries.at(-1)?.data.enabled, true)
  assert.equal(appendedEntries.at(-1)?.data.estimatedContextTokens <= 150_000, true)
  assert.equal(latestPluginState(emittedEvents).ignoredTokens > 0, true)
})

test('正常 agent_end 按绝对规则命中后应用忽略', async () => {
  const messages = longSessionMessages('stop')
  const contextUsage = {
    current: { tokens: 500_000, contextWindow: 600_000, percent: 83 }
  }
  const { handlers, appendedEntries, ctx } = createHarness(
    branchFromMessages(messages),
    contextUsage,
    absoluteRuleSettings(400_000)
  )
  await handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx)

  const originalInfo = console.info
  console.info = () => undefined
  try {
    await handlers.get('agent_end')[0]({ type: 'agent_end', messages }, ctx)
  } finally {
    console.info = originalInfo
  }

  const persisted = appendedEntries.at(-1)
  assert.equal(persisted?.customType, 'context-ignore-state')
  assert.equal(persisted?.data.enabled, true)
  assert.equal(persisted?.data.estimatedContextTokens < 500_000, true)
})

test('正常 agent_end 没有规则命中时交给 Pi 原生策略', async () => {
  const messages = longSessionMessages('stop')
  const contextUsage = {
    current: { tokens: 500_000, contextWindow: 600_000, percent: 83 }
  }
  const { handlers, appendedEntries, ctx } = createHarness(
    branchFromMessages(messages),
    contextUsage,
    absoluteRuleSettings(900_000)
  )
  await handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx)
  await handlers.get('agent_end')[0]({ type: 'agent_end', messages }, ctx)
  assert.equal(appendedEntries.length, 0)
})

test('检查点授权 ctx 一次并在工具返回前应用忽略', async () => {
  const messages = longSessionMessages('toolUse')
  const branch = branchFromMessages(messages)
  const contextUsage = {
    current: { tokens: 500_000, contextWindow: 600_000, percent: 83 }
  }
  const { handlers, appendedEntries, tools, sentMessages, ctx } = createHarness(
    branch,
    contextUsage,
    absoluteRuleSettings(400_000, 450_000)
  )
  await handlers.get('session_start')[0]({ type: 'session_start', reason: 'startup' }, ctx)

  const originalInfo = console.info
  console.info = () => undefined
  try {
    await handlers.get('turn_end')[0](
      { type: 'turn_end', turnIndex: 4, message: messages.at(-1), toolResults: [] },
      ctx
    )
  } finally {
    console.info = originalInfo
  }

  assert.equal(sentMessages.length, 1)
  assert.match(sentMessages[0].message.content, /下一步必须立即调用 `ctx`/)
  assert.deepEqual(sentMessages[0].options, { deliverAs: 'steer', triggerTurn: true })

  const ctxTool = tools.get('ctx')
  assert.ok(ctxTool)
  const result = await ctxTool.execute('ctx-call', {}, undefined, undefined, ctx)
  assert.equal(result.content[0].text, '已处理，继续当前任务。')
  assert.equal(appendedEntries.at(-1)?.data.enabled, true)

  const checkpointMessage = {
    role: 'custom',
    customType: 'context-ignore-checkpoint-request',
    content: '临时检查点指令',
    display: false,
    timestamp: 430
  }
  const transformed = await handlers.get('context')[0](
    { type: 'context', messages: [...messages, checkpointMessage] },
    ctx
  )
  assert.equal(
    transformed.messages.some(
      (message) =>
        message.role === 'custom' && message.customType === 'context-ignore-checkpoint-request'
    ),
    false
  )
  const unauthorizedResult = await ctxTool.execute('ctx-call-again', {}, undefined, undefined, ctx)
  assert.equal(unauthorizedResult.content[0].text, 'ctx 当前未获授权，请忽略并继续执行。')

  const repeatedUnauthorizedResult = await ctxTool.execute(
    'ctx-call-third',
    {},
    undefined,
    undefined,
    ctx
  )
  assert.equal(repeatedUnauthorizedResult.content[0].text, 'ctx 当前未获授权，请忽略并继续执行。')
})
