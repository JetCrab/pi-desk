import 'server-only'

import { setTimeout as delay } from 'node:timers/promises'

import {
  L2ChatModelContextGetRequestSchema,
  L2ChatModelContextGetResponseSchema,
  type L2ChatModelContextGetRequest,
  type L2ChatModelContextGetResponse
} from '@common/l2_biz/chat/l2-chat-context-contract'
import {
  L2ChatImageGetRequestSchema,
  L2ChatImageGetResponseSchema,
  L2ChatMessageDetailRequestSchema,
  L2ChatMessageDetailResponseSchema,
  L2ChatRuntimeSchema,
  L2ChatSourceSchema,
  L2ChatSourceStateSchema,
  L2ChatUserSummarySchema,
  type L2ChatCursor,
  type L2ChatMode,
  type L2ChatImageGetRequest,
  type L2ChatImageGetResponse,
  type L2ChatMessageDetailRequest,
  type L2ChatMessageDetailResponse,
  type L2ChatRuntime,
  type L2ChatSource,
  type L2ChatSourceState
} from '@common/l2_biz/chat/l2-chat-contract'
import {
  type L2ChatModelSetRequest,
  type L2ChatCapabilityModeSetRequest,
  type L2ChatQueueRestoreResponse,
  type L2ChatSendRequest,
  type L2ChatSendResponse,
  type L2ChatSessionSyncEvent,
  type L2ChatSourceEvent
} from '@common/l2_biz/chat/l2-chat-websocket-contract'
import { L2_EMPTY_CHAT_RUNTIME, applyL2ChatSourceEvent } from '@common/l2_biz/chat/l2-chat-state'
import type {
  L2PluginInvokeRequest,
  L2PluginInvokeResponse
} from '@common/l2_biz/plugin/l2-plugin-websocket-contract'
import type { L3PluginPushMessage } from '@common/l3_modules/plugin-host/l3-plugin-push-contract'
import type { L2WorkSessionStatus } from '@common/l2_biz/work-session/l2-work-session-contract'
import { WorkSession } from '@server/l3_modules/work-session/l3-work-session'
import type { L4PiChatMessage } from '@server/l4_foundation/pi/l4-pi-chat-projection'
import { isL4PiDeskSafeMode } from '@server/l4_foundation/pi/l4-pi-desk-mode'
import { L4PiDirectBashRunningError } from '@server/l4_foundation/pi/l4-pi-chat-worker'
import type {
  L4PiChatWorkerEvent,
  L4PiDirectBashInput,
  L4PiDirectBashResult,
  L4PiNativeCommandInfo,
  L4PiNativeToolInfo
} from '@server/l4_foundation/pi/l4-pi-chat-worker'
import {
  buildL3ConversationMessageUpdate,
  projectL3ConversationDurableMessage,
  projectL3ConversationTemporaryMessage,
  withoutL3ConversationMessageDetail
} from '@server/l3_modules/conversation/l3-conversation-mapper'
import {
  disposeL4PiWorkSessionRuntime,
  getL4PiWorkSessionRuntime
} from '@server/l4_foundation/pi/l4-pi-work-session-runtime'

export interface L2WorkSessionChatMetadata {
  sessionTitle: string | null
  messageCounts: {
    user: number
    total: number
  }
  lastMessageUpdatedAt: number | null
}

export type L2WorkSessionChatRuntimeEvent =
  | {
      type: 'source_event'
      source: L2ChatSource
      version: number
      event: L2ChatSourceEvent
    }
  | {
      type: 'source_invalidated'
      source: L2ChatSource
    }

export interface L2PreparedChatSourceSync {
  event: L2ChatSessionSyncEvent
  watermark: number
}

type L2WorkSessionChatRuntimeListener = (event: L2WorkSessionChatRuntimeEvent) => void
type L2WorkSessionChatRecordListener = (
  workId: string,
  previousMetadata: L2WorkSessionChatMetadata,
  previousStatus: L2WorkSessionStatus
) => void
type L2WorkSessionPluginPushListener = (message: L3PluginPushMessage) => void

interface L2WorkSessionChatRecord {
  workSession: WorkSession
  source: L2ChatSource
  state: L2ChatSourceState
  sourceEventVersion: number
  forceFullSync: boolean
  rawTemporaryMessages: Map<string, L4PiChatMessage>
  metadata: L2WorkSessionChatMetadata
  mainRunning: boolean
  backgroundTaskIds: Set<string>
  completedPending: boolean
  acceptingCommands: boolean
  directBashActive: boolean
  compactionStart: Promise<boolean> | null
  commandTail: Promise<void>
  pendingCommands: number
  unsubscribeWorker: () => void
}

export class L2ChatSourceBindingError extends Error {
  constructor(source: L2ChatSource) {
    super(`Chat source is not current: ${source.workId}/${source.sessionId}/${source.branchId}`)
    this.name = 'L2ChatSourceBindingError'
  }
}

