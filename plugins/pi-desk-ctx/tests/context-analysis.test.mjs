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
const { createJiti } = require(require.resolve('jiti', { paths: [process.cwd()] }))
const jiti = createJiti(import.meta.url, {
  alias: {
    '@earendil-works/pi-coding-agent': codingAgentEntry,
    '@earendil-works/pi-agent-core': packageEntry('@earendil-works/pi-agent-core'),
    '@earendil-works/pi-ai': packageEntry('@earendil-works/pi-ai')
  },
  tsconfigPaths: true
})
const { analyzeContext, analyzeIgnorePotential, selectRecentProcessCandidate } = await jiti.import(
  new URL('../src/context-analysis.ts', import.meta.url).pathname
)
const { resolveAutoCompactionIgnoreAction } = await jiti.import(
  new URL('../src/auto-compaction.ts', import.meta.url).pathname
)
const { transformContextMessages } = await jiti.import(
  new URL('../src/context-transform.ts', import.meta.url).pathname
)
const { buildContextEntries, sessionEntryToContextMessages } = await jiti.import(codingAgentEntry)

function user(timestamp) {
  return { role: 'user', content: '继续处理', timestamp }
}

function assistant(timestamp, toolCallId) {
  return {
    role: 'assistant',
    content: toolCallId
      ? [
          {
            type: 'toolCall',
            id: toolCallId,
            name: 'read',
            arguments: { path: 'src/file.ts' }
          }
        ]
      : [
          {
            type: 'thinking',
            thinking: '继续分析',
            thinkingSignature: 'signature'
          }
        ],
    timestamp,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: toolCallId ? 'toolUse' : 'stop'
  }
}

function toolResult(toolCallId, timestamp, text) {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp
  }
}

test('候选边界在过程信息超过预算时推进且保持精确 potential', () => {
  const messages = [
    user(1),
    assistant(2),
    user(10),
    assistant(11, 'read-large'),
    toolResult('read-large', 12, 'x'.repeat(200_000)),
    user(20),
    assistant(21),
    user(30),
    assistant(31)
  ]
  const state = { enabled: false, mode: 'user-turns', keepTurns: 3, updatedAt: 1 }

  const candidate = selectRecentProcessCandidate(messages, state, 3, 40_000)

  assert.equal(candidate?.cutoffTimestamp, 21)
  assert.equal(candidate?.nextState.cutoffTimestamp, 21)
  const expectedPotential = {
    reasoningReplayTokens: 3,
    netTokens: 49_976,
    providerNetTokens: 49_979
  }
  assert.deepEqual(candidate?.potential, expectedPotential)
  assert.deepEqual(analyzeIgnorePotential(messages, state, 3, 40_000), expectedPotential)
  assert.deepEqual(analyzeContext(messages, state), {
    rawTokens: 50_014,
    effectiveTokens: 50_014,
    providerEffectiveTokens: 50_023,
    ignoredTokens: 0,
    providerIgnoredTokens: 0,
    reasoningReplayTokens: 0,
    completeTurns: 4
  })

  const decision = {
    shouldIgnore: true,
    cutoffTimestamp: candidate.cutoffTimestamp,
    potential: candidate.potential
  }
  const actionAt = (contextTokens) =>
    resolveAutoCompactionIgnoreAction(
      'overflow',
      true,
      decision,
      'first-active-entry',
      contextTokens,
      200_000,
      100_000
    ).type
  assert.equal(actionAt(149_979), 'retry')
  assert.equal(actionAt(149_980), 'compact')
})

test('压缩保留半轮过程但没有用户消息时仍按预算计算，并保留摘要、结论和 Skill', () => {
  const oldAssistant = {
    ...assistant(2, 'read-old'),
    content: [
      { type: 'thinking', thinking: '旧思考'.repeat(1_000), thinkingSignature: 'x'.repeat(10_000) },
      { type: 'text', text: '已经定位问题' },
      ...assistant(2, 'read-old').content
    ]
  }
  const skillAssistant = {
    ...assistant(4, 'read-skill'),
    content: [
      {
        type: 'toolCall',
        id: 'read-skill',
        name: 'read',
        arguments: { path: '/skills/sample/SKILL.md' }
      }
    ]
  }
  const skillResult = toolResult('read-skill', 5, '规则'.repeat(100_000))
  const recentAssistant = assistant(6)
  const originalMessages = [
    user(1),
    oldAssistant,
    toolResult('read-old', 3, 'x'.repeat(200_000)),
    skillAssistant,
    skillResult,
    recentAssistant
  ]
  const entries = originalMessages.map((message, index) => ({
    type: 'message',
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message
  }))
  const compaction = {
    type: 'compaction',
    id: 'compaction',
    parentId: 'entry-5',
    timestamp: new Date(20).toISOString(),
    summary: '已完成的任务摘要',
    tokensBefore: 200_000,
    firstKeptEntryId: 'entry-1'
  }
  entries.push(compaction)
  const messages = buildContextEntries(entries, compaction.id).flatMap(
    sessionEntryToContextMessages
  )
  assert.equal(
    messages.some((message) => message.role === 'user'),
    false
  )
  const state = { enabled: false, mode: 'user-turns', keepTurns: 3, updatedAt: 1 }
  const options = { skillBaseDirs: ['/skills/sample'] }

  const candidate = selectRecentProcessCandidate(messages, state, 3, 40_000, options)

  assert.ok(candidate)
  assert.equal(candidate.cutoffTimestamp, 4)
  assert.equal(candidate.potential.netTokens > 40_000, true)
  assert.equal(candidate.potential.reasoningReplayTokens > 0, true)
  assert.deepEqual(analyzeIgnorePotential(messages, state, 3, 40_000, options), candidate.potential)
  const transformed = transformContextMessages(messages, candidate.nextState, options).messages
  assert.deepEqual(transformed[0], messages[0])
  assert.deepEqual(
    transformed.find((message) => message.role === 'assistant'),
    {
      ...oldAssistant,
      content: [{ type: 'text', text: '已经定位问题' }]
    }
  )
  assert.equal(
    transformed.some(
      (message) => message.role === 'toolResult' && message.toolCallId === 'read-old'
    ),
    false
  )
  assert.equal(transformed.includes(skillAssistant), true)
  assert.equal(transformed.includes(skillResult), true)
  assert.equal(transformed.includes(recentAssistant), true)
})

test('没有用户消息但过程未超预算，或只有摘要时，可忽略量仍为零', () => {
  const summary = {
    role: 'compactionSummary',
    summary: '保留摘要',
    tokensBefore: 200_000,
    timestamp: 20
  }
  const state = { enabled: false, mode: 'user-turns', keepTurns: 3, updatedAt: 1 }
  for (const messages of [[], [summary], [summary, assistant(2)]]) {
    assert.deepEqual(analyzeIgnorePotential(messages, state, 3, 40_000), {
      reasoningReplayTokens: 0,
      netTokens: 0,
      providerNetTokens: 0
    })
  }
})
