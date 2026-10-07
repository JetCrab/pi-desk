import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L2ChatRuntimeSchema,
  L2ChatTemporaryMessageSnapshotSchema,
  type L2ChatSourceState
} from '../src/common/l2_biz/chat/l2-chat-contract'
import {
  L2ChatSendRequestSchema,
  L2ChatSocketContracts,
  L2ChatSourceEventSchema,
  L2ChatSubscribeRequestSchema
} from '../src/common/l2_biz/chat/l2-chat-websocket-contract'
import {
  applyL2ChatSourceEvent,
  getL2ChatLatestCursor
} from '../src/common/l2_biz/chat/l2-chat-state'

const TEMP_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE = {
  workId: 'work-1',
  sessionId: '22222222-2222-4222-8222-222222222222',
  branchId: 'v1:main'
}
const TIMESTAMP_MS = 1_765_800_000_000
const USAGE = {
  inputTokens: 1_200,
  outputTokens: 345,
  cacheReadTokens: 6_000,
  costUsd: 0.0042
}
const EMPTY_RUNTIME = {
  extensionMode: 'normal' as const,
  presentationMode: 'normal' as const,
  initializationError: null,
  queues: { steering: [], followUp: [] },
  model: null,
  capabilityMode: null,
  contextUsage: null,
  plugins: {}
}

function emptyState(): L2ChatSourceState {
  return { messages: [], temporaryMessages: [], runtime: EMPTY_RUNTIME }
}

function userDurable(index = 0, text = '你好') {
  return {
    location: { index, entryId: `entry-${index}` },
    fixed: {
      timestampMs: TIMESTAMP_MS + index,
      type: 'user' as const,
      viewKey: 'pi-desk/user',
      hasDetail: false as const
    },
    summary: { text, images: [] }
  }
}

function assistantTemporary(text = '', thinking = '', includeDetail = false) {
  return {
    location: { tempId: TEMP_ID },
    fixed: {
      timestampMs: null,
      type: 'assistant' as const,
      viewKey: 'pi-desk/assistant',
      status: 'running' as const,
      hasDetail: includeDetail || thinking.length > 0,
      usage: { ...USAGE, outputTokens: 0, costUsd: 0 }
    },
    summary: { text, errorMessage: null },
    ...(includeDetail || thinking ? { detail: { thinking } } : {})
  }
}

test('chat subscribe保留初始化接管窗口且不改动其他请求默认超时', () => {
  assert.equal(L2ChatSocketContracts.subscribe.timeoutMs, 125_000)
  assert.equal(L2ChatSocketContracts.reload.timeoutMs, 125_000)
  assert.equal(L2ChatSocketContracts.interrupt.timeoutMs, undefined)
})

test('旧Runtime缺少模式字段时默认normal', () => {
  const runtime = L2ChatRuntimeSchema.parse({
    queues: { steering: [], followUp: [] },
    model: null,
    capabilityMode: null,
    contextUsage: null,
    plugins: {}
  })

  assert.equal(runtime.extensionMode, 'normal')
  assert.equal(runtime.presentationMode, 'normal')
  assert.equal(runtime.initializationError, null)
})

test('Snapshot 严格关联 fixed、summary、detail，并支持 Tool usage/activity', () => {
  assert.equal(
    L2ChatTemporaryMessageSnapshotSchema.safeParse({
      location: { tempId: TEMP_ID },
      fixed: {
        timestampMs: null,
        type: 'assistant',
        viewKey: 'pi-desk/assistant',
        status: 'completed',
        hasDetail: true,
        usage: USAGE
      },
      summary: { text: '已完成', errorMessage: null },
      detail: { thinking: '内部分析' }
    }).success,
    true
  )

  assert.equal(
    L2ChatTemporaryMessageSnapshotSchema.safeParse({
      location: { tempId: TEMP_ID },
      fixed: {
        timestampMs: null,
        type: 'tool',
        viewKey: 'pi-desk/tool',
        status: 'running',
        hasDetail: false,
        usage: null
      },
      summary: {
        name: 'write',
        reasoning: '生成页面',
        inputPreview: 'temp/demo.html',
        activity: '3,842 · L126'
      }
    }).success,
    true
  )

  assert.equal(
    L2ChatTemporaryMessageSnapshotSchema.safeParse({
      location: { tempId: TEMP_ID },
      fixed: {
        timestampMs: null,
        type: 'assistant',
        viewKey: 'pi-desk/assistant',
        status: 'running',
        hasDetail: false,
        usage: USAGE
      },
      summary: { name: 'read', reasoning: null, inputPreview: null, activity: null }
    }).success,
    true
  )

  assert.equal(
    L2ChatTemporaryMessageSnapshotSchema.safeParse({
      location: { tempId: TEMP_ID },
      fixed: {
        timestampMs: null,
        type: 'assistant',
        viewKey: 'pi-desk/assistant',
        status: 'running',
        hasDetail: false,
        usage: USAGE
      },
      summary: { text: '', errorMessage: null },
      detail: { thinking: '' }
    }).success,
    false
  )
})

