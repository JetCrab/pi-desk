'use client'

import type { PluginJsonObject } from '@jetcrab/pi-desk-sdk/browser'
import {
  L2TaskDetailSnapshotSchema,
  type L2TaskDetailSnapshot,
  type L2TaskSummary
} from '@common/l2_biz/task-center/l2-task-center-contract'
import type { L2TaskDetailEventPush } from '@common/l2_biz/task-center/l2-task-center-websocket-contract'
import { L2_TASK_CENTER_MESSAGES } from '@common/l2_biz/task-center/l2-task-center-messages'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'
import {
  applyL2TaskDetailEvent,
  applyL2TaskMessageDetail,
  replaceL2TaskDetailSnapshot
} from '@common/l2_biz/task-center/l2-task-center-state'
import {
  L3WorkSessionSourceSchema,
  type L3WorkSessionSource
} from '@common/l3_modules/work-session/l3-work-session-source-contract'
import type { L3ConversationDisplayMessage } from '@client/l3_modules/conversation/l3-conversation-display'
import type { L3ConversationAcquireImage } from '@client/l3_modules/conversation/l3-conversation-messages'
import { createL4Base64ImageBlob } from '@client/l4_foundation/media/l4-base64-image'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L2TaskCenterBiz } from './l2-task-center-biz'

export interface L2TaskCenterState {
  open: boolean
  source: L3WorkSessionSource | null
  selectedTaskId: string | null
  details: Readonly<Record<string, L2TaskDetailSnapshot>>
  loading: boolean
  refreshing: boolean
  error: string | null
}

export interface L2TaskCenterRuntime {
  start: (onError: (cause: unknown) => void) => void
  subscribe: (listener: () => void) => () => void
  getState: () => L2TaskCenterState
  open: (source: L3WorkSessionSource, preferredTaskId: string | null) => void
  close: () => void
  selectTask: (taskId: string) => void
  reconcileWorkSessions: (workSessions: readonly L2WorkSessionListItem[]) => void
  reconcileTasks: (source: L3WorkSessionSource, tasks: readonly L2TaskSummary[]) => void
  interruptSelected: () => Promise<void>
  loadMessageDetail: (message: L3ConversationDisplayMessage) => Promise<PluginJsonObject | null>
  acquireImage: L3ConversationAcquireImage
  disconnected: () => void
  reconnected: () => void
  dispose: () => void
}

interface L2TaskCachedImage {
  taskId: string
  url: string
}

function taskText(key: keyof (typeof L2_TASK_CENTER_MESSAGES)['zh-CN']): string {
  return l4LocalizedErrorMessage({
    msg: L2_TASK_CENTER_MESSAGES['zh-CN'][key],
    i18n: { key: `taskCenter:${key}` }
  })
}

const TASK_STATE_NOTIFICATION_DELAY_MS = 16

const EMPTY_STATE: L2TaskCenterState = Object.freeze({
  open: false,
  source: null,
  selectedTaskId: null,
  details: {},
  loading: false,
  refreshing: false,
  error: null
})

function sameSource(left: L3WorkSessionSource | null, right: L3WorkSessionSource | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.workId === right.workId &&
      left.sessionId === right.sessionId &&
      left.branchId === right.branchId)
  )
}

function imageKey(
  source: L3WorkSessionSource,
  taskId: string,
  entryId: string,
  imageIndex: number
): string {
  return JSON.stringify([
    source.workId,
    source.sessionId,
    source.branchId,
    taskId,
    entryId,
    imageIndex
  ])
}

