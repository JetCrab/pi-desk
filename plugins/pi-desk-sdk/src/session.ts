import { randomUUID } from 'node:crypto'
import type { AgentSession, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { normalizePluginIdentifier, type PluginJsonObject, type PluginSource } from './shared.ts'
import type { SessionCapabilityRules } from './capabilities.js'

export type { PluginJsonObject, PluginJsonValue, PluginSource } from './shared.js'

export { PluginMethodError, isPluginMethodError, type PluginMethodErrorCode } from './errors.ts'

export const SESSION_PLUGIN_STATE_EVENT = 'pi-desk:session-plugins'
export const SESSION_PLUGIN_METHOD_EVENT = 'pi-desk:session-plugin-methods:v1'
export const SESSION_PLUGIN_PUSH_EVENT = 'pi-desk:session-plugin-push:v1'
export const SESSION_PLUGIN_CAPABILITIES_EVENT = 'pi-desk:session-capabilities'

export type SessionCapabilityHandler = (
  rules: SessionCapabilityRules,
  context: ExtensionContext
) => void | Promise<void>

/** Registration is shared only inside the Session EventBus, never serialized. */
export interface SessionCapabilityRegistration {
  readonly pluginName: string
  readonly execute: SessionCapabilityHandler
  hostManaged: boolean
}

export type SessionCapabilityRegistrationEvent = {
  readonly type: 'register' | 'unregister'
  readonly registration: SessionCapabilityRegistration
}

export interface SessionPluginEventTarget {
  events: {
    emit(channel: string, payload: unknown): void
  }
}

export type SessionPluginSource = PluginSource

export interface SessionPluginMethodContext {
  source: SessionPluginSource
  extensionContext: ExtensionContext
}

export type SessionPluginMethodHandler = (
  input: PluginJsonObject,
  context: SessionPluginMethodContext
) => Promise<PluginJsonObject>

export interface SessionPluginMethodRegistration {
  readonly pluginName: string
  readonly method: string
  readonly execute: SessionPluginMethodHandler
}

export type SessionPluginMethodEvent =
  | {
      readonly type: 'register'
      readonly registration: SessionPluginMethodRegistration
    }
  | {
      readonly type: 'unregister'
      readonly registration: SessionPluginMethodRegistration
    }

export interface SessionPluginFacade {
  readonly name: string
  setState(state: PluginJsonObject | null): void
  push(event: string, data: PluginJsonObject): void
  registerMethod(method: string, execute: SessionPluginMethodHandler): () => void
  onCapabilitiesChange(handler: SessionCapabilityHandler): () => void
  startTask(input: StartTaskInput): TaskHandle
  reportTasks(tasks: readonly TaskRuntimeSnapshot[]): void
}

export interface SessionPluginPushEvent {
  readonly pluginName: string
  readonly event: string
  readonly data: PluginJsonObject
}

export interface SessionPluginPushCapability {
  push(event: string, data: PluginJsonObject): void
}

export interface SessionPluginGlobalMethodCapability {
  invokeGlobal(method: string, input: PluginJsonObject): Promise<PluginJsonObject>
}

export interface SessionPluginTargetCapabilities {
  readonly push: SessionPluginPushCapability
  readonly global: SessionPluginGlobalMethodCapability
}

export function bindSessionPlugin(pi: ExtensionAPI, pluginName: string): SessionPluginFacade {
  const name = normalizePluginIdentifier(pluginName, 'pluginName')

  return {
    name,
    setState(state): void {
      pi.events.emit(SESSION_PLUGIN_STATE_EVENT, { [name]: state })
    },
    push(eventInput, data): void {
      const event = normalizePluginIdentifier(eventInput, 'event')
      pi.events.emit(SESSION_PLUGIN_PUSH_EVENT, {
        pluginName: name,
        event,
        data
      })
    },
    registerMethod(methodInput, execute): () => void {
      const method = normalizePluginIdentifier(methodInput, 'method')
      const registration: SessionPluginMethodRegistration = {
        pluginName: name,
        method,
        execute
      }
      pi.events.emit(SESSION_PLUGIN_METHOD_EVENT, { type: 'register', registration })

      let registered = true
      return (): void => {
        if (!registered) return
        registered = false
        pi.events.emit(SESSION_PLUGIN_METHOD_EVENT, { type: 'unregister', registration })
      }
    },
    onCapabilitiesChange(execute): () => void {
      const registration: SessionCapabilityRegistration = {
        pluginName: name,
        execute,
        hostManaged: false
      }
      let active = true
      pi.events.emit(SESSION_PLUGIN_CAPABILITIES_EVENT, { type: 'register', registration })
      const unregister = (): void => {
        if (!active) return
        active = false
        pi.events.emit(SESSION_PLUGIN_CAPABILITIES_EVENT, { type: 'unregister', registration })
      }
      pi.on('session_start', async (_event, context) => {
        if (active && !registration.hostManaged) {
          await execute({ tools: {}, skills: {}, capabilities: {} }, context)
        }
      })
      pi.on('session_shutdown', unregister)
      return unregister
    },
    startTask(input): TaskHandle {
      return startTask(pi, input)
    },
    reportTasks(tasks): void {
      reportTasks(pi, tasks)
    }
  }
}

export const TASK_REPORT_EVENT = 'pi-desk:task-report:v1'

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export interface TaskInfoItem {
  label: string
  value: string
}

/** 仅在 Pi 与服务端同进程运行态中使用，不进入公共 JSON 快照。 */
export type TaskInfoLoader = () => readonly TaskInfoItem[] | Promise<readonly TaskInfoItem[]>

export type TaskInterrupt = () => Promise<void>

export interface TaskTextFileSource {
  kind: 'text-file'
  path: string
}

export interface TaskPiConversationSessionSource {
  kind: 'pi-conversation'
  session: AgentSession
  sessionFile?: never
}

export interface TaskPiConversationFileSource {
  kind: 'pi-conversation'
  session?: never
  sessionFile: string
}

export type TaskPiConversationSource =
  TaskPiConversationSessionSource | TaskPiConversationFileSource

export type TaskDetailSource = TaskTextFileSource | TaskPiConversationSource

export interface TaskRuntimeSnapshot {
  taskId: string
  taskKind?: string | null
  taskType?: string | null
  title: string
  info?: readonly TaskInfoItem[]
  /** 仅服务端内存使用，Task Runtime 会在需要时调用并转成 info。 */
  infoLoader?: TaskInfoLoader | null
  status: TaskStatus
  activity: string | null
  startedAt: number
  endedAt: number | null
  detailSource: TaskDetailSource | null
  interrupt: TaskInterrupt | null
}

export type TaskReportEvent =
  | {
      type: 'upsert'
      tasks: readonly TaskRuntimeSnapshot[]
    }
  | {
      type: 'remove'
      taskIds: readonly string[]
    }

export interface TaskEventTarget {
  events: {
    emit(channel: string, payload: unknown): void
  }
}

export interface StartTaskInput {
  taskId?: string
  taskKind?: string | null
  taskType?: string | null
  title: string
  info?: readonly TaskInfoItem[]
  /** 仅服务端内存使用，Task Runtime 会在需要时调用并转成 info。 */
  infoLoader?: TaskInfoLoader | null
  activity?: string | null
  startedAt?: number
  detailSource?: TaskDetailSource | null
  interrupt?: TaskInterrupt | null
}

export interface TaskUpdate {
  taskKind?: string | null
  taskType?: string | null
  title?: string
  info?: readonly TaskInfoItem[]
  /** 仅服务端内存使用，Task Runtime 会在需要时调用并转成 info。 */
  infoLoader?: TaskInfoLoader | null
  activity?: string | null
  detailSource?: TaskDetailSource | null
  interrupt?: TaskInterrupt | null
}

export interface TaskHandle {
  readonly taskId: string
  update(input: TaskUpdate): void
  complete(activity?: string): void
  fail(activity?: string): void
  stopped(activity?: string): void
  interrupted(activity?: string): void
  remove(): void
}

function timestamp(): number {
  return Date.now()
}

function terminalTask(
  snapshot: TaskRuntimeSnapshot,
  status: Exclude<TaskStatus, 'running'>,
  activity: string | undefined
): TaskRuntimeSnapshot {
  const source = snapshot.detailSource
  const session = source?.kind === 'pi-conversation' ? source.session : undefined
  const detailSource = session?.sessionFile
    ? { kind: 'pi-conversation' as const, sessionFile: session.sessionFile }
    : source
  return {
    ...snapshot,
    status,
    activity: activity === undefined ? snapshot.activity : activity,
    endedAt: timestamp(),
    detailSource,
    interrupt: null
  }
}

function emit(target: TaskEventTarget, event: TaskReportEvent): void {
  target.events.emit(TASK_REPORT_EVENT, event)
}

export function reportTasks(target: TaskEventTarget, tasks: readonly TaskRuntimeSnapshot[]): void {
  emit(target, { type: 'upsert', tasks })
}

export function startTask(target: TaskEventTarget, input: StartTaskInput): TaskHandle {
  let snapshot: TaskRuntimeSnapshot = {
    taskId: input.taskId ?? randomUUID(),
    taskKind: input.taskKind ?? null,
    taskType: input.taskType ?? null,
    title: input.title,
    info: input.info?.map((item) => ({ ...item })) ?? [],
    ...(input.infoLoader ? { infoLoader: input.infoLoader } : {}),
    status: 'running',
    activity: input.activity ?? null,
    startedAt: input.startedAt ?? timestamp(),
    endedAt: null,
    detailSource: input.detailSource ?? null,
    interrupt: input.interrupt ?? null
  }
  let removed = false

  const report = (): void => {
    if (removed) throw new Error('Task has been removed')
    emit(target, { type: 'upsert', tasks: [snapshot] })
  }

  report()

  return {
    get taskId(): string {
      return snapshot.taskId
    },
    update(input: TaskUpdate): void {
      if (snapshot.status !== 'running') throw new Error('Terminal task cannot be updated')
      snapshot = {
        ...snapshot,
        ...input,
        taskKind: input.taskKind === undefined ? snapshot.taskKind : input.taskKind,
        taskType: input.taskType === undefined ? snapshot.taskType : input.taskType,
        info: input.info === undefined ? snapshot.info : input.info.map((item) => ({ ...item })),
        infoLoader: input.infoLoader === undefined ? snapshot.infoLoader : input.infoLoader,
        activity: input.activity === undefined ? snapshot.activity : input.activity,
        detailSource: input.detailSource === undefined ? snapshot.detailSource : input.detailSource,
        interrupt: input.interrupt === undefined ? snapshot.interrupt : input.interrupt
      }
      report()
    },
    complete(activity?: string): void {
      if (snapshot.status !== 'running') throw new Error('Task is already terminal')
      snapshot = terminalTask(snapshot, 'completed', activity)
      report()
    },
    fail(activity?: string): void {
      if (snapshot.status !== 'running') throw new Error('Task is already terminal')
      snapshot = terminalTask(snapshot, 'failed', activity)
      report()
    },
    stopped(activity?: string): void {
      if (snapshot.status !== 'running') throw new Error('Task is already terminal')
      snapshot = terminalTask(snapshot, 'stopped', activity)
      report()
    },
    interrupted(activity?: string): void {
      if (snapshot.status !== 'running') throw new Error('Task is already terminal')
      snapshot = terminalTask(snapshot, 'interrupted', activity)
      report()
    },
    remove(): void {
      if (removed) return
      removed = true
      emit(target, { type: 'remove', taskIds: [snapshot.taskId] })
    }
  }
}
