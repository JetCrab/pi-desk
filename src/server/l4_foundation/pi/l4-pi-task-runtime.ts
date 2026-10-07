import 'server-only'

import { isAbsolute } from 'node:path'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { EventBusController } from '@earendil-works/pi-coding-agent'
import {
  TASK_REPORT_EVENT,
  type TaskDetailSource,
  type TaskInfoItem,
  type TaskInfoLoader,
  type TaskInterrupt,
  type TaskReportEvent,
  type TaskRuntimeSnapshot,
  type TaskStatus
} from '@jetcrab/pi-desk-sdk'
import {
  L4PiTaskDetailPool,
  type L4PiTaskDetailEvent,
  type L4PiTaskDetailWatch
} from './l4-pi-task-detail-runtime'
import {
  retainL4PiAgentToolRuntime,
  type L4PiAgentToolRuntimeLease
} from './l4-pi-agent-tool-runtime'

export interface L4PiTaskSummary {
  taskId: string
  taskKind: string | null
  taskType: string | null
  title: string
  info: TaskInfoItem[]
  status: TaskStatus
  activity: string | null
  startedAt: number
  endedAt: number | null
}

export type L4PiTaskDetailSource = TaskDetailSource

export interface L4PiTaskRecord extends L4PiTaskSummary {
  detailSource: L4PiTaskDetailSource | null
  interrupt: TaskInterrupt | null
}

interface L4PiTaskRuntimeOptions {
  onChanged: (summaries: readonly L4PiTaskSummary[], activeTaskIds: readonly string[]) => void
  onInvalidReport: (cause: unknown) => void
}

const TERMINAL_HISTORY_LIMIT = 100
const TASK_ACTIVITY_MAX_LENGTH = 300

function nonEmptyText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} must contain 1-${maxLength} characters`)
  }
  return normalized
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  return value === undefined || value === null ? null : nonEmptyText(value, field, maxLength)
}

function taskActivity(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('Task activity must be a string')
  const normalized = value.trim()
  if (!normalized) return null
  return normalized.length <= TASK_ACTIVITY_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, TASK_ACTIVITY_MAX_LENGTH - 1)}…`
}

function taskInfo(value: unknown): TaskInfoItem[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error('Task info must be an array with at most 12 items')
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Task info ${index} must be an object`)
    }
    const input = item as { label?: unknown; value?: unknown }
    return {
      label: nonEmptyText(input.label, `Task info ${index} label`, 64),
      value: nonEmptyText(input.value, `Task info ${index} value`, 500)
    }
  })
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative Unix millisecond timestamp`)
  }
  return value
}

function normalizeInfoLoader(value: unknown): TaskInfoLoader | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'function') throw new Error('Task infoLoader must be a function')
  return value as TaskInfoLoader
}

function sameTaskInfo(left: readonly TaskInfoItem[], right: readonly TaskInfoItem[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index]
      return item.label === other?.label && item.value === other.value
    })
  )
}

function status(value: unknown): TaskStatus {
  switch (value) {
    case 'running':
    case 'completed':
    case 'failed':
    case 'stopped':
    case 'interrupted':
      return value
    default:
      throw new Error('Task status is invalid')
  }
}

function isAgentSession(value: unknown): value is AgentSession {
  if (!value || typeof value !== 'object') return false
  const session = value as Partial<AgentSession>
  return (
    typeof session.sessionId === 'string' &&
    typeof session.sessionManager?.getBranch === 'function' &&
    typeof session.agent?.subscribe === 'function'
  )
}

function detailSource(value: unknown): L4PiTaskDetailSource | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('Task detailSource is invalid')
  const source = value as {
    kind?: unknown
    path?: unknown
    session?: unknown
    sessionFile?: unknown
  }
  if (source.kind === 'text-file') {
    const path = nonEmptyText(source.path, 'Task text-file path', 32_768)
    if (!isAbsolute(path)) throw new Error('Task text-file path must be absolute')
    return { kind: 'text-file', path }
  }
  if (source.kind !== 'pi-conversation') throw new Error('Task detailSource kind is invalid')
  if (source.session !== undefined) {
    if (!isAgentSession(source.session)) throw new Error('Task AgentSession is invalid')
    return { kind: 'pi-conversation', session: source.session }
  }
  const sessionFile = nonEmptyText(source.sessionFile, 'Task sessionFile', 32_768)
  if (!isAbsolute(sessionFile)) throw new Error('Task sessionFile must be absolute')
  return { kind: 'pi-conversation', sessionFile }
}

interface NormalizedTaskRecord {
  record: L4PiTaskRecord
  infoLoader: TaskInfoLoader | null
}

