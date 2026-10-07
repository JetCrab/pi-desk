import 'server-only'

import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import type { AgentSession, SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { TaskStatus } from '@jetcrab/pi-desk-sdk'
import {
  getL4TextLogPool,
  type L4TextLogEvent,
  type L4TextLogObservation,
  type L4TextLogSnapshot
} from '../file/l4-text-log-runtime'
import {
  projectL4PiAgentMessage,
  projectL4PiChatEntries,
  projectL4PiChatEntry,
  readL4PiChatImageContent,
  type L4PiChatMessage,
  type L4PiChatProjectedEntry
} from './l4-pi-chat-projection'
import {
  retainL4PiAgentToolRuntime,
  type L4PiAgentToolRuntime,
  type L4PiAgentToolRuntimeEvent,
  type L4PiAgentToolRuntimeLease
} from './l4-pi-agent-tool-runtime'
import {
  readL4PiReadonlySessionEntry,
  readL4PiReadonlySessionFile,
  readL4PiReadonlySessionImage
} from './l4-pi-readonly-session'
import type { L4PiTaskDetailSource } from './l4-pi-task-runtime'

export interface L4PiTaskDetailRecord {
  taskId: string
  status: TaskStatus
  detailSource: L4PiTaskDetailSource | null
  canInterrupt: boolean
}

export type L4PiTaskConversationEvent =
  | { type: 'durable_append'; entries: L4PiChatProjectedEntry[] }
  | { type: 'message_start'; tempId: string; message: L4PiChatMessage }
  | { type: 'message_update'; tempId: string; message: L4PiChatMessage }
  | {
      type: 'message_commit'
      tempId: string
      entryId: string
      timestampMs: number
    }
  | { type: 'message_discard'; tempId: string }

export type L4PiTaskDetailBody =
  | null
  | { kind: 'text'; text: string; truncated: boolean }
  | {
      kind: 'conversation'
      entries: L4PiChatProjectedEntry[]
      temporaryMessages: Array<{ tempId: string; message: L4PiChatMessage }>
      truncated: boolean
    }

export interface L4PiTaskDetailSnapshot {
  taskId: string
  canInterrupt: boolean
  body: L4PiTaskDetailBody
}

export type L4PiTaskDetailEvent =
  | { type: 'snapshot'; snapshot: L4PiTaskDetailSnapshot }
  | { type: 'text_append'; text: string }
  | { type: 'conversation_event'; event: L4PiTaskConversationEvent }
  | { type: 'unavailable' }

type L4PiTaskDetailListener = (event: L4PiTaskDetailEvent) => void

type L4PiTaskSourceEvent =
  | { type: 'snapshot' }
  | { type: 'text_append'; text: string }
  | { type: 'conversation_event'; event: L4PiTaskConversationEvent }
  | { type: 'unavailable' }

interface L4PiTaskSourceRuntime {
  snapshot(): L4PiTaskDetailBody
  subscribe(listener: (event: L4PiTaskSourceEvent) => void): () => void
  dispose(): void
}

interface L4PiTaskDetailSharedRuntime {
  sourceRuntime: L4PiTaskSourceRuntime
  sourceIdentity: unknown
  canInterrupt: boolean
  listeners: Set<L4PiTaskDetailListener>
  unsubscribeSource: () => void
}

export interface L4PiTaskDetailWatch {
  snapshot: L4PiTaskDetailSnapshot
  readSnapshot: () => L4PiTaskDetailSnapshot
  release: () => void
}

const FILE_REFRESH_INTERVAL_MS = 500
const FILE_WATCH_DEBOUNCE_MS = 40

function messageRole(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const role = (message as { role?: unknown }).role
  return typeof role === 'string' ? role : null
}

function toolResultId(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const value = (message as { toolCallId?: unknown }).toolCallId
  return typeof value === 'string' ? value : null
}

function timestampFromEntry(entryId: string, timestamp: string): number {
  const value = Date.parse(timestamp)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi session entry has an invalid timestamp: ${entryId}`)
  }
  return value
}

function taskSourceIdentity(source: L4PiTaskDetailSource | null): unknown {
  if (source === null) return null
  if (source.kind === 'text-file') return `text:${source.path}`
  return source.session !== undefined ? source.session : `session-file:${source.sessionFile}`
}

function publishSafely<T>(listeners: Iterable<(event: T) => void>, event: T, label: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      console.error('[Pi Desk][TaskDetailRuntime] 事件监听器执行失败', {
        label,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
    }
  }
}

class L4PiEmptyTaskSourceRuntime implements L4PiTaskSourceRuntime {
  snapshot(): null {
    return null
  }

  subscribe(): () => void {
    return () => undefined
  }

  dispose(): void {}
}

class L4PiTextTaskSourceRuntime implements L4PiTaskSourceRuntime {
  private readonly listeners = new Set<(event: L4PiTaskSourceEvent) => void>()
  private current: L4TextLogSnapshot
  private disposed = false

  private constructor(
    private readonly path: string,
    initial: L4TextLogSnapshot,
    private readonly observation: L4TextLogObservation
  ) {
    this.current = initial
  }

  static async create(path: string): Promise<L4PiTextTaskSourceRuntime> {
    const queued: L4TextLogEvent[] = []
    let runtime: L4PiTextTaskSourceRuntime | null = null
    const observation = await getL4TextLogPool().observe(path, (event) => {
      if (runtime) runtime.handleLogEvent(event)
      else queued.push(event)
    })
    runtime = new L4PiTextTaskSourceRuntime(path, observation.snapshot, observation)
    for (const event of queued) runtime.handleLogEvent(event)
    return runtime
  }

  snapshot(): L4PiTaskDetailBody {
    return { kind: 'text', ...this.current }
  }

  subscribe(listener: (event: L4PiTaskSourceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.observation.release()
    this.listeners.clear()
  }

  private handleLogEvent(event: L4TextLogEvent): void {
    if (this.disposed) return
    if (event.type === 'snapshot') {
      this.current = { ...event.snapshot }
      publishSafely(this.listeners, { type: 'snapshot' }, this.path)
      return
    }
    if (event.type === 'text_append') {
      this.current = { ...this.current, text: this.current.text + event.text }
      publishSafely(this.listeners, event, this.path)
      return
    }
    publishSafely(this.listeners, event, this.path)
  }
}

class L4PiSessionFileTaskSourceRuntime implements L4PiTaskSourceRuntime {
  private readonly listeners = new Set<(event: L4PiTaskSourceEvent) => void>()
  private watcher: FSWatcher | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private refreshPromise: Promise<void> | null = null
  private current: Awaited<ReturnType<typeof readL4PiReadonlySessionFile>>
  private disposed = false

  private constructor(
    private readonly sessionFile: string,
    initial: Awaited<ReturnType<typeof readL4PiReadonlySessionFile>>
  ) {
    this.current = initial
  }

  static async create(sessionFile: string): Promise<L4PiSessionFileTaskSourceRuntime> {
    const runtime = new L4PiSessionFileTaskSourceRuntime(
      sessionFile,
      await readL4PiReadonlySessionFile(sessionFile)
    )
    runtime.startWatching()
    return runtime
  }

  snapshot(): L4PiTaskDetailBody {
    return {
      kind: 'conversation',
      entries: this.current.entries,
      temporaryMessages: [],
      truncated: this.current.truncated
    }
  }

  subscribe(listener: (event: L4PiTaskSourceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.watcher?.close()
    if (this.interval) clearInterval(this.interval)
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.watcher = null
    this.interval = null
    this.refreshTimer = null
    this.listeners.clear()
  }

  private startWatching(): void {
    try {
      this.watcher = watch(this.sessionFile, () => this.scheduleRefresh())
      this.watcher.on('error', () => this.scheduleRefresh())
    } catch {
      this.watcher = null
    }
    this.interval = setInterval(() => this.scheduleRefresh(), FILE_REFRESH_INTERVAL_MS)
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, FILE_WATCH_DEBOUNCE_MS)
  }

  private refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      try {
        const next = await readL4PiReadonlySessionFile(this.sessionFile)
        if (this.disposed) return
        const previousIds = this.current.entries.map((entry) => entry.entryId)
        const nextIds = next.entries.map((entry) => entry.entryId)
        if (
          previousIds.length === nextIds.length &&
          previousIds.every((entryId, index) => entryId === nextIds[index])
        ) {
          this.current = next
          return
        }

        const prefixMatches =
          !this.current.truncated &&
          !next.truncated &&
          previousIds.every((entryId, index) => entryId === nextIds[index])
        const appended = prefixMatches ? next.entries.slice(previousIds.length) : []
        this.current = next
        if (appended.length > 0) {
          publishSafely(
            this.listeners,
            { type: 'conversation_event', event: { type: 'durable_append', entries: appended } },
            this.sessionFile
          )
        } else {
          publishSafely(this.listeners, { type: 'snapshot' }, this.sessionFile)
        }
      } catch (error) {
        console.warn('[Pi Desk][TaskSessionFileDetail] 刷新会话失败', {
          sessionFile: this.sessionFile,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        publishSafely(this.listeners, { type: 'unavailable' }, this.sessionFile)
      }
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }
}

interface L4PiActiveMessage {
  tempId: string
  started: boolean
  toolCallId: string | null
}

class L4PiAgentSessionTaskSourceRuntime implements L4PiTaskSourceRuntime {
  private readonly listeners = new Set<(event: L4PiTaskSourceEvent) => void>()
  private readonly temporaryMessages = new Map<string, L4PiChatMessage>()
  private readonly temporaryOrder: string[] = []
  private readonly pendingEvents: L4PiTaskConversationEvent[] = []
  private readonly toolRuntimeLease: L4PiAgentToolRuntimeLease
  private readonly toolRuntime: L4PiAgentToolRuntime
  private readonly unsubscribeToolRuntime: () => void
  private readonly unsubscribeAgent: () => void
  private entries: L4PiChatProjectedEntry[]
  private activeMessage: L4PiActiveMessage | null = null
  private drainScheduled = false
  private disposed = false

  constructor(private readonly session: AgentSession) {
    this.toolRuntimeLease = retainL4PiAgentToolRuntime(session)
    this.toolRuntime = this.toolRuntimeLease.runtime
    this.unsubscribeToolRuntime = this.toolRuntime.subscribe((event) =>
      this.captureToolEvent(event)
    )
    this.unsubscribeAgent = session.agent.subscribe((event) => {
      try {
        this.captureAgentEvent(event)
      } catch (error) {
        console.error('[Pi Desk][TaskAgentDetail] 捕获 AgentEvent 失败', {
          sessionId: session.sessionId,
          eventType: event.type,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    })

    this.entries = projectL4PiChatEntries(session.sessionManager.getBranch())
    for (const tool of this.toolRuntime.activeMessages()) {
      this.setTemporary(tool.tempId, tool.message)
    }

    const streaming = session.agent.state.streamingMessage
    if (streaming) {
      const projected = projectL4PiAgentMessage(streaming)
      if (projected) {
        const tempId = randomUUID()
        this.activeMessage = { tempId, started: true, toolCallId: null }
        this.setTemporary(tempId, projected)
        this.toolRuntime.syncStreamingTools(streaming, false)
        for (const tool of this.toolRuntime.activeMessages()) {
          this.setTemporary(tool.tempId, tool.message)
        }
      }
    }
  }

  snapshot(): L4PiTaskDetailBody {
    return {
      kind: 'conversation',
      entries: this.entries,
      temporaryMessages: this.temporaryOrder.flatMap((tempId) => {
        const message = this.temporaryMessages.get(tempId)
        return message ? [{ tempId, message }] : []
      }),
      truncated: false
    }
  }

  subscribe(listener: (event: L4PiTaskSourceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeAgent()
    this.unsubscribeToolRuntime()
    this.toolRuntimeLease.release()
    this.listeners.clear()
    this.pendingEvents.length = 0
    this.temporaryMessages.clear()
    this.temporaryOrder.length = 0
  }

  private captureAgentEvent(event: AgentEvent): void {
    if (this.disposed) return
    switch (event.type) {
      case 'message_start':
        this.startMessage(event.message)
        return
      case 'message_update':
        this.updateMessage(event.message)
        this.toolRuntime.syncStreamingTools(event.message)
        return
      case 'message_end':
        this.toolRuntime.syncStreamingTools(event.message)
        this.endMessage(event.message)
        return
      default:
        return
    }
  }

  private captureToolEvent(event: L4PiAgentToolRuntimeEvent): void {
    if (this.disposed) return
    if (event.type === 'message_discard') {
      this.removeTemporary(event.tempId)
      this.queueEvent(event)
      return
    }
    this.setTemporary(event.tempId, event.message)
    this.queueEvent(event)
  }

  private startMessage(messageInput: SessionMessageEntry['message']): void {
    const role = messageRole(messageInput)
    let tempId: string = randomUUID()
    let started = true
    let toolCallId: string | null = null
    if (role === 'toolResult') {
      toolCallId = toolResultId(messageInput)
      const toolTempId = toolCallId ? this.toolRuntime.tempId(toolCallId) : null
      if (toolTempId) {
        tempId = toolTempId
        started = false
      }
    }
    const message = this.projectLiveMessage(messageInput, toolCallId)
    if (!message) return
    this.activeMessage = { tempId, started, toolCallId }
    this.setTemporary(tempId, message)
    this.queueEvent({ type: started ? 'message_start' : 'message_update', tempId, message })
  }

  private updateMessage(messageInput: SessionMessageEntry['message']): void {
    const active = this.activeMessage
    if (!active) return
    const message = this.projectLiveMessage(messageInput, active.toolCallId)
    if (!message) return
    this.setTemporary(active.tempId, message)
    this.queueEvent({ type: 'message_update', tempId: active.tempId, message })
  }

  private endMessage(messageInput: SessionMessageEntry['message']): void {
    let active = this.activeMessage
    const role = messageRole(messageInput)
    const toolCallId = role === 'toolResult' ? toolResultId(messageInput) : null
    if (!active) {
      const message = this.projectLiveMessage(messageInput, toolCallId)
      if (!message) return
      active = { tempId: randomUUID(), started: true, toolCallId }
      this.setTemporary(active.tempId, message)
      this.queueEvent({ type: 'message_start', tempId: active.tempId, message })
    }

    const finalMessage = this.projectLiveMessage(messageInput, active.toolCallId)
    if (finalMessage) {
      this.setTemporary(active.tempId, finalMessage)
      this.queueEvent({ type: 'message_update', tempId: active.tempId, message: finalMessage })
    }

    const leaf = this.session.sessionManager.getLeafEntry()
    const projected = leaf ? projectL4PiChatEntry(leaf) : null
    if (leaf && projected) {
      if (!this.entries.some((entry) => entry.entryId === projected.entryId)) {
        this.entries = [...this.entries, projected]
      }
      this.removeTemporary(active.tempId)
      this.queueEvent({
        type: 'message_commit',
        tempId: active.tempId,
        entryId: projected.entryId,
        timestampMs: timestampFromEntry(leaf.id, leaf.timestamp)
      })
    } else if (active.started) {
      this.removeTemporary(active.tempId)
      this.queueEvent({ type: 'message_discard', tempId: active.tempId })
    }

    if (active.toolCallId) this.toolRuntime.remove(active.toolCallId)
    this.activeMessage = null
  }

  private projectLiveMessage(
    message: SessionMessageEntry['message'],
    toolCallId: string | null
  ): L4PiChatMessage | null {
    if (messageRole(message) !== 'toolResult' || !toolCallId) {
      return projectL4PiAgentMessage(message)
    }
    return this.toolRuntime.projectLiveResult(message, toolCallId)
  }

  private setTemporary(tempId: string, message: L4PiChatMessage): void {
    if (!this.temporaryMessages.has(tempId)) this.temporaryOrder.push(tempId)
    this.temporaryMessages.set(tempId, message)
  }

  private removeTemporary(tempId: string): void {
    this.temporaryMessages.delete(tempId)
    const index = this.temporaryOrder.indexOf(tempId)
    if (index >= 0) this.temporaryOrder.splice(index, 1)
  }

  private queueEvent(event: L4PiTaskConversationEvent): void {
    if (this.disposed) return
    if (event.type === 'message_update') {
      const previous = this.pendingEvents.at(-1)
      if (previous?.type === 'message_update' && previous.tempId === event.tempId) {
        this.pendingEvents[this.pendingEvents.length - 1] = event
      } else {
        this.pendingEvents.push(event)
      }
    } else {
      this.pendingEvents.push(event)
    }
    if (this.drainScheduled) return
    this.drainScheduled = true
    queueMicrotask(() => this.drainEvents())
  }

  private drainEvents(): void {
    this.drainScheduled = false
    if (this.disposed) return
    while (this.pendingEvents.length > 0) {
      const event = this.pendingEvents.shift()!
      publishSafely(this.listeners, { type: 'conversation_event', event }, this.session.sessionId)
    }
  }
}

async function createSourceRuntime(
  source: L4PiTaskDetailSource | null
): Promise<L4PiTaskSourceRuntime> {
  if (source === null) return new L4PiEmptyTaskSourceRuntime()
  if (source.kind === 'text-file') return L4PiTextTaskSourceRuntime.create(source.path)
  return source.session !== undefined
    ? new L4PiAgentSessionTaskSourceRuntime(source.session)
    : L4PiSessionFileTaskSourceRuntime.create(source.sessionFile)
}

export class L4PiTaskDetailPool {
  private readonly sharedByTaskId = new Map<string, L4PiTaskDetailSharedRuntime>()
  private operationTail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly readRecord: (taskId: string) => L4PiTaskDetailRecord | null) {}

  watch(taskId: string, listener: L4PiTaskDetailListener): Promise<L4PiTaskDetailWatch> {
    return this.enqueue(() => this.watchInternal(taskId, listener))
  }

  taskChanged(taskId: string): void {
    void this.enqueue(async () => {
      const shared = this.sharedByTaskId.get(taskId)
      if (!shared) return
      const record = this.readRecord(taskId)
      if (!record) {
        publishSafely(shared.listeners, { type: 'unavailable' }, taskId)
        this.disposeShared(taskId, shared)
        return
      }
      const identity = taskSourceIdentity(record.detailSource)
      if (identity !== shared.sourceIdentity) {
        await this.replaceShared(taskId, shared, record)
        return
      }
      if (shared.canInterrupt !== record.canInterrupt) {
        shared.canInterrupt = record.canInterrupt
        publishSafely(
          shared.listeners,
          { type: 'snapshot', snapshot: this.snapshot(taskId, shared) },
          taskId
        )
      }
    })
  }

  async readMessage(
    taskId: string,
    entryId: string
  ): Promise<{ index: number; entry: L4PiChatProjectedEntry }> {
    const record = this.readRecord(taskId)
    if (!record) throw new L4PiTaskDetailNotFoundError(taskId)
    const source = record.detailSource
    if (source?.kind !== 'pi-conversation') throw new L4PiTaskDetailUnsupportedError(taskId)
    if (source.session !== undefined) {
      const entries = projectL4PiChatEntries(source.session.sessionManager.getBranch())
      const index = entries.findIndex((entry) => entry.entryId === entryId)
      if (index < 0) throw new L4PiTaskMessageNotFoundError(entryId)
      return { index, entry: entries[index]! }
    }
    const result = await readL4PiReadonlySessionEntry(source.sessionFile, entryId)
    const index = result.snapshot.entries.findIndex((entry) => entry.entryId === entryId)
    if (index < 0) throw new L4PiTaskMessageNotFoundError(entryId)
    return { index, entry: result.projected }
  }

  async readImage(
    taskId: string,
    entryId: string,
    imageIndex: number
  ): Promise<{ mimeType: string; data: string }> {
    if (!Number.isSafeInteger(imageIndex) || imageIndex < 0) throw new Error('图片位置无效')
    const record = this.readRecord(taskId)
    if (!record) throw new L4PiTaskDetailNotFoundError(taskId)
    const source = record.detailSource
    if (source?.kind !== 'pi-conversation') throw new L4PiTaskDetailUnsupportedError(taskId)
    if (source.session === undefined) {
      return readL4PiReadonlySessionImage(source.sessionFile, entryId, imageIndex)
    }
    const branch = source.session.sessionManager.getBranch()
    if (!branch.some((entry) => entry.id === entryId))
      throw new L4PiTaskMessageNotFoundError(entryId)
    const entry = source.session.sessionManager.getEntry(entryId)
    if (
      entry?.type !== 'message' ||
      (entry.message.role !== 'user' && entry.message.role !== 'toolResult')
    ) {
      throw new L4PiTaskMessageNotFoundError(entryId)
    }
    const image = readL4PiChatImageContent(entry.message.content, imageIndex)
    if (!image) throw new L4PiTaskMessageNotFoundError(`${entryId}/${imageIndex}`)
    return image
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [taskId, shared] of this.sharedByTaskId) this.disposeShared(taskId, shared)
    this.sharedByTaskId.clear()
  }

  private async watchInternal(
    taskId: string,
    listener: L4PiTaskDetailListener
  ): Promise<L4PiTaskDetailWatch> {
    if (this.disposed) throw new Error('Task detail pool has been disposed')
    const record = this.readRecord(taskId)
    if (!record) throw new L4PiTaskDetailNotFoundError(taskId)

    let shared = this.sharedByTaskId.get(taskId)
    const identity = taskSourceIdentity(record.detailSource)
    if (!shared || shared.sourceIdentity !== identity) {
      shared?.unsubscribeSource()
      shared?.sourceRuntime.dispose()
      const sourceRuntime = await createSourceRuntime(record.detailSource)
      if (this.disposed) {
        sourceRuntime.dispose()
        throw new Error('Task detail pool was disposed during initialization')
      }
      shared = {
        sourceRuntime,
        sourceIdentity: identity,
        canInterrupt: record.canInterrupt,
        listeners: new Set(),
        unsubscribeSource: () => undefined
      }
      shared.unsubscribeSource = sourceRuntime.subscribe((event) =>
        this.handleSourceEvent(taskId, shared!, event)
      )
      this.sharedByTaskId.set(taskId, shared)
    }

    shared.canInterrupt = record.canInterrupt
    shared.listeners.add(listener)
    let released = false
    return {
      snapshot: this.snapshot(taskId, shared),
      readSnapshot: () => this.snapshot(taskId, shared!),
      release: () => {
        if (released) return
        released = true
        this.release(taskId, shared!, listener)
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private snapshot(taskId: string, shared: L4PiTaskDetailSharedRuntime): L4PiTaskDetailSnapshot {
    return {
      taskId,
      canInterrupt: shared.canInterrupt,
      body: shared.sourceRuntime.snapshot()
    }
  }

  private handleSourceEvent(
    taskId: string,
    shared: L4PiTaskDetailSharedRuntime,
    event: L4PiTaskSourceEvent
  ): void {
    if (this.sharedByTaskId.get(taskId) !== shared) return
    if (event.type === 'snapshot') {
      publishSafely(
        shared.listeners,
        { type: 'snapshot', snapshot: this.snapshot(taskId, shared) },
        taskId
      )
      return
    }
    publishSafely(shared.listeners, event, taskId)
  }

  private release(
    taskId: string,
    shared: L4PiTaskDetailSharedRuntime,
    listener: L4PiTaskDetailListener
  ): void {
    if (this.sharedByTaskId.get(taskId) !== shared) return
    shared.listeners.delete(listener)
    if (shared.listeners.size === 0) this.disposeShared(taskId, shared)
  }

  private disposeShared(taskId: string, shared: L4PiTaskDetailSharedRuntime): void {
    if (this.sharedByTaskId.get(taskId) === shared) this.sharedByTaskId.delete(taskId)
    shared.unsubscribeSource()
    shared.sourceRuntime.dispose()
    shared.listeners.clear()
  }

  private async replaceShared(
    taskId: string,
    previous: L4PiTaskDetailSharedRuntime,
    record: L4PiTaskDetailRecord
  ): Promise<void> {
    try {
      const sourceRuntime = await createSourceRuntime(record.detailSource)
      if (this.sharedByTaskId.get(taskId) !== previous) {
        sourceRuntime.dispose()
        return
      }
      previous.unsubscribeSource()
      previous.sourceRuntime.dispose()
      previous.sourceRuntime = sourceRuntime
      previous.sourceIdentity = taskSourceIdentity(record.detailSource)
      previous.canInterrupt = record.canInterrupt
      previous.unsubscribeSource = sourceRuntime.subscribe((event) =>
        this.handleSourceEvent(taskId, previous, event)
      )
      publishSafely(
        previous.listeners,
        { type: 'snapshot', snapshot: this.snapshot(taskId, previous) },
        taskId
      )
    } catch (error) {
      console.warn('[Pi Desk][TaskDetailPool] 替换详情来源失败', {
        taskId,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
      publishSafely(previous.listeners, { type: 'unavailable' }, taskId)
      this.disposeShared(taskId, previous)
    }
  }
}

export class L4PiTaskDetailNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task detail was not found: ${taskId}`)
    this.name = 'L4PiTaskDetailNotFoundError'
  }
}

export class L4PiTaskDetailUnsupportedError extends Error {
  constructor(taskId: string) {
    super(`Task does not provide conversation detail: ${taskId}`)
    this.name = 'L4PiTaskDetailUnsupportedError'
  }
}

export class L4PiTaskMessageNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Task conversation message was not found: ${entryId}`)
    this.name = 'L4PiTaskMessageNotFoundError'
  }
}