test('实时消息按 location start、增量 update、fixed update 和 commit 收敛', () => {
  let state = applyL2ChatSourceEvent(emptyState(), {
    type: 'message_start',
    snapshot: assistantTemporary('', '', true)
  })
  state = applyL2ChatSourceEvent(state, {
    type: 'message_update',
    location: { tempId: TEMP_ID },
    fixed: { status: 'completed', hasDetail: true, usage: USAGE },
    increments: {
      'summary.text': '完成',
      'detail.thinking': '分析'
    }
  })
  state = applyL2ChatSourceEvent(state, {
    type: 'message_commit',
    location: { tempId: TEMP_ID },
    durable: { index: 0, entryId: 'entry-0' },
    fixed: { timestampMs: TIMESTAMP_MS }
  })

  assert.deepEqual(state.temporaryMessages, [])
  assert.deepEqual(state.messages, [
    {
      location: { index: 0, entryId: 'entry-0' },
      fixed: {
        timestampMs: TIMESTAMP_MS,
        type: 'assistant',
        viewKey: 'pi-desk/assistant',
        status: 'completed',
        hasDetail: true,
        usage: USAGE
      },
      summary: { text: '完成', errorMessage: null },
      detail: { thinking: '分析' }
    }
  ])
})

test('message_update 撤销 hasDetail 时清除 Temporary Detail', () => {
  const state = applyL2ChatSourceEvent(
    {
      messages: [],
      temporaryMessages: [assistantTemporary('', '临时思考')],
      runtime: EMPTY_RUNTIME
    },
    {
      type: 'message_update',
      location: { tempId: TEMP_ID },
      fixed: { hasDetail: false }
    }
  )

  assert.equal(state.temporaryMessages[0]?.detail, undefined)
})

test('Detail increment 目标缺失时拒绝，replacement 可建立 Detail', () => {
  const current = {
    messages: [],
    temporaryMessages: [assistantTemporary()],
    runtime: EMPTY_RUNTIME
  }
  assert.throws(() =>
    applyL2ChatSourceEvent(current, {
      type: 'message_update',
      location: { tempId: TEMP_ID },
      increments: { 'detail.thinking': '流式思考' }
    })
  )

  const state = applyL2ChatSourceEvent(current, {
    type: 'message_update',
    location: { tempId: TEMP_ID },
    detail: { thinking: '流式思考' }
  })
  assert.equal(state.temporaryMessages[0]?.fixed.hasDetail, true)
  assert.deepEqual(state.temporaryMessages[0]?.detail, {
    thinking: '流式思考'
  })
})

test('显式清除 hasDetail 时拒绝同时更新 Detail', () => {
  assert.throws(() =>
    applyL2ChatSourceEvent(
      {
        messages: [],
        temporaryMessages: [assistantTemporary()],
        runtime: EMPTY_RUNTIME
      },
      {
        type: 'message_update',
        location: { tempId: TEMP_ID },
        fixed: { hasDetail: false },
        increments: { 'detail.thinking': '冲突增量' }
      }
    )
  )
})

test('full sync 替换权威摘要，并保留仍声明 hasDetail 的本地详情', () => {
  const localDetail = { thinking: '本地已加载详情' }
  const state = applyL2ChatSourceEvent(
    {
      messages: [
        {
          location: { index: 0, entryId: 'entry-0' },
          fixed: {
            timestampMs: TIMESTAMP_MS,
            type: 'assistant',
            viewKey: 'pi-desk/assistant',
            status: 'completed',
            hasDetail: true,
            usage: USAGE
          },
          summary: { text: '旧摘要', errorMessage: null },
          detail: localDetail
        }
      ],
      temporaryMessages: [],
      runtime: EMPTY_RUNTIME
    },
    {
      type: 'session_sync',
      mode: 'full',
      baseCursor: null,
      messages: [
        {
          location: { index: 0, entryId: 'entry-0' },
          fixed: {
            timestampMs: TIMESTAMP_MS,
            type: 'assistant',
            viewKey: 'pi-desk/assistant',
            status: 'completed',
            hasDetail: true,
            usage: USAGE
          },
          summary: { text: '权威摘要', errorMessage: null }
        }
      ],
      temporaryMessages: [
        {
          location: { tempId: TEMP_ID },
          fixed: {
            timestampMs: null,
            type: 'tool',
            viewKey: 'pi-desk/tool',
            status: 'running',
            hasDetail: false,
            usage: null
          },
          summary: {
            name: 'read',
            reasoning: null,
            inputPreview: 'src/common/chat.ts',
            activity: '1-200'
          }
        }
      ],
      runtime: EMPTY_RUNTIME
    }
  )

  assert.deepEqual(state.messages[0]?.summary, {
    text: '权威摘要',
    errorMessage: null
  })
  assert.deepEqual(state.messages[0]?.detail, localDetail)
  assert.equal(state.temporaryMessages[0]?.location.tempId, TEMP_ID)
})

