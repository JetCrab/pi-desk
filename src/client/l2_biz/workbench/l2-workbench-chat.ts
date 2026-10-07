'use client'

import {
  L2ChatSourceSchema,
  L2ChatSourceStateSchema,
  type L2ChatMessageDetail,
  type L2ChatMode,
  type L2ChatMessageDetailRequest,
  type L2ChatMessageDetailResponse,
  type L2ChatSource,
  type L2ChatSourceState
} from '@common/l2_biz/chat/l2-chat-contract'
import {
  L2ChatSocketContracts,
  type L2ChatSourceEventPush
} from '@common/l2_biz/chat/l2-chat-websocket-contract'
import {
  L2_EMPTY_CHAT_SOURCE_STATE,
  applyL2ChatMessageDetail,
  applyL2ChatSourceEvent,
  getL2ChatLatestCursor
} from '@common/l2_biz/chat/l2-chat-state'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L4AppSocketClient } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import {
  createL2WorkbenchChatRepository,
  type L2WorkbenchChatRepository
} from './l2-workbench-chat-repository'
import { l2WorkbenchText } from './l2-workbench-text'
import { L2NativeUiBiz } from './native-ui/l2-native-ui-biz'

export interface L2WorkbenchChatViewportSnapshot {
  messageId: string
  offset: number
}

interface L2WorkbenchChatQueuedPush {
  epoch: number
  push: L2ChatSourceEventPush
}

interface L2WorkbenchChatEventQueue {
  pushes: L2WorkbenchChatQueuedPush[]
  processing: boolean
  syncEpoch: number | null
}

export interface L2WorkbenchChatSourceState extends L2ChatSourceState {
  // 仅页面内存：loading 尚未展示过，syncing 保留旧画面，ready 可执行聊天命令。
  syncStatus: 'loading' | 'syncing' | 'ready'
}

const CHAT_STATE_NOTIFICATION_DELAY_MS = 50

export interface L2WorkbenchChatRuntime {
  readonly nativeUi: L2NativeUiBiz
  start: (onError: (cause: unknown) => void) => void
  applyWorkSessionsList: (workSessions: readonly L2WorkSessionListItem[]) => Promise<void>
  reconcileWorkSessions: (workSessions: readonly L2WorkSessionListItem[]) => void
  ensureDisplayedWorkSessions: (workSessions: readonly L2WorkSessionListItem[]) => void
  subscribe: (listener: () => void) => () => void
  subscribeSourceEvents: (
    listener: (push: L2ChatSourceEventPush, state: L2ChatSourceState) => void
  ) => () => void
  getSourceState: (source: L2ChatSource) => L2WorkbenchChatSourceState
  getViewportSnapshot: (source: L2ChatSource) => L2WorkbenchChatViewportSnapshot | null
  saveViewportSnapshot: (source: L2ChatSource, snapshot: L2WorkbenchChatViewportSnapshot) => void
  clearViewportSnapshot: (source: L2ChatSource) => void
  loadMessageDetail: (
    source: L2ChatSource,
    index: number,
    entryId: string
  ) => Promise<L2ChatMessageDetail>
  compact: (source: L2ChatSource) => Promise<void>
  reload: (source: L2ChatSource, mode?: L2ChatMode) => Promise<void>
  setPresentation: (source: L2ChatSource, mode: L2ChatMode) => Promise<void>
  disconnected: () => void
  dispose: () => void
}

const EMPTY_CHAT_SOURCE_STATE: L2WorkbenchChatSourceState = Object.freeze({
  ...L2_EMPTY_CHAT_SOURCE_STATE,
  syncStatus: 'loading'
})

function sourceFor(workSession: L2WorkSessionListItem): L2ChatSource {
  return L2ChatSourceSchema.parse({
    workId: workSession.workId,
    sessionId: workSession.sessionId,
    branchId: workSession.branchId
  })
}

function sourceKey(source: L2ChatSource): string {
  return JSON.stringify([source.workId, source.sessionId, source.branchId])
}

function sameSource(left: L2ChatSource, right: L2ChatSource): boolean {
  return (
    left.workId === right.workId &&
    left.sessionId === right.sessionId &&
    left.branchId === right.branchId
  )
}

