import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import 'fake-indexeddb/auto'
import type {
  L2ChatDurableMessageSnapshot,
  L2ChatSource
} from '../src/common/l2_biz/chat/l2-chat-contract'
import { createL2WorkbenchChatInputRepository } from '../src/client/l2_biz/workbench/l2-workbench-chat-input-repository'
import { createL2WorkbenchChatRepository } from '../src/client/l2_biz/workbench/l2-workbench-chat-repository'
import {
  L4_CHAT_DRAFT_STORE,
  L4_CHAT_MESSAGE_SOURCE_INDEX,
  L4_CHAT_MESSAGE_STORE,
  L4_CHAT_OUTBOX_STORE,
  openL4ChatDatabase,
  readL4IdbRequest,
  waitForL4IdbTransaction
} from '../src/client/l4_foundation/storage/l4-chat-indexed-db'

Object.defineProperty(globalThis, 'window', {
  value: globalThis,
  configurable: true
})

const TIMESTAMP_MS = 1_765_800_000_000
const INDEXED_DB_V2_RECORD = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/chat-indexeddb-v2-record.json', import.meta.url)),
    'utf8'
  )
) as {
  sessionId: string
  branchId: string
  index: number
  entryId: string
  fixed: L2ChatDurableMessageSnapshot['fixed']
  summary: L2ChatDurableMessageSnapshot['summary']
  detail?: L2ChatDurableMessageSnapshot['detail']
}
const USAGE = {
  inputTokens: 1_200,
  outputTokens: 345,
  cacheReadTokens: 6_000,
  costUsd: 0.0042
}

function source(sessionId: string): L2ChatSource {
  return {
    workId: '33333333-3333-4333-8333-333333333333',
    sessionId,
    branchId: 'v1:main'
  }
}

function assistantMessage(entryId: string): L2ChatDurableMessageSnapshot {
  return {
    location: { index: 0, entryId },
    fixed: {
      timestampMs: TIMESTAMP_MS,
      type: 'assistant',
      viewKey: 'pi-desk/assistant',
      status: 'completed',
      hasDetail: true,
      usage: USAGE
    },
    summary: { text: '多标签页共享消息', errorMessage: null }
  }
}

async function putRawMessageRecord(record: unknown): Promise<void> {
  const database = await openL4ChatDatabase()
  const transaction = database.transaction(L4_CHAT_MESSAGE_STORE, 'readwrite')
  const done = waitForL4IdbTransaction(transaction)
  transaction.objectStore(L4_CHAT_MESSAGE_STORE).put(record)
  await done
}

test('IndexedDB v2 固定消息、草稿和 Outbox Schema', async () => {
  const database = await openL4ChatDatabase()
  assert.equal(database.name, 'pi-super-chat')
  assert.equal(database.version, 2)
  assert.deepEqual(Array.from(database.objectStoreNames).sort(), [
    L4_CHAT_DRAFT_STORE,
    L4_CHAT_MESSAGE_STORE,
    L4_CHAT_OUTBOX_STORE
  ])

  const transaction = database.transaction(
    [L4_CHAT_MESSAGE_STORE, L4_CHAT_DRAFT_STORE, L4_CHAT_OUTBOX_STORE],
    'readonly'
  )
  const messageStore = transaction.objectStore(L4_CHAT_MESSAGE_STORE)
  assert.deepEqual(messageStore.keyPath, ['sessionId', 'branchId', 'index'])
  assert.deepEqual(Array.from(messageStore.indexNames), [L4_CHAT_MESSAGE_SOURCE_INDEX])
  const sourceIndex = messageStore.index(L4_CHAT_MESSAGE_SOURCE_INDEX)
  assert.deepEqual(sourceIndex.keyPath, ['sessionId', 'branchId'])
  assert.equal(sourceIndex.unique, false)
  assert.deepEqual(transaction.objectStore(L4_CHAT_DRAFT_STORE).keyPath, ['sessionId', 'branchId'])
  assert.deepEqual(transaction.objectStore(L4_CHAT_OUTBOX_STORE).keyPath, ['sessionId', 'branchId'])
})

