import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import { projectSubagentStartMessage } from '../plugins/pi-desk-subagent/src/pi-desk'
import {
  projectL4PiChatEntries,
  projectL4PiLiveToolResultMessage,
  projectL4PiToolCallDisplay,
  readL4PiToolCalls,
  type L4PiToolCallDisplayCache
} from '../src/server/l4_foundation/pi/l4-pi-chat-projection'

test('read activity 按已知 offset/limit 逐步形成范围', () => {
  assert.equal(projectL4PiToolCallDisplay('read', {}).activity, null)
  assert.equal(projectL4PiToolCallDisplay('read', { limit: 200 }).activity, '1-200')
  assert.equal(projectL4PiToolCallDisplay('read', { offset: 100 }).activity, '100-')
  assert.equal(projectL4PiToolCallDisplay('read', { offset: 100, limit: 200 }).activity, '100-299')
})

test('write activity 使用增量缓存统计 Unicode 字符和行数', () => {
  const cache: L4PiToolCallDisplayCache = {}
  assert.equal(projectL4PiToolCallDisplay('write', { content: '' }, cache).activity, '0 · L0')
  assert.equal(projectL4PiToolCallDisplay('write', { content: '你' }, cache).activity, '1 · L1')
  assert.equal(projectL4PiToolCallDisplay('write', { content: '你\n好' }, cache).activity, '3 · L2')
  assert.equal(projectL4PiToolCallDisplay('write', { content: '你\n好' }, cache).activity, '3 · L2')
  assert.equal(projectL4PiToolCallDisplay('write', { content: '🙂' }, cache).activity, '1 · L1')
})

test('edit activity 汇总多个替换的当前 old/new 行数', () => {
  assert.equal(
    projectL4PiToolCallDisplay('edit', {
      edits: [
        { oldText: 'a\nb', newText: 'a\nb\nc' },
        { oldText: 'x', newText: '' }
      ]
    }).activity,
    '2 · -3 +3'
  )
  assert.equal(
    projectL4PiToolCallDisplay('edit', { edits: [{ oldText: 'a\nb' }] }).activity,
    '1 · -2'
  )
})

test('partial ToolCall 只暴露当前已解析的 id/name/arguments', () => {
  assert.deepEqual(
    readL4PiToolCalls([
      { type: 'thinking', thinking: '分析' },
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'write',
        arguments: { path: 'temp/demo.html', content: '<html' }
      }
    ]),
    [
      {
        id: 'call-1',
        name: 'write',
        input: { path: 'temp/demo.html', content: '<html' }
      }
    ]
  )
})

test('Tool final 投影保留 arguments 和 Prompt detail', () => {
  const argumentsValue = {
    subagent_type: 'explore',
    description: '调查消息投影',
    prompt: '## 调查目标\n\n检查 Tool final 详情。'
  }
  const message = {
    role: 'toolResult',
    toolCallId: 'call-agent',
    toolName: 'agent',
    content: [{ type: 'text', text: '子代理已在后台启动。' }],
    details: {
      version: 1,
      kind: 'launch',
      taskId: 'agent-1',
      agentType: 'explore',
      title: '调查消息投影',
      sessionFile: 'C:/sessions/agent-1.jsonl',
      startedAt: 1
    },
    isError: false,
    timestamp: 1
  } as SessionMessageEntry['message']
  const projected = projectL4PiLiveToolResultMessage(
    message,
    'call-agent',
    projectL4PiToolCallDisplay('agent', argumentsValue),
    argumentsValue
  )
  assert.ok(projected)
  assert.equal(projected.type, 'tool')
  assert.deepEqual(projected.declaration?.message, {
    kind: 'tool',
    toolName: 'agent',
    toolCallId: 'call-agent',
    arguments: argumentsValue,
    partialResult: null,
    result: {
      content: [{ type: 'text', text: '子代理已在后台启动。' }],
      details: {
        version: 1,
        kind: 'launch',
        taskId: 'agent-1',
        agentType: 'explore',
        title: '调查消息投影',
        sessionFile: 'C:/sessions/agent-1.jsonl',
        startedAt: 1
      },
      output: '子代理已在后台启动。'
    },
    isError: false
  })
  const declarationMessage = projected.declaration?.message
  assert.ok(declarationMessage)
  const projection = projectSubagentStartMessage({
    source: { workId: 'work-1', sessionId: 'session-1', branchId: 'v1:main' },
    stage: 'final',
    message: declarationMessage,
    raw: null,
    defaultProjection: { viewKey: 'pi-desk/tool', summary: {}, detail: null }
  })
  assert.deepEqual(projection.detail, {
    markdown: '## 调查目标\n\n检查 Tool final 详情。'
  })
})

test('CompactionEntry 投影为保留压缩视图且摘要留在声明详情', () => {
  const entry = {
    type: 'compaction',
    id: 'compaction-1',
    parentId: 'assistant-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    summary: '## Goal\n\n保留当前目标。',
    firstKeptEntryId: 'assistant-1',
    tokensBefore: 120_000
  } as SessionEntry

  const projected = projectL4PiChatEntries([entry])
  assert.equal(projected.length, 1)
  assert.equal(projected[0]?.entryId, 'compaction-1')
  assert.deepEqual(projected[0]?.message, {
    type: 'compaction',
    summary: '## Goal\n\n保留当前目标。',
    declaration: {
      message: {
        kind: 'custom',
        customType: 'pi-desk/compaction',
        content: '',
        details: { text: '## Goal\n\n保留当前目标。' }
      },
      raw: entry
    }
  })
})

test('Durable ToolResult 按 toolCallId 恢复原始 arguments', () => {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const branch = [
    {
      type: 'message',
      id: 'assistant-1',
      parentId: null,
      timestamp,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-agent',
            name: 'agent',
            arguments: {
              subagent_type: 'explore',
              description: '调查消息投影',
              prompt: '## 调查目标\n\n检查 Durable arguments。'
            }
          }
        ],
        api: 'openai-responses',
        provider: 'test',
        model: 'test-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'toolUse',
        timestamp: Date.parse(timestamp)
      }
    },
    {
      type: 'message',
      id: 'tool-1',
      parentId: 'assistant-1',
      timestamp: '2026-01-01T00:00:00.100Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-agent',
        toolName: 'agent',
        content: [{ type: 'text', text: '子代理已在后台启动。' }],
        details: { kind: 'launch' },
        isError: false,
        timestamp: Date.parse(timestamp) + 100
      }
    }
  ] as SessionEntry[]

  const projected = projectL4PiChatEntries(branch).at(-1)?.message.declaration?.message
  assert.equal(projected?.kind, 'tool')
  assert.deepEqual(projected?.kind === 'tool' ? projected.arguments : null, {
    subagent_type: 'explore',
    description: '调查消息投影',
    prompt: '## 调查目标\n\n检查 Durable arguments。'
  })
})
