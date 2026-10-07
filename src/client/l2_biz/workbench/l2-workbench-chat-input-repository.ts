'use client'

import { L2ChatSourceSchema, type L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import {
  L4_CHAT_DRAFT_STORE,
  L4_CHAT_OUTBOX_STORE,
  openL4ChatDatabase,
  readL4IdbRequest,
  waitForL4IdbTransaction
} from '@client/l4_foundation/storage/l4-chat-indexed-db'
import { l2WorkbenchText } from './l2-workbench-text'

export interface L2WorkbenchStoredImage {
  blob: Blob
  mimeType: string
  width: number
  height: number
  optimized: boolean
}

export interface L2WorkbenchStoredInput {
  text: string
  images: L2WorkbenchStoredImage[]
}

interface L2WorkbenchStoredInputRecord extends L2WorkbenchStoredInput {
  sessionId: string
  branchId: string
}

export interface L2WorkbenchChatInputRepository {
  recoverOutbox: (source: L2ChatSource) => Promise<{
    input: L2WorkbenchStoredInput
    recovered: boolean
  }>
  writeDraft: (source: L2ChatSource, input: L2WorkbenchStoredInput) => Promise<void>
  moveDraftToOutbox: (source: L2ChatSource, input: L2WorkbenchStoredInput) => Promise<void>
  clearOutbox: (source: L2ChatSource) => Promise<void>
  restoreOutboxToDraft: (source: L2ChatSource) => Promise<L2WorkbenchStoredInput>
  deleteOutbox: (source: L2ChatSource) => Promise<void>
  clearSource: (source: L2ChatSource) => Promise<void>
}

const EMPTY_INPUT: L2WorkbenchStoredInput = { text: '', images: [] }

function key(source: L2ChatSource): [string, string] {
  return [source.sessionId, source.branchId]
}

function toRecord(
  source: L2ChatSource,
  input: L2WorkbenchStoredInput
): L2WorkbenchStoredInputRecord {
  return {
    sessionId: source.sessionId,
    branchId: source.branchId,
    text: input.text,
    images: input.images
  }
}

function parseRecord(value: unknown): L2WorkbenchStoredInput | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<L2WorkbenchStoredInputRecord>
  if (typeof record.text !== 'string' || !Array.isArray(record.images)) return null

  const images: L2WorkbenchStoredImage[] = []
  for (const image of record.images) {
    if (
      !image ||
      typeof image !== 'object' ||
      !(image.blob instanceof Blob) ||
      typeof image.mimeType !== 'string' ||
      !Number.isSafeInteger(image.width) ||
      image.width! <= 0 ||
      !Number.isSafeInteger(image.height) ||
      image.height! <= 0 ||
      typeof image.optimized !== 'boolean'
    ) {
      return null
    }
    images.push({
      blob: image.blob,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      optimized: image.optimized
    })
  }
  return { text: record.text, images }
}

function mergeInputs(
  outbox: L2WorkbenchStoredInput,
  draft: L2WorkbenchStoredInput | null
): L2WorkbenchStoredInput {
  if (!draft) return outbox
  const text = [outbox.text, draft.text].filter((value) => value.trim()).join('\n\n')
  return { text, images: [...outbox.images, ...draft.images] }
}

function isEmpty(input: L2WorkbenchStoredInput): boolean {
  return !input.text && input.images.length === 0
}

export function createL2WorkbenchChatInputRepository(): L2WorkbenchChatInputRepository {
  return {
    async recoverOutbox(sourceInput) {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(
        [L4_CHAT_DRAFT_STORE, L4_CHAT_OUTBOX_STORE],
        'readwrite'
      )
      const done = waitForL4IdbTransaction(transaction)
      const draftStore = transaction.objectStore(L4_CHAT_DRAFT_STORE)
      const outboxStore = transaction.objectStore(L4_CHAT_OUTBOX_STORE)
      const sourceKey = key(source)
      const [draftValue, outboxValue] = await Promise.all([
        readL4IdbRequest(draftStore.get(sourceKey)),
        readL4IdbRequest(outboxStore.get(sourceKey))
      ])
      const draft = parseRecord(draftValue)
      const outbox = parseRecord(outboxValue)
      if (!outbox) {
        await done
        return { input: draft ?? EMPTY_INPUT, recovered: false }
      }

      const input = mergeInputs(outbox, draft)
      draftStore.put(toRecord(source, input))
      outboxStore.delete(sourceKey)
      await done
      return { input, recovered: true }
    },

    async writeDraft(sourceInput, input) {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(L4_CHAT_DRAFT_STORE, 'readwrite')
      const done = waitForL4IdbTransaction(transaction)
      const store = transaction.objectStore(L4_CHAT_DRAFT_STORE)
      if (isEmpty(input)) store.delete(key(source))
      else store.put(toRecord(source, input))
      await done
    },

    async moveDraftToOutbox(sourceInput, input) {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(
        [L4_CHAT_DRAFT_STORE, L4_CHAT_OUTBOX_STORE],
        'readwrite'
      )
      const done = waitForL4IdbTransaction(transaction)
      transaction.objectStore(L4_CHAT_OUTBOX_STORE).put(toRecord(source, input))
      transaction.objectStore(L4_CHAT_DRAFT_STORE).delete(key(source))
      await done
    },

    async clearOutbox(sourceInput) {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(L4_CHAT_OUTBOX_STORE, 'readwrite')
      const done = waitForL4IdbTransaction(transaction)
      transaction.objectStore(L4_CHAT_OUTBOX_STORE).delete(key(source))
      await done
    },

    async restoreOutboxToDraft(sourceInput) {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(
        [L4_CHAT_DRAFT_STORE, L4_CHAT_OUTBOX_STORE],
        'readwrite'
      )
      const done = waitForL4IdbTransaction(transaction)
      const draftStore = transaction.objectStore(L4_CHAT_DRAFT_STORE)
      const outboxStore = transaction.objectStore(L4_CHAT_OUTBOX_STORE)
      const sourceKey = key(source)
      const [draftValue, outboxValue] = await Promise.all([
        readL4IdbRequest(draftStore.get(sourceKey)),
        readL4IdbRequest(outboxStore.get(sourceKey))
      ])
      const outbox = parseRecord(outboxValue)
      if (!outbox) {
        transaction.abort()
        await done.catch(() => undefined)
        throw new Error(l2WorkbenchText('outboxMissing'))
      }
      const input = mergeInputs(outbox, parseRecord(draftValue))
      draftStore.put(toRecord(source, input))
      outboxStore.delete(sourceKey)
      await done
      return input
    },

    async deleteOutbox(sourceInput) {
      await this.clearOutbox(sourceInput)
    },

    async clearSource(sourceInput) {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const database = await openL4ChatDatabase()
      const transaction = database.transaction(
        [L4_CHAT_DRAFT_STORE, L4_CHAT_OUTBOX_STORE],
        'readwrite'
      )
      const done = waitForL4IdbTransaction(transaction)
      transaction.objectStore(L4_CHAT_DRAFT_STORE).delete(key(source))
      transaction.objectStore(L4_CHAT_OUTBOX_STORE).delete(key(source))
      await done
    }
  }
}