test('高版本 IndexedDB 自动清空全部本地聊天数据并按 v2 重建', async () => {
  const chatSource = source('99999999-9999-4999-8999-999999999999')
  const messages = createL2WorkbenchChatRepository()
  const inputs = createL2WorkbenchChatInputRepository()
  const previousWarn = console.warn

  await messages.appendMessage(chatSource, assistantMessage('entry-before-downgrade'))
  await inputs.moveDraftToOutbox(chatSource, { text: '待发送内容', images: [] })
  await inputs.writeDraft(chatSource, { text: '草稿内容', images: [] })

  try {
    console.warn = () => undefined
    const upgradedDatabase = await readL4IdbRequest(indexedDB.open('pi-super-chat', 3))
    upgradedDatabase.close()

    const database = await openL4ChatDatabase()
    assert.equal(database.version, 2)

    const transaction = database.transaction(
      [L4_CHAT_MESSAGE_STORE, L4_CHAT_DRAFT_STORE, L4_CHAT_OUTBOX_STORE],
      'readonly'
    )
    const done = waitForL4IdbTransaction(transaction)
    const [messageCount, draftCount, outboxCount] = await Promise.all([
      readL4IdbRequest(transaction.objectStore(L4_CHAT_MESSAGE_STORE).count()),
      readL4IdbRequest(transaction.objectStore(L4_CHAT_DRAFT_STORE).count()),
      readL4IdbRequest(transaction.objectStore(L4_CHAT_OUTBOX_STORE).count())
    ])
    await done

    assert.deepEqual([messageCount, draftCount, outboxCount], [0, 0, 0])
  } finally {
    console.warn = previousWarn
  }
})

test('M0 IndexedDB v2 旧记录缺少 viewKey 时按 Source 清理重建', async () => {
  const chatSource = source(INDEXED_DB_V2_RECORD.sessionId)
  const repository = createL2WorkbenchChatRepository()
  const previousWarn = console.warn

  await repository.clearSource(chatSource)
  try {
    await putRawMessageRecord(INDEXED_DB_V2_RECORD)
    console.warn = () => undefined
    assert.equal(await repository.readLatestCursor(chatSource), null)
    assert.deepEqual(await repository.readMessages(chatSource), [])
  } finally {
    console.warn = previousWarn
    await repository.clearSource(chatSource)
  }
})

test('旧 Assistant 错误 Detail 缓存按 Source 清理并回退全量同步', async () => {
  const chatSource = source('44444444-4444-4444-8444-444444444444')
  const repository = createL2WorkbenchChatRepository()
  const message = assistantMessage('entry-old-assistant-projection')
  const previousWarn = console.warn

  await repository.clearSource(chatSource)
  try {
    await putRawMessageRecord({
      sessionId: chatSource.sessionId,
      branchId: chatSource.branchId,
      index: message.location.index,
      entryId: message.location.entryId,
      fixed: { ...message.fixed, status: 'error', hasDetail: true },
      summary: { text: '' },
      detail: { thinking: '', errorMessage: 'terminated' }
    })
    console.warn = () => undefined

    assert.equal(await repository.readLatestCursor(chatSource), null)
    assert.deepEqual(await repository.readMessages(chatSource), [])
  } finally {
    console.warn = previousWarn
    await repository.clearSource(chatSource)
  }
})

test('无效消息记录只清理目标 Source 并回退全量同步', async () => {
  const invalidSource = source('77777777-7777-4777-8777-777777777777')
  const validSource = source('88888888-8888-4888-8888-888888888888')
  const repository = createL2WorkbenchChatRepository()
  const validMessage = assistantMessage('entry-valid-neighbor')
  const previousWarn = console.warn

  await Promise.all([repository.clearSource(invalidSource), repository.clearSource(validSource)])
  try {
    await repository.appendMessage(validSource, validMessage)
    await putRawMessageRecord({
      ...INDEXED_DB_V2_RECORD,
      sessionId: invalidSource.sessionId,
      unsupportedField: true
    })
    console.warn = () => undefined

    assert.equal(await repository.readLatestCursor(invalidSource), null)
    assert.deepEqual(await repository.readMessages(invalidSource), [])
    assert.deepEqual(await repository.readMessages(validSource), [validMessage])
  } finally {
    console.warn = previousWarn
    await Promise.all([repository.clearSource(invalidSource), repository.clearSource(validSource)])
  }
})

