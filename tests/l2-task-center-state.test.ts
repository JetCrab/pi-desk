import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L2TaskCenterPluginStateSchema,
  L2TaskDetailSnapshotSchema,
  L2TaskSummarySchema
} from '../src/common/l2_biz/task-center/l2-task-center-contract'
import { L2TaskCenterSocketContracts } from '../src/common/l2_biz/task-center/l2-task-center-websocket-contract'
import { applyL2TaskDetailEvent } from '../src/common/l2_biz/task-center/l2-task-center-state'

const TEMP_ID = '11111111-1111-4111-8111-111111111111'
const TIMESTAMP_MS = 1_765_800_000_000
const USAGE = {
  inputTokens: 10,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0
}

function assistantTemporary(text = '') {
  return {
    location: { tempId: TEMP_ID },
    fixed: {
      timestampMs: null,
      type: 'assistant' as const,
      viewKey: 'pi-desk/assistant',
      status: 'running' as const,
      hasDetail: false,
      usage: USAGE
    },
    summary: { text, errorMessage: null }
  }
}

test('Task Summary 固定状态与 endedAt 约束', () => {
  assert.equal(
    L2TaskSummarySchema.safeParse({
      taskId: 'task-1',
      taskKind: '子代理',
      taskType: 'explore',
      title: '执行任务',
      info: [{ label: '运行信息', value: 'test/model · 100/1000 tokens' }],
      status: 'running',
      activity: null,
      startedAt: TIMESTAMP_MS,
      endedAt: null
    }).success,
    true
  )
  assert.equal(
    L2TaskSummarySchema.safeParse({
      taskId: 'task-1',
      taskKind: null,
      taskType: null,
      title: '执行任务',
      info: [],
      status: 'completed',
      activity: '完成',
      startedAt: TIMESTAMP_MS,
      endedAt: null
    }).success,
    false
  )
  assert.equal(
    L2TaskCenterPluginStateSchema.safeParse({
      tasks: [
        {
          taskId: 'same',
          taskKind: null,
          taskType: null,
          title: 'A',
          info: [],
          status: 'running',
          activity: null,
          startedAt: TIMESTAMP_MS,
          endedAt: null
        },
        {
          taskId: 'same',
          taskKind: null,
          taskType: null,
          title: 'B',
          info: [],
          status: 'failed',
          activity: null,
          startedAt: TIMESTAMP_MS,
          endedAt: TIMESTAMP_MS + 1
        }
      ]
    }).success,
    false
  )
})

test('文本详情按 append 更新，Snapshot 保持有界标记', () => {
  const current = L2TaskDetailSnapshotSchema.parse({
    taskId: 'task-1',
    canInterrupt: true,
    body: { kind: 'text', text: '第一行', truncated: true }
  })
  const next = applyL2TaskDetailEvent(current, {
    type: 'text_append',
    text: '\n第二行'
  })
  assert.deepEqual(next?.body, {
    kind: 'text',
    text: '第一行\n第二行',
    truncated: true
  })
})

test('Conversation 支持 start、update、commit 和 durable_append', () => {
  let current = L2TaskDetailSnapshotSchema.parse({
    taskId: 'task-1',
    canInterrupt: true,
    body: { kind: 'conversation', messages: [], temporaryMessages: [], truncated: false }
  })
  current = applyL2TaskDetailEvent(current, {
    type: 'conversation_event',
    event: { type: 'message_start', snapshot: assistantTemporary() }
  })!
  current = applyL2TaskDetailEvent(current, {
    type: 'conversation_event',
    event: {
      type: 'message_update',
      location: { tempId: TEMP_ID },
      increments: { 'summary.text': '完成' }
    }
  })!
  current = applyL2TaskDetailEvent(current, {
    type: 'conversation_event',
    event: {
      type: 'message_commit',
      location: { tempId: TEMP_ID },
      durable: { index: 0, entryId: 'entry-0' },
      fixed: { timestampMs: TIMESTAMP_MS }
    }
  })!
  current = applyL2TaskDetailEvent(current, {
    type: 'conversation_event',
    event: {
      type: 'durable_append',
      messages: [
        {
          location: { index: 1, entryId: 'entry-1' },
          fixed: {
            timestampMs: TIMESTAMP_MS + 1,
            type: 'user',
            viewKey: 'pi-desk/user',
            hasDetail: false
          },
          summary: { text: '继续', images: [] }
        }
      ]
    }
  })!

  assert.equal(current.body?.kind, 'conversation')
  assert.deepEqual(
    current.body?.kind === 'conversation'
      ? current.body.messages.map((message) => message.location.entryId)
      : [],
    ['entry-0', 'entry-1']
  )
  assert.deepEqual(current.body?.kind === 'conversation' ? current.body.temporaryMessages : [], [])
})