test('full sync 在服务端撤销 hasDetail 时删除本地旧详情', () => {
  const state = applyL2ChatSourceEvent(
    {
      messages: [
        {
          location: { index: 0, entryId: 'entry-0' },
          fixed: {
            timestampMs: TIMESTAMP_MS,
            type: 'assistant',
            viewKey: 'pi-desk/assistant',
            status: 'completed',
            hasDetail: true,
            usage: USAGE
          },
          summary: { text: '旧摘要', errorMessage: null },
          detail: { thinking: '过期详情' }
        }
      ],
      temporaryMessages: [],
      runtime: EMPTY_RUNTIME
    },
    {
      type: 'session_sync',
      mode: 'full',
      baseCursor: null,
      messages: [
        {
          location: { index: 0, entryId: 'entry-0' },
          fixed: {
            timestampMs: TIMESTAMP_MS,
            type: 'assistant',
            viewKey: 'pi-desk/assistant',
            status: 'completed',
            hasDetail: false,
            usage: USAGE
          },
          summary: { text: '权威摘要', errorMessage: null }
        }
      ],
      temporaryMessages: [],
      runtime: EMPTY_RUNTIME
    }
  )

  assert.equal(state.messages[0]?.detail, undefined)
})

test('incremental sync 必须匹配当前 cursor 并连续追加', () => {
  const current: L2ChatSourceState = {
    messages: [userDurable()],
    temporaryMessages: [],
    runtime: EMPTY_RUNTIME
  }

  const next = applyL2ChatSourceEvent(current, {
    type: 'session_sync',
    mode: 'incremental',
    baseCursor: { index: 0, entryId: 'entry-0' },
    messages: [
      {
        location: { index: 1, entryId: 'entry-1' },
        fixed: {
          timestampMs: TIMESTAMP_MS + 1,
          type: 'assistant',
          viewKey: 'pi-desk/assistant',
          status: 'completed',
          hasDetail: false,
          usage: USAGE
        },
        summary: { text: '收到', errorMessage: null }
      }
    ],
    temporaryMessages: [],
    runtime: EMPTY_RUNTIME
  })
  assert.deepEqual(getL2ChatLatestCursor(next.messages), { index: 1, entryId: 'entry-1' })

  assert.throws(() =>
    applyL2ChatSourceEvent(current, {
      type: 'session_sync',
      mode: 'incremental',
      baseCursor: { index: 0, entryId: 'wrong-entry' },
      messages: [],
      temporaryMessages: [],
      runtime: EMPTY_RUNTIME
    })
  )
})

test('message_update 按顺序追加全部增量并保留 durable 与 Runtime 引用', () => {
  const messages: L2ChatSourceState['messages'] = [userDurable(0, '历史消息')]
  const temporaryMessages: L2ChatSourceState['temporaryMessages'] = [assistantTemporary('旧')]
  const current: L2ChatSourceState = { messages, temporaryMessages, runtime: EMPTY_RUNTIME }

  let next = applyL2ChatSourceEvent(current, {
    type: 'message_update',
    location: { tempId: TEMP_ID },
    increments: { 'summary.text': '内容' }
  })
  next = applyL2ChatSourceEvent(next, {
    type: 'message_update',
    location: { tempId: TEMP_ID },
    increments: { 'summary.text': '继续' }
  })

  assert.equal(next.messages, messages)
  assert.equal(next.runtime, EMPTY_RUNTIME)
  assert.equal(L2ChatAssistantText(next), '旧内容继续')
})

function L2ChatAssistantText(state: L2ChatSourceState): string {
  const message = state.temporaryMessages[0]
  assert.equal(message?.fixed.type, 'assistant')
  return (message?.summary as { text: string }).text
}

