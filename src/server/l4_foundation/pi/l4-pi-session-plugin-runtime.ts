import 'server-only'

import {
  createEventBus,
  type EventBus,
  type EventBusController,
  type ExtensionContext
} from '@earendil-works/pi-coding-agent'
import {
  SESSION_PLUGIN_METHOD_EVENT,
  SESSION_PLUGIN_PUSH_EVENT,
  SESSION_PLUGIN_STATE_EVENT,
  type SessionPluginMethodEvent,
  type SessionPluginPushEvent,
  type SessionPluginMethodRegistration,
  type SessionPluginSource
} from '@jetcrab/pi-desk-sdk'
import { z } from 'zod'
import { L4PiTaskRuntime, type L4PiTaskRecord, type L4PiTaskSummary } from './l4-pi-task-runtime'
import type { L4PiTaskDetailEvent, L4PiTaskDetailWatch } from './l4-pi-task-detail-runtime'
import {
  L4PiPluginMethodConflictError,
  L4PiPluginMethodNotFoundError,
  l4PiPluginMethodKey,
  parseL4PiPluginMethodData,
  parseL4PiPluginMethodName,
  parseL4PiPluginName
} from './l4-pi-plugin-method-runtime'

const L4PiSessionPluginIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const L4PiSessionPluginObjectSchema = z.record(z.string(), z.json())
const L4PiSessionPluginUpdateSchema = z.record(
  z.string().min(1),
  z.union([L4PiSessionPluginObjectSchema, z.null()])
)
const L4PiSessionPluginPushSchema = z
  .object({
    pluginName: L4PiSessionPluginIdentifierSchema,
    event: L4PiSessionPluginIdentifierSchema,
    data: L4PiSessionPluginObjectSchema
  })
  .strict()
const L4_PI_SESSION_PLUGIN_PUSH_MAX_BYTES = 64 * 1024

export type L4PiSessionPluginObject = z.infer<typeof L4PiSessionPluginObjectSchema>
export type L4PiSessionPluginSnapshot = Record<string, L4PiSessionPluginObject>

interface L4PiSessionPluginRuntimeOptions {
  onChanged: () => void
  onPush: (event: SessionPluginPushEvent) => void
  onTasksChanged: (activeTaskIds: readonly string[]) => void
  onInvalidUpdate: (cause: unknown) => void
}

interface L4PiSessionPluginSlot {
  serialized: string
  value: L4PiSessionPluginObject
}

export class L4PiSessionPluginRuntime {
  private readonly controller: EventBusController = createEventBus()
  private readonly slots = new Map<string, L4PiSessionPluginSlot>()
  private readonly methods = new Map<string, SessionPluginMethodRegistration>()
  private taskRuntime!: L4PiTaskRuntime
  private unsubscribe: () => void = () => undefined
  private unsubscribePush: () => void = () => undefined
  private disposed = false

  readonly eventBus: EventBus

  constructor(private readonly options: L4PiSessionPluginRuntimeOptions) {
    this.eventBus = {
      emit: (channel, input) => {
        if (this.disposed) return
        if (channel === SESSION_PLUGIN_METHOD_EVENT) {
          this.applyMethodEvent(input)
          return
        }
        this.controller.emit(channel, input)
      },
      on: (channel, handler) =>
        this.disposed ? () => undefined : this.controller.on(channel, handler)
    }
    this.bindChannels()
  }

  private createTaskRuntime(): L4PiTaskRuntime {
    const options = this.options
    return new L4PiTaskRuntime(this.controller, {
      onChanged: (summaries, activeTaskIds) => {
        this.applyTaskSummaries(summaries)
        options.onTasksChanged(activeTaskIds)
        options.onChanged()
      },
      onInvalidReport: (cause) => options.onInvalidUpdate(cause)
    })
  }

  private bindChannels(): void {
    const options = this.options
    this.taskRuntime = this.createTaskRuntime()
    this.unsubscribe = this.controller.on(SESSION_PLUGIN_STATE_EVENT, (input) => {
      if (this.disposed) return
      const parsed = L4PiSessionPluginUpdateSchema.safeParse(input)
      if (!parsed.success) {
        options.onInvalidUpdate(parsed.error)
        return
      }
      try {
        if (this.apply(parsed.data)) options.onChanged()
      } catch (cause) {
        options.onInvalidUpdate(cause)
      }
    })
    this.unsubscribePush = this.controller.on(SESSION_PLUGIN_PUSH_EVENT, (input) => {
      if (this.disposed) return
      const parsed = L4PiSessionPluginPushSchema.safeParse(input)
      if (!parsed.success) {
        options.onInvalidUpdate(parsed.error)
        return
      }
      if (
        Buffer.byteLength(JSON.stringify(parsed.data.data), 'utf8') >
        L4_PI_SESSION_PLUGIN_PUSH_MAX_BYTES
      ) {
        options.onInvalidUpdate(new Error('Session Plugin Push data exceeds 64KB'))
        return
      }
      options.onPush(structuredClone(parsed.data) as SessionPluginPushEvent)
    })
  }