function normalizeRecord(value: unknown): NormalizedTaskRecord {
  if (!value || typeof value !== 'object') throw new Error('Task snapshot is invalid')
  const input = value as Partial<TaskRuntimeSnapshot>
  const taskStatus = status(input.status)
  const endedAt = input.endedAt === null ? null : timestamp(input.endedAt, 'Task endedAt')
  if (taskStatus === 'running' && endedAt !== null) {
    throw new Error('Running task requires endedAt=null')
  }
  if (taskStatus !== 'running' && endedAt === null) {
    throw new Error('Terminal task requires endedAt')
  }

  let source = detailSource(input.detailSource)
  if (taskStatus !== 'running' && source?.kind === 'pi-conversation' && source.session) {
    const sessionFile = source.session.sessionFile
    source = sessionFile ? { kind: 'pi-conversation', sessionFile } : null
  }

  return {
    record: {
      taskId: nonEmptyText(input.taskId, 'Task id', 200),
      taskKind: optionalText(input.taskKind, 'Task kind', 100),
      taskType: optionalText(input.taskType, 'Task type', 100),
      title: nonEmptyText(input.title, 'Task title', 200),
      info: taskInfo(input.info),
      status: taskStatus,
      activity: taskActivity(input.activity),
      startedAt: timestamp(input.startedAt, 'Task startedAt'),
      endedAt,
      detailSource: source,
      interrupt:
        taskStatus === 'running' && typeof input.interrupt === 'function' ? input.interrupt : null
    },
    infoLoader: normalizeInfoLoader(input.infoLoader)
  }
}

function summary(record: L4PiTaskRecord): L4PiTaskSummary {
  const { detailSource: _detailSource, interrupt: _interrupt, ...result } = record
  return { ...result, info: result.info.map((item) => ({ ...item })) }
}

function orderedRecords(records: Iterable<L4PiTaskRecord>): L4PiTaskRecord[] {
  const active: L4PiTaskRecord[] = []
  const terminal: L4PiTaskRecord[] = []
  for (const record of records) {
    if (record.status === 'running') active.push(record)
    else terminal.push(record)
  }
  terminal.sort(
    (left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0) || right.startedAt - left.startedAt
  )
  return [...active, ...terminal.slice(0, TERMINAL_HISTORY_LIMIT)].sort(
    (left, right) => right.startedAt - left.startedAt
  )
}

interface TaskInfoRuntime {
  loader: TaskInfoLoader
  promise: Promise<void> | null
}

interface TaskToolRuntimeOwner {
  session: AgentSession
  lease: L4PiAgentToolRuntimeLease
}

export class L4PiTaskRuntime {
  private readonly records = new Map<string, L4PiTaskRecord>()
  private readonly infoRuntimes = new Map<string, TaskInfoRuntime>()
  private readonly toolRuntimeOwners = new Map<string, TaskToolRuntimeOwner>()
  private readonly detailPool: L4PiTaskDetailPool
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(
    controller: EventBusController,
    private readonly options: L4PiTaskRuntimeOptions
  ) {
    this.detailPool = new L4PiTaskDetailPool((taskId) => {
      const record = this.records.get(taskId)
      return record
        ? {
            taskId: record.taskId,
            status: record.status,
            detailSource: record.detailSource,
            canInterrupt: record.status === 'running' && record.interrupt !== null
          }
        : null
    })
    this.unsubscribe = controller.on(TASK_REPORT_EVENT, (input) => {
      if (this.disposed) return
      try {
        this.apply(input)
      } catch (error) {
        this.options.onInvalidReport(error)
      }
    })
  }

  summaries(): L4PiTaskSummary[] {
    return orderedRecords(this.records.values()).map(summary)
  }

  activeTaskIds(): string[] {
    return [...this.records.values()]
      .filter((record) => record.status === 'running')
      .map((record) => record.taskId)
      .sort()
  }

  record(taskId: string): L4PiTaskRecord | null {
    return this.records.get(taskId) ?? null
  }

  async watchDetail(
    taskId: string,
    listener: (event: L4PiTaskDetailEvent) => void
  ): Promise<L4PiTaskDetailWatch> {
    await this.loadInfo(taskId)
    return this.detailPool.watch(taskId, listener)
  }

  readMessage(taskId: string, entryId: string) {
    return this.detailPool.readMessage(taskId, entryId)
  }

  readImage(taskId: string, entryId: string, imageIndex: number) {
    return this.detailPool.readImage(taskId, entryId, imageIndex)
  }

  async interrupt(taskId: string): Promise<void> {
    const record = this.records.get(taskId)
    if (!record) throw new L4PiTaskNotFoundError(taskId)
    if (record.status !== 'running' || !record.interrupt) {
      throw new L4PiTaskNotInterruptibleError(taskId)
    }
    await record.interrupt()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.detailPool.dispose()
    for (const owner of this.toolRuntimeOwners.values()) owner.lease.release()
    this.toolRuntimeOwners.clear()
    this.records.clear()
    this.infoRuntimes.clear()
  }