export function createL2TaskCenterRuntime(biz: L2TaskCenterBiz): L2TaskCenterRuntime {
  const listeners = new Set<() => void>()
  const images = new Map<string, L2TaskCachedImage>()
  let state: L2TaskCenterState = EMPTY_STATE
  let selectionEpoch = 0
  let connectionEpoch = 0
  let acceptPush = false
  let unsubscribePush: (() => void) | null = null
  let errorListener: (cause: unknown) => void = () => undefined
  let stateNotificationTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const emitListeners = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[Pi Desk][TaskCenterClient] 状态监听器执行失败', {
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }

  const notify = (deferred = false): void => {
    if (deferred) {
      if (stateNotificationTimer) return
      stateNotificationTimer = setTimeout(() => {
        stateNotificationTimer = null
        emitListeners()
      }, TASK_STATE_NOTIFICATION_DELAY_MS)
      return
    }

    if (stateNotificationTimer) clearTimeout(stateNotificationTimer)
    stateNotificationTimer = null
    emitListeners()
  }

  const setState = (next: L2TaskCenterState, deferredNotification = false): void => {
    state = next
    notify(deferredNotification)
  }

  const revokeImages = (taskId?: string): void => {
    for (const [key, image] of images) {
      if (taskId !== undefined && image.taskId !== taskId) continue
      URL.revokeObjectURL(image.url)
      images.delete(key)
    }
  }

  const close = (): void => {
    if (!state.open && state.source === null) return
    const source = state.source
    selectionEpoch += 1
    acceptPush = false
    setState(EMPTY_STATE)
    revokeImages()
    if (source) {
      void biz.watchDetail({ source, taskId: null }).catch(() => undefined)
    }
  }

  const applyPush = (push: L2TaskDetailEventPush): void => {
    if (
      disposed ||
      !state.open ||
      !acceptPush ||
      !sameSource(state.source, push.source) ||
      state.selectedTaskId !== push.taskId
    ) {
      return
    }
    const current = state.details[push.taskId]
    if (!current) return
    try {
      const next = applyL2TaskDetailEvent(current, push.event)
      if (!next) {
        const details = { ...state.details }
        delete details[push.taskId]
        revokeImages(push.taskId)
        setState({
          ...state,
          details,
          loading: false,
          refreshing: false,
          error: taskText('detailUnavailable')
        })
        return
      }
      const deferredNotification =
        push.event.type === 'text_append' ||
        (push.event.type === 'conversation_event' && push.event.event.type === 'message_update')
      setState(
        {
          ...state,
          details: { ...state.details, [push.taskId]: next },
          loading: false,
          refreshing: false,
          error: null
        },
        deferredNotification
      )
    } catch (error) {
      acceptPush = false
      errorListener(error)
      void selectTask(push.taskId)
    }
  }

  const selectTask = async (taskIdInput: string): Promise<void> => {
    if (disposed || !state.open || !state.source) return
    const taskId = taskIdInput.trim()
    if (!taskId) return
    const source = state.source
    const epoch = ++selectionEpoch
    const socketEpoch = connectionEpoch
    const cached = state.details[taskId]
    acceptPush = false
    setState({
      ...state,
      selectedTaskId: taskId,
      loading: cached === undefined,
      refreshing: cached !== undefined,
      error: null
    })

    try {
      const response = await biz.watchDetail({ source, taskId })
      if (
        disposed ||
        epoch !== selectionEpoch ||
        socketEpoch !== connectionEpoch ||
        !state.open ||
        !sameSource(state.source, source) ||
        state.selectedTaskId !== taskId
      ) {
        return
      }
      if (!response.snapshot) throw new Error(taskText('detailResponseMissing'))
      const snapshot = L2TaskDetailSnapshotSchema.parse(response.snapshot)
      const nextSnapshot = cached ? replaceL2TaskDetailSnapshot(cached, snapshot) : snapshot
      setState({
        ...state,
        details: { ...state.details, [taskId]: nextSnapshot },
        loading: false,
        refreshing: false,
        error: null
      })
      acceptPush = true
    } catch (error) {
      if (epoch !== selectionEpoch || !state.open || state.selectedTaskId !== taskId) return
      setState({
        ...state,
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : taskText('detailLoadFailed')
      })
    }
  }

  return {
    start(onError): void {
      errorListener = onError
      if (unsubscribePush) return
      disposed = false
      unsubscribePush = biz.subscribeDetailEvents(applyPush)
    },

    subscribe(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    getState(): L2TaskCenterState {
      return state
    },

    open(sourceInput, preferredTaskId): void {
      const source = L3WorkSessionSourceSchema.parse(sourceInput)
      if (!state.open || !sameSource(state.source, source)) {
        selectionEpoch += 1
        acceptPush = false
        revokeImages()
        setState({ ...EMPTY_STATE, open: true, source })
      }
      if (preferredTaskId) void selectTask(preferredTaskId)
    },

    close,

    selectTask(taskId): void {
      void selectTask(taskId)
    },

    reconcileWorkSessions(workSessions): void {
      if (!state.open || !state.source) return
      const current = workSessions.find(
        (workSession) => workSession.workId === state.source?.workId
      )
      if (
        !current ||
        current.sessionId !== state.source.sessionId ||
        current.branchId !== state.source.branchId
      ) {
        close()
      }
    },

    reconcileTasks(sourceInput, tasks): void {
      const source = L3WorkSessionSourceSchema.parse(sourceInput)
      if (!state.open || !sameSource(state.source, source)) return
      const taskIds = new Set(tasks.map((task) => task.taskId))
      const details = { ...state.details }
      let changed = false
      for (const taskId of Object.keys(details)) {
        if (taskIds.has(taskId)) continue
        delete details[taskId]
        revokeImages(taskId)
        changed = true
      }
      if (state.selectedTaskId && !taskIds.has(state.selectedTaskId)) {
        selectionEpoch += 1
        acceptPush = false
        setState({
          ...state,
          selectedTaskId: null,
          details,
          loading: false,
          refreshing: false,
          error: null
        })
        return
      }
      if (changed) setState({ ...state, details })
    },

    async interruptSelected(): Promise<void> {
      if (!state.open || !state.source || !state.selectedTaskId) return
      await biz.interrupt({ source: state.source, taskId: state.selectedTaskId })
    },

    async loadMessageDetail(message): Promise<PluginJsonObject | null> {
      const source = state.source
      const taskId = state.selectedTaskId
      if (!state.open || !source || !taskId || !message.durable) return null
      const current = state.details[taskId]
      if (!current || current.body?.kind !== 'conversation') return null
      if (message.detail !== undefined) return message.detail
      if (!message.snapshot.fixed.hasDetail) return null

      const response = await biz.getMessageDetail({
        source,
        taskId,
        entryId: message.durable.location.entryId
      })
      const latest = state.details[taskId]
      if (!latest) return response.detail
      setState({
        ...state,
        details: {
          ...state.details,
          [taskId]: applyL2TaskMessageDetail(latest, response)
        }
      })
      return response.detail
    },

    async acquireImage(message, imageIndex): Promise<{ url: string; release: () => void }> {
      const source = state.source
      const taskId = state.selectedTaskId
      const entryId = message.durable?.location.entryId
      if (!state.open || !source || !taskId || !entryId) {
        throw new Error(taskText('imageDurableOnly'))
      }
      const key = imageKey(source, taskId, entryId, imageIndex)
      const cached = images.get(key)
      if (cached) return { url: cached.url, release: () => undefined }

      const response = await biz.getImage({ source, taskId, entryId, imageIndex })
      if (!state.open || !sameSource(state.source, source)) {
        throw new Error(taskText('centerClosed'))
      }
      const concurrent = images.get(key)
      if (concurrent) return { url: concurrent.url, release: () => undefined }
      const url = URL.createObjectURL(createL4Base64ImageBlob(response))
      images.set(key, { taskId, url })
      return { url, release: () => undefined }
    },

    disconnected(): void {
      connectionEpoch += 1
      acceptPush = false
      if (!state.open) return
      setState({
        ...state,
        loading: state.selectedTaskId !== null && state.details[state.selectedTaskId] === undefined,
        refreshing:
          state.selectedTaskId !== null && state.details[state.selectedTaskId] !== undefined
      })
    },

    reconnected(): void {
      if (state.open && state.selectedTaskId) void selectTask(state.selectedTaskId)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      const source = state.source
      selectionEpoch += 1
      connectionEpoch += 1
      acceptPush = false
      unsubscribePush?.()
      unsubscribePush = null
      revokeImages()
      if (source) void biz.watchDetail({ source, taskId: null }).catch(() => undefined)
      state = EMPTY_STATE
      if (stateNotificationTimer) clearTimeout(stateNotificationTimer)
      stateNotificationTimer = null
      listeners.clear()
      errorListener = () => undefined
    }
  }
}
