import assert from 'node:assert/strict'
import Module from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

process.env.PI_CODING_AGENT_DIR = resolve('temp/pi/session-search-tests/current-branch/agent')
process.env.PI_CODING_AGENT_SESSION_DIR = resolve(process.env.PI_CODING_AGENT_DIR, 'sessions')
const { SessionManager } = await import('@earendil-works/pi-coding-agent')
const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {}
  return originalLoad.call(this, request, parent, isMain)
}
const { searchL4PiSessionBranch } =
  await import('../src/server/l4_foundation/pi/l4-pi-session-search.ts')
Module._load = originalLoad
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function assistant(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'test',
    model: 'test',
    usage,
    stopReason: 'stop',
    timestamp: 2
  }
}

test('工作会话搜索跟随内存leaf，旁支和切换后的旧路径不参与', () => {
  const manager = SessionManager.inMemory()
  manager.appendMessage({ role: 'user', content: '共同内容', timestamp: 1 })
  const base = manager.appendMessage(assistant('共同回答'))
  const older = manager.appendMessage({ role: 'user', content: '原路径苹果', timestamp: 3 })
  manager.branch(base)
  manager.appendMessage({ role: 'user', content: '新路径柠檬', timestamp: 4 })
  const query = (value) => searchL4PiSessionBranch(manager, { query: value, searchIn: ['user'] })
  assert.equal(query('共同').length, 1)
  assert.deepEqual(query('苹果'), [])
  assert.equal(query('柠檬').length, 1)
  manager.branch(older)
  assert.equal(query('苹果').length, 1)
  assert.deepEqual(query('柠檬'), [])
  assert.deepEqual(
    searchL4PiSessionBranch(SessionManager.inMemory(), { query: '共同', searchIn: ['user'] }),
    []
  )
})

test('文字范围与历史搜索一致，计数按消息且只展示最近摘要', () => {
  const manager = SessionManager.inMemory()
  manager.appendSessionInfo('任务 TOKEN')
  const first = manager.appendMessage({ role: 'user', content: '前文 token token', timestamp: 1 })
  const latest = manager.appendMessage({
    role: 'user',
    content: [
      { type: 'text', text: '最新 TOKEN' },
      { type: 'image', data: 'image-secret', mimeType: 'image/png' }
    ],
    timestamp: 2
  })
  manager.appendMessage({
    ...assistant(''),
    content: [
      { type: 'thinking', thinking: 'thinking-secret' },
      { type: 'text', text: '助手 token' },
      { type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'tool-argument-secret' } }
    ]
  })
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'call',
    toolName: 'bash',
    content: [{ type: 'text', text: 'tool-output-secret' }],
    isError: false,
    timestamp: 3
  })
  const result = searchL4PiSessionBranch(manager, {
    query: '  ToKeN ',
    searchIn: ['title', 'user', 'assistant']
  })
  assert.deepEqual(
    result.map(({ scope, count }) => ({ scope, count })),
    [
      { scope: 'title', count: 1 },
      { scope: 'user', count: 2 },
      { scope: 'assistant', count: 1 }
    ]
  )
  assert.equal(result[1].entryId, latest)
  assert.notEqual(result[1].entryId, first)
  assert.equal(result[1].preview, '最新 TOKEN')
  for (const text of [
    'image-secret',
    'thinking-secret',
    'tool-argument-secret',
    'tool-output-secret'
  ]) {
    assert.deepEqual(
      searchL4PiSessionBranch(manager, { query: text, searchIn: ['user', 'assistant'] }),
      []
    )
  }
  assert.equal(
    searchL4PiSessionBranch(manager, { query: manager.getSessionId(), searchIn: ['sessionId'] })[0]
      .scope,
    'sessionId'
  )
})
