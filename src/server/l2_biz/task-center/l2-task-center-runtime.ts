import 'server-only'

import {
  L2TaskImageGetResponseSchema,
  L2TaskMessageGetResponseSchema,
  type L2TaskDetailEvent,
  type L2TaskDetailSnapshot,
  type L2TaskImageGetResponse,
  type L2TaskMessageGetResponse
} from '@common/l2_biz/task-center/l2-task-center-contract'
import { applyL2TaskDetailEvent } from '@common/l2_biz/task-center/l2-task-center-state'
import type { L3WorkSessionSource } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import { projectL3ConversationDurableMessage } from '@server/l3_modules/conversation/l3-conversation-mapper'
import {
  L4PiTaskDetailNotFoundError,
  L4PiTaskDetailUnsupportedError,
  L4PiTaskMessageNotFoundError,
  type L4PiTaskDetailEvent,
  type L4PiTaskDetailWatch
} from '@server/l4_foundation/pi/l4-pi-task-detail-runtime'
import {
  L4PiTaskNotFoundError,
  L4PiTaskNotInterruptibleError
} from '@server/l4_foundation/pi/l4-pi-task-runtime'
import type { L4PiWorkSessionRuntime } from '@server/l4_foundation/pi/l4-pi-work-session-runtime'
import { projectL2TaskDetailEvent, projectL2TaskDetailSnapshot } from './l2-task-center-mapper'

export interface L2TaskDetailObservation {
  snapshot: L2TaskDetailSnapshot
  release: () => void
}

type L2TaskDetailListener = (event: L2TaskDetailEvent) => void

export class L2TaskCenterRuntime {
  private readonly commandTails = new Map<string, Promise<void>>()

  constructor(
    private readonly resolveRuntime: (
      source: L3WorkSessionSource
    ) => Promise<L4PiWorkSessionRuntime>
  ) {}

  async watchDetail(
    source: L3WorkSessionSource,
    taskId: string,
    listener: L2TaskDetailListener
  ): Promise<L2TaskDetailObservation> {
    const runtime = await this.resolveRuntime(source)
    const queued: L4PiTaskDetailEvent[] = []
    let current: L2TaskDetailSnapshot | null = null
    let watch: L4PiTaskDetailWatch | null = null
    let ready = false
    let released = false

    const applyRawEvent = (raw: L4PiTaskDetailEvent): void => {
      if (released) return
      if (!ready || !current || !watch) {
        queued.push(raw)
        return
      }
      try {
        const event = projectL2TaskDetailEvent(source, current, raw)
        if (!event) return
        const next = applyL2TaskDetailEvent(current, event)
        if (next) current = next
        listener(event)
      } catch (error) {
        console.warn('[Pi Desk][TaskCenterRuntime] 任务详情增量无效，重建 Snapshot', {
          workId: source.workId,
          taskId,
          eventType: raw.type,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        const snapshot = projectL2TaskDetailSnapshot(source, watch.readSnapshot())
        current = snapshot
        listener({ type: 'snapshot', snapshot })
      }
    }

    try {
      watch = await runtime.watchTaskDetail(taskId, applyRawEvent)
      await this.resolveRuntime(source)
      current = projectL2TaskDetailSnapshot(source, watch.snapshot)
      ready = true
      for (const event of queued.splice(0)) applyRawEvent(event)
      return {
        snapshot: current,
        release: () => {
          if (released) return
          released = true
          queued.length = 0
          watch?.release()
          watch = null
          current = null
        }
      }
    } catch (error) {
      released = true
      watch?.release()
      throw mapTaskError(error)
    }
  }

  async getMessageDetail(
    source: L3WorkSessionSource,
    taskId: string,
    entryId: string
  ): Promise<L2TaskMessageGetResponse> {
    try {
      const runtime = await this.resolveRuntime(source)
      const { index, entry } = await runtime.readTaskMessage(taskId, entryId)
      const snapshot = projectL3ConversationDurableMessage(
        index,
        entry.entryId,
        entry.timestampMs,
        entry.message,
        source
      )
      if (!snapshot.fixed.hasDetail || snapshot.detail === undefined) {
        throw new L2TaskMessageDetailUnavailableError(entryId)
      }
      return L2TaskMessageGetResponseSchema.parse({
        index,
        entryId,
        detail: snapshot.detail
      })
    } catch (error) {
      throw mapTaskReadError(error)
    }
  }

  async getImage(
    source: L3WorkSessionSource,
    taskId: string,
    entryId: string,
    imageIndex: number
  ): Promise<L2TaskImageGetResponse> {
    try {
      const runtime = await this.resolveRuntime(source)
      return L2TaskImageGetResponseSchema.parse(
        await runtime.readTaskImage(taskId, entryId, imageIndex)
      )
    } catch (error) {
      throw mapTaskReadError(error)
    }
  }

  interrupt(source: L3WorkSessionSource, taskId: string): Promise<void> {
    const key = JSON.stringify([source.workId, source.sessionId, source.branchId, taskId])
    const previous = this.commandTails.get(key) ?? Promise.resolve()
    const interrupt = async (): Promise<void> => {
      const runtime = await this.resolveRuntime(source)
      await runtime.interruptTask(taskId)
    }
    const operation = previous.then(interrupt, interrupt)
    const tail = operation.then(
      () => undefined,
      () => undefined
    )
    this.commandTails.set(key, tail)
    void tail.finally(() => {
      if (this.commandTails.get(key) === tail) this.commandTails.delete(key)
    })
    return operation.catch((error: unknown) => Promise.reject(mapTaskError(error)))
  }
}

function mapTaskReadError(error: unknown): unknown {
  const mapped = mapTaskError(error)
  return mapped === error
    ? new L2TaskDetailUnavailableError(
        error instanceof Error ? error.message : 'Task detail source is unavailable'
      )
    : mapped
}

function mapTaskError(error: unknown): unknown {
  if (error instanceof L4PiTaskNotFoundError || error instanceof L4PiTaskDetailNotFoundError) {
    return new L2TaskNotFoundError(error.message)
  }
  if (error instanceof L4PiTaskNotInterruptibleError) {
    return new L2TaskNotInterruptibleError(error.message)
  }
  if (error instanceof L4PiTaskDetailUnsupportedError) {
    return new L2TaskDetailUnsupportedError(error.message)
  }
  if (error instanceof L4PiTaskMessageNotFoundError) {
    return new L2TaskMessageNotFoundError(error.message)
  }
  return error
}

export class L2TaskNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L2TaskNotFoundError'
  }
}

export class L2TaskNotInterruptibleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L2TaskNotInterruptibleError'
  }
}

export class L2TaskDetailUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L2TaskDetailUnsupportedError'
  }
}

export class L2TaskMessageNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L2TaskMessageNotFoundError'
  }
}

export class L2TaskDetailUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L2TaskDetailUnavailableError'
  }
}

export class L2TaskMessageDetailUnavailableError extends Error {
  constructor(entryId: string) {
    super(`Task message does not provide canonical detail: ${entryId}`)
    this.name = 'L2TaskMessageDetailUnavailableError'
  }
}