test('runtime_update 整体替换 Runtime 并保留消息状态', () => {
  const current: L2ChatSourceState = {
    messages: [userDurable(0, '保留消息')],
    temporaryMessages: [],
    runtime: EMPTY_RUNTIME
  }
  const runtime = {
    extensionMode: 'normal' as const,
    presentationMode: 'normal' as const,
    initializationError: null,
    queues: {
      steering: [{ tempId: TEMP_ID, text: '继续', images: [] }],
      followUp: []
    },
    model: { provider: 'test', modelId: 'model', thinkingLevel: 'high' as const },
    capabilityMode: null,
    contextUsage: { tokens: 12_345, contextWindow: 200_000 },
    plugins: {
      'context-ignore': { ignoredTokens: 8_000, potentialTokens: 4_000 }
    }
  }
  const next = applyL2ChatSourceEvent(current, { type: 'runtime_update', runtime })

  assert.deepEqual(next.messages, current.messages)
  assert.deepEqual(next.temporaryMessages, current.temporaryMessages)
  assert.deepEqual(next.runtime, runtime)
})

test('discard 只删除 temp，不产生 durable 空洞', () => {
  const state = applyL2ChatSourceEvent(
    {
      messages: [],
      temporaryMessages: [
        {
          location: { tempId: TEMP_ID },
          fixed: {
            timestampMs: null,
            type: 'tool',
            viewKey: 'pi-desk/tool',
            status: 'running',
            hasDetail: false,
            usage: null
          },
          summary: {
            name: 'bash',
            reasoning: null,
            inputPreview: 'pnpm test',
            activity: null
          }
        }
      ],
      runtime: EMPTY_RUNTIME
    },
    { type: 'message_discard', location: { tempId: TEMP_ID } }
  )
  assert.deepEqual(state, emptyState())
})

test('increments 支持嵌套对象、数组下标和转义字段', () => {
  const state = applyL2ChatSourceEvent(
    {
      messages: [],
      temporaryMessages: [
        {
          location: { tempId: TEMP_ID },
          fixed: {
            timestampMs: null,
            type: 'assistant',
            viewKey: 'fixture/nested',
            status: 'running',
            hasDetail: true,
            usage: USAGE
          },
          summary: {
            text: '',
            timeline: { events: ['start'] },
            'field.with.dot': 'a'
          },
          detail: {
            sections: [{ logs: ['first'] }],
            'raw.name': 'x'
          }
        }
      ],
      runtime: EMPTY_RUNTIME
    },
    {
      type: 'message_update',
      location: { tempId: TEMP_ID },
      increments: {
        'summary.timeline.events': ['next'],
        'summary.field\\.with\\.dot': 'b',
        'detail.sections.0.logs': ['second'],
        'detail.raw\\.name': 'y'
      }
    }
  )

  assert.deepEqual(state.temporaryMessages[0]?.summary, {
    text: '',
    timeline: { events: ['start', 'next'] },
    'field.with.dot': 'ab'
  })
  assert.deepEqual(state.temporaryMessages[0]?.detail, {
    sections: [{ logs: ['first', 'second'] }],
    'raw.name': 'xy'
  })
})

test('公共协议拒绝内部字段、非法/冲突增量和重复 workId 订阅', () => {
  assert.equal(
    L2ChatSourceEventSchema.safeParse({
      type: 'message_update',
      location: { tempId: TEMP_ID },
      contentIndex: 0,
      increments: { 'summary.text': '你好' }
    }).success,
    false
  )
  assert.equal(
    L2ChatSourceEventSchema.safeParse({
      type: 'message_update',
      location: { tempId: TEMP_ID },
      increments: { 'detail.output': 'internal' }
    }).success,
    true
  )
  assert.equal(
    L2ChatSourceEventSchema.safeParse({
      type: 'message_update',
      location: { tempId: TEMP_ID },
      increments: { 'metadata.output': 'invalid-root' }
    }).success,
    false
  )
  assert.equal(
    L2ChatSourceEventSchema.safeParse({
      type: 'message_update',
      location: { tempId: TEMP_ID },
      increments: {
        'detail.sections': ['parent'],
        'detail.sections.0': ['child']
      }
    }).success,
    false
  )
  assert.equal(
    L2ChatSourceEventSchema.safeParse({
      type: 'message_commit',
      location: { tempId: TEMP_ID },
      durable: { index: 0, entryId: 'entry-0', timestampMs: TIMESTAMP_MS }
    }).success,
    false
  )
  assert.equal(
    L2ChatSourceEventSchema.safeParse({
      type: 'message_commit',
      location: { tempId: TEMP_ID },
      durable: { index: 0, entryId: 'entry-0' },
      fixed: { timestampMs: TIMESTAMP_MS }
    }).success,
    true
  )
  assert.equal(
    L2ChatSendRequestSchema.safeParse({
      source: SOURCE,
      mode: 'auto',
      text: '   ',
      images: []
    }).success,
    false
  )
  assert.equal(
    L2ChatSubscribeRequestSchema.safeParse({
      subscriptions: [
        { source: SOURCE, cursor: null },
        { source: { ...SOURCE, sessionId: 'other-session' }, cursor: null }
      ]
    }).success,
    false
  )
})