export class L2ChatMessageNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Chat message was not found: ${entryId}`)
    this.name = 'L2ChatMessageNotFoundError'
  }
}

export class L2ChatLifecycleBlockedError extends Error {
  constructor(workId: string) {
    super(`Chat commands are blocked by WorkSession lifecycle: ${workId}`)
    this.name = 'L2ChatLifecycleBlockedError'
  }
}

export class L2PluginReloadBlockedError extends Error {
  constructor(
    readonly workId: string,
    readonly reason: string
  ) {
    super(`工作会话 ${workId} 阻止插件重载：${reason}`)
    this.name = 'L2PluginReloadBlockedError'
  }
}

function snapshotTemporaryMessage(message: L4PiChatMessage): L4PiChatMessage {
  try {
    return structuredClone(message)
  } catch {
    // 插件raw可能含函数或执行对象，恢复基线至少保留已规范化的内置内容。
    const { declaration: _declaration, ...body } = message
    return structuredClone(body)
  }
}

function sameRuntime(left: L2ChatRuntime, right: L2ChatRuntime): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class L2WorkSessionChatRuntime {
  private readonly recordsByWorkId = new Map<string, L2WorkSessionChatRecord>()
  private readonly listeners = new Set<L2WorkSessionChatRuntimeListener>()
  private readonly recordListeners = new Set<L2WorkSessionChatRecordListener>()
  private readonly pluginPushListeners = new Set<L2WorkSessionPluginPushListener>()
  private pluginChangeActive = false
  private pluginChangeFrozen = false

  async initialize(workSessions: readonly WorkSession[]): Promise<void> {
    const records = workSessions.map((workSession) => this.buildRecord(workSession))
    this.recordsByWorkId.clear()
    for (const record of records) this.recordsByWorkId.set(record.source.workId, record)
  }

  addWorkSession(workSession: WorkSession): void {
    this.recordsByWorkId.set(workSession.workId, this.buildRecord(workSession))
  }

  async replaceWorkSession(previous: WorkSession, next: WorkSession): Promise<void> {
    const previousSource = this.recordsByWorkId.get(previous.workId)?.source
    await this.closeRecord(previous.workId)
    if (previousSource) this.publish({ type: 'source_invalidated', source: previousSource })
    this.recordsByWorkId.set(next.workId, this.buildRecord(next))
    if (previous.sessionId !== next.sessionId)
      await disposeL4PiWorkSessionRuntime(previous.sessionId)
  }

  async refreshWorkSession(workSession: WorkSession): Promise<void> {
    const previousSource = this.recordsByWorkId.get(workSession.workId)?.source
    await this.closeRecord(workSession.workId)
    if (previousSource) this.publish({ type: 'source_invalidated', source: previousSource })
    this.recordsByWorkId.set(workSession.workId, this.buildRecord(workSession))
  }

  async removeWorkSession(workSession: WorkSession): Promise<void> {
    const source = this.recordsByWorkId.get(workSession.workId)?.source
    await this.closeRecord(workSession.workId)
    if (source) this.publish({ type: 'source_invalidated', source })
    await disposeL4PiWorkSessionRuntime(workSession.sessionId)
  }

  async pauseWorkSession(workId: string): Promise<void> {
    const record = this.recordsByWorkId.get(workId)
    if (!record) return
    if (this.pluginChangeFrozen) throw new L2ChatLifecycleBlockedError(workId)
    record.acceptingCommands = false
    getL4PiWorkSessionRuntime(record.source.sessionId).nativeUi.cancelAll()
    await record.commandTail
  }

  resumeWorkSession(workId: string): void {
    const record = this.recordsByWorkId.get(workId)
    if (record) record.acceptingCommands = true
  }

  async pauseForProcessRestart(): Promise<() => void> {
    if (this.pluginChangeFrozen) throw new Error('插件维护正在应用变更')
    const records = [...this.recordsByWorkId.values()]
    const initialBlock = records
      .map((record) => ({ record, reason: this.pluginReloadBlockReason(record) }))
      .find((item) => item.reason !== null)
    if (initialBlock?.reason) {
      throw new L2PluginReloadBlockedError(initialBlock.record.source.workId, initialBlock.reason)
    }

    for (const record of records) record.acceptingCommands = false
    await Promise.all(records.map((record) => record.commandTail))

    const finalBlock = records
      .map((record) => ({ record, reason: this.pluginReloadBlockReason(record) }))
      .find((item) => item.reason !== null)
    if (finalBlock?.reason) {
      for (const record of records) record.acceptingCommands = true
      throw new L2PluginReloadBlockedError(finalBlock.record.source.workId, finalBlock.reason)
    }

    let active = true
    return (): void => {
      if (!active) return
      active = false
      for (const record of records) {
        if (this.recordsByWorkId.get(record.source.workId) === record) {
          record.acceptingCommands = true
        }
      }
    }
  }

  async runPluginChange<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    onWaiting: (reason: string) => void
  ): Promise<T> {
    if (this.pluginChangeActive) throw new Error('已有插件维护正在进行')
    this.pluginChangeActive = true
    const blockReason = (): string | null => {
      for (const record of this.recordsByWorkId.values()) {
        const reason = !record.acceptingCommands
          ? '工作会话生命周期正在处理'
          : record.pendingCommands > 0 || record.compactionStart
            ? '会话命令仍在执行'
            : this.pluginReloadBlockReason(record)
        if (reason) return `工作会话 ${record.source.workId}：${reason}`
      }
      return null
    }
    try {
      while (true) {
        signal.throwIfAborted()
        const reason = blockReason()
        if (reason) {
          onWaiting(reason)
          await delay(250, undefined, { signal })
          continue
        }
        // 独立维护标记不修改 acceptingCommands，不能解除替换/关闭持有的锁。
        this.pluginChangeFrozen = true
        const finalReason = blockReason()
        if (!finalReason) break
        this.pluginChangeFrozen = false
        onWaiting(finalReason)
        await delay(250, undefined, { signal })
      }
      signal.throwIfAborted()
      const records = [...this.recordsByWorkId.values()]
      let failed = false
      let firstError: unknown
      let result!: T
      try {
        result = await operation()
      } catch (error) {
        failed = true
        firstError = error
      }
      for (const record of records) {
        if (!this.isCurrentRecord(record)) continue
        if (record.state.runtime.extensionMode !== 'normal') continue
        let refreshStarted = false
        try {
          const runtime = getL4PiWorkSessionRuntime(record.source.sessionId)
          if (!runtime.isWorkerInitialized) continue
          refreshStarted = true
          await runtime.reload('normal')
        } catch (error) {
          if (!failed) firstError = error
          failed = true
          console.error('[Pi Desk][WorkSessionChatRuntime] 插件维护后会话资源重载失败', {
            workId: record.source.workId,
            message: error instanceof Error ? error.message : String(error)
          })
        } finally {
          if (refreshStarted && this.isCurrentRecord(record)) {
            try {
              await this.syncRecordRuntime(record)
              if (this.isCurrentRecord(record)) {
                this.reprojectRecord(record, record.state.runtime.presentationMode)
              }
              if (
                record.state.runtime.extensionMode !== 'normal' ||
                record.state.runtime.initializationError
              ) {
                throw new Error(
                  record.state.runtime.initializationError ?? '插件重载后会话已降级为基础模式'
                )
              }
            } catch (error) {
              if (!failed) firstError = error
              failed = true
              console.error('[Pi Desk][WorkSessionChatRuntime] 插件维护后会话快照同步失败', {
                workId: record.source.workId,
                message: error instanceof Error ? error.message : String(error)
              })
            }
          }
        }
      }
      if (failed) throw firstError
      signal.throwIfAborted()
      return result
    } finally {
      this.pluginChangeFrozen = false
      this.pluginChangeActive = false
    }
  }

  private isCurrentRecord(record: L2WorkSessionChatRecord): boolean {
    return (
      this.recordsByWorkId.get(record.source.workId) === record &&
      this.matches(record.source, this.sourceFor(record.workSession))
    )
  }

  metadataFor(workSession: WorkSession): L2WorkSessionChatMetadata {
    return this.recordFor(workSession).metadata
  }

  statusFor(workSession: WorkSession): L2WorkSessionStatus {
    return this.statusForRecord(this.recordFor(workSession))
  }

  private statusForRecord(record: L2WorkSessionChatRecord): L2WorkSessionStatus {
    if (record.mainRunning) return 'main_running'
    if (record.backgroundTaskIds.size > 0) return 'background_running'
    if (record.completedPending) return 'completed'
    return 'idle'
  }

  acknowledgeCompleted(workId: string): boolean {
    const record = this.recordsByWorkId.get(workId)
    if (!record || !record.completedPending) return false
    const previousStatus = this.statusForRecord(record)
    record.completedPending = false
    this.publishRecordChanged(workId, record.metadata, previousStatus)
    return true
  }

  isCurrentSource(sourceInput: L2ChatSource): boolean {
    const source = L2ChatSourceSchema.parse(sourceInput)
    const record = this.recordsByWorkId.get(source.workId)
    return record !== undefined && this.matches(record.source, source)
  }

  refreshPluginMessages(): void {
    for (const record of this.recordsByWorkId.values()) {
      if (record.state.runtime.presentationMode === 'basic') continue
      try {
        this.reprojectRecord(record, record.state.runtime.presentationMode)
      } catch (error) {
        console.error('[Pi Desk][WorkSessionChatRuntime] 插件消息刷新失败，保留已有聊天', {
          workId: record.source.workId,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  setPresentation(source: L2ChatSource, mode: L2ChatMode): Promise<void> {
    const record = this.currentRecord(source)
    return this.enqueueCommand(record, async () => {
      if (
        (isL4PiDeskSafeMode() || record.state.runtime.extensionMode === 'basic') &&
        mode === 'normal'
      ) {
        throw new Error('基础模式不启用插件消息展示，请先恢复插件聊天')
      }
      if (record.state.runtime.presentationMode !== mode) this.reprojectRecord(record, mode)
    })
  }

  private reprojectRecord(record: L2WorkSessionChatRecord, mode: L2ChatMode): void {
    const snapshot = getL4PiWorkSessionRuntime(record.source.sessionId).readChatSnapshot()
    const entries = new Map(snapshot.entries.map((entry) => [entry.entryId, entry]))
    const basic = mode === 'basic'
    // 只使用已接纳前缀和最后发布的临时原文，不提前提交或混入尚未发布的Pi事件。
    const messages = record.state.messages.map((message) => {
      const entry = entries.get(message.location.entryId)
      if (!entry) throw new Error(`无法重新投影消息：${message.location.entryId}`)
      return projectL3ConversationDurableMessage(
        message.location.index,
        entry.entryId,
        entry.timestampMs,
        entry.message,
        record.source,
        basic
      )
    })
    const temporaryMessages = record.state.temporaryMessages.map((message) => {
      const raw = record.rawTemporaryMessages.get(message.location.tempId)
      if (!raw) throw new Error(`临时消息基线尚不可重投影：${message.location.tempId}`)
      return projectL3ConversationTemporaryMessage(
        message.location.tempId,
        raw,
        record.source,
        false,
        'update',
        basic
      )
    })
    record.state = {
      messages,
      temporaryMessages,
      runtime: { ...record.state.runtime, presentationMode: mode }
    }
    record.forceFullSync = true
    record.sourceEventVersion += 1
    this.publish({
      type: 'source_event',
      source: record.source,
      version: record.sourceEventVersion,
      event: this.createSync(record.source, null).event
    })
  }

  prepareSource(sourceInput: L2ChatSource): Promise<void> {
    const record = this.currentRecord(sourceInput)
    return this.enqueueCommand(record, () => this.syncRecordRuntime(record))
  }

  private async syncRecordRuntime(record: L2WorkSessionChatRecord): Promise<void> {
    const source = record.source
    const runtime = L2ChatRuntimeSchema.parse({
      ...(await getL4PiWorkSessionRuntime(source.sessionId).readChatRuntime()),
      presentationMode: record.state.runtime.presentationMode
    })
    if (!this.isCurrentSource(source)) return
    if (!sameRuntime(record.state.runtime, runtime))
      this.applySourceEvent(source, { type: 'runtime_update', runtime })
    if (runtime.extensionMode === 'basic' && record.state.runtime.presentationMode !== 'basic') {
      this.reprojectRecord(record, 'basic')
    }
  }

  createSync(sourceInput: L2ChatSource, cursor: L2ChatCursor): L2PreparedChatSourceSync {
    const record = this.currentRecord(sourceInput)
    const source = record.source
    const messages = record.state.messages
    const temporaryMessages = record.state.temporaryMessages
    const runtime = record.state.runtime

    const serverMessage = cursor === null ? undefined : messages[cursor.index]
    const cursorMatches = cursor !== null && serverMessage?.location.entryId === cursor.entryId
    if (cursor !== null && !cursorMatches) {
      console.warn('[Pi Desk][WorkSessionChatRuntime] 客户端消息 cursor 不匹配，回退全量', {
        workId: source.workId,
        sessionId: source.sessionId,
        branchId: source.branchId,
        clientCursorIndex: cursor.index,
        clientCursorEntryId: cursor.entryId,
        serverEntryIdAtIndex: serverMessage?.location.entryId ?? null,
        serverLatestIndex: messages.at(-1)?.location.index ?? -1
      })
    }

    const event: L2ChatSessionSyncEvent =
      cursor !== null && cursorMatches && !record.forceFullSync
        ? {
            type: 'session_sync',
            mode: 'incremental',
            baseCursor: cursor,
            messages: messages.slice(cursor.index + 1).map(withoutL3ConversationMessageDetail),
            temporaryMessages,
            runtime
          }
        : {
            type: 'session_sync',
            mode: 'full',
            baseCursor: null,
            messages: messages.map(withoutL3ConversationMessageDetail),
            temporaryMessages,
            runtime
          }

    return { event, watermark: record.sourceEventVersion }
  }

  getImage(inputValue: L2ChatImageGetRequest): L2ChatImageGetResponse {
    const input = L2ChatImageGetRequestSchema.parse(inputValue)
    const record = this.recordForSession(input.sessionId, input.branchId)
    const message = record.state.messages.find(
      (candidate) => candidate.location.entryId === input.entryId
    )
    if (!message || (message.fixed.type !== 'user' && message.fixed.type !== 'tool')) {
      throw new L2ChatMessageNotFoundError(`${input.entryId}/${input.imageIndex}`)
    }
    return L2ChatImageGetResponseSchema.parse(
      getL4PiWorkSessionRuntime(record.source.sessionId).readChatImage(
        input.entryId,
        input.imageIndex
      )
    )
  }

  getMessageDetail(inputValue: L2ChatMessageDetailRequest): L2ChatMessageDetailResponse {
    const input = L2ChatMessageDetailRequestSchema.parse(inputValue)
    const record = this.recordForSession(input.sessionId, input.branchId)
    const message = record.state.messages.find(
      (candidate) => candidate.location.entryId === input.entryId
    )
    if (!message) throw new L2ChatMessageNotFoundError(input.entryId)

    return L2ChatMessageDetailResponseSchema.parse({
      index: message.location.index,
      entryId: message.location.entryId,
      detail: message.detail ?? null
    })
  }

  getModelContext(
    inputValue: L2ChatModelContextGetRequest
  ): Promise<L2ChatModelContextGetResponse> {
    const input = L2ChatModelContextGetRequestSchema.parse(inputValue)
    const record = this.currentRecord(input.source)
    return this.enqueueCommand(record, async () =>
      L2ChatModelContextGetResponseSchema.parse(
        await getL4PiWorkSessionRuntime(record.source.sessionId).readModelContext()
      )
    )
  }

  send(input: L2ChatSendRequest): Promise<L2ChatSendResponse> {
    const record = this.currentRecord(input.source)
    if (getL4PiWorkSessionRuntime(input.source.sessionId).nativeUi.hasPending) {
      return Promise.reject(new Error('请先处理当前插件问题，或停止当前任务'))
    }
    const send = (): Promise<L2ChatSendResponse> =>
      record.workSession.send({ mode: input.mode, text: input.text, images: input.images })
    if (!record.compactionStart) return this.enqueueCommand(record, send)
    if (!record.acceptingCommands || this.pluginChangeFrozen) {
      return Promise.reject(new L2ChatLifecycleBlockedError(record.source.workId))
    }
    return record.compactionStart.then((started) => {
      if (!record.acceptingCommands || this.pluginChangeFrozen) {
        throw new L2ChatLifecycleBlockedError(record.source.workId)
      }
      return started ? send() : this.enqueueCommand(record, send)
    })
  }

  interrupt(source: L2ChatSource): Promise<void> {
    const record = this.currentRecord(source)
    if (this.pluginChangeFrozen) {
      return Promise.reject(new L2ChatLifecycleBlockedError(record.source.workId))
    }
    // 等待回答的命令占有串行链；停止必须先解除该等待。
    if (getL4PiWorkSessionRuntime(source.sessionId).nativeUi.hasPending) {
      return record.workSession.interrupt()
    }
    return this.enqueueCommand(record, () => record.workSession.interrupt())
  }

  compact(source: L2ChatSource): Promise<void> {
    const record = this.currentRecord(source)
    if (record.compactionStart) return Promise.reject(new Error('上下文正在压缩'))

    let resolveStart!: (started: boolean) => void
    const compactionStart = new Promise<boolean>((resolve) => {
      resolveStart = resolve
    })
    record.compactionStart = compactionStart
    const operation = this.enqueueCommand(record, () => {
      try {
        const compact = getL4PiWorkSessionRuntime(record.source.sessionId).compact()
        resolveStart(true)
        return compact
      } catch (error) {
        resolveStart(false)
        throw error
      }
    })
    void operation.then(
      () => {
        resolveStart(false)
        if (record.compactionStart === compactionStart) record.compactionStart = null
      },
      () => {
        resolveStart(false)
        if (record.compactionStart === compactionStart) record.compactionStart = null
      }
    )
    return operation
  }

  reload(source: L2ChatSource, mode?: L2ChatMode): Promise<void> {
    const record = this.currentRecord(source)
    if (this.pluginChangeFrozen) {
      return Promise.reject(new L2ChatLifecycleBlockedError(record.source.workId))
    }
    getL4PiWorkSessionRuntime(source.sessionId).nativeUi.cancelAll()
    return this.enqueueCommand(record, async () => {
      try {
        await getL4PiWorkSessionRuntime(record.source.sessionId).reload(mode)
      } finally {
        if (this.recordsByWorkId.get(source.workId) === record) {
          await this.syncRecordRuntime(record)
          if (
            record.state.runtime.extensionMode === 'basic' &&
            record.state.runtime.presentationMode !== 'basic'
          ) {
            this.reprojectRecord(record, 'basic')
          }
        }
      }
    })
  }

  restoreQueuedMessages(source: L2ChatSource): Promise<L2ChatQueueRestoreResponse> {
    const record = this.currentRecord(source)
    return this.enqueueCommand(record, () => record.workSession.restoreQueuedMessages())
  }

  setModel(input: L2ChatModelSetRequest): Promise<void> {
    const record = this.currentRecord(input.source)
    return this.enqueueCommand(record, () => record.workSession.setModel(input.model))
  }

  setCapabilityMode(input: L2ChatCapabilityModeSetRequest): Promise<void> {
    const record = this.currentRecord(input.source)
    return this.enqueueCommand(record, () =>
      getL4PiWorkSessionRuntime(record.source.sessionId).setCapabilityMode(input.capabilityMode)
    )
  }

  invokePluginMethod(
    input: Extract<L2PluginInvokeRequest, { scope: 'session' }>
  ): Promise<L2PluginInvokeResponse> {
    const record = this.currentRecord(input.source)
    return this.enqueueCommand(record, () =>
      getL4PiWorkSessionRuntime(record.source.sessionId).invokePluginMethod(
        record.source,
        input.pluginName,
        input.method,
        input.input
      )
    )
  }

  listNativeCommands(source: L2ChatSource): Promise<readonly L4PiNativeCommandInfo[]> {
    const record = this.currentRecord(source)
    return this.enqueueCommand(record, () =>
      getL4PiWorkSessionRuntime(record.source.sessionId).listNativeCommands()
    )
  }

  executeNativeCommand(source: L2ChatSource, command: string, args: string): Promise<void> {
    const record = this.currentRecord(source)
    return this.enqueueCommand(record, () =>
      getL4PiWorkSessionRuntime(record.source.sessionId).executeNativeCommand(command, args)
    )
  }

  listNativeTools(source: L2ChatSource): Promise<readonly L4PiNativeToolInfo[]> {
    const record = this.currentRecord(source)
    return this.enqueueCommand(record, () =>
      getL4PiWorkSessionRuntime(record.source.sessionId).listNativeTools()
    )
  }

  executeDirectBash(
    source: L2ChatSource,
    input: L4PiDirectBashInput
  ): Promise<L4PiDirectBashResult> {
    const record = this.currentRecord(source)
    if (record.directBashActive) {
      return Promise.reject(new L4PiDirectBashRunningError())
    }
    record.directBashActive = true
    return this.enqueueCommand(record, () =>
      getL4PiWorkSessionRuntime(record.source.sessionId).executeDirectBash(input)
    ).finally(() => {
      record.directBashActive = false
    })
  }

  abortDirectBash(source: L2ChatSource): Promise<void> {
    const record = this.currentRecord(source)
    if (this.pluginChangeFrozen) {
      return Promise.reject(new L2ChatLifecycleBlockedError(record.source.workId))
    }
    return getL4PiWorkSessionRuntime(record.source.sessionId).abortDirectBash()
  }

  subscribe(listener: L2WorkSessionChatRuntimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeRecordChanges(listener: L2WorkSessionChatRecordListener): () => void {
    this.recordListeners.add(listener)
    return () => this.recordListeners.delete(listener)
  }

  subscribePluginPush(listener: L2WorkSessionPluginPushListener): () => void {
    this.pluginPushListeners.add(listener)
    return () => this.pluginPushListeners.delete(listener)
  }

  private buildRecord(workSession: WorkSession): L2WorkSessionChatRecord {
    const source = this.sourceFor(workSession)
    const runtime = getL4PiWorkSessionRuntime(workSession.sessionId)
    const snapshot = runtime.readChatSnapshot()
    const messages = snapshot.entries.map((entry, index) =>
      projectL3ConversationDurableMessage(
        index,
        entry.entryId,
        entry.timestampMs,
        entry.message,
        source,
        isL4PiDeskSafeMode()
      )
    )
    const state = L2ChatSourceStateSchema.parse({
      messages,
      temporaryMessages: [],
      runtime: {
        ...L2_EMPTY_CHAT_RUNTIME,
        extensionMode: isL4PiDeskSafeMode() ? 'basic' : 'normal',
        presentationMode: isL4PiDeskSafeMode() ? 'basic' : 'normal'
      }
    })
    const firstUser = state.messages.find((message) => message.fixed.type === 'user')
    const firstUserSummary = firstUser ? L2ChatUserSummarySchema.safeParse(firstUser.summary) : null
    const firstUserTitle = firstUserSummary?.success
      ? firstUserSummary.data.text.trim() || null
      : null
    const record: L2WorkSessionChatRecord = {
      workSession,
      source,
      state,
      sourceEventVersion: 0,
      forceFullSync: isL4PiDeskSafeMode(),
      rawTemporaryMessages: new Map(),
      metadata: {
        sessionTitle: snapshot.sessionName ?? firstUserTitle,
        messageCounts: {
          user: state.messages.filter((message) => message.fixed.type === 'user').length,
          total: state.messages.length
        },
        lastMessageUpdatedAt: state.messages.at(-1)?.fixed.timestampMs ?? null
      },
      mainRunning: false,
      backgroundTaskIds: new Set(runtime.readChatBackgroundTaskIds()),
      completedPending: false,
      acceptingCommands: true,
      directBashActive: false,
      compactionStart: null,
      commandTail: Promise.resolve(),
      pendingCommands: 0,
      unsubscribeWorker: () => undefined
    }
    record.unsubscribeWorker = runtime.subscribeChat((event) =>
      this.handleWorkerEvent(record, event)
    )
    return record
  }

  private handleWorkerEvent(record: L2WorkSessionChatRecord, event: L4PiChatWorkerEvent): void {
    if (this.recordsByWorkId.get(record.source.workId) !== record) return
    const previousMetadata = record.metadata
    const previousStatus = this.statusForRecord(record)

    switch (event.type) {
      case 'message_start':
        record.rawTemporaryMessages.set(event.tempId, snapshotTemporaryMessage(event.message))
        this.applySourceEvent(record.source, {
          type: 'message_start',
          snapshot: projectL3ConversationTemporaryMessage(
            event.tempId,
            event.message,
            record.source,
            false,
            'temporary',
            record.state.runtime.presentationMode === 'basic'
          )
        })
        return
      case 'message_update': {
        const current = record.state.temporaryMessages.find(
          (message) => message.location.tempId === event.tempId
        )
        if (!current) throw new Error(`Temporary chat message was not found: ${event.tempId}`)
        record.rawTemporaryMessages.set(event.tempId, snapshotTemporaryMessage(event.message))
        const update = buildL3ConversationMessageUpdate(
          current,
          projectL3ConversationTemporaryMessage(
            event.tempId,
            event.message,
            record.source,
            false,
            'update',
            record.state.runtime.presentationMode === 'basic'
          )
        )
        if (update) this.applySourceEvent(record.source, update)
        return
      }
      case 'message_commit': {
        const current = record.state.temporaryMessages.find(
          (message) => message.location.tempId === event.tempId
        )
        if (!current) throw new Error(`Temporary chat message was not found: ${event.tempId}`)
        const publicFinal = projectL3ConversationTemporaryMessage(
          event.tempId,
          event.message,
          record.source,
          false,
          'final',
          record.state.runtime.presentationMode === 'basic'
        )
        const update = buildL3ConversationMessageUpdate(current, publicFinal)
        if (update) this.applySourceEvent(record.source, update)
        this.replaceCanonicalTemporary(record, event.tempId, event.message)
        record.rawTemporaryMessages.delete(event.tempId)
        this.applySourceEvent(record.source, {
          type: 'message_commit',
          location: { tempId: event.tempId },
          durable: {
            index: record.state.messages.length,
            entryId: event.entryId
          },
          fixed: { timestampMs: event.timestampMs }
        })
        return
      }
      case 'message_discard':
        record.rawTemporaryMessages.delete(event.tempId)
        this.applySourceEvent(record.source, {
          type: 'message_discard',
          location: { tempId: event.tempId }
        })
        return
      case 'plugin_push':
        this.publishPluginPush({
          pluginName: event.pluginName,
          target: { scope: 'session', source: record.source },
          event: event.event,
          data: structuredClone(event.data)
        })
        return
      case 'runtime_changed': {
        const runtime = L2ChatRuntimeSchema.parse({
          ...event.runtime,
          presentationMode: record.state.runtime.presentationMode
        })
        if (!sameRuntime(record.state.runtime, runtime)) {
          this.applySourceEvent(record.source, { type: 'runtime_update', runtime })
        }
        if (
          runtime.extensionMode === 'basic' &&
          record.state.runtime.presentationMode !== 'basic'
        ) {
          this.reprojectRecord(record, 'basic')
        }
        return
      }
      case 'agent_started':
        if (record.mainRunning) return
        record.mainRunning = true
        record.completedPending = false
        this.publishRecordChanged(record.source.workId, previousMetadata, previousStatus)
        return
      case 'main_operation_cancelled':
      case 'main_operation_finished':
        if (!record.mainRunning) return
        record.mainRunning = false
        record.completedPending = false
        this.publishRecordChanged(record.source.workId, previousMetadata, previousStatus)
        return
      case 'agent_settled': {
        const wasRunning = record.mainRunning || record.backgroundTaskIds.size > 0
        record.mainRunning = false
        if (wasRunning && record.backgroundTaskIds.size === 0) record.completedPending = true
        this.publishRecordChanged(record.source.workId, previousMetadata, previousStatus)
        return
      }
      case 'background_tasks_changed': {
        const wasRunning = record.mainRunning || record.backgroundTaskIds.size > 0
        record.backgroundTaskIds = new Set(event.taskIds)
        if (wasRunning && !record.mainRunning && record.backgroundTaskIds.size === 0) {
          record.completedPending = true
        }
        this.publishRecordChanged(record.source.workId, previousMetadata, previousStatus)
        return
      }
      case 'session_info_changed':
        record.metadata = { ...record.metadata, sessionTitle: event.sessionTitle }
        this.publishRecordChanged(record.source.workId, previousMetadata, previousStatus)
        return
    }
  }

  private replaceCanonicalTemporary(
    record: L2WorkSessionChatRecord,
    tempId: string,
    message: L4PiChatMessage
  ): void {
    const index = record.state.temporaryMessages.findIndex(
      (candidate) => candidate.location.tempId === tempId
    )
    if (index < 0) throw new Error(`Temporary chat message was not found: ${tempId}`)
    const temporaryMessages = [...record.state.temporaryMessages]
    temporaryMessages[index] = projectL3ConversationTemporaryMessage(
      tempId,
      message,
      record.source,
      true,
      'final',
      record.state.runtime.presentationMode === 'basic'
    )
    record.state = { ...record.state, temporaryMessages }
  }

  private applySourceEvent(sourceInput: L2ChatSource, event: L2ChatSourceEvent): void {
    const record = this.currentRecord(sourceInput)
    const source = record.source
    record.state = applyL2ChatSourceEvent(record.state, event)
    record.sourceEventVersion += 1

    if (event.type === 'message_commit') {
      const committed = record.state.messages[event.durable.index]
      if (!committed || committed.location.entryId !== event.durable.entryId) {
        throw new Error(
          `Committed chat message is missing: ${event.durable.index}/${event.durable.entryId}`
        )
      }
      const previousMetadata = record.metadata
      record.metadata = this.metadataFromState(record)
      this.publishRecordChanged(source.workId, previousMetadata, this.statusForRecord(record))
    }

    this.publish({
      type: 'source_event',
      source,
      version: record.sourceEventVersion,
      event
    })
  }

  private metadataFromState(record: L2WorkSessionChatRecord): L2WorkSessionChatMetadata {
    const firstUser = record.state.messages.find((message) => message.fixed.type === 'user')
    const firstUserSummary = firstUser ? L2ChatUserSummarySchema.safeParse(firstUser.summary) : null
    const derivedTitle = firstUserSummary?.success
      ? firstUserSummary.data.text.trim() || null
      : null
    return {
      sessionTitle: record.metadata.sessionTitle ?? derivedTitle,
      messageCounts: {
        user: record.state.messages.filter((message) => message.fixed.type === 'user').length,
        total: record.state.messages.length
      },
      lastMessageUpdatedAt: record.state.messages.at(-1)?.fixed.timestampMs ?? null
    }
  }

  private enqueueCommand<T>(
    record: L2WorkSessionChatRecord,
    command: () => Promise<T>
  ): Promise<T> {
    if (!record.acceptingCommands || this.pluginChangeFrozen) {
      return Promise.reject(new L2ChatLifecycleBlockedError(record.source.workId))
    }
    record.pendingCommands += 1
    const operation = record.commandTail.then(command, command).finally(() => {
      record.pendingCommands -= 1
    })
    record.commandTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private pluginReloadBlockReason(record: L2WorkSessionChatRecord): string | null {
    if (getL4PiWorkSessionRuntime(record.source.sessionId).nativeUi.hasPending)
      return '原生插件问题正在等待回答'
    if (record.directBashActive) return 'Direct Bash 正在运行'
    if (record.mainRunning) return '主 Agent 正在运行'
    if (record.backgroundTaskIds.size > 0) return '插件后台任务正在运行'
    return getL4PiWorkSessionRuntime(record.source.sessionId).readPluginReloadBlockReason()
  }

  private async closeRecord(workId: string): Promise<void> {
    const record = this.recordsByWorkId.get(workId)
    if (!record) return
    record.acceptingCommands = false
    getL4PiWorkSessionRuntime(record.source.sessionId).nativeUi.cancelAll()
    await record.commandTail
    record.unsubscribeWorker()
    record.rawTemporaryMessages.clear()
    this.recordsByWorkId.delete(workId)
  }

  private recordFor(workSession: WorkSession): L2WorkSessionChatRecord {
    const record = this.recordsByWorkId.get(workSession.workId)
    if (!record || !this.matches(record.source, this.sourceFor(workSession))) {
      throw new Error(`WorkSession chat state is not initialized: ${workSession.workId}`)
    }
    return record
  }

  private sourceFor(workSession: WorkSession): L2ChatSource {
    return L2ChatSourceSchema.parse({
      workId: workSession.workId,
      sessionId: workSession.sessionId,
      branchId: workSession.branchId
    })
  }

  private currentRecord(sourceInput: L2ChatSource): L2WorkSessionChatRecord {
    const source = L2ChatSourceSchema.parse(sourceInput)
    const record = this.recordsByWorkId.get(source.workId)
    if (!record || !this.matches(record.source, source)) throw new L2ChatSourceBindingError(source)
    return record
  }

  private recordForSession(sessionId: string, branchId: string): L2WorkSessionChatRecord {
    const record = [...this.recordsByWorkId.values()].find(
      (candidate) =>
        candidate.source.sessionId === sessionId && candidate.source.branchId === branchId
    )
    if (record) return record
    throw new L2ChatSourceBindingError({ workId: 'unknown', sessionId, branchId })
  }

  private matches(left: L2ChatSource, right: L2ChatSource): boolean {
    return (
      left.workId === right.workId &&
      left.sessionId === right.sessionId &&
      left.branchId === right.branchId
    )
  }

  private publishPluginPush(message: L3PluginPushMessage): void {
    for (const listener of [...this.pluginPushListeners]) {
      try {
        listener(message)
      } catch (error) {
        console.error('[Pi Desk][WorkSessionChatRuntime] Plugin Push 监听器执行失败', {
          pluginName: message.pluginName,
          event: message.event,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }

  private publish(event: L2WorkSessionChatRuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[Pi Desk][WorkSessionChatRuntime] Source 事件监听器执行失败', {
          eventType: event.type,
          workId: event.source.workId,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }

  private publishRecordChanged(
    workId: string,
    previousMetadata: L2WorkSessionChatMetadata,
    previousStatus: L2WorkSessionStatus
  ): void {
    for (const listener of [...this.recordListeners]) {
      try {
        listener(workId, previousMetadata, previousStatus)
      } catch (error) {
        console.error('[Pi Desk][WorkSessionChatRuntime] Record 监听器执行失败', {
          workId,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }
}
