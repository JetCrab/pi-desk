'use client'

import { L4_LOCALE_MESSAGES } from '@common/l4_foundation/locale/l4-locale-messages'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'

export const L4_CHAT_MESSAGE_STORE = 'messages'
export const L4_CHAT_MESSAGE_SOURCE_INDEX = 'source'
export const L4_CHAT_DRAFT_STORE = 'drafts'
export const L4_CHAT_OUTBOX_STORE = 'outbox'

// 数据库名是本机浏览器已有草稿与待发内容的存储身份，不随展示品牌更改。
const DATABASE_NAME = 'pi-super-chat'
const DATABASE_VERSION = 2
const DATABASE_OPEN_TIMEOUT_MS = 10_000

let databasePromise: Promise<IDBDatabase> | null = null
let openedDatabase: IDBDatabase | null = null

function storageError(key: keyof (typeof L4_LOCALE_MESSAGES)['zh-CN']['common']): Error {
  return new Error(
    l4LocalizedErrorMessage({
      msg: L4_LOCALE_MESSAGES['zh-CN'].common[key],
      i18n: { key: `common:${key}` }
    })
  )
}

function createMessageStore(database: IDBDatabase): void {
  if (database.objectStoreNames.contains(L4_CHAT_MESSAGE_STORE)) return
  const store = database.createObjectStore(L4_CHAT_MESSAGE_STORE, {
    keyPath: ['sessionId', 'branchId', 'index']
  })
  store.createIndex(L4_CHAT_MESSAGE_SOURCE_INDEX, ['sessionId', 'branchId'], { unique: false })
}

function createInputStore(database: IDBDatabase, storeName: string): void {
  if (database.objectStoreNames.contains(storeName)) return
  database.createObjectStore(storeName, { keyPath: ['sessionId', 'branchId'] })
}

function closeDatabaseOnVersionChange(database: IDBDatabase): void {
  database.addEventListener('versionchange', () => {
    database.close()
    if (openedDatabase === database) {
      openedDatabase = null
      databasePromise = null
    }
    console.warn('[Pi Desk][ChatIndexedDB] 数据库版本已变化，当前连接已关闭')
  })
}

function requestL4ChatDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    let settled = false
    const timeout = window.setTimeout(() => {
      fail(storageError('dbOpenTimeout'))
    }, DATABASE_OPEN_TIMEOUT_MS)

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      reject(error)
    }

    request.addEventListener(
      'upgradeneeded',
      () => {
        const database = request.result
        createMessageStore(database)
        createInputStore(database, L4_CHAT_DRAFT_STORE)
        createInputStore(database, L4_CHAT_OUTBOX_STORE)
      },
      { once: true }
    )
    request.addEventListener(
      'blocked',
      () => {
        fail(storageError('dbOpenBlocked'))
      },
      { once: true }
    )
    request.addEventListener(
      'success',
      () => {
        const database = request.result
        if (settled) {
          database.close()
          return
        }
        settled = true
        window.clearTimeout(timeout)
        resolve(database)
      },
      { once: true }
    )
    request.addEventListener('error', () => fail(request.error ?? storageError('dbOpenFailed')), {
      once: true
    })
  })
}

function deleteL4ChatDatabase(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME)
    let settled = false
    const timeout = window.setTimeout(() => {
      fail(storageError('dbDeleteTimeout'))
    }, DATABASE_OPEN_TIMEOUT_MS)

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      reject(error)
    }

    request.addEventListener(
      'blocked',
      () => {
        fail(storageError('dbDeleteBlocked'))
      },
      { once: true }
    )
    request.addEventListener(
      'success',
      () => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
    request.addEventListener('error', () => fail(request.error ?? storageError('dbDeleteFailed')), {
      once: true
    })
  })
}

function isVersionError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'VersionError'
  )
}

async function requestL4ChatDatabaseWithRecovery(): Promise<IDBDatabase> {
  try {
    return await requestL4ChatDatabase()
  } catch (error) {
    if (!isVersionError(error)) throw error

    console.warn(
      '[Pi Desk][ChatIndexedDB] 本地数据库版本高于当前版本，清空全部本地聊天数据后重建',
      {
        databaseName: DATABASE_NAME,
        requestedVersion: DATABASE_VERSION
      }
    )
    await deleteL4ChatDatabase()
    return requestL4ChatDatabase()
  }
}

export function openL4ChatDatabase(): Promise<IDBDatabase> {
  if (openedDatabase) return Promise.resolve(openedDatabase)
  if (databasePromise) return databasePromise

  databasePromise = requestL4ChatDatabaseWithRecovery()
    .then((database) => {
      openedDatabase = database
      closeDatabaseOnVersionChange(database)
      return database
    })
    .catch((error: unknown) => {
      databasePromise = null
      throw error
    })

  return databasePromise
}

export function readL4IdbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener(
      'error',
      () => reject(request.error ?? storageError('dbRequestFailed')),
      { once: true }
    )
  })
}

function errorFromL4IdbEvent(
  event: Event,
  transaction: IDBTransaction,
  fallbackMessage: string
): Error {
  const target = event.target as { error?: DOMException | null } | null
  return target?.error ?? transaction.error ?? new Error(fallbackMessage)
}

export function waitForL4IdbTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener(
      'abort',
      (event) =>
        reject(
          errorFromL4IdbEvent(event, transaction, storageError('dbTransactionAborted').message)
        ),
      { once: true }
    )
    transaction.addEventListener(
      'error',
      (event) =>
        reject(
          errorFromL4IdbEvent(event, transaction, storageError('dbTransactionFailed').message)
        ),
      { once: true }
    )
  })
}
