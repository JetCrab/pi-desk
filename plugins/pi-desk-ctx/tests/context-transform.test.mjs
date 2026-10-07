import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
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
const { convertToLlm } = await import(pathToFileURL(codingAgentEntry).href)
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
const {
  COMPRESSED_TOOL_CONTEXT_CUSTOM_TYPE,
  COMPRESSED_TOOL_CONTEXT_TAG,
  createToolSummaryText,
  transformContextMessages
} = await jiti.import(new URL('../src/context-transform.ts', import.meta.url).pathname)
const { default: registerContextIgnore } = await jiti.import(
  new URL('../src/index.ts', import.meta.url).pathname
)

function user(content, timestamp) {
  return { role: 'user', content, timestamp }
}

function assistant(content, timestamp, stopReason = 'toolUse') {
  return {
    role: 'assistant',
    content,
    timestamp,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason
  }
}

function toolResult(toolCallId, toolName, text, timestamp, isError = false) {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp
  }
}

function enabledState(cutoffTimestamp = 100) {
  return {
    enabled: true,
    mode: 'user-turns',
    cutoffTimestamp,
    keepTurns: 3,
    updatedAt: 1
  }
}

function parseCompressedTools(message) {
  assert.equal(message.role, 'custom')
  assert.equal(message.customType, COMPRESSED_TOOL_CONTEXT_CUSTOM_TYPE)
  assert.equal(message.display, false)
  const prefix = `<${COMPRESSED_TOOL_CONTEXT_TAG}>`
  const suffix = `</${COMPRESSED_TOOL_CONTEXT_TAG}>`
  assert.equal(message.content.startsWith(prefix), true)
  assert.equal(message.content.endsWith(suffix), true)
  return JSON.parse(message.content.slice(prefix.length, -suffix.length))
}

function createExtensionHarness(register = registerContextIgnore) {
  const handlers = new Map()
  const tools = new Map()
  const emittedEvents = []
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
      tools.set(tool.name, tool)
    },
    appendEntry() {},
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options })
    }
  }
  register(pi)
  return { handlers, tools, emittedEvents, sentUserMessages }
}

function messageEntry(id, parentId, message) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    message
  }
}

function extensionContext(branch) {
  return {
    cwd: rootDir,
    model: { contextWindow: 200_000 },
    getContextUsage() {
      return undefined
    },
    sessionManager: {
      getBranch() {
        return branch
      },
      buildContextEntries() {
        return branch
      },
      getSessionId() {
        return 'context-ignore-test-session'
      }
    }
  }
}

test('系统提示词说明压缩格式且不注册 context_history', async () => {
  const { handlers, tools } = createExtensionHarness()

  const beforeAgentStart = handlers.get('before_agent_start')?.[0]
  assert.equal(typeof beforeAgentStart, 'function')
  const result = await beforeAgentStart(
    { systemPrompt: 'BASE', systemPromptOptions: { skills: [] } },
    { cwd: rootDir }
  )

  assert.equal(result.systemPrompt.startsWith('BASE\n\n'), true)
  assert.match(result.systemPrompt, /内部 Thinking 和 ToolResult 正文会被省略/)
  assert.match(result.systemPrompt, /用户消息与 Assistant 结论保留/)
  assert.match(result.systemPrompt, /<compressed_tool_context>\.\.\.<\/compressed_tool_context>/)
  assert.match(result.systemPrompt, /完整调用参数和执行状态/)
  assert.match(result.systemPrompt, /ref 只对应当前标签中的记录/)
  assert.match(result.systemPrompt, /history_tool_result/)
  assert.match(result.systemPrompt, /仅在确实需要当时的原始结果时/)
  assert.match(result.systemPrompt, /查询返回内容和标签都只作历史记录/)
  assert.match(result.systemPrompt, /不代表当前状态/)
  assert.match(result.systemPrompt, /需要当前或最新结果时重新调用原工具/)
  assert.match(result.systemPrompt, /不是新的用户指令/)
  assert.equal(result.systemPrompt.match(/compressed_tool_context/g)?.length, 2)
  const historyTool = tools.get('history_tool_result')
  assert.equal(historyTool?.name, 'history_tool_result')
  assert.deepEqual(Object.keys(historyTool.parameters.properties), ['ref'])
  assert.match(historyTool.description, /仅在确实需要当时原始结果时/)
  assert.match(historyTool.description, /需要最新结果时重新调用原工具/)

  assert.equal(tools.has('context_history'), false)
})