  activeTaskIds(): string[] {
    return this.taskRuntime.activeTaskIds()
  }

  taskRecord(taskId: string): L4PiTaskRecord | null {
    return this.taskRuntime.record(taskId)
  }

  watchTaskDetail(
    taskId: string,
    listener: (event: L4PiTaskDetailEvent) => void
  ): Promise<L4PiTaskDetailWatch> {
    return this.taskRuntime.watchDetail(taskId, listener)
  }

  readTaskMessage(taskId: string, entryId: string) {
    return this.taskRuntime.readMessage(taskId, entryId)
  }

  readTaskImage(taskId: string, entryId: string, imageIndex: number) {
    return this.taskRuntime.readImage(taskId, entryId, imageIndex)
  }

  interruptTask(taskId: string): Promise<void> {
    return this.taskRuntime.interrupt(taskId)
  }

  snapshot(): L4PiSessionPluginSnapshot {
    return Object.fromEntries(
      [...this.slots.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([pluginName, slot]) => [pluginName, structuredClone(slot.value)])
    )
  }

  async invokeMethod(
    pluginNameInput: string,
    methodInput: string,
    input: unknown,
    source: SessionPluginSource,
    extensionContext: ExtensionContext
  ): Promise<L4PiSessionPluginObject> {
    if (this.disposed) throw new Error('Pi session plugin runtime has been disposed')
    const pluginName = parseL4PiPluginName(pluginNameInput)
    const method = parseL4PiPluginMethodName(methodInput)
    const registration = this.methods.get(l4PiPluginMethodKey(pluginName, method))
    if (!registration) throw new L4PiPluginMethodNotFoundError(pluginName, method)

    const result = await registration.execute(parseL4PiPluginMethodData(input, 'input'), {
      source,
      extensionContext
    })
    return parseL4PiPluginMethodData(result, 'output')
  }

  resetBranch(): void {
    if (this.disposed) return
    this.taskRuntime.dispose()
    this.slots.clear()
    this.taskRuntime = this.createTaskRuntime()
    this.options.onTasksChanged([])
    this.options.onChanged()
  }

  reset(): void {
    if (this.disposed) return
    this.unsubscribe()
    this.unsubscribePush()
    this.taskRuntime.dispose()
    this.controller.clear()
    this.methods.clear()
    this.slots.clear()
    this.bindChannels()
    this.options.onTasksChanged([])
    this.options.onChanged()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.unsubscribePush()
    this.taskRuntime.dispose()
    this.controller.clear()
    this.methods.clear()
    this.slots.clear()
  }

  private applyMethodEvent(input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Session plugin method event is invalid')
    }
    const event = input as Partial<SessionPluginMethodEvent>
    const registration = event.registration
    if (
      (event.type !== 'register' && event.type !== 'unregister') ||
      !registration ||
      typeof registration !== 'object' ||
      typeof registration.pluginName !== 'string' ||
      typeof registration.method !== 'string' ||
      typeof registration.execute !== 'function'
    ) {
      throw new Error('Session plugin method registration is invalid')
    }

    const pluginName = parseL4PiPluginName(registration.pluginName)
    const method = parseL4PiPluginMethodName(registration.method)
    const key = l4PiPluginMethodKey(pluginName, method)
    if (event.type === 'register') {
      if (this.methods.has(key)) throw new L4PiPluginMethodConflictError(pluginName, method)
      this.methods.set(key, registration)
      return
    }
    if (this.methods.get(key) === registration) this.methods.delete(key)
  }

  private applyTaskSummaries(summaries: readonly L4PiTaskSummary[]): void {
    if (summaries.length === 0) {
      this.slots.delete('task-center')
      return
    }
    const value: L4PiSessionPluginObject = {
      tasks: summaries.map((task) => ({
        ...task,
        info: task.info.map((item) => ({ ...item }))
      }))
    }
    this.slots.set('task-center', { serialized: JSON.stringify(value), value })
  }

  private apply(update: z.infer<typeof L4PiSessionPluginUpdateSchema>): boolean {
    if (Object.hasOwn(update, 'task-center')) {
      throw new Error('task-center plugin slot is reserved by the Task Runtime')
    }
    let changed = false
    for (const [pluginName, value] of Object.entries(update)) {
      if (value === null) {
        changed = this.slots.delete(pluginName) || changed
        continue
      }

      const serialized = JSON.stringify(value)
      if (this.slots.get(pluginName)?.serialized === serialized) continue
      this.slots.set(pluginName, { serialized, value })
      changed = true
    }
    return changed
  }
}
