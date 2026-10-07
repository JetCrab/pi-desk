'use client'

import { z } from 'zod'
import {
  L2ChatAssistantDetailSchema,
  L2ChatAssistantSummarySchema,
  L2ChatDurableMessageFixedSchema,
  L2ChatDurableMessageSnapshotSchema,
  L2ChatMessageDetailSchema,
  L2ChatMessageSummarySchema,
  L2ChatSourceSchema,
  type L2ChatCursor,
  type L2ChatDurableMessageSnapshot,
  type L2ChatMessageDetail,
  type L2ChatSource
} from '@common/l2_biz/chat/l2-chat-contract'
import { getL2ChatLatestCursor } from '@common/l2_biz/chat/l2-chat-state'
import {
  L4_CHAT_MESSAGE_SOURCE_INDEX,
  L4_CHAT_MESSAGE_STORE,
  openL4ChatDatabase,
  readL4IdbRequest,
  waitForL4IdbTransaction
} from '@client/l4_foundation/storage/l4-chat-indexed-db'

const L2BrowserChatMessageRecordSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    branchId: z.string().trim().min(1),
    index: z.number().int().nonnegative(),
    entryId: z.string().trim().min(1),
    fixed: L2ChatDurableMessageFixedSchema,
    summary: L2ChatMessageSummarySchema,
    detail: L2ChatMessageDetailSchema.optional()
  })
  .strict()

type L2BrowserChatMessageRecord = z.infer<typeof L2BrowserChatMessageRecordSchema>

export interface L2WorkbenchChatRepository {
  readMessages: (source: L2ChatSource) => Promise<L2ChatDurableMessageSnapshot[]>
  readLatestCursor: (source: L2ChatSource) => Promise<L2ChatCursor>
  replaceMessages: (
    source: L2ChatSource,
    messages: readonly L2ChatDurableMessageSnapshot[]
  ) => Promise<void>
  appendMessage: (source: L2ChatSource, message: L2ChatDurableMessageSnapshot) => Promise<void>
  saveDetail: (
    source: L2ChatSource,
    index: number,
    entryId: string,
    detail: L2ChatMessageDetail
  ) => Promise<void>
  clearSource: (source: L2ChatSource) => Promise<void>
}

function sourceRange(source: L2ChatSource): IDBKeyRange {
  return IDBKeyRange.only([source.sessionId, source.branchId])
}

function sourceMessageRange(source: L2ChatSource): IDBKeyRange {
  return IDBKeyRange.bound(
    [source.sessionId, source.branchId, 0],
    [source.sessionId, source.branchId, Number.MAX_SAFE_INTEGER]
  )
}

function toRecord(
  source: L2ChatSource,
  message: L2ChatDurableMessageSnapshot
): L2BrowserChatMessageRecord {
  return L2BrowserChatMessageRecordSchema.parse({
    sessionId: source.sessionId,
    branchId: source.branchId,
    index: message.location.index,
    entryId: message.location.entryId,
    fixed: message.fixed,
    summary: message.summary,
    ...(message.detail === undefined ? {} : { detail: message.detail })
  })
}

function fromRecord(recordInput: unknown): L2ChatDurableMessageSnapshot {
  const record = L2BrowserChatMessageRecordSchema.parse(recordInput)
  if (record.fixed.type === 'assistant' && record.fixed.viewKey === 'pi-desk/assistant') {
    if (!Object.hasOwn(record.summary, 'errorMessage')) {
      throw new Error('Assistant Summary cache uses an outdated projection')
    }
    L2ChatAssistantSummarySchema.parse(record.summary)
    if (record.detail !== undefined) L2ChatAssistantDetailSchema.parse(record.detail)
  }
  return L2ChatDurableMessageSnapshotSchema.parse({
    location: {
      index: record.index,
      entryId: record.entryId
    },
    fixed: record.fixed,
    summary: record.summary,
    ...(record.detail === undefined ? {} : { detail: record.detail })
  })
}