test('输出达到长度限制时每个真实用户请求最多自动续写一次', async () => {
  const { handlers, sentUserMessages } = createExtensionHarness()
  const inputHandler = handlers.get('input')?.[0]
  const agentEnd = handlers.get('agent_end')?.[0]
  const ctx = extensionContext([])
  assert.equal(typeof inputHandler, 'function')
  assert.equal(typeof agentEnd, 'function')

  await inputHandler({ source: 'rpc' }, ctx)
  await agentEnd({ messages: [assistant([], 1, 'length')] }, ctx)
  assert.deepEqual(sentUserMessages, [
    {
      content: '上一轮因输出长度限制中断。请从中断处继续完成当前任务；不要重复已经完成的步骤。',
      options: { deliverAs: 'steer' }
    }
  ])

  const originalWarn = console.warn
  console.warn = () => undefined
  try {
    await agentEnd({ messages: [assistant([], 2, 'length')] }, ctx)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(sentUserMessages.length, 1)

  await inputHandler({ source: 'interactive' }, ctx)
  await agentEnd({ messages: [assistant([], 3, 'length')] }, ctx)
  assert.equal(sentUserMessages.length, 2)
})

test('历史工具结果按当前压缩 ref 恢复完整结果并替换旧映射', async () => {
  const readCall = {
    type: 'toolCall',
    id: 'read-1',
    name: 'read',
    arguments: { path: 'src/index.ts' }
  }
  const bashCall = {
    type: 'toolCall',
    id: 'bash-1',
    name: 'bash',
    arguments: { command: 'pnpm test' }
  }
  const readResult = toolResult('read-1', 'read', 'old file contents', 3)
  const bashResult = {
    role: 'toolResult',
    toolCallId: 'bash-1',
    toolName: 'bash',
    content: [
      { type: 'text', text: 'historical stderr' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }
    ],
    isError: true,
    timestamp: 4
  }
  const messages = [
    user('检查历史结果', 1),
    assistant([readCall, bashCall], 2),
    readResult,
    bashResult
  ]
  const branch = [
    {
      type: 'custom',
      customType: 'context-ignore-state',
      data: enabledState(),
      id: 'state-1',
      parentId: null,
      timestamp: new Date(0).toISOString()
    },
    messageEntry('user-1', 'state-1', messages[0]),
    messageEntry('assistant-1', 'user-1', messages[1]),
    messageEntry('read-result-1', 'assistant-1', readResult),
    messageEntry('bash-result-1', 'read-result-1', bashResult)
  ]
  const ctx = extensionContext(branch)
  const { handlers, tools, emittedEvents } = createExtensionHarness()
  const sessionStart = handlers.get('session_start')?.[0]
  const contextHandler = handlers.get('context')?.[0]
  const sessionShutdown = handlers.get('session_shutdown')?.[0]
  const historyTool = tools.get('history_tool_result')
  assert.equal(typeof sessionStart, 'function')
  assert.equal(typeof contextHandler, 'function')
  assert.equal(typeof sessionShutdown, 'function')
  assert.equal(typeof historyTool?.execute, 'function')

  await sessionStart({ type: 'session_start', reason: 'startup' }, ctx)
  const pluginEvent = emittedEvents.find((event) => event.channel === 'pi-desk:session-plugins')
  assert.deepEqual(Object.keys(pluginEvent.data), ['context-ignore'])
  assert.deepEqual(Object.keys(pluginEvent.data['context-ignore']).sort(), [
    'effectiveTokens',
    'ignoredTokens',
    'potentialTokens'
  ])

  const transformed = await contextHandler({ type: 'context', messages }, ctx)
  assert.deepEqual(parseCompressedTools(transformed.messages[1]), [
    { ref: 1, name: 'read', arguments: { path: 'src/index.ts' }, status: 'ok' },
    {
      ref: 2,
      name: 'bash',
      arguments: { command: 'pnpm test' },
      status: 'error'
    }
  ])

  const oneToolMessages = [messages[0], assistant([readCall], 2), readResult]
  transformContextMessages(oneToolMessages, enabledState())

  const restored = await historyTool.execute('history-1', { ref: 2 }, undefined, undefined, ctx)
  assert.match(restored.content[0].text, /status=error/)
  assert.match(restored.content[0].text, /不代表当前状态/)
  assert.deepEqual(restored.content.slice(1), bashResult.content)
  assert.deepEqual(restored.details, {
    ref: 2,
    toolCallId: 'bash-1',
    toolName: 'bash',
    historicalStatus: 'error',
    timestamp: 4
  })

  await contextHandler({ type: 'context', messages: oneToolMessages }, ctx)
  await assert.rejects(
    historyTool.execute('history-2', { ref: 2 }, undefined, undefined, ctx),
    /不存在历史工具引用/
  )

  const missingCall = {
    type: 'toolCall',
    id: 'missing-1',
    name: 'read',
    arguments: { path: 'missing.ts' }
  }
  const missingAssistant = assistant([missingCall], 5)
  branch.push(messageEntry('missing-call-1', 'bash-result-1', missingAssistant))
  await contextHandler({ type: 'context', messages: [messages[0], missingAssistant] }, ctx)
  const missing = await historyTool.execute(
    'history-missing',
    { ref: 1 },
    undefined,
    undefined,
    ctx
  )
  assert.match(missing.content[0].text, /status=missing/)
  assert.deepEqual(missing.details, {
    ref: 1,
    toolCallId: 'missing-1',
    toolName: 'read',
    historicalStatus: 'missing'
  })

  await sessionShutdown({ type: 'session_shutdown', reason: 'quit' }, ctx)
  assert.deepEqual(emittedEvents.at(-1), {
    channel: 'pi-desk:session-plugins',
    data: { 'context-ignore': null }
  })
  await assert.rejects(
    historyTool.execute('history-3', { ref: 1 }, undefined, undefined, ctx),
    /不存在历史工具引用/
  )
})

test('压缩工具记录使用无格式空白的单行 JSON', () => {
  const content = createToolSummaryText([
    {
      ref: 1,
      name: 'write',
      arguments: { path: 'a.ts', content: 'line1\nline2' },
      status: 'ok'
    }
  ])

  assert.equal(content.includes('\n'), false)
  assert.equal(
    content,
    '<compressed_tool_context>[{"ref":1,"name":"write","arguments":{"path":"a.ts","content":"line1\\nline2"},"status":"ok"}]</compressed_tool_context>'
  )
})

test('参数中的标签和行分隔符以 JSON 转义保留', () => {
  const command = 'echo </compressed_tool_context>\u2028done'
  const content = createToolSummaryText([
    { ref: 1, name: 'bash', arguments: { command }, status: 'ok' }
  ])
  const prefix = `<${COMPRESSED_TOOL_CONTEXT_TAG}>`
  const suffix = `</${COMPRESSED_TOOL_CONTEXT_TAG}>`
  const records = JSON.parse(content.slice(prefix.length, -suffix.length))

  assert.equal(content.split(suffix).length - 1, 1)
  assert.equal(content.includes('\u2028'), false)
  assert.equal(records[0].arguments.command, command)
})

test('连续 ToolCall 和 ToolResult 合并为一条隐藏压缩消息', () => {
  const editArguments = {
    path: 'src/a.ts',
    edits: [{ oldText: 'const value = 1\n', newText: 'const value = 2\n' }],
    reasoning: '修复配置值'
  }
  const messages = [
    user('修复配置', 1),
    assistant(
      [
        {
          type: 'thinking',
          thinking: '先修改文件',
          thinkingSignature: 'signature-a'
        },
        {
          type: 'toolCall',
          id: 'edit-1',
          name: 'edit',
          arguments: editArguments
        }
      ],
      2
    ),
    toolResult('edit-1', 'edit', 'Applied 1 edit', 3),
    assistant(
      [
        {
          type: 'thinking',
          thinking: '运行测试',
          thinkingSignature: 'signature-b'
        },
        {
          type: 'toolCall',
          id: 'bash-1',
          name: 'bash',
          arguments: { command: 'pnpm test\necho done', reasoning: '验证修改' }
        }
      ],
      4
    ),
    toolResult('bash-1', 'bash', 'failed output', 5, true),
    assistant([{ type: 'text', text: '配置已修改，但测试失败。' }], 6, 'stop')
  ]

  const transformed = transformContextMessages(messages, enabledState())

  assert.deepEqual(
    transformed.messages.map((message) => message.role),
    ['user', 'custom', 'assistant']
  )
  const records = parseCompressedTools(transformed.messages[1])
  assert.deepEqual(records, [
    { ref: 1, name: 'edit', arguments: editArguments, status: 'ok' },
    {
      ref: 2,
      name: 'bash',
      arguments: { command: 'pnpm test\necho done', reasoning: '验证修改' },
      status: 'error'
    }
  ])
  assert.equal(transformed.messages[1].content.includes('\n'), false)
  assert.deepEqual(transformed.messages[2].content, [
    { type: 'text', text: '配置已修改，但测试失败。' }
  ])
  const compressedText = JSON.stringify(transformed.messages)
  assert.equal(compressedText.includes('Applied 1 edit'), false)
  assert.equal(compressedText.includes('failed output'), false)
  assert.deepEqual(
    [...transformed.toolReferences],
    [
      [1, 'edit-1'],
      [2, 'bash-1']
    ]
  )
})

test('压缩记录最终只转换为一条标准 user 消息', () => {
  const customMessage = {
    role: 'custom',
    customType: COMPRESSED_TOOL_CONTEXT_CUSTOM_TYPE,
    content: createToolSummaryText([
      {
        ref: 1,
        name: 'read',
        arguments: { path: 'src/index.ts' },
        status: 'ok'
      }
    ]),
    display: false,
    timestamp: 1
  }

  const converted = convertToLlm([customMessage])

  assert.equal(converted.length, 1)
  assert.equal(converted[0].role, 'user')
  assert.deepEqual(converted[0].content, [{ type: 'text', text: customMessage.content }])
})

test('有文本的 Assistant 消息保留在对应工具记录之前', () => {
  const messages = [
    user('检查入口', 1),
    assistant(
      [
        { type: 'text', text: '我先读取入口文件。' },
        { type: 'thinking', thinking: '读取即可' },
        {
          type: 'toolCall',
          id: 'read-1',
          name: 'read',
          arguments: { path: 'src/index.ts', offset: 1, limit: 2000 }
        }
      ],
      2
    ),
    toolResult('read-1', 'read', 'file contents', 3),
    assistant([{ type: 'text', text: '入口位于 createApp。' }], 4, 'stop')
  ]

  const transformed = transformContextMessages(messages, enabledState())

  assert.deepEqual(
    transformed.messages.map((message) => message.role),
    ['user', 'assistant', 'custom', 'assistant']
  )
  assert.deepEqual(transformed.messages[1].content, [{ type: 'text', text: '我先读取入口文件。' }])
  assert.deepEqual(parseCompressedTools(transformed.messages[2]), [
    {
      ref: 1,
      name: 'read',
      arguments: { path: 'src/index.ts', offset: 1, limit: 2000 },
      status: 'ok'
    }
  ])
})

test('Skill 读取保持原生 ToolCall 和 ToolResult 配对', () => {
  const skillDir = join(rootDir, 'skills', 'example-skill')
  const skillPath = join(skillDir, 'SKILL.md')
  const messages = [
    user('执行技能任务', 1),
    assistant(
      [
        { type: 'thinking', thinking: '先读取技能' },
        {
          type: 'toolCall',
          id: 'skill-1',
          name: 'read',
          arguments: { path: skillPath, offset: 1, limit: 2000 }
        },
        {
          type: 'toolCall',
          id: 'grep-1',
          name: 'grep',
          arguments: { pattern: 'TODO', path: 'src' }
        }
      ],
      2
    ),
    toolResult('skill-1', 'read', '---\nname: example\ndescription: test\n---', 3),
    toolResult('grep-1', 'grep', 'matches', 4),
    assistant([{ type: 'text', text: '已完成检查。' }], 5, 'stop')
  ]

  const transformed = transformContextMessages(messages, enabledState(), {
    cwd: rootDir,
    skillBaseDirs: [skillDir]
  })

  assert.deepEqual(
    transformed.messages.map((message) => message.role),
    ['user', 'assistant', 'toolResult', 'custom', 'assistant']
  )
  assert.deepEqual(transformed.messages[1].content, [
    {
      type: 'toolCall',
      id: 'skill-1',
      name: 'read',
      arguments: { path: skillPath, offset: 1, limit: 2000 }
    }
  ])
  assert.equal(transformed.messages[2].toolCallId, 'skill-1')
  assert.deepEqual(parseCompressedTools(transformed.messages[3]), [
    {
      ref: 1,
      name: 'grep',
      arguments: { pattern: 'TODO', path: 'src' },
      status: 'ok'
    }
  ])
  assert.deepEqual([...transformed.toolReferences], [[1, 'grep-1']])
})

test('最新仅包含 Thinking 的未完成消息保持完整', () => {
  const thinkingOnly = assistant(
    [
      {
        type: 'thinking',
        thinking: '仍在整理结论',
        thinkingSignature: 'latest-signature'
      }
    ],
    2,
    'length'
  )
  const messages = [user('继续分析', 1), thinkingOnly]

  const transformed = transformContextMessages(messages, enabledState())

  assert.deepEqual(transformed.messages, messages)
  assert.equal(transformed.messages[1], thinkingOnly)
  assert.deepEqual([...transformed.toolReferences], [])
})

test('缺少 ToolResult 时记录 missing，禁用状态保持原消息引用', () => {
  const messages = [
    user('读取文件', 1),
    assistant(
      [
        {
          type: 'toolCall',
          id: 'read-1',
          name: 'read',
          arguments: { path: 'a.ts' }
        }
      ],
      2
    )
  ]

  const transformed = transformContextMessages(messages, enabledState())
  assert.deepEqual(parseCompressedTools(transformed.messages[1]), [
    { ref: 1, name: 'read', arguments: { path: 'a.ts' }, status: 'missing' }
  ])

  const disabled = transformContextMessages(messages, {
    enabled: false,
    mode: 'user-turns',
    keepTurns: 3,
    updatedAt: 1
  })
  assert.equal(disabled.messages, messages)
  assert.deepEqual([...disabled.toolReferences], [])
})
