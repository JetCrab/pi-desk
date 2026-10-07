import assert from 'node:assert/strict'
import test from 'node:test'
import { buildL3ConversationMessageUpdate } from '../src/common/l3_modules/conversation/l3-conversation-diff'
import {
  projectL3ConversationDurableMessageCore,
  projectL3ConversationTemporaryMessageCore,
  type L3ConversationProjectionDeclaration
} from '../src/server/l3_modules/conversation/l3-conversation-projection-core'
import type { L4PiChatMessage } from '../src/server/l4_foundation/pi/l4-pi-chat-projection'

const TEMP_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE = { workId: 'work-1', sessionId: 'session-1', branchId: 'v1:main' }
const USAGE = {
  inputTokens: 10,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0
}

function projectL3ConversationTemporaryMessage(
  tempId: string,
  message: L4PiChatMessage,
  source: typeof SOURCE
) {
  return projectL3ConversationTemporaryMessageCore(tempId, message, source, [])
}

function projectL3ConversationDurableMessage(
  index: number,
  entryId: string,
  timestampMs: number,
  message: L4PiChatMessage,
  source: typeof SOURCE
) {
  return projectL3ConversationDurableMessageCore(index, entryId, timestampMs, message, source, [])
}

function assistant(thinking: string, text = '') {
  return projectL3ConversationTemporaryMessage(
    TEMP_ID,
    {
      type: 'assistant',
      text,
      thinking,
      status: 'running',
      errorMessage: null,
      usage: USAGE
    },
    SOURCE
  )
}

test('空 Assistant Snapshot 不保存空 Detail', () => {
  const snapshot = assistant('')

  assert.deepEqual(snapshot.location, { tempId: TEMP_ID })
  assert.equal(snapshot.fixed.timestampMs, null)
  assert.equal(snapshot.fixed.viewKey, 'pi-desk/assistant')
  assert.equal(snapshot.fixed.hasDetail, false)
  assert.deepEqual(snapshot.summary, { text: '', errorMessage: null })
  assert.equal(snapshot.detail, undefined)
})

test('Assistant 错误进入 Summary 且不创建 Detail', () => {
  const snapshot = projectL3ConversationTemporaryMessage(
    TEMP_ID,
    {
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'error',
      errorMessage: 'terminated',
      usage: USAGE
    },
    SOURCE
  )

  assert.equal(snapshot.fixed.hasDetail, false)
  assert.deepEqual(snapshot.summary, { text: '', errorMessage: 'terminated' })
  assert.equal(snapshot.detail, undefined)
})

test('撤销 Assistant Detail 时只发送 hasDetail Patch', () => {
  const previous = assistant('分析')
  const next = assistant('')

  assert.deepEqual(buildL3ConversationMessageUpdate(previous, next), {
    type: 'message_update',
    location: { tempId: TEMP_ID },
    fixed: { hasDetail: false }
  })
})

test('Read content 只进入 Durable Detail，内容增长不产生公共 Update', () => {
  const firstMessage = {
    type: 'tool' as const,
    name: 'read',
    reasoning: '读取实现',
    inputPreview: 'src/chat.ts',
    activity: '1-200',
    status: 'completed' as const,
    usage: null,
    output: '第一段'
  }
  const first = projectL3ConversationTemporaryMessage(TEMP_ID, firstMessage, SOURCE)
  const next = projectL3ConversationTemporaryMessage(
    TEMP_ID,
    { ...firstMessage, output: '第一段\n第二段' },
    SOURCE
  )
  const durable = projectL3ConversationDurableMessage(
    0,
    'entry-0',
    1_765_800_000_000,
    firstMessage,
    SOURCE
  )

  assert.equal(first.fixed.hasDetail, true)
  assert.equal(first.fixed.viewKey, 'pi-desk/read')
  assert.equal(first.detail, undefined)
  assert.deepEqual(durable.location, { index: 0, entryId: 'entry-0' })
  assert.equal(durable.fixed.timestampMs, 1_765_800_000_000)
  assert.deepEqual(durable.detail, { content: '第一段' })
  assert.equal(buildL3ConversationMessageUpdate(first, next), null)
})