export function createL2WorkbenchChatRuntime(
  appSocket: L4AppSocketClient,
  detailLoader: (input: L2ChatMessageDetailRequest) => Promise<L2ChatMessageDetailResponse>,
  repository: L2WorkbenchChatRepository = createL2WorkbenchChatRepository()
): L2WorkbenchChatRuntime {
  const nativeUi = new L2NativeUiBiz(appSocket)
  const subscriptionPool = new Map<string, L2ChatSource>()
  const currentWorkSessions = new Map<string, L2WorkSessionListItem>()
  const statesBySource = new Map<string, L2WorkbenchChatSourceState>()
  const pendingSyncs = new Map<string, object>()
  const viewportSnapshotsBySource = new Map<string, L2WorkbenchChatViewportSnapshot>()
  const eventQueues = new Map<string, L2WorkbenchChatEventQueue>()
  const detailRequests = new Map<string, Promise<L2ChatMessageDetail>>()
  const persistenceTails = new Map<string, Promise<void>>()
  const presentationRequests = new Map<string, Promise<void>>()
  const stateListeners = new Set<() => void>()
  const sourceEventListeners = new Set<
    (push: L2ChatSourceEventPush, state: L2ChatSourceState) => void
  >()
  let workSessionsReady = false
  let connectionEpoch = 0
  let unsubscribePush: (() => void) | null = null
  let errorListener: (cause: unknown) => void = () => undefined
  let stateNotificationTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const emitStateListeners = (): void => {
    for (const listener of [...stateListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[Pi Desk][WorkbenchChat] 消息状态监听器执行失败', {
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }

  const notifyStateListeners = (deferred = false): void => {
    if (deferred) {
      if (stateNotificationTimer) return
      stateNotificationTimer = setTimeout(() => {
        stateNotificationTimer = null
        emitStateListeners()
      }, CHAT_STATE_NOTIFICATION_DELAY_MS)
      return
    }

    if (stateNotificationTimer) clearTimeout(stateNotificationTimer)
    stateNotificationTimer = null
    emitStateListeners()
  }

  const setSourceState = (
    source: L2ChatSource,
    state: L2WorkbenchChatSourceState,
    deferredNotification = false
  ): void => {
    statesBySource.set(sourceKey(source), state)
    notifyStateListeners(deferredNotification)
  }

  const isCurrentAndSubscribed = (source: L2ChatSource): boolean => {
    const subscription = subscriptionPool.get(source.workId)
    const workSession = currentWorkSessions.get(source.workId)
    return (
      subscription !== undefined &&
      workSession !== undefined &&
      sameSource(subscription, source) &&
      sameSource(sourceFor(workSession), source)
    )
  }

  const persistSource = (source: L2ChatSource, operation: () => Promise<void>): Promise<void> => {
    const key = sourceKey(source)
    const request = (persistenceTails.get(key) ?? Promise.resolve()).then(operation, operation)
    persistenceTails.set(key, request)
    const release = (): void => {
      if (persistenceTails.get(key) === request) persistenceTails.delete(key)
    }
    void request.then(release, release)
    return request
  }

  const invalidateDetails = (source: L2ChatSource): void => {
    const prefix = `${sourceKey(source)}\u0000`
    for (const key of detailRequests.keys()) if (key.startsWith(prefix)) detailRequests.delete(key)
  }

  const subscribeSources = async (
    sources: readonly L2ChatSource[],
    full = false
  ): Promise<void> => {
    if (!workSessionsReady || sources.length === 0 || disposed) return
    const epoch = connectionEpoch
    const pending = sources
      .filter((source) => isCurrentAndSubscribed(source) && !pendingSyncs.has(sourceKey(source)))
      .map((source) => {
        const key = sourceKey(source)
        const token = {}
        pendingSyncs.set(key, token)
        const state = statesBySource.get(key)
        if (state) statesBySource.set(key, { ...state, syncStatus: 'syncing' })
        return { source, token }
      })
    if (pending.length === 0) return
    notifyStateListeners()

    const isPending = ({ source, token }: (typeof pending)[number]): boolean =>
      !disposed &&
      workSessionsReady &&
      epoch === connectionEpoch &&
      isCurrentAndSubscribed(source) &&
      pendingSyncs.get(sourceKey(source)) === token

    try {
      const prepared = await Promise.all(
        pending.map(async (item) => ({
          ...item,
          cursor: full ? null : await repository.readLatestCursor(item.source)
        }))
      )
      const subscriptions = prepared
        .filter(isPending)
        .map(({ source, cursor }) => ({ source, cursor }))
      if (subscriptions.length === 0) return
      await appSocket.request(L2ChatSocketContracts.subscribe, { subscriptions })
    } catch (error) {
      const current = pending.filter(isPending)
      for (const { source } of current) pendingSyncs.delete(sourceKey(source))
      if (current.length > 0) throw error
    }
  }

  const loadState = async (source: L2ChatSource): Promise<L2ChatSourceState> => {
    const key = sourceKey(source)
    const existing = statesBySource.get(key)
    if (existing) return existing

    // 首次展示仍等待服务端快照；读取缓存不提前写入可见状态。
    return L2ChatSourceStateSchema.parse({
      messages: await repository.readMessages(source),
      temporaryMessages: [],
      runtime: L2_EMPTY_CHAT_SOURCE_STATE.runtime
    })
  }

  const resubscribe = async (source: L2ChatSource): Promise<void> => {
    if (!isCurrentAndSubscribed(source) || !workSessionsReady || disposed) return
    pendingSyncs.delete(sourceKey(source))
    await subscribeSources([source], true)
  }

  const applyPush = async (queued: L2WorkbenchChatQueuedPush): Promise<boolean> => {
    const { epoch, push } = queued
    const { source, event } = push
    const key = sourceKey(source)
    const token = pendingSyncs.get(key)
    const isCurrent = (): boolean =>
      !disposed &&
      workSessionsReady &&
      epoch === connectionEpoch &&
      isCurrentAndSubscribed(source) &&
      pendingSyncs.get(key) === token
    if (!isCurrent()) return false
    if (event.type !== 'session_sync' && (token || !statesBySource.has(key))) return false
    if (event.type === 'session_sync' && event.mode === 'full') {
      invalidateDetails(source)
      const previous = statesBySource.get(key)
      if (previous) setSourceState(source, { ...previous, syncStatus: 'syncing' })
    }

    let current =
      event.type === 'session_sync' && event.mode === 'full'
        ? (statesBySource.get(key) ?? EMPTY_CHAT_SOURCE_STATE)
        : await loadState(source)
    if (!isCurrent()) return false
    if (event.type === 'session_sync' && event.mode === 'incremental') {
      const latest = current.messages.at(-1)
      if (
        latest?.location.index !== event.baseCursor.index ||
        latest.location.entryId !== event.baseCursor.entryId
      ) {
        // 断线可能发生在 IndexedDB 提交与内存更新之间；使用请求 cursor 对应的前缀。
        // 其他标签页可能已追加更多消息，不能把它们与本次增量重复合并。
        const messages = await repository.readMessages(source)
        if (!isCurrent()) return false
        const prefix = messages.slice(0, event.baseCursor.index + 1)
        const cursor = getL2ChatLatestCursor(prefix)
        if (
          cursor?.index !== event.baseCursor.index ||
          cursor.entryId !== event.baseCursor.entryId
        ) {
          throw new Error(l2WorkbenchText('chatCacheMismatch'))
        }
        current = { ...current, messages: prefix }
      }
    }
    const next = applyL2ChatSourceEvent(current, event)

    if (event.type === 'session_sync') {
      await persistSource(source, async () => {
        if (isCurrent()) await repository.replaceMessages(source, next.messages)
      })
    } else if (event.type === 'message_commit') {
      const committed = next.messages.at(-1)
      if (
        !committed ||
        committed.location.index !== event.durable.index ||
        committed.location.entryId !== event.durable.entryId
      ) {
        throw new Error(
          `Chat commit result is missing: ${event.durable.index}/${event.durable.entryId}`
        )
      }
      await persistSource(source, async () => {
        if (isCurrent()) await repository.appendMessage(source, committed)
      })
    }

    if (!isCurrent()) return false
    if (event.type === 'session_sync') pendingSyncs.delete(key)
    setSourceState(
      source,
      {
        ...next,
        syncStatus: event.type === 'session_sync' ? 'syncing' : statesBySource.get(key)!.syncStatus
      },
      event.type === 'message_update'
    )
    for (const listener of [...sourceEventListeners]) {
      try {
        listener(push, next)
      } catch (error) {
        console.error('[Pi Desk][WorkbenchChat] Source 事件观察器执行失败', {
          eventType: event.type,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
    return true
  }

  const drainEventQueue = async (key: string, queue: L2WorkbenchChatEventQueue): Promise<void> => {
    if (queue.processing) return
    queue.processing = true
    try {
      while (!disposed && eventQueues.get(key) === queue) {
        const queued = queue.pushes.shift()
        if (!queued) break

        try {
          const applied = await applyPush(queued)
          if (applied && queued.push.event.type === 'session_sync') queue.syncEpoch = queued.epoch
        } catch (error) {
          if (
            disposed ||
            queued.epoch !== connectionEpoch ||
            !isCurrentAndSubscribed(queued.push.source)
          ) {
            continue
          }
          queue.pushes.length = 0
          queue.syncEpoch = null
          const { push } = queued
          const eventTempId =
            push.event.type === 'message_start'
              ? push.event.snapshot.location.tempId
              : 'location' in push.event
                ? push.event.location.tempId
                : null
          console.error('[Pi Desk][WorkbenchChat] 应用聊天 Source 事件失败，重新同步', {
            workId: push.source.workId,
            sessionId: push.source.sessionId,
            branchId: push.source.branchId,
            eventType: push.event.type,
            eventTempId,
            updateLayers:
              push.event.type === 'message_update'
                ? {
                    fixed: push.event.fixed !== undefined,
                    summary: push.event.summary !== undefined,
                    detail: push.event.detail !== undefined,
                    increments: push.event.increments !== undefined
                  }
                : null,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            errorMessage: error instanceof Error ? error.message : String(error)
          })
          try {
            await resubscribe(push.source)
          } catch (resubscribeError) {
            errorListener(resubscribeError)
          }
          break
        }
      }
    } finally {
      queue.processing = false
      if (eventQueues.get(key) !== queue) return
      if (queue.pushes.length === 0) {
        eventQueues.delete(key)
        const state = statesBySource.get(key)
        if (
          !disposed &&
          workSessionsReady &&
          queue.syncEpoch === connectionEpoch &&
          !pendingSyncs.has(key) &&
          state?.syncStatus === 'syncing'
        ) {
          // 订阅响应不代表同步完成，当前已收到的快照及增量全部应用后才开放命令。
          statesBySource.set(key, { ...state, syncStatus: 'ready' })
          notifyStateListeners()
        }
      } else if (!disposed) {
        void drainEventQueue(key, queue)
      }
    }
  }

  const enqueuePush = (push: L2ChatSourceEventPush): void => {
    if (disposed || !workSessionsReady || !isCurrentAndSubscribed(push.source)) return
    const key = sourceKey(push.source)
    const queue = eventQueues.get(key) ?? { pushes: [], processing: false, syncEpoch: null }
    queue.pushes.push({ epoch: connectionEpoch, push })
    eventQueues.set(key, queue)
    if (!queue.processing) void drainEventQueue(key, queue)
  }

  const reconcile = (workSessions: readonly L2WorkSessionListItem[]): void => {
    currentWorkSessions.clear()
    for (const workSession of workSessions) {
      currentWorkSessions.set(workSession.workId, workSession)
    }

    let changed = false
    for (const subscription of [...subscriptionPool.values()]) {
      const current = currentWorkSessions.get(subscription.workId)
      if (current && sameSource(subscription, sourceFor(current))) continue

      subscriptionPool.delete(subscription.workId)
      statesBySource.delete(sourceKey(subscription))
      pendingSyncs.delete(sourceKey(subscription))
      viewportSnapshotsBySource.delete(sourceKey(subscription))
      invalidateDetails(subscription)
      eventQueues.delete(sourceKey(subscription))
      changed = true
    }
    if (changed) notifyStateListeners()
  }

  const ensureDisplayed = (workSessions: readonly L2WorkSessionListItem[]): void => {
    const addedSources: L2ChatSource[] = []

    for (const workSession of workSessions) {
      const displayedSource = sourceFor(workSession)
      const current = currentWorkSessions.get(workSession.workId)
      if (!current && workSessionsReady) continue

      const source = current ? sourceFor(current) : displayedSource
      if (!sameSource(displayedSource, source)) continue
      const existing = subscriptionPool.get(source.workId)
      if (existing && sameSource(existing, source)) continue

      if (existing) {
        statesBySource.delete(sourceKey(existing))
        pendingSyncs.delete(sourceKey(existing))
        viewportSnapshotsBySource.delete(sourceKey(existing))
        invalidateDetails(existing)
        eventQueues.delete(sourceKey(existing))
      }
      subscriptionPool.set(source.workId, source)
      addedSources.push(source)
    }

    if (addedSources.length === 0) return
    notifyStateListeners()
    if (workSessionsReady) {
      void subscribeSources(addedSources).catch((error: unknown) => {
        errorListener(error)
      })
    }
  }

  return {
    nativeUi,
    start(onError): void {
      errorListener = onError
      if (unsubscribePush) return
      disposed = false
      unsubscribePush = appSocket.subscribe(L2ChatSocketContracts.sourceEvent, enqueuePush)
    },

    async applyWorkSessionsList(workSessions): Promise<void> {
      reconcile(workSessions)
      workSessionsReady = true
      nativeUi.ready(workSessions.map(sourceFor))
      await subscribeSources([...subscriptionPool.values()])
    },

    reconcileWorkSessions(workSessions): void {
      reconcile(workSessions)
      nativeUi.reconcile(workSessions.map(sourceFor))
    },

    ensureDisplayedWorkSessions(workSessions): void {
      ensureDisplayed(workSessions)
    },

    subscribe(listener): () => void {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },

    subscribeSourceEvents(listener): () => void {
      sourceEventListeners.add(listener)
      return () => sourceEventListeners.delete(listener)
    },

    getSourceState(sourceInput): L2WorkbenchChatSourceState {
      const source = L2ChatSourceSchema.parse(sourceInput)
      return statesBySource.get(sourceKey(source)) ?? EMPTY_CHAT_SOURCE_STATE
    },

    getViewportSnapshot(sourceInput): L2WorkbenchChatViewportSnapshot | null {
      const source = L2ChatSourceSchema.parse(sourceInput)
      return viewportSnapshotsBySource.get(sourceKey(source)) ?? null
    },

    saveViewportSnapshot(sourceInput, snapshot): void {
      const source = L2ChatSourceSchema.parse(sourceInput)
      if (!snapshot.messageId || !Number.isFinite(snapshot.offset)) return
      viewportSnapshotsBySource.set(sourceKey(source), snapshot)
    },

    clearViewportSnapshot(sourceInput): void {
      const source = L2ChatSourceSchema.parse(sourceInput)
      viewportSnapshotsBySource.delete(sourceKey(source))
    },

    async loadMessageDetail(sourceInput, index, entryId): Promise<L2ChatMessageDetail> {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const current = await loadState(source)
      const message = current.messages.find(
        (candidate) => candidate.location.index === index && candidate.location.entryId === entryId
      )
      if (!message) throw new Error(l2WorkbenchText('chatMessageMissing', { index, entryId }))
      if (message.detail !== undefined) return message.detail
      if (!message.fixed.hasDetail) return null
      if (statesBySource.get(sourceKey(source))?.syncStatus !== 'ready')
        throw new Error(l2WorkbenchText('sourceSyncing'))
      const epoch = connectionEpoch
      const requestKey = `${sourceKey(source)}\u0000${index}\u0000${entryId}`
      const existing = detailRequests.get(requestKey)
      if (existing) return existing

      const request = (async (): Promise<L2ChatMessageDetail> => {
        const response = await detailLoader({
          sessionId: source.sessionId,
          branchId: source.branchId,
          entryId
        })
        const stillCurrent = (): boolean =>
          !disposed &&
          connectionEpoch === epoch &&
          isCurrentAndSubscribed(source) &&
          detailRequests.get(requestKey) === request
        await persistSource(source, async () => {
          if (!stillCurrent()) throw new Error(l2WorkbenchText('sourceSyncing'))
          await repository.saveDetail(source, response.index, response.entryId, response.detail)
        })
        if (!stillCurrent()) throw new Error(l2WorkbenchText('sourceSyncing'))
        if (isCurrentAndSubscribed(source) && !disposed) {
          const latest = statesBySource.get(sourceKey(source))
          if (latest) {
            setSourceState(source, {
              ...applyL2ChatMessageDetail(latest, response),
              syncStatus: latest.syncStatus
            })
          }
        }
        return response.detail
      })().finally(() => {
        if (detailRequests.get(requestKey) === request) detailRequests.delete(requestKey)
      })
      detailRequests.set(requestKey, request)
      return request
    },

    async compact(sourceInput): Promise<void> {
      const source = L2ChatSourceSchema.parse(sourceInput)
      if (statesBySource.get(sourceKey(source))?.syncStatus !== 'ready') {
        throw new Error(l2WorkbenchText('sourceSyncing'))
      }
      await appSocket.request(L2ChatSocketContracts.compact, { source })
    },

    async reload(sourceInput, mode): Promise<void> {
      const source = L2ChatSourceSchema.parse(sourceInput)
      if (statesBySource.get(sourceKey(source))?.syncStatus !== 'ready') {
        throw new Error(l2WorkbenchText('sourceSyncing'))
      }
      await appSocket.request(
        L2ChatSocketContracts.reload,
        mode === undefined ? { source } : { source, mode }
      )
    },

    async setPresentation(sourceInput, mode): Promise<void> {
      const source = L2ChatSourceSchema.parse(sourceInput)
      const key = sourceKey(source)
      const current = statesBySource.get(key)
      if (!current || current.syncStatus !== 'ready') {
        throw new Error(l2WorkbenchText('sourceSyncing'))
      }
      if (current.runtime.presentationMode === mode) return
      const requestKey = `${key}\u0000${mode}`
      const pending = presentationRequests.get(requestKey)
      if (pending) return pending
      const request = appSocket
        .request(L2ChatSocketContracts.presentationSet, { source, mode })
        .then(() => undefined)
        .finally(() => {
          if (presentationRequests.get(requestKey) === request)
            presentationRequests.delete(requestKey)
        })
      presentationRequests.set(requestKey, request)
      return request
    },

    disconnected(): void {
      nativeUi.disconnected()
      workSessionsReady = false
      connectionEpoch += 1
      detailRequests.clear()
      presentationRequests.clear()
      pendingSyncs.clear()
      for (const queue of eventQueues.values()) queue.pushes.length = 0
      let changed = false
      for (const [key, state] of statesBySource) {
        if (state.syncStatus === 'syncing') continue
        // 保留服务端最后一次投影供阅读；新连接以完整 Temporary Snapshot 重建基线。
        statesBySource.set(key, { ...state, syncStatus: 'syncing' })
        changed = true
      }
      if (changed) notifyStateListeners()
    },

    dispose(): void {
      if (disposed) return
      nativeUi.dispose()
      disposed = true
      workSessionsReady = false
      unsubscribePush?.()
      unsubscribePush = null
      errorListener = () => undefined
      subscriptionPool.clear()
      currentWorkSessions.clear()
      statesBySource.clear()
      pendingSyncs.clear()
      viewportSnapshotsBySource.clear()
      eventQueues.clear()
      detailRequests.clear()
      persistenceTails.clear()
      presentationRequests.clear()
      if (stateNotificationTimer) clearTimeout(stateNotificationTimer)
      stateNotificationTimer = null
      stateListeners.clear()
      sourceEventListeners.clear()
    }
  }
}