test('Conversation 流式更新保留 Durable 历史引用', () => {
  const current = L2TaskDetailSnapshotSchema.parse({
    taskId: 'task-1',
    canInterrupt: true,
    body: {
      kind: 'conversation',
      messages: [
        {
          location: { index: 0, entryId: 'entry-history' },
          fixed: {
            timestampMs: TIMESTAMP_MS,
            type: 'user',
            viewKey: 'pi-desk/user',
            hasDetail: false
          },
          summary: { text: '历史消息', images: [] }
        }
      ],
      temporaryMessages: [assistantTemporary()],
      truncated: false
    }
  })
  if (current.body?.kind !== 'conversation') throw new Error('Expected conversation body')

  const messages = current.body.messages
  const durable = messages[0]
  const next = applyL2TaskDetailEvent(current, {
    type: 'conversation_event',
    event: {
      type: 'message_update',
      location: { tempId: TEMP_ID },
      increments: { 'summary.text': '继续输出' }
    }
  })
  if (next?.body?.kind !== 'conversation') throw new Error('Expected conversation body')

  assert.strictEqual(next.body.messages, messages)
  assert.strictEqual(next.body.messages[0], durable)
  assert.deepEqual(next.body.temporaryMessages[0]?.summary, {
    text: '继续输出',
    errorMessage: null
  })
})

test('Conversation Snapshot 刷新保留相同 Durable 的已加载详情', () => {
  const current = L2TaskDetailSnapshotSchema.parse({
    taskId: 'task-1',
    canInterrupt: true,
    body: {
      kind: 'conversation',
      messages: [
        {
          location: { index: 0, entryId: 'entry-assistant' },
          fixed: {
            timestampMs: TIMESTAMP_MS,
            type: 'assistant',
            viewKey: 'pi-desk/assistant',
            status: 'completed',
            hasDetail: true,
            usage: USAGE
          },
          summary: { text: '完成', errorMessage: null },
          detail: { thinking: '已加载思考过程' }
        }
      ],
      temporaryMessages: [],
      truncated: false
    }
  })
  const next = applyL2TaskDetailEvent(current, {
    type: 'snapshot',
    snapshot: L2TaskDetailSnapshotSchema.parse({
      taskId: 'task-1',
      canInterrupt: false,
      body: {
        kind: 'conversation',
        messages: [
          {
            location: { index: 0, entryId: 'entry-assistant' },
            fixed: {
              timestampMs: TIMESTAMP_MS,
              type: 'assistant',
              viewKey: 'pi-desk/assistant',
              status: 'completed',
              hasDetail: true,
              usage: USAGE
            },
            summary: { text: '完成', errorMessage: null }
          }
        ],
        temporaryMessages: [],
        truncated: false
      }
    })
  })

  assert.equal(next?.canInterrupt, false)
  assert.deepEqual(next?.body?.kind === 'conversation' ? next.body.messages[0]?.detail : null, {
    thinking: '已加载思考过程'
  })
})

test('Task Center WebSocket 只冻结三个逻辑 path', () => {
  assert.deepEqual(
    Object.values(L2TaskCenterSocketContracts).map((contract) => contract.path),
    ['task-center/detail-watch', 'task-center/interrupt', 'task-center/detail-event']
  )
})