test('压缩运行中只发布空 Summary，完成后仅开放 Durable Detail', () => {
  const running = projectL3ConversationTemporaryMessage(
    TEMP_ID,
    { type: 'compaction', summary: '' },
    SOURCE
  )
  const completed = projectL3ConversationTemporaryMessageCore(
    TEMP_ID,
    { type: 'compaction', summary: '## Goal\n\n继续当前工作。' },
    SOURCE,
    [],
    false,
    'final'
  )
  const durable = projectL3ConversationDurableMessage(
    0,
    'entry-compaction',
    1_765_800_000_000,
    { type: 'compaction', summary: '## Goal\n\n继续当前工作。' },
    SOURCE
  )

  assert.equal(running.fixed.type, 'custom')
  assert.equal(running.fixed.viewKey, 'pi-desk/compaction')
  assert.equal(running.fixed.hasDetail, false)
  assert.deepEqual(running.summary, {})
  assert.equal(running.detail, undefined)
  assert.equal(completed.fixed.hasDetail, true)
  assert.deepEqual(completed.summary, {})
  assert.equal(completed.detail, undefined)
  assert.deepEqual(buildL3ConversationMessageUpdate(running, completed), {
    type: 'message_update',
    location: { tempId: TEMP_ID },
    fixed: { hasDetail: true }
  })
  assert.deepEqual(durable.summary, {})
  assert.deepEqual(durable.detail, { text: '## Goal\n\n继续当前工作。' })
})

test('Custom Detail仅在Durable投影开放，Temporary不预发', () => {
  const declaration: L3ConversationProjectionDeclaration = {
    pluginName: 'fixture',
    declarationName: 'custom',
    declaration: {
      priority: 100,
      match: ({ message }) => message.kind === 'custom' && message.customType === 'fixture/custom',
      project: ({ message, stage }) => {
        if (message.kind !== 'custom') throw new Error('expected custom message')
        return {
          viewKey: 'fixture/custom',
          summary: { text: message.content },
          detail: { output: `canonical:${stage}:${'x'.repeat(1200)}` }
        }
      }
    }
  }
  const customMessage = (text: string): L4PiChatMessage => ({
    type: 'custom',
    text,
    declaration: {
      message: { kind: 'custom', customType: 'fixture/custom', content: text, details: null },
      raw: {}
    }
  })
  const temporary = projectL3ConversationTemporaryMessageCore(
    TEMP_ID,
    customMessage('draft'),
    SOURCE,
    [declaration]
  )
  const updated = projectL3ConversationTemporaryMessageCore(
    TEMP_ID,
    customMessage('draft updated'),
    SOURCE,
    [declaration],
    false,
    'update'
  )
  const update = buildL3ConversationMessageUpdate(temporary, updated)
  const durable = projectL3ConversationDurableMessageCore(
    0,
    'entry-custom',
    1_765_800_000_000,
    customMessage('history'),
    SOURCE,
    [declaration]
  )

  assert.equal(temporary.fixed.viewKey, 'fixture/custom')
  assert.equal(temporary.fixed.hasDetail, true)
  assert.equal(temporary.detail, undefined)
  assert.ok(update)
  assert.equal('detail' in update, false)
  assert.equal(JSON.stringify(update).includes('canonical:'), false)
  assert.equal(durable.fixed.hasDetail, true)
  assert.deepEqual(durable.detail, {
    output: `canonical:durable:${'x'.repeat(1200)}`
  })
})

test('Temporary Snapshot保留Assistant thinking并隐藏工具输出', () => {
  const thinking = assistant('private thinking')
  const tool = projectL3ConversationTemporaryMessage(
    TEMP_ID,
    {
      type: 'tool',
      name: 'exec',
      reasoning: null,
      inputPreview: 'command',
      activity: null,
      status: 'completed',
      usage: null,
      output: 'private tool output'
    },
    SOURCE
  )
  const bash = projectL3ConversationTemporaryMessage(
    TEMP_ID,
    { type: 'bash', command: 'echo private', status: 'completed', output: 'private bash output' },
    SOURCE
  )

  assert.deepEqual(thinking.detail, { thinking: 'private thinking' })
  assert.equal(tool.fixed.hasDetail, true)
  assert.equal(tool.detail, undefined)
  assert.equal(bash.fixed.hasDetail, true)
  assert.equal(bash.detail, undefined)
})

test('首次 thinking 使用 Detail replacement，已有字符串使用 increment', () => {
  const previous = assistant('')
  const firstThinking = assistant('分析', '回答')
  const nextThinking = assistant('分析继续', '回答完成')

  assert.deepEqual(buildL3ConversationMessageUpdate(previous, firstThinking), {
    type: 'message_update',
    location: { tempId: TEMP_ID },
    fixed: { hasDetail: true },
    detail: { thinking: '分析' },
    increments: { 'summary.text': '回答' }
  })
  assert.deepEqual(buildL3ConversationMessageUpdate(firstThinking, nextThinking), {
    type: 'message_update',
    location: { tempId: TEMP_ID },
    increments: {
      'summary.text': '完成',
      'detail.thinking': '继续'
    }
  })
})