  private setToolRuntime(taskId: string, source: L4PiTaskDetailSource | null): void {
    const session = source?.kind === 'pi-conversation' ? source.session : undefined
    const current = this.toolRuntimeOwners.get(taskId)
    if (current?.session === session) return

    current?.lease.release()
    if (!session) {
      this.toolRuntimeOwners.delete(taskId)
      return
    }
    this.toolRuntimeOwners.set(taskId, {
      session,
      lease: retainL4PiAgentToolRuntime(session)
    })
  }

  private releaseToolRuntime(taskId: string): void {
    this.toolRuntimeOwners.get(taskId)?.lease.release()
    this.toolRuntimeOwners.delete(taskId)
  }

  private setInfoLoader(taskId: string, loader: TaskInfoLoader | null): void {
    const current = this.infoRuntimes.get(taskId)
    if (loader && current?.loader === loader) return
    if (!loader) {
      this.infoRuntimes.delete(taskId)
      return
    }
    this.infoRuntimes.set(taskId, { loader, promise: null })
  }

  private async loadInfo(taskId: string): Promise<void> {
    const runtime = this.infoRuntimes.get(taskId)
    if (!runtime) return
    if (runtime.promise) return runtime.promise

    const promise = (async (): Promise<void> => {
      try {
        if (!this.records.has(taskId)) return
        const nextInfo = taskInfo(await runtime.loader())
        if (this.infoRuntimes.get(taskId) !== runtime) return
        this.infoRuntimes.delete(taskId)
        const record = this.records.get(taskId)
        if (!record || sameTaskInfo(record.info, nextInfo)) return
        record.info = nextInfo
        this.options.onChanged(this.summaries(), this.activeTaskIds())
      } catch (error) {
        console.warn('[Pi Desk][TaskRuntime] 按需加载任务 info 失败', {
          taskId,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      } finally {
        if (this.infoRuntimes.get(taskId) === runtime) runtime.promise = null
      }
    })()
    runtime.promise = promise
    await promise
  }

  private apply(input: unknown): void {
    if (!input || typeof input !== 'object') throw new Error('Task report is invalid')
    const report = input as Partial<TaskReportEvent>
    let changed = false
    const changedTaskIds = new Set<string>()

    if (report.type === 'upsert') {
      if (!Array.isArray(report.tasks)) throw new Error('Task upsert requires tasks')
      const normalized = report.tasks.map(normalizeRecord)
      const ids = new Set<string>()
      for (const item of normalized) {
        if (ids.has(item.record.taskId))
          throw new Error(`Task report contains duplicate id: ${item.record.taskId}`)
        ids.add(item.record.taskId)
      }
      for (const item of normalized) {
        this.records.set(item.record.taskId, item.record)
        this.setToolRuntime(item.record.taskId, item.record.detailSource)
        this.setInfoLoader(item.record.taskId, item.infoLoader)
        changedTaskIds.add(item.record.taskId)
        changed = true
      }
    } else if (report.type === 'remove') {
      if (!Array.isArray(report.taskIds)) throw new Error('Task remove requires taskIds')
      for (const taskIdInput of report.taskIds) {
        const taskId = nonEmptyText(taskIdInput, 'Task id', 200)
        const removed = this.records.delete(taskId)
        this.infoRuntimes.delete(taskId)
        this.releaseToolRuntime(taskId)
        if (removed) changedTaskIds.add(taskId)
        changed = removed || changed
      }
    } else {
      throw new Error('Task report type is invalid')
    }

    if (!changed) return
    const trimmedTaskIds = this.trimTerminalHistory()
    for (const taskId of trimmedTaskIds) changedTaskIds.add(taskId)
    for (const taskId of changedTaskIds) this.detailPool.taskChanged(taskId)
    this.options.onChanged(this.summaries(), this.activeTaskIds())
  }

  private trimTerminalHistory(): string[] {
    const removed: string[] = []
    const retained = new Set(orderedRecords(this.records.values()).map((record) => record.taskId))
    for (const [taskId, record] of this.records) {
      if (record.status === 'running' || retained.has(taskId)) continue
      this.records.delete(taskId)
      this.infoRuntimes.delete(taskId)
      this.releaseToolRuntime(taskId)
      removed.push(taskId)
    }
    return removed
  }
}

export class L4PiTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task was not found: ${taskId}`)
    this.name = 'L4PiTaskNotFoundError'
  }
}

export class L4PiTaskNotInterruptibleError extends Error {
  constructor(taskId: string) {
    super(`Task is not interruptible: ${taskId}`)
    this.name = 'L4PiTaskNotInterruptibleError'
  }
}
