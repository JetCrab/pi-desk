import assert from 'node:assert/strict'
import test from 'node:test'
import { buildL3ConversationTurns } from '../src/client/l3_modules/conversation/l3-conversation-display'
import type { L3ConversationDurableMessageSnapshot } from '../src/common/l3_modules/conversation/l3-conversation-contract'

function assistant(
  index: number,
  cost: number,
  text: string
): L3ConversationDurableMessageSnapshot {
  return {
    location: { index, entryId: `assistant-${index}` },
    fixed: {
      type: 'assistant',
      viewKey: 'pi-desk/assistant',
      status: 'completed',
      timestampMs: index + 1,
      hasDetail: true,
      usage: { inputTokens: index + 1, outputTokens: 2, cacheReadTokens: 0, costUsd: cost }
    },
    summary: { text, errorMessage: null, model: { provider: 'fixture', modelId: `model-${index}` } }
  }
}
function user(index: number): L3ConversationDurableMessageSnapshot {
  return {
    location: { index, entryId: `user-${index}` },
    fixed: { type: 'user', viewKey: 'pi-desk/user', timestampMs: index + 1, hasDetail: false },
    summary: { text: 'continue', images: [] }
  }
}

test('各文字回复只带上次展示之后的调用，常驻用量保持当前回复值', () => {
  const messages = [
    assistant(0, 0.001, 'first'),
    assistant(1, 0.0062, ''),
    assistant(2, 0.0048, ''),
    assistant(3, 0.0072, 'next'),
    assistant(4, 0.002, ''),
    assistant(5, 0.003, 'final')
  ]
  const [turn] = buildL3ConversationTurns({ messages, temporaryMessages: [] })
  assert.ok(turn)
  const first = turn.processItems.find((item) => item.message.position === 0)!.message
  const next = turn.processItems.find((item) => item.message.position === 3)!.message
  assert.deepEqual(
    first.usageCalls?.map((message) => message.durable?.location.entryId),
    ['assistant-0']
  )
  assert.deepEqual(
    next.usageCalls?.map((message) => message.durable?.location.entryId),
    ['assistant-1', 'assistant-2', 'assistant-3']
  )
  assert.deepEqual(
    turn.finalAssistant?.usageCalls?.map((message) => message.durable?.location.entryId),
    ['assistant-4', 'assistant-5']
  )
  assert.equal(next.summary.type === 'assistant' && next.summary.usage.costUsd, 0.0072)
  assert.equal(
    turn.finalAssistant?.summary.type === 'assistant' && turn.finalAssistant.summary.usage.costUsd,
    0.003
  )
})

test('调用区间依据消息顺序而非用户轮次，去重且排除 Temporary', () => {
  const hidden = assistant(1, 0, '')
  const state = {
    messages: [assistant(0, 0, 'previous'), hidden, hidden, user(2), assistant(3, 0.01, 'current')],
    temporaryMessages: [
      {
        location: { tempId: 'streaming' },
        fixed: {
          type: 'assistant' as const,
          viewKey: 'pi-desk/assistant',
          timestampMs: null,
          status: 'running' as const,
          hasDetail: false,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }
        },
        summary: { text: 'streaming' }
      }
    ]
  }
  const turns = buildL3ConversationTurns(state)
  const current = turns[1]!.processItems.find((item) => item.message.position === 3)!.message
  assert.deepEqual(
    current.usageCalls?.map((message) => message.durable?.location.entryId),
    ['assistant-1', 'assistant-3']
  )
  assert.equal(turns[1]!.finalAssistant?.usageCalls, undefined)
})

test('历史首段缺失保持标记，后续展示区间完整且追加消息不改旧范围', () => {
  const state = {
    messages: [assistant(8, 0.01, ''), assistant(9, 0.02, 'loaded'), assistant(10, 0.03, 'next')],
    temporaryMessages: []
  }
  const [before] = buildL3ConversationTurns(state)
  const loaded = before!.processItems.find((item) => item.message.position === 9)!.message
  assert.equal(loaded.usageIncomplete, true)
  assert.equal(before!.finalAssistant?.usageIncomplete, false)
  const [after] = buildL3ConversationTurns({
    ...state,
    messages: [...state.messages, assistant(11, 0.04, 'new')]
  })
  const previous = after!.processItems.find((item) => item.message.position === 9)!.message
  assert.deepEqual(previous.usageCalls, loaded.usageCalls)
  assert.deepEqual(
    before!.finalAssistant?.usageCalls?.map((message) => message.position),
    [10]
  )
})

test('压缩边界不把上一段未展示调用归到后续回复', () => {
  const compact: L3ConversationDurableMessageSnapshot = {
    location: { index: 1, entryId: 'compact' },
    fixed: { type: 'custom', viewKey: 'pi-desk/compaction', timestampMs: 2, hasDetail: false },
    summary: {}
  }
  const turns = buildL3ConversationTurns({
    messages: [assistant(0, 0.1, ''), compact, assistant(2, 0.02, 'after compaction')],
    temporaryMessages: []
  })
  assert.deepEqual(
    turns.at(-1)?.finalAssistant?.usageCalls?.map((message) => message.position),
    [2]
  )
})