test('消息和输入 clearSource 只清理目标 Source', async () => {
  const firstSource = source('55555555-5555-4555-8555-555555555555')
  const secondSource = source('66666666-6666-4666-8666-666666666666')
  const messages = createL2WorkbenchChatRepository()
  const inputs = createL2WorkbenchChatInputRepository()
  const firstMessage = assistantMessage('entry-clear-first')
  const secondMessage = assistantMessage('entry-clear-second')

  await Promise.all([
    messages.clearSource(firstSource),
    messages.clearSource(secondSource),
    inputs.clearSource(firstSource),
    inputs.clearSource(secondSource)
  ])
  try {
    await messages.appendMessage(firstSource, firstMessage)
    await messages.appendMessage(secondSource, secondMessage)
    await inputs.moveDraftToOutbox(firstSource, { text: '第一条待确认', images: [] })
    await inputs.writeDraft(firstSource, { text: '第一条草稿', images: [] })
    await inputs.moveDraftToOutbox(secondSource, { text: '第二条待确认', images: [] })
    await inputs.writeDraft(secondSource, { text: '第二条草稿', images: [] })

    await Promise.all([messages.clearSource(firstSource), inputs.clearSource(firstSource)])

    assert.deepEqual(await messages.readMessages(firstSource), [])
    assert.deepEqual(await messages.readMessages(secondSource), [secondMessage])
    assert.deepEqual(await inputs.recoverOutbox(firstSource), {
      input: { text: '', images: [] },
      recovered: false
    })
    assert.deepEqual(await inputs.recoverOutbox(secondSource), {
      input: { text: '第二条待确认\n\n第二条草稿', images: [] },
      recovered: true
    })
  } finally {
    await Promise.all([
      messages.clearSource(firstSource),
      messages.clearSource(secondSource),
      inputs.clearSource(firstSource),
      inputs.clearSource(secondSource)
    ])
  }
})

test('两个 Repository 并发追加同一 durable 消息时幂等', async () => {
  const chatSource = source('11111111-1111-4111-8111-111111111111')
  const first = createL2WorkbenchChatRepository()
  const second = createL2WorkbenchChatRepository()
  const message = assistantMessage('entry-shared')

  await first.clearSource(chatSource)
  try {
    await Promise.all([
      first.appendMessage(chatSource, message),
      second.appendMessage(chatSource, message)
    ])

    assert.deepEqual(await first.readMessages(chatSource), [message])

    await first.saveDetail(chatSource, 0, message.location.entryId, {
      thinking: '已加载的本地详情'
    })
    await second.appendMessage(chatSource, message)

    assert.deepEqual((await first.readMessages(chatSource))[0]?.detail, {
      thinking: '已加载的本地详情'
    })
  } finally {
    await first.clearSource(chatSource)
  }
})

test('相同 durable index 出现不同 entryId 时清理 Source 缓存', async () => {
  const chatSource = source('22222222-2222-4222-8222-222222222222')
  const first = createL2WorkbenchChatRepository()
  const second = createL2WorkbenchChatRepository()

  await first.clearSource(chatSource)
  try {
    await first.appendMessage(chatSource, assistantMessage('entry-first'))

    await assert.rejects(
      () => second.appendMessage(chatSource, assistantMessage('entry-conflict')),
      /IndexedDB 消息身份冲突：0\/entry-conflict\/entry-first/
    )
    assert.deepEqual(await first.readMessages(chatSource), [])
  } finally {
    await first.clearSource(chatSource)
  }
})