function deleteSourceRecords(store: IDBObjectStore, source: L2ChatSource): void {
  store.delete(sourceMessageRange(source))
}

export function createL2WorkbenchChatRepository(): L2WorkbenchChatRepository {
  return {
    async readMessages(sourceInput): Promise<L2ChatDurableMessageSnapshot[]> {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(L4_CHAT_MESSAGE_STORE, 'readonly')
      const done = waitForL4IdbTransaction(transaction)
      const records = await readL4IdbRequest(
        transaction
          .objectStore(L4_CHAT_MESSAGE_STORE)
          .index(L4_CHAT_MESSAGE_SOURCE_INDEX)
          .getAll(sourceRange(source))
      )
      await done
      return records
        .map(fromRecord)
        .sort((left, right) => left.location.index - right.location.index)
    },

    async readLatestCursor(source): Promise<L2ChatCursor> {
      try {
        const messages = await this.readMessages(source)
        const cursor = getL2ChatLatestCursor(messages)
        if (cursor === null && messages.length > 0) await this.clearSource(source)
        return cursor
      } catch (error) {
        console.warn('[Pi Desk][WorkbenchChatRepository] 本地消息缓存无效，回退全量同步', {
          sessionId: source.sessionId,
          branchId: source.branchId,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        await this.clearSource(source)
        return null
      }
    },

    async replaceMessages(sourceInput, messagesInput): Promise<void> {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(L4_CHAT_MESSAGE_STORE, 'readwrite')
      const done = waitForL4IdbTransaction(transaction)
      const store = transaction.objectStore(L4_CHAT_MESSAGE_STORE)
      deleteSourceRecords(store, source)
      for (const message of messagesInput) store.put(toRecord(source, message))
      await done
    },

    async appendMessage(sourceInput, messageInput): Promise<void> {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const record = toRecord(source, messageInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(L4_CHAT_MESSAGE_STORE, 'readwrite')
      const done = waitForL4IdbTransaction(transaction)
      const store = transaction.objectStore(L4_CHAT_MESSAGE_STORE)
      const key = [record.sessionId, record.branchId, record.index]
      const request = store.get(key)
      let identityConflict: Error | null = null

      request.addEventListener(
        'success',
        () => {
          if (request.result === undefined) {
            store.add(record)
            return
          }

          const existing = L2BrowserChatMessageRecordSchema.safeParse(request.result)
          if (existing.success && existing.data.entryId === record.entryId) return

          const existingEntryId = existing.success ? existing.data.entryId : 'invalid-record'
          identityConflict = new Error(
            `IndexedDB 消息身份冲突：${record.index}/${record.entryId}/${existingEntryId}`
          )
          deleteSourceRecords(store, source)
        },
        { once: true }
      )

      await done
      if (identityConflict) throw identityConflict
    },

    async saveDetail(sourceInput, index, entryId, detailInput): Promise<void> {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const detail = L2ChatMessageDetailSchema.parse(detailInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(L4_CHAT_MESSAGE_STORE, 'readwrite')
      const done = waitForL4IdbTransaction(transaction)
      const store = transaction.objectStore(L4_CHAT_MESSAGE_STORE)
      const key = [source.sessionId, source.branchId, index]
      const current = await readL4IdbRequest(store.get(key))
      const record = L2BrowserChatMessageRecordSchema.parse(current)
      if (record.entryId !== entryId) {
        transaction.abort()
        await done.catch(() => undefined)
        throw new Error(`IndexedDB 消息身份不匹配：${index}/${entryId}`)
      }
      const { detail: _previousDetail, ...summaryRecord } = record
      store.put(detail === null ? summaryRecord : { ...summaryRecord, detail })
      await done
    },

    async clearSource(sourceInput): Promise<void> {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(L4_CHAT_MESSAGE_STORE, 'readwrite')
      const done = waitForL4IdbTransaction(transaction)
      deleteSourceRecords(transaction.objectStore(L4_CHAT_MESSAGE_STORE), source)
      await done
    }
  }
}
