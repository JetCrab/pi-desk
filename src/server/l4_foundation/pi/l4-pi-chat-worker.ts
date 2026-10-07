import 'server-only'

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { CapabilityMode as L3CapabilityMode } from '@jetcrab/pi-desk-sdk/capabilities'
import type { L4PiCapabilityRuntime } from './l4-pi-capability-runtime'
import { L4PiSessionInitialization } from './l4-pi-session-initialization'
import { L4PiUiRuntime } from './l4-pi-ui-runtime'
import { L4PiSessionResources } from './l4-pi-session-resources'
import { isL4PiDeskSafeMode } from './l4-pi-desk-mode'
import {
  type AgentSession,
  type AgentSessionEvent,
  type SessionEntry,
  type SlashCommandSource,
  type SessionManager,
  type SessionMessageEntry
} from '@earendil-works/pi-coding-agent'
import type { PluginJsonObject, PluginJsonValue, SessionPluginSource } from '@jetcrab/pi-desk-sdk'
import type { AgentEvent, ThinkingLevel } from '@earendil-works/pi-agent-core'
import { getSupportedThinkingLevels, type ImageContent } from '@earendil-works/pi-ai'
import {
  prepareL4PiChatInput,
  prepareL4PiTransformedInput,
  toL4PiImageContent,
  validateL4PiQueuedInputs,
  type L4PiChatInput,
  type L4PiPreparedChatInput
} from './l4-pi-chat-input'
import {
  projectL4PiAgentMessage,
  projectL4PiChatEntry,
  type L4PiChatMessage
} from './l4-pi-chat-projection'
import {
  retainL4PiAgentToolRuntime,
  type L4PiAgentToolRuntime,
  type L4PiAgentToolRuntimeLease
} from './l4-pi-agent-tool-runtime'
import type { L4PiImageMetadata, L4PiInputImage } from './l4-pi-image'
import { readL4PiModelCatalog, type L4PiModelCatalog } from './l4-pi-model-catalog'
import { invalidateL4PiSessionHistoryCache } from './l4-pi-session-catalog'
import type { L4PiSessionMessageGate } from './l4-pi-session-message-gate'
import {
  executeL4PiDeskCommand,
  type L4PiDeskCommandResult
} from '@server/l4_foundation/pidesk/l4-pidesk-runtime'
import type {
  L4PiSessionPluginRuntime,
  L4PiSessionPluginSnapshot
} from './l4-pi-session-plugin-runtime'
import type { L4PiTaskRecord } from './l4-pi-task-runtime'
import type { L4PiTaskDetailEvent, L4PiTaskDetailWatch } from './l4-pi-task-detail-runtime'

export interface L4PiChatSendInput extends L4PiChatInput {
  mode: 'auto' | 'follow_up'
}

export interface L4PiChatModelInput {
  provider: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

export type L4PiChatModelState = L4PiChatModelInput

export interface L4PiNativeCommandInfo {
  name: string
  description: string | null
  source: SlashCommandSource
}

const NATIVE_COMMAND_DESCRIPTION_MAX_LENGTH = 80

function commandDescriptionForMenu(value: string | null | undefined): string | null {
  if (!value) return null
  const characters = Array.from(value)
  if (characters.length <= NATIVE_COMMAND_DESCRIPTION_MAX_LENGTH) return value
  return `${characters.slice(0, NATIVE_COMMAND_DESCRIPTION_MAX_LENGTH - 1).join('')}…`
}

export interface L4PiNativeToolInfo {
  name: string
  description: string
  parameters: PluginJsonObject
  active: boolean
  exposure: 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden'
  source: string | null
  blockedByMode: boolean
}

export interface L4PiModelContextTool {
  name: string
  description: string
  parameters: PluginJsonObject
}

export interface L4PiModelContext {
  systemPrompt: string
  tools: L4PiModelContextTool[]
}

export interface L4PiDirectBashInput {
  command: string
  excludeFromContext: boolean
}

export interface L4PiDirectBashResult {
  output: string
  exitCode: number | null
  cancelled: boolean
  truncated: boolean
  fullOutputPath: string | null
}

export class L4PiNativeCommandNotFoundError extends Error {
  constructor(command: string) {
    super(`Pi Extension Command was not found: ${command}`)
    this.name = 'L4PiNativeCommandNotFoundError'
  }
}

export class L4PiDirectBashRunningError extends Error {
  constructor() {
    super('Pi Direct Bash is already running')
    this.name = 'L4PiDirectBashRunningError'
  }
}

export class L4PiModelContextBusyError extends Error {
  constructor() {
    super('当前会话正在运行，暂时无法查看系统上下文')
    this.name = 'L4PiModelContextBusyError'
  }
}

export interface L4PiChatContextUsage {
  tokens: number | null
  contextWindow: number
}

export interface L4PiChatQueuedInput {
  tempId: string
  text: string
  images: L4PiImageMetadata[]
}

export interface L4PiChatRuntimeSnapshot {
  extensionMode: 'normal' | 'basic'
  initializationError: string | null
  queues: {
    steering: L4PiChatQueuedInput[]
    followUp: L4PiChatQueuedInput[]
  }
  model: L4PiChatModelState | null
  capabilityMode: string | null
  contextUsage: L4PiChatContextUsage | null
  plugins: L4PiSessionPluginSnapshot
}

export type L4PiChatWorkerEvent =
  | { type: 'message_start'; tempId: string; message: L4PiChatMessage }
  | { type: 'message_update'; tempId: string; message: L4PiChatMessage }
  | {
      type: 'message_commit'
      tempId: string
      entryId: string
      timestampMs: number
      message: L4PiChatMessage
    }
  | { type: 'message_discard'; tempId: string }
  | { type: 'runtime_changed'; runtime: L4PiChatRuntimeSnapshot }
  | { type: 'agent_started' }
  | { type: 'main_operation_cancelled' }
  | { type: 'main_operation_finished' }
  | { type: 'agent_settled' }
  | { type: 'background_tasks_changed'; taskIds: string[] }
  | {
      type: 'plugin_push'
      pluginName: string
      event: string
      data: PluginJsonObject
    }
  | { type: 'session_info_changed'; sessionTitle: string | null }

type L4PiChatWorkerListener = (event: L4PiChatWorkerEvent) => void
type L4PiChatMessageUpdateEvent = Extract<L4PiChatWorkerEvent, { type: 'message_update' }>

const L4_PI_CHAT_LIVE_UPDATE_INTERVAL_MS = 500
const L4_PI_CHAT_MAX_STREAMING_TOOL_ARGUMENT_CHARS = 256 * 1024

type L4PiQueueKind = 'steering' | 'followUp'
type L4PiResolvedSendMode = 'prompt' | 'steer' | 'followUp'

interface L4PiQueuedInputRecord {
  tempId: string
  input: L4PiPreparedChatInput
  confirmed: boolean
}

interface L4PiAcceptedInput {
  tempId: string
  input: L4PiChatSendInput
  initial: L4PiPreparedChatInput
  deferredByCompaction: boolean
  allowIdleFollowUp: boolean
}

interface L4PiActiveMessage {
  tempId: string
  started: boolean
  toolCallId: string | null
}

interface L4PiBashTemp {
  tempId: string
  executionId: string
  command: string
  output: string
  status: 'running' | 'completed' | 'error' | 'aborted'
}

interface L4PiInputValidationContext {
  tempId: string
  requestedMode: L4PiChatSendInput['mode']
  mode: L4PiResolvedSendMode
  prepared: L4PiPreparedChatInput | null
  error: Error | null
  compactionStarted: boolean
  allowIdleFollowUp: boolean
}

interface L4PiChatLiveUpdateState {
  lastPublishedAt: number
  pending: L4PiChatMessageUpdateEvent | null
  timer: ReturnType<typeof setTimeout> | null
  receivedCount: number
  publishedCount: number
}

interface L4PiOversizedStreamingToolCall {
  toolCallId: string | null
  toolName: string | null
  argumentChars: number
}

function findOversizedStreamingToolCall(message: unknown): L4PiOversizedStreamingToolCall | null {
  if (messageRole(message) !== 'assistant') return null
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return null

  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    const toolCall = part as {
      type?: unknown
      id?: unknown
      name?: unknown
      partialJson?: unknown
    }
    if (
      toolCall.type !== 'toolCall' ||
      typeof toolCall.partialJson !== 'string' ||
      toolCall.partialJson.length <= L4_PI_CHAT_MAX_STREAMING_TOOL_ARGUMENT_CHARS
    ) {
      continue
    }
    return {
      toolCallId: typeof toolCall.id === 'string' ? toolCall.id : null,
      toolName: typeof toolCall.name === 'string' ? toolCall.name : null,
      argumentChars: toolCall.partialJson.length
    }
  }
  return null
}

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

function pluginJsonValue(value: unknown): PluginJsonValue {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? null : (JSON.parse(serialized) as PluginJsonValue)
  } catch {
    return null
  }
}

function pluginJsonObject(value: unknown): PluginJsonObject {
  const json = pluginJsonValue(value)
  return json && typeof json === 'object' && !Array.isArray(json) ? json : {}
}

function inputImages(input: L4PiPreparedChatInput): L4PiImageMetadata[] {
  return input.images.map(({ mimeType, width, height }) => ({ mimeType, width, height }))
}

function runtimeQueueItem(record: L4PiQueuedInputRecord): L4PiChatQueuedInput {
  return {
    tempId: record.tempId,
    text: record.input.text,
    images: inputImages(record.input)
  }
}

function runtimeAcceptedInput(record: L4PiAcceptedInput): L4PiChatQueuedInput {
  return {
    tempId: record.tempId,
    text: record.initial.text,
    images: inputImages(record.initial)
  }
}

function isL4PiWebCompatibleExtensionCommand(command: {
  name: string
  sourceInfo: { path: string }
}): boolean {
  const sourcePath = command.sourceInfo.path.replaceAll('\\', '/')
  return command.name !== 'llama' || !sourcePath.includes('/extensions/llama/')
}

function compactionMessage(summary = ''): L4PiChatMessage {
  return { type: 'compaction', summary }
}

function timestampFromEntry(entryId: string, timestamp: string): number {
  const timestampMs = Date.parse(timestamp)
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error(`Pi session entry has an invalid timestamp: ${entryId}`)
  }
  return timestampMs
}

export class L4PiChatWorker {
  readonly nativeUi = new L4PiUiRuntime()
  private readonly listeners = new Set<L4PiChatWorkerListener>()
  private commandLifetime = new AbortController()
  private reloadRequested = false
  private initialization: L4PiSessionInitialization
  private readonly resources: L4PiSessionResources
  private readonly ownsResources: boolean
  private initializationError: string | null = null

  private get pluginRuntime(): L4PiSessionPluginRuntime {
    return this.initialization.plugins
  }

  private get capabilityRuntime(): L4PiCapabilityRuntime {
    return this.initialization.capabilities
  }

  private get messageGate(): L4PiSessionMessageGate {
    return this.initialization.messages
  }
  private readonly steeringQueue: L4PiQueuedInputRecord[] = []
  private readonly followUpQueue: L4PiQueuedInputRecord[] = []
  private readonly pendingQueueText = new Map<L4PiQueueKind, readonly string[]>()
  private readonly bashTempsById = new Map<string, L4PiBashTemp>()
  private readonly observedRunPromises = new Set<Promise<void>>()
  private readonly committedEntryIds = new Set<string>()
  private readonly backgroundTaskIds = new Set<string>()
  private readonly liveUpdatesByTempId = new Map<string, L4PiChatLiveUpdateState>()
  private readonly acceptedInputs: L4PiAcceptedInput[] = []
  private readonly presentedInputTempIds = new Set<string>()
  private session: AgentSession | null = null
  private extensionMode: 'normal' | 'basic' = isL4PiDeskSafeMode() ? 'basic' : 'normal'
  private sessionLifecycle: Promise<void> | null = null
  private treeNavigation: { committed: boolean } | null = null
  private treeResumeImmediate: ReturnType<typeof setImmediate> | null = null
  private disposePromise: Promise<void> | null = null
  private initializePromise: Promise<AgentSession> | null = null
  private unsubscribeAgent: (() => void) | null = null
  private unsubscribeSession: (() => void) | null = null
  private toolRuntime: L4PiAgentToolRuntime | null = null
  private toolRuntimeLease: L4PiAgentToolRuntimeLease | null = null
  private unsubscribeToolRuntime: (() => void) | null = null
  private pendingPrompt: { tempId: string; input: L4PiPreparedChatInput } | null = null
  private activeMessage: L4PiActiveMessage | null = null
  private activeValidation: L4PiInputValidationContext | null = null
  private activeCompactionTempId: string | null = null
  private acceptedInputTimer: ReturnType<typeof setTimeout> | null = null
  private compactionResumeTimer: ReturnType<typeof setTimeout> | null = null
  private startingAcceptedInput = false
  private compactionResumeScheduled = false
  private manualCompactionFinishPending = false
  private observedEntryCount: number
  private publishingModel = false
  private oversizedToolCallAbortRequested = false
  private disposed = false

  constructor(
    readonly cwd: string,
    private readonly sessionManager: SessionManager,
    private readonly onEntryAppended: (entry: SessionEntry) => void = () => undefined,
    private readonly capabilities: {
      mode: () => string | null
      rules: () => L3CapabilityMode | undefined
    } = { mode: () => null, rules: () => undefined },
    resources?: L4PiSessionResources
  ) {
    this.resources = resources ?? new L4PiSessionResources()
    this.ownsResources = resources === undefined
    this.initialization = this.createInitialization()
    this.observedEntryCount = sessionManager.getEntries().length
    for (const entry of sessionManager.getBranch()) this.committedEntryIds.add(entry.id)

    // 后台任务属于本进程运行态；历史 JSONL 中的 running 仅是当时的记录，不能恢复为当前运行。
  }

  private createInitialization(): L4PiSessionInitialization {
    return new L4PiSessionInitialization({
      cwd: this.cwd,
      sessionManager: this.sessionManager,
      mode: this.extensionMode,
      resources: this.resources,
      ui: this.nativeUi,
      readCapabilities: this.capabilities.rules,
      onInput: (event) =>
        this.validateFinalInput(event.text, event.images, event.streamingBehavior),
      onTree: () => this.resetBranchRuntime(),
      onCommand: (args, toolCallId) => {
        const signal = this.commandLifetime.signal
        return executeL4PiDeskCommand(args, {
          cwd: this.cwd,
          signal,
          reload: () => this.requestReload(toolCallId),
          notify: (message) => this.notifyCommandResult(toolCallId, message, signal)
        })
      },
      pluginEvents: {
        onChanged: () => this.emitRuntime(),
        onPush: ({ pluginName, event, data }) =>
          this.emit({ type: 'plugin_push', pluginName, event, data }),
        onTasksChanged: (ids) => this.updateBackgroundTasks(ids),
        onInvalidUpdate: (cause) => {
          console.warn('[Pi Desk][PiChatWorker] 已忽略非法插件运行态更新', {
            sessionId: this.sessionManager.getSessionId(),
            cwd: this.cwd,
            errorName: cause instanceof Error ? cause.name : 'UnknownError'
          })
        }
      }
    })
  }

  private async notifyCommandResult(
    toolCallId: string,
    message: string,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) return
    await this.sessionLifecycle
    if (signal.aborted || this.disposed || !this.session) return
    const belongsToBranch = this.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'assistant' &&
          entry.message.content.some((part) => part.type === 'toolCall' && part.id === toolCallId)
      )
    if (!belongsToBranch) return
    this.session.resourceLoader.getExtensions().runtime.sendMessage(
      {
        customType: 'pi-desk:command-result',
        content: message,
        display: true,
        details: { toolCallId }
      },
      { deliverAs: 'steer', triggerTurn: true }
    )
  }

  private requestReload(toolCallId: string): L4PiDeskCommandResult {
    this.commandLifetime.signal.throwIfAborted()
    if (this.reloadRequested) throw new Error('当前会话已有重载请求，请结束本轮并等待完成通知')
    this.reloadRequested = true
    console.info('[Pi Desk][Commands] 当前会话重载请求已接纳', {
      sessionId: this.sessionManager.getSessionId(),
      toolCallId
    })
    void this.reloadWhenIdle(toolCallId).finally(() => {
      this.reloadRequested = false
    })
    return {
      mode: 'async',
      message:
        '已收到当前窗口的 Pi 配置重载请求。请结束本轮对话并等待，无需查询或重复调用；会话空闲后会执行重载，完成后向本会话发送结果消息并自动唤醒。'
    }
  }

  private async reloadWhenIdle(toolCallId: string): Promise<void> {
    const signal = this.commandLifetime.signal
    const logContext = { sessionId: this.sessionManager.getSessionId(), toolCallId }
    let message: string
    try {
      // 接纳结果先交还工具；只在有请求期间检查现有完整空闲条件。
      do {
        await delay(250, undefined, { signal })
      } while (this.readPluginReloadBlockReason() !== null)
      console.info('[Pi Desk][Commands] 会话已空闲，开始重载 Pi 配置', logContext)
      await this.reload()
      signal.throwIfAborted()
      if (this.initializationError) {
        throw new Error(`扩展未恢复，当前使用基础会话。\n${this.initializationError}`)
      }
      message =
        this.extensionMode === 'basic'
          ? '当前窗口的 Pi 配置已重载完成。服务处于基础模式，未加载外部插件。可以继续处理重载前尚未完成的任务。'
          : '当前窗口的 Pi 配置已重载完成，已重新加载配置及本机已安装插件的当前代码。可以继续处理重载前尚未完成的任务。'
      console.info('[Pi Desk][Commands] 当前会话重载完成', logContext)
    } catch (error) {
      if (signal.aborted) return
      const reason = error instanceof Error ? error.message : String(error)
      console.warn('[Pi Desk][Commands] 当前会话重载失败', { ...logContext, reason })
      message = `当前窗口的 Pi 配置重载失败。\n原因：${reason}`
    }
    try {
      // 超时后旧生命周期可能仍未退出，不能向尚未就绪的扩展实例投递。
      if (this.sessionLifecycle || !this.session) throw new Error('会话尚未恢复，无法投递重载结果')
      await this.notifyCommandResult(toolCallId, message, signal)
    } catch (error) {
      if (signal.aborted) return
      console.warn('[Pi Desk][Commands] 会话重载结果投递失败', {
        ...logContext,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  getBackgroundTaskIds(): string[] {
    return this.pluginRuntime.activeTaskIds()
  }

  getTaskRecord(taskId: string): L4PiTaskRecord | null {
    return this.pluginRuntime.taskRecord(taskId)
  }

  async watchTaskDetail(
    taskId: string,
    listener: (event: L4PiTaskDetailEvent) => void
  ): Promise<L4PiTaskDetailWatch> {
    await this.ensureSession()
    return this.pluginRuntime.watchTaskDetail(taskId, listener)
  }

  async readTaskMessage(taskId: string, entryId: string) {
    await this.ensureSession()
    return this.pluginRuntime.readTaskMessage(taskId, entryId)
  }

  async readTaskImage(taskId: string, entryId: string, imageIndex: number) {
    await this.ensureSession()
    return this.pluginRuntime.readTaskImage(taskId, entryId, imageIndex)
  }

  async interruptTask(taskId: string): Promise<void> {
    await this.ensureSession()
    await this.pluginRuntime.interruptTask(taskId)
  }

  async invokePluginMethod(
    pluginName: string,
    method: string,
    input: unknown,
    source: SessionPluginSource
  ): Promise<PluginJsonObject> {
    const session = await this.ensureSession()
    return this.pluginRuntime.invokeMethod(
      pluginName,
      method,
      input,
      source,
      session.extensionRunner.createContext()
    )
  }

  async listNativeCommands(): Promise<readonly L4PiNativeCommandInfo[]> {
    const session = await this.ensureSession()
    const registeredCommands = session.extensionRunner.getRegisteredCommands()
    const extensionNames = new Set(registeredCommands.map((command) => command.invocationName))
    const extensionCommands = registeredCommands
      .filter(isL4PiWebCompatibleExtensionCommand)
      .map((command) => ({
        name: command.invocationName,
        description: commandDescriptionForMenu(command.description),
        source: 'extension' as const
      }))
    const skillCommands = session.resourceLoader
      .getSkills()
      .skills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: commandDescriptionForMenu(skill.description),
        source: 'skill' as const
      }))
      .filter((command) => !extensionNames.has(command.name))
    const skillNames = new Set(skillCommands.map((command) => command.name))
    const promptCommands = session.promptTemplates
      .filter((template) => !extensionNames.has(template.name) && !skillNames.has(template.name))
      .map((template) => ({
        name: template.name,
        description: commandDescriptionForMenu(template.description),
        source: 'prompt' as const
      }))

    return [...extensionCommands, ...promptCommands, ...skillCommands]
  }

  async executeNativeCommand(commandName: string, args: string): Promise<void> {
    const session = await this.ensureSession()
    const command = session.extensionRunner.getCommand(commandName)
    if (!command) throw new L4PiNativeCommandNotFoundError(commandName)

    try {
      await command.handler(args, session.extensionRunner.createCommandContext())
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      session.extensionRunner.emitError({
        extensionPath: command.sourceInfo.path,
        event: `command:${command.invocationName}`,
        error: error.message,
        ...(error.stack ? { stack: error.stack } : {})
      })
      throw error
    }
  }

  async listNativeTools(loadedOnly = false): Promise<readonly L4PiNativeToolInfo[]> {
    if (loadedOnly && !this.session) return []
    const session = await this.ensureSession()
    const active = new Set(session.getActiveToolNames())
    const sources = new Map<string, string>()
    for (const extension of session.resourceLoader.getExtensions().extensions) {
      for (const name of extension.tools.keys()) {
        sources.set(name, extension.sourceInfo?.path ?? extension.path)
      }
    }
    return session.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.parameters)) as PluginJsonObject,
      active: active.has(tool.name),
      exposure: tool.exposure ?? 'direct',
      source: tool.namespace?.name ?? sources.get(tool.name) ?? null,
      blockedByMode: !this.capabilityRuntime.isToolAllowed(tool.name)
    }))
  }

  async executeDirectBash(input: L4PiDirectBashInput): Promise<L4PiDirectBashResult> {
    const session = await this.ensureSession()
    if (session.isBashRunning) throw new L4PiDirectBashRunningError()

    const executionId = randomUUID()
    console.info('[Pi Desk][PiChatWorker] Direct Bash 已开始', {
      sessionId: session.sessionId,
      executionId,
      excludeFromContext: input.excludeFromContext,
      commandLength: input.command.length
    })
    this.startBash(executionId, input.command)
    try {
      const eventResult = await session.extensionRunner.emitUserBash({
        type: 'user_bash',
        command: input.command,
        excludeFromContext: input.excludeFromContext,
        cwd: this.cwd
      })
      const result = eventResult?.result
        ? eventResult.result
        : await session.executeBash(input.command, undefined, {
            excludeFromContext: input.excludeFromContext,
            id: executionId,
            operations: eventResult?.operations
          })
      if (eventResult?.result) {
        session.recordBashResult(input.command, result, {
          excludeFromContext: input.excludeFromContext
        })
      }
      this.completeBash(executionId, result)
      return {
        output: result.output,
        exitCode: result.exitCode ?? null,
        cancelled: result.cancelled,
        truncated: result.truncated,
        fullOutputPath: result.fullOutputPath ?? null
      }
    } catch (error) {
      this.discardBash(executionId)
      throw error
    } finally {
      console.info('[Pi Desk][PiChatWorker] Direct Bash 已结束', {
        sessionId: session.sessionId,
        executionId
      })
    }
  }

  async abortDirectBash(): Promise<void> {
    const session = await this.ensureSession()
    session.abortBash()
  }

  assertIdle(): void {
    if (this.disposed || this.initializePromise)
      throw new Error('Pi 会话仍在初始化或关闭，不能切换分支')
    if (this.sessionLifecycle) throw new Error('Pi 会话生命周期仍在处理，不能切换分支')
    if (this.startingAcceptedInput || this.acceptedInputs.length > 0) {
      throw new Error('主 Agent 正在接管聊天输入，不能切换分支')
    }
    if (this.activeCompactionTempId) {
      throw new Error('上下文压缩期间不能切换分支')
    }
    if (this.session && !this.session.isIdle) {
      throw new Error('主 Agent 运行时不能切换分支')
    }
  }

  readPluginReloadBlockReason(): string | null {
    if (this.disposed) return 'Pi Worker 已释放'
    if (this.sessionLifecycle) return 'Pi 扩展重载或关闭仍未完成'
    if (this.initializePromise) return 'AgentSession 正在初始化'
    if (this.startingAcceptedInput || this.acceptedInputs.length > 0 || this.acceptedInputTimer) {
      return '聊天输入正在接纳'
    }
    if (this.activeValidation || this.pendingPrompt) return '聊天输入正在校验'
    if (this.activeCompactionTempId) return '上下文正在压缩'
    if (this.steeringQueue.length > 0 || this.followUpQueue.length > 0) return '聊天队列不为空'
    if (this.observedRunPromises.size > 0) return 'Agent 运行仍在收尾'
    if (this.backgroundTaskIds.size > 0) return '插件后台任务仍在运行'
    if (this.session?.isBashRunning) return 'Bash 正在运行'
    if (this.session && !this.session.isIdle) return '主 Agent 正在运行'
    if (this.activeMessage || (this.toolRuntime?.size ?? 0) > 0 || this.bashTempsById.size > 0) {
      return '实时消息仍在处理'
    }
    return null
  }

  subscribe(listener: L4PiChatWorkerListener): () => void {
    if (this.disposed) throw new Error('Pi chat worker has been disposed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async getRuntime(): Promise<L4PiChatRuntimeSnapshot> {
    const initialization = this.ensureSession()
    let release = (): void => undefined
    const interaction = new Promise<void>((resolve) => {
      release = this.nativeUi.subscribe(() => {
        if (this.nativeUi.hasPending) resolve()
      })
      if (this.nativeUi.hasPending) resolve()
    })
    try {
      // 启动钩子可等待用户；先交付已有快照，让页面能展示并回答原生问题。
      await Promise.race([initialization, interaction])
      return this.runtimeSnapshot()
    } finally {
      release()
    }
  }

  async readModelContext(): Promise<L4PiModelContext> {
    if (
      this.startingAcceptedInput ||
      this.acceptedInputs.length > 0 ||
      this.activeValidation ||
      this.pendingPrompt ||
      this.activeCompactionTempId ||
      this.observedRunPromises.size > 0
    ) {
      throw new L4PiModelContextBusyError()
    }

    const session = await this.ensureSession()
    if (!session.isIdle || session.isBashRunning) throw new L4PiModelContextBusyError()

    const activeToolNames = new Set(session.getActiveToolNames())
    const tools = session
      .getAllTools()
      .filter((tool) => activeToolNames.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: pluginJsonObject(tool.parameters)
      }))

    const context: L4PiModelContext = {
      systemPrompt: session.systemPrompt,
      tools
    }
    console.info('[Pi Desk][PiChatWorker] 已读取模型上下文', {
      sessionId: session.sessionId,
      toolCount: context.tools.length
    })
    return context
  }

  async listModels(): Promise<L4PiModelCatalog> {
    return readL4PiModelCatalog(this.sessionLifecycle ? null : this.session, this.cwd)
  }

  async send(input: L4PiChatSendInput): Promise<{ tempId: string }> {
    const session = await this.ensureSession()
    const initial = prepareL4PiChatInput(input)
    if (initial.images.length > 0 && !session.model?.input.includes('image')) {
      throw new Error('当前模型不支持图片输入')
    }

    const deferredByCompaction = this.messageGate.isBlocking
    if (input.mode === 'follow_up' && !deferredByCompaction) {
      this.resolveMode(session, input.mode)
    }
    if (deferredByCompaction) {
      validateL4PiQueuedInputs([
        ...this.steeringQueue.map((item) => item.input),
        ...this.followUpQueue.map((item) => item.input),
        ...this.acceptedInputs
          .filter((item) => item.deferredByCompaction)
          .map((item) => item.initial),
        initial
      ])
    }

    const tempId = randomUUID()
    const accepted: L4PiAcceptedInput = {
      tempId,
      input,
      initial,
      deferredByCompaction,
      allowIdleFollowUp: deferredByCompaction
    }
    this.acceptedInputs.push(accepted)
    if (
      !deferredByCompaction ||
      !this.messageGate.defer('web-user-message', () => this.startDeferredAcceptedInput(accepted))
    ) {
      accepted.deferredByCompaction = false
      this.scheduleAcceptedInputStart()
    } else {
      this.emitRuntime()
    }
    console.info('[Pi Desk][PiChatWorker] 聊天输入已由 Worker 接管', {
      sessionId: session.sessionId,
      tempId,
      requestedMode: input.mode,
      deferredByCompaction
    })
    return { tempId }
  }

  async interrupt(): Promise<void> {
    this.nativeUi.cancelAll()
    this.discardAcceptedInputs()
    const session = await this.ensureSession()
    session.abortRetry()
    session.abortCompaction()
    session.agent.abort()
  }

  async navigateTree(entryId: string): Promise<boolean> {
    const session = await this.ensureSession()
    this.assertIdle()
    if (this.treeResumeImmediate) clearImmediate(this.treeResumeImmediate)
    this.treeResumeImmediate = null
    let changed = false
    try {
      await this.runSessionLifecycle(async () => {
        const previousLeaf = this.sessionManager.getLeafId()
        const navigation = { committed: false }
        this.treeNavigation = navigation
        this.messageGate.pause()
        try {
          this.initialization.setStage('切换会话树')
          const result = await session.navigateTree(entryId, { summarize: false })
          changed = !result.cancelled
          if (changed) await this.capabilityRuntime.apply()
        } catch (error) {
          // SDK 内部失败也可能发生在 leaf 已提交之后，不能继续把数据投到旧 Source。
          if (!navigation.committed && this.sessionManager.getLeafId() !== previousLeaf) {
            this.resetBranchRuntime()
          }
          throw error
        } finally {
          try {
            if (navigation.committed) {
              this.syncOwnerAppendedEntries()
              this.observedEntryCount = this.sessionManager.getEntries().length
              this.committedEntryIds.clear()
              for (const entry of this.sessionManager.getBranch())
                this.committedEntryIds.add(entry.id)
            }
          } finally {
            this.treeNavigation = null
            if (!navigation.committed) {
              this.reconcileAppendedEntries()
              this.emitTreeState()
            }
            this.scheduleTreeMessageResume()
          }
        }
      })
      return changed
    } catch (error) {
      session.abortCompaction()
      throw error
    }
  }

  private resetBranchRuntime(): void {
    if (this.treeNavigation) this.treeNavigation.committed = true
    this.commandLifetime.abort()
    this.commandLifetime = new AbortController()
    if (this.acceptedInputTimer) clearTimeout(this.acceptedInputTimer)
    if (this.compactionResumeTimer) clearTimeout(this.compactionResumeTimer)
    this.acceptedInputTimer = null
    this.compactionResumeTimer = null
    this.messageGate.discardPending()
    this.toolRuntime?.discardAll()
    this.clearLiveUpdates()
    this.clearMemory()
    this.nativeUi.reset()
    this.capabilityRuntime.restoreBranchSelection()
    this.pluginRuntime.resetBranch()
  }

  private scheduleTreeMessageResume(): void {
    if (this.disposed) return
    // 当前调用链先重建 Source；再投递新分支树钩子留下的消息，不引入确认协议。
    const resume = setImmediate(() => {
      const finish = async (): Promise<void> => {
        await this.sessionLifecycle?.catch(() => undefined)
        if (this.treeResumeImmediate !== resume) return
        this.treeResumeImmediate = null
        if (this.disposed || this.treeNavigation || !this.session) return
        await this.messageGate.resume()
        if (this.disposed) return
        this.reconcileAppendedEntries()
        this.emitTreeState()
        this.scheduleAcceptedInputStart()
      }
      void finish().catch((error: unknown) => {
        if (this.treeResumeImmediate === resume) this.treeResumeImmediate = null
        console.warn('[Pi Desk][PiChatWorker] 分支消息恢复失败', { error })
      })
    })
    this.treeResumeImmediate = resume
  }

  private emitTreeState(): void {
    this.emitBackgroundTasks()
    this.emit({
      type: 'session_info_changed',
      sessionTitle: this.sessionManager.getSessionName()?.trim() || null
    })
    this.emitRuntime()
  }

  async reload(mode?: 'normal' | 'basic'): Promise<void> {
    const target = mode ?? (isL4PiDeskSafeMode() ? 'basic' : 'normal')
    if (isL4PiDeskSafeMode() && target === 'normal') {
      throw new Error('服务处于基础模式，请正常启动 Pi Desk 后再加载外部扩展')
    }
    const blocked = this.readPluginReloadBlockReason()
    if (blocked) throw new Error(`当前会话不能重载 Pi 配置：${blocked}`)
    if (target !== this.extensionMode || !this.session) {
      await this.runSessionLifecycle(async () => {
        this.releaseSessionBindings()
        this.initialization.dispose()
        this.session = null
        this.updateBackgroundTasks([])
        if (this.disposed) throw new Error('Pi Worker 已释放')
        this.extensionMode = target
        this.initialization = this.createInitialization()
        try {
          await this.createSession(target === 'normal')
        } finally {
          this.emit({ type: 'runtime_changed', runtime: this.runtimeSnapshot() })
        }
      }, 125_000)
      return
    }

    const session = await this.ensureSession()
    const reason = this.readPluginReloadBlockReason()
    if (reason) throw new Error(`当前会话不能重载 Pi 配置：${reason}`)
    await this.runSessionLifecycle(async () => {
      // Pi 会重挂自己的监听；宿主必须最后重挂，且不能在异步reload尚未结束时提前重挂。
      this.unsubscribeAgent?.()
      this.unsubscribeAgent = null
      try {
        await this.initialization.reload()
      } catch (cause) {
        this.restoreBasicInitialization(cause)
        await this.createSession()
        return
      } finally {
        if (!this.disposed && this.session === session && !this.unsubscribeAgent) {
          this.unsubscribeAgent = session.agent.subscribe((event) => {
            if (this.session === session) this.handleAgentEvent(event)
          })
        }
      }
      if (this.disposed || this.session !== session) return
      this.messageGate.installExtensionRuntime(session.resourceLoader.getExtensions().runtime)
      await this.capabilityRuntime.apply()
      this.reconcileAppendedEntries()
      this.emitRuntime()
    })
  }

  private waitForSessionLifecycle<T>(execution: Promise<T>, timeoutMs = 15_000): Promise<T> {
    return this.nativeUi.waitForOperation(
      execution,
      timeoutMs,
      () => new Error(`Pi 扩展生命周期未在截止时间内完成\n${this.initialization.describeStage()}`)
    )
  }

  private async runSessionLifecycle(
    operation: () => Promise<void>,
    timeoutMs = 15_000
  ): Promise<void> {
    if (this.sessionLifecycle) throw new Error('Pi 扩展生命周期尚未完成')
    const execution = Promise.resolve().then(() => {
      if (this.disposed) throw new Error('Pi Worker 已释放')
      return operation()
    })
    this.sessionLifecycle = execution
    const release = (): void => {
      if (this.sessionLifecycle === execution) this.sessionLifecycle = null
    }
    void execution.then(release, release)
    await this.waitForSessionLifecycle(execution, timeoutMs)
  }

  private releaseSessionBindings(): void {
    this.unsubscribeAgent?.()
    this.unsubscribeSession?.()
    this.unsubscribeToolRuntime?.()
    this.toolRuntimeLease?.release()
    this.unsubscribeAgent = null
    this.unsubscribeSession = null
    this.unsubscribeToolRuntime = null
    this.toolRuntimeLease = null
    this.toolRuntime = null
  }

  async compact(): Promise<void> {
    if (this.startingAcceptedInput || this.acceptedInputs.length > 0) {
      throw new Error('主 Agent 正在接管聊天输入，不能压缩上下文')
    }
    if (this.activeCompactionTempId) throw new Error('上下文正在压缩')

    this.messageGate.pause()
    let session: AgentSession | null = null
    try {
      session = await this.ensureSession()
      if (!session.isIdle) throw new Error('主 Agent 运行时不能压缩上下文')
      if (session.isBashRunning) throw new Error('Bash 运行时不能压缩上下文')

      // Pi 手动压缩会重挂内部 Agent 监听；Worker 必须随后重挂，才能读取已持久化的 entry。
      const unsubscribeAgent = this.unsubscribeAgent
      this.unsubscribeAgent = null
      unsubscribeAgent?.()
      try {
        await session.compact()
      } finally {
        if (!this.disposed && this.session === session && !this.unsubscribeAgent) {
          this.unsubscribeAgent = session.agent.subscribe((event) => this.handleAgentEvent(event))
        }
      }
    } finally {
      this.scheduleCompactionMessageResume()
    }
  }

  async restoreQueuedMessages(): Promise<{ text: string; images: L4PiInputImage[] }> {
    const session = await this.ensureSession()
    const accepted = this.acceptedInputs.splice(0)
    const acceptedSteering = accepted
      .filter((item) => item.input.mode === 'auto')
      .map((item) => item.initial)
    const acceptedFollowUp = accepted
      .filter((item) => item.input.mode === 'follow_up')
      .map((item) => item.initial)
    const steeringRecords = this.steeringQueue.splice(0)
    const followUpRecords = this.followUpQueue.splice(0)
    const steering = steeringRecords.map((item) => item.input)
    const followUp = followUpRecords.map((item) => item.input)
    const queued = [...steering, ...acceptedSteering, ...followUp, ...acceptedFollowUp]
    this.pendingQueueText.clear()
    session.clearQueue()
    for (const input of accepted) this.discardPresentedInput(input.tempId)
    for (const input of [...steeringRecords, ...followUpRecords]) {
      this.discardPresentedInput(input.tempId)
    }
    this.emitRuntime()
    return {
      text: queued
        .map((item) => item.text)
        .filter((text) => text.trim())
        .join('\n\n'),
      images: queued.flatMap((item) => item.images.map((image) => ({ ...image })))
    }
  }

  async applyCapabilityMode(): Promise<void> {
    const initialized = this.session !== null
    await this.ensureSession()
    try {
      if (initialized) await this.capabilityRuntime.apply()
    } finally {
      this.emitRuntime()
    }
  }

  async setModel(input: L4PiChatModelInput): Promise<void> {
    if (this.startingAcceptedInput || this.acceptedInputs.length > 0) {
      throw new Error('主 Agent 正在接管聊天输入，不能切换模型')
    }
    if (this.activeCompactionTempId) throw new Error('上下文压缩期间不能切换模型')
    const session = await this.ensureSession()
    if (!session.isIdle) throw new Error('主 Agent 运行时不能切换模型')

    const model = session.modelRuntime.getModel(input.provider, input.modelId)
    if (!model) throw new Error('模型不存在或当前不可用')
    if (!getSupportedThinkingLevels(model).includes(input.thinkingLevel)) {
      throw new Error('模型不支持该思考等级')
    }

    this.publishingModel = true
    try {
      await session.setModel(model)
      session.setThinkingLevel(input.thinkingLevel)
    } finally {
      this.publishingModel = false
      this.emitRuntime()
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeSession().finally(() => {
      if (this.ownsResources) this.resources.reset()
    })
    return this.disposePromise
  }

  private async disposeSession(): Promise<void> {
    this.disposed = true
    this.nativeUi.dispose()
    this.commandLifetime.abort()
    if (this.treeResumeImmediate) clearImmediate(this.treeResumeImmediate)
    this.treeResumeImmediate = null
    if (this.acceptedInputTimer) clearTimeout(this.acceptedInputTimer)
    if (this.compactionResumeTimer) clearTimeout(this.compactionResumeTimer)
    this.acceptedInputTimer = null
    this.compactionResumeTimer = null
    this.messageGate.dispose()
    this.clearLiveUpdates()
    this.listeners.clear()

    const activeSession = this.session
    if (!activeSession) this.initialization.dispose()
    activeSession?.clearQueue()
    activeSession?.abortCompaction()
    const interrupt = activeSession?.abort().catch(() => undefined)
    await Promise.allSettled([this.initializePromise, this.sessionLifecycle, interrupt])
    const session = this.session
    if (!session) {
      this.capabilityRuntime.dispose()
      this.pluginRuntime.dispose()
      this.clearMemory()
      return
    }
    if (session !== activeSession) {
      session.clearQueue()
      session.abortCompaction()
      await session.abort().catch(() => undefined)
    }
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    } catch (cause) {
      console.warn('[Pi Desk][PiChatWorker] 扩展关闭失败', {
        sessionId: session.sessionId,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    }
    this.releaseSessionBindings()
    this.initialization.dispose(false)
    this.session = null
    this.initializationError = null
    await Promise.allSettled([...this.observedRunPromises])
    this.clearMemory()
  }

  private resolveMode(
    session: AgentSession,
    requested: L4PiChatSendInput['mode'],
    allowIdleFollowUp = false
  ): L4PiResolvedSendMode {
    if (requested === 'follow_up') {
      if (session.isStreaming) return 'followUp'
      if (allowIdleFollowUp) return 'prompt'
      throw new Error('主 Agent 已空闲，不能添加 Follow-up')
    }
    return session.isStreaming ? 'steer' : 'prompt'
  }

  private scheduleCompactionMessageResume(): void {
    if (this.disposed || this.compactionResumeScheduled || this.compactionResumeTimer) return
    this.compactionResumeScheduled = true
    queueMicrotask(() => {
      this.compactionResumeScheduled = false
      if (this.disposed) return
      if (this.session?.isCompacting) {
        this.compactionResumeTimer = setTimeout(() => {
          this.compactionResumeTimer = null
          this.scheduleCompactionMessageResume()
        }, 0)
        return
      }
      if (this.activeValidation?.compactionStarted) return

      void this.messageGate.resume().then(() => {
        if (this.disposed) return
        this.scheduleAcceptedInputStart()
        if (this.manualCompactionFinishPending) {
          this.manualCompactionFinishPending = false
          if (!this.session?.isStreaming) this.emit({ type: 'main_operation_finished' })
        }
        this.emitRuntime()
      })
    })
  }

  private scheduleAcceptedInputStart(): void {
    if (
      this.disposed ||
      this.startingAcceptedInput ||
      this.acceptedInputs.length === 0 ||
      this.acceptedInputTimer ||
      this.messageGate.isBlocking
    ) {
      return
    }
    this.acceptedInputTimer = setTimeout(() => {
      this.acceptedInputTimer = null
      this.startAcceptedInput()
    }, 0)
  }

  private startAcceptedInput(): void {
    if (this.disposed || this.startingAcceptedInput || this.messageGate.isBlocking) return
    const accepted = this.acceptedInputs.shift()
    if (!accepted) return

    this.startingAcceptedInput = true
    void this.runAcceptedInput(accepted).finally(() => {
      this.startingAcceptedInput = false
      this.scheduleAcceptedInputStart()
    })
  }

  private async startDeferredAcceptedInput(accepted: L4PiAcceptedInput): Promise<void> {
    if (this.disposed) return
    const index = this.acceptedInputs.indexOf(accepted)
    if (index < 0) return
    this.acceptedInputs.splice(index, 1)
    accepted.deferredByCompaction = false
    this.emitRuntime()

    this.startingAcceptedInput = true
    try {
      await this.runAcceptedInput(accepted)
    } finally {
      this.startingAcceptedInput = false
    }
  }

  private async runAcceptedInput(accepted: L4PiAcceptedInput): Promise<void> {
    let validation: L4PiInputValidationContext | null = null
    try {
      const session = await this.ensureSession()
      const mode = this.resolveMode(session, accepted.input.mode, accepted.allowIdleFollowUp)
      validation = {
        tempId: accepted.tempId,
        requestedMode: accepted.input.mode,
        mode,
        prepared: null,
        error: null,
        compactionStarted: false,
        allowIdleFollowUp: accepted.allowIdleFollowUp
      }
      this.activeValidation = validation
      if (mode === 'prompt') {
        this.presentedInputTempIds.add(accepted.tempId)
        this.emit({
          type: 'message_start',
          tempId: accepted.tempId,
          message: {
            type: 'user',
            text: accepted.initial.text,
            images: inputImages(accepted.initial)
          }
        })
      }

      let resolvePreflight!: (accepted: boolean) => void
      const preflight = new Promise<boolean>((resolve) => {
        resolvePreflight = resolve
      })
      let runError: unknown = null
      const run = session.prompt(accepted.input.text, {
        images: toL4PiImageContent(accepted.initial.images),
        source: 'rpc',
        streamingBehavior: accepted.input.mode === 'follow_up' ? 'followUp' : 'steer',
        preflightResult: () => resolvePreflight(true)
      })
      const observed = run.then(
        () => {
          resolvePreflight(false)
          this.finishObservedSend(validation!)
        },
        (error: unknown) => {
          runError = error
          // Pi 拒绝输入时不再触发 preflightResult，必须结束接纳等待。
          resolvePreflight(false)
          this.finishObservedSend(validation!)
        }
      )
      this.observeRun(observed)

      const acceptedByPi = await preflight
      if (this.activeValidation === validation) this.activeValidation = null
      if (validation.compactionStarted) this.scheduleCompactionMessageResume()
      if (validation.error) throw validation.error
      if (!acceptedByPi) {
        await observed
        throw runError instanceof Error ? runError : new Error('Pi 拒绝接纳聊天输入')
      }
      if (!validation.prepared) {
        this.discardPresentedInput(accepted.tempId)
        console.info('[Pi Desk][PiChatWorker] 聊天输入已由扩展直接处理', {
          sessionId: session.sessionId,
          tempId: accepted.tempId
        })
        return
      }
      console.info('[Pi Desk][PiChatWorker] Pi 已开始处理已接管聊天输入', {
        sessionId: session.sessionId,
        tempId: accepted.tempId,
        mode: validation.mode
      })
    } catch (error) {
      if (this.activeValidation === validation) this.activeValidation = null
      if (validation) {
        this.cancelPreflightOperation(validation)
        if (validation.compactionStarted) this.scheduleCompactionMessageResume()
      }
      this.discardPresentedInput(accepted.tempId)
      console.warn('[Pi Desk][PiChatWorker] 已撤回未被 Pi 接纳的聊天输入', {
        sessionId: this.session?.sessionId ?? this.sessionManager.getSessionId(),
        tempId: accepted.tempId,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
    }
  }

  private discardAcceptedInputs(): void {
    const accepted = this.acceptedInputs.splice(0)
    for (const input of accepted) this.discardPresentedInput(input.tempId)
    if (accepted.some((input) => input.deferredByCompaction)) this.emitRuntime()
  }

  private discardPresentedInput(tempId: string): void {
    if (!this.presentedInputTempIds.delete(tempId)) return
    this.emit({ type: 'message_discard', tempId })
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.disposed) throw new Error('Pi chat worker has been disposed')
    if (this.sessionLifecycle)
      throw new Error('Pi 扩展生命周期尚未完成，请等待或在新会话使用基础聊天')
    if (this.session) return this.session
    if (this.initializePromise) return this.initializePromise

    this.initializePromise = this.createSession().finally(() => {
      this.initializePromise = null
    })
    return this.initializePromise
  }

  private restoreBasicInitialization(cause: unknown): void {
    this.releaseSessionBindings()
    this.initialization.dispose()
    this.session = null
    if (this.disposed || this.extensionMode === 'basic') throw cause
    const diagnostic = cause instanceof Error ? cause.message : String(cause)
    this.initializationError =
      diagnostic.length > 32_000 ? `${diagnostic.slice(0, 31_970)}\n…诊断过长，已截断` : diagnostic
    this.extensionMode = 'basic'
    this.updateBackgroundTasks([])
    this.initialization = this.createInitialization()
    console.warn('[Pi Desk][PiChatWorker] 扩展加载失败，切换基础聊天', {
      sessionId: this.sessionManager.getSessionId(),
      cwd: this.cwd,
      message: this.initializationError
    })
  }

  private async createSession(refreshResources = false): Promise<AgentSession> {
    let session: AgentSession
    try {
      session = await this.initialization.start(refreshResources)
    } catch (cause) {
      this.restoreBasicInitialization(cause)
      session = await this.initialization.start()
    }
    if (this.disposed) {
      this.initialization.dispose()
      throw new Error('Pi Worker 已释放')
    }
    try {
      this.syncOwnerAppendedEntries()
    } catch (error) {
      this.initialization.dispose()
      throw error
    }

    this.session = session
    if (this.extensionMode === 'normal') this.initializationError = null
    this.unsubscribeAgent = session.agent.subscribe((event) => {
      if (this.session === session) this.handleAgentEvent(event)
    })
    this.toolRuntimeLease = retainL4PiAgentToolRuntime(session)
    this.toolRuntime = this.toolRuntimeLease.runtime
    this.unsubscribeToolRuntime = this.toolRuntime.subscribe((event) => {
      if (this.session !== session) return
      this.emit(event)
      if (
        event.type === 'message_update' &&
        event.message.type === 'tool' &&
        event.message.status !== 'running'
      ) {
        this.flushLiveUpdates()
      }
    })
    this.unsubscribeSession = session.subscribe((event) => {
      if (this.session === session) this.handleSessionEvent(event)
    })
    if (this.backgroundTaskIds.size > 0) this.emitBackgroundTasks()
    this.emitRuntime()
    return session
  }

  private syncOwnerAppendedEntries(): void {
    const entries = this.sessionManager.getEntries()
    for (const entry of entries.slice(this.observedEntryCount)) {
      this.onEntryAppended(entry)
    }
  }

  private validateFinalInput(
    text: string,
    images: ImageContent[] | undefined,
    streamingBehavior: 'steer' | 'followUp' | undefined
  ) {
    const validation = this.activeValidation
    if (!validation) return { action: 'continue' as const }

    try {
      const actualMode: L4PiResolvedSendMode = streamingBehavior ?? 'prompt'
      if (
        validation.requestedMode === 'follow_up' &&
        actualMode !== 'followUp' &&
        !(validation.allowIdleFollowUp && actualMode === 'prompt')
      ) {
        throw new Error('主 Agent 已空闲，不能添加 Follow-up')
      }
      validation.mode = actualMode
      const session = this.session
      if (!session) throw new Error('Pi AgentSession 尚未就绪')
      const prepared = prepareL4PiTransformedInput(
        text,
        images,
        session.resourceLoader.getSkills().skills,
        session.promptTemplates
      )
      if (prepared.images.length > 0 && !session.model?.input.includes('image')) {
        throw new Error('当前模型不支持图片输入')
      }
      validation.prepared = prepared

      if (validation.mode === 'prompt') {
        this.pendingPrompt = { tempId: validation.tempId, input: prepared }
      } else {
        const queue = validation.mode === 'steer' ? this.steeringQueue : this.followUpQueue
        const candidate: L4PiQueuedInputRecord = {
          tempId: validation.tempId,
          input: prepared,
          confirmed: false
        }
        validateL4PiQueuedInputs([
          ...this.steeringQueue.map((item) => item.input),
          ...this.followUpQueue.map((item) => item.input),
          prepared
        ])
        queue.push(candidate)
      }
      return { action: 'continue' as const }
    } catch (error) {
      validation.error = error instanceof Error ? error : new Error('聊天输入校验失败')
      return { action: 'handled' as const }
    }
  }

  private cancelPreflightOperation(validation: L4PiInputValidationContext): void {
    if (!validation.compactionStarted) return
    validation.compactionStarted = false
    this.emit({ type: 'main_operation_cancelled' })
  }

  private finishObservedSend(validation: L4PiInputValidationContext): void {
    this.reconcileAppendedEntries()
    if (this.activeValidation === validation) this.activeValidation = null
    if (this.pendingPrompt?.tempId === validation.tempId) {
      this.pendingPrompt = null
      this.discardPresentedInput(validation.tempId)
    }
    const removed = this.removeUnconfirmedQueueItem(validation.tempId)
    if (removed) {
      this.discardPresentedInput(validation.tempId)
      this.emitRuntime()
    }
  }

  private removeUnconfirmedQueueItem(tempId: string): boolean {
    for (const queue of [this.steeringQueue, this.followUpQueue]) {
      const index = queue.findIndex((item) => item.tempId === tempId && !item.confirmed)
      if (index >= 0) {
        queue.splice(index, 1)
        return true
      }
    }
    return false
  }

  private observeRun(run: Promise<void>): void {
    this.observedRunPromises.add(run)
    void run.finally(() => this.observedRunPromises.delete(run))
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (this.disposed || this.treeNavigation) return
    switch (event.type) {
      case 'agent_start':
        this.oversizedToolCallAbortRequested = false
        this.emit({ type: 'agent_started' })
        return
      case 'agent_end':
        this.oversizedToolCallAbortRequested = false
        this.reconcileAppendedEntries()
        return
      case 'message_start':
        if (this.abortOversizedStreamingToolCall(event.message)) return
        this.startMessage(event.message)
        return
      case 'message_update':
        if (this.abortOversizedStreamingToolCall(event.message)) return
        this.updateMessage(event.message)
        this.toolRuntime?.syncStreamingTools(event.message)
        return
      case 'message_end':
        this.toolRuntime?.syncStreamingTools(event.message)
        this.endMessage(event.message)
        return
      default:
        return
    }
  }

  private abortOversizedStreamingToolCall(message: unknown): boolean {
    const oversized = findOversizedStreamingToolCall(message)
    if (!oversized) return false

    if (!this.oversizedToolCallAbortRequested) {
      this.oversizedToolCallAbortRequested = true
      console.warn('[Pi Desk][PiChatWorker] 工具参数流过大，已中止当前 Agent', {
        sessionId: this.sessionManager.getSessionId(),
        toolCallId: oversized.toolCallId,
        toolName: oversized.toolName,
        argumentChars: oversized.argumentChars,
        maxArgumentChars: L4_PI_CHAT_MAX_STREAMING_TOOL_ARGUMENT_CHARS
      })
      this.session?.agent.abort()
    }
    return true
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    if (this.disposed) return
    switch (event.type) {
      case 'queue_update':
        this.handleQueueUpdate(event.steering, event.followUp)
        return
      case 'agent_end':
        if (event.willRetry && (this.toolRuntime?.size ?? 0) > 0) {
          console.warn('[Pi Desk][PiChatWorker] 自动重试前丢弃未闭合 ToolCall', {
            sessionId: this.sessionManager.getSessionId(),
            toolCount: this.toolRuntime?.size ?? 0
          })
          this.toolRuntime?.discardAll()
        }
        return
      case 'agent_settled':
        this.oversizedToolCallAbortRequested = false
        this.reconcileAppendedEntries()
        this.toolRuntime?.discardAll()
        this.emitRuntime()
        this.emit({ type: 'agent_settled' })
        return
      case 'compaction_start': {
        this.messageGate.pause()
        console.info('[Pi Desk][PiChatWorker] 上下文压缩开始', {
          sessionId: this.session?.sessionId,
          reason: event.reason
        })
        if (!this.activeCompactionTempId) {
          const tempId = randomUUID()
          this.activeCompactionTempId = tempId
          this.emit({ type: 'message_start', tempId, message: compactionMessage() })
        } else {
          console.warn('[Pi Desk][PiChatWorker] 已忽略重复的上下文压缩开始事件', {
            sessionId: this.session?.sessionId,
            reason: event.reason
          })
        }
        if (this.activeValidation) this.activeValidation.compactionStarted = true
        this.emit({ type: 'agent_started' })
        return
      }
      case 'compaction_end':
        if (event.errorMessage) {
          console.error('[Pi Desk][PiChatWorker] 上下文压缩失败', {
            sessionId: this.session?.sessionId,
            reason: event.reason,
            errorMessage: event.errorMessage
          })
        } else {
          console.info('[Pi Desk][PiChatWorker] 上下文压缩结束', {
            sessionId: this.session?.sessionId,
            reason: event.reason,
            aborted: event.aborted,
            compacted: event.result !== undefined,
            willRetry: event.willRetry
          })
        }
        if (event.result) {
          const activeTempId = this.activeCompactionTempId
          this.reconcileAppendedEntries()
          if (activeTempId && this.activeCompactionTempId === activeTempId) {
            console.error('[Pi Desk][PiChatWorker] 压缩成功但未找到对应 CompactionEntry', {
              sessionId: this.session?.sessionId,
              reason: event.reason
            })
            this.discardActiveCompaction()
          }
        } else {
          this.discardActiveCompaction()
        }
        this.emitRuntime()
        if (event.reason === 'manual') this.manualCompactionFinishPending = true
        this.scheduleCompactionMessageResume()
        return
      case 'thinking_level_changed':
        if (!this.publishingModel) this.emitRuntime()
        return
      case 'entry_appended':
        if (!this.treeNavigation) this.onEntryAppended(event.entry)
        return
      case 'session_info_changed':
        this.emit({ type: 'session_info_changed', sessionTitle: event.name?.trim() || null })
        return
      case 'bash_execution_update':
        if (event.id) this.updateBash(event.id, event.delta)
        return
      default:
        return
    }
  }

  private startMessage(messageInput: SessionMessageEntry['message']): void {
    const role = messageRole(messageInput)
    let tempId: string
    let started = true
    let presentedInput = false
    let toolCallId: string | null = null

    if (role === 'user') {
      const reserved = this.takeUserInput()
      tempId = reserved?.tempId ?? randomUUID()
      presentedInput = this.presentedInputTempIds.delete(tempId)
    } else if (role === 'toolResult') {
      toolCallId = toolResultId(messageInput)
      const toolTempId = toolCallId ? this.toolRuntime?.tempId(toolCallId) : null
      tempId = toolTempId ?? randomUUID()
      started = toolTempId === null
    } else {
      tempId = randomUUID()
    }

    const message = this.projectLiveMessage(messageInput, toolCallId)
    if (!message) return
    this.activeMessage = { tempId, started: started || presentedInput, toolCallId }
    this.emit({
      type: started && !presentedInput ? 'message_start' : 'message_update',
      tempId,
      message
    })
  }

  private updateMessage(messageInput: SessionMessageEntry['message']): void {
    const active = this.activeMessage
    if (!active) return
    const message = this.projectLiveMessage(messageInput, active.toolCallId)
    if (message) this.emit({ type: 'message_update', tempId: active.tempId, message })
  }

  private endMessage(messageInput: SessionMessageEntry['message']): void {
    let active = this.activeMessage
    const role = messageRole(messageInput)
    const toolCallId = role === 'toolResult' ? toolResultId(messageInput) : null
    if (!active) {
      const message = this.projectLiveMessage(messageInput, toolCallId)
      if (!message) return
      active = { tempId: randomUUID(), started: true, toolCallId }
      this.emit({ type: 'message_start', tempId: active.tempId, message })
    }

    const finalMessage = this.projectLiveMessage(messageInput, active.toolCallId)
    if (finalMessage) {
      this.emit({ type: 'message_update', tempId: active.tempId, message: finalMessage })
    }

    const leaf = this.sessionManager.getLeafEntry()
    const projected = leaf ? projectL4PiChatEntry(leaf) : null
    if (leaf && projected) {
      this.onEntryAppended(leaf)
      this.committedEntryIds.add(leaf.id)
      this.observedEntryCount = this.sessionManager.getEntries().length
      this.emit({
        type: 'message_commit',
        tempId: active.tempId,
        entryId: projected.entryId,
        timestampMs: projected.timestampMs,
        message: finalMessage ?? projected.message
      })
      this.emitRuntime()
    } else if (active.started) {
      this.emit({ type: 'message_discard', tempId: active.tempId })
    }

    if (active.toolCallId) this.toolRuntime?.remove(active.toolCallId)
    this.activeMessage = null
  }

  private projectLiveMessage(
    message: SessionMessageEntry['message'],
    toolCallId: string | null
  ): L4PiChatMessage | null {
    if (messageRole(message) !== 'toolResult' || !toolCallId) {
      return projectL4PiAgentMessage(message)
    }

    return this.toolRuntime?.projectLiveResult(message, toolCallId) ?? null
  }

  private takeUserInput(): { tempId: string; input: L4PiPreparedChatInput } | null {
    if (this.pendingPrompt) {
      const pending = this.pendingPrompt
      this.pendingPrompt = null
      return pending
    }

    const queued = this.steeringQueue.shift() ?? this.followUpQueue.shift()
    if (!queued) return null
    this.applyPendingQueueText()
    this.emitRuntime()
    return { tempId: queued.tempId, input: queued.input }
  }

  private startBash(executionId: string, command: string): void {
    const bash: L4PiBashTemp = {
      tempId: randomUUID(),
      executionId,
      command,
      output: '',
      status: 'running'
    }
    this.bashTempsById.set(executionId, bash)
    this.emit({ type: 'message_start', tempId: bash.tempId, message: this.bashMessage(bash) })
  }

  private updateBash(executionId: string, delta: string): void {
    const bash = this.bashTempsById.get(executionId)
    if (!bash || bash.status !== 'running') return
    bash.output += delta
    this.emit({ type: 'message_update', tempId: bash.tempId, message: this.bashMessage(bash) })
  }

  private completeBash(
    executionId: string,
    result: {
      output: string
      exitCode?: number
      cancelled: boolean
      truncated: boolean
    }
  ): void {
    const bash = this.bashTempsById.get(executionId)
    if (!bash) return
    bash.output = result.output
    bash.status = result.cancelled ? 'aborted' : result.exitCode === 0 ? 'completed' : 'error'
    this.emit({ type: 'message_update', tempId: bash.tempId, message: this.bashMessage(bash) })
    this.flushLiveUpdates()

    const leaf = this.sessionManager.getLeafEntry()
    const projected = leaf ? projectL4PiChatEntry(leaf) : null
    if (leaf && projected?.message.type === 'bash' && projected.message.command === bash.command) {
      this.onEntryAppended(leaf)
      this.commitBash(bash, projected)
    }
  }

  private commitBash(
    bash: L4PiBashTemp,
    projected: { entryId: string; timestampMs: number; message: L4PiChatMessage }
  ): void {
    this.flushLiveUpdates()
    this.committedEntryIds.add(projected.entryId)
    this.observedEntryCount = this.sessionManager.getEntries().length
    this.emit({
      type: 'message_commit',
      tempId: bash.tempId,
      entryId: projected.entryId,
      timestampMs: projected.timestampMs,
      message: projected.message
    })
    this.bashTempsById.delete(bash.executionId)
  }

  private discardBash(executionId: string): void {
    const bash = this.bashTempsById.get(executionId)
    if (!bash) return
    this.bashTempsById.delete(executionId)
    this.emit({ type: 'message_discard', tempId: bash.tempId })
  }

  private bashMessage(bash: L4PiBashTemp): L4PiChatMessage {
    return {
      type: 'bash',
      command: bash.command,
      status: bash.status,
      output: bash.output,
      declaration: {
        message: {
          kind: 'bash',
          command: bash.command,
          output: bash.output,
          exitCode: bash.status === 'completed' ? 0 : null,
          cancelled: bash.status === 'aborted',
          truncated: false
        },
        raw: {
          executionId: bash.executionId,
          command: bash.command,
          output: bash.output,
          status: bash.status
        }
      }
    }
  }

  private handleQueueUpdate(steering: readonly string[], followUp: readonly string[]): void {
    this.confirmAndSyncQueue('steering', steering)
    this.confirmAndSyncQueue('followUp', followUp)
    this.emitRuntime()
  }

  private confirmAndSyncQueue(kind: L4PiQueueKind, texts: readonly string[]): void {
    const queue = kind === 'steering' ? this.steeringQueue : this.followUpQueue
    for (const item of queue) item.confirmed = true
    if (queue.length !== texts.length) {
      this.pendingQueueText.set(kind, texts)
      return
    }
    queue.forEach((item, index) => {
      item.input.text = texts[index] ?? item.input.text
    })
    this.pendingQueueText.delete(kind)
  }

  private applyPendingQueueText(): void {
    for (const kind of ['steering', 'followUp'] as const) {
      const pending = this.pendingQueueText.get(kind)
      if (pending) this.confirmAndSyncQueue(kind, pending)
    }
  }

  private reconcileAppendedEntries(): void {
    if (this.treeNavigation) return
    const entries = this.sessionManager.getEntries()
    const appended = entries.slice(this.observedEntryCount)
    this.observedEntryCount = entries.length

    for (const entry of appended) {
      this.onEntryAppended(entry)
      if (this.committedEntryIds.has(entry.id)) continue
      const projected = projectL4PiChatEntry(entry)
      if (!projected) continue
      if (entry.type === 'compaction' && this.activeCompactionTempId) {
        const tempId = this.activeCompactionTempId
        this.activeCompactionTempId = null
        this.committedEntryIds.add(entry.id)
        this.emit({
          type: 'message_commit',
          tempId,
          entryId: projected.entryId,
          timestampMs: timestampFromEntry(entry.id, entry.timestamp),
          message: projected.message
        })
        continue
      }
      if (projected.message.type === 'bash') {
        const command = projected.message.command
        const pendingBash = [...this.bashTempsById.values()]
          .reverse()
          .find((bash) => bash.command === command)
        if (pendingBash) {
          this.commitBash(pendingBash, projected)
          continue
        }
      }
      const tempId = randomUUID()
      this.committedEntryIds.add(entry.id)
      this.emit({ type: 'message_start', tempId, message: projected.message })
      this.emit({
        type: 'message_commit',
        tempId,
        entryId: projected.entryId,
        timestampMs: timestampFromEntry(entry.id, entry.timestamp),
        message: projected.message
      })
    }
  }

  private discardActiveCompaction(): void {
    const tempId = this.activeCompactionTempId
    if (!tempId) return
    this.activeCompactionTempId = null
    this.emit({ type: 'message_discard', tempId })
  }

  private updateBackgroundTasks(taskIds: readonly string[]): void {
    const next = new Set(taskIds)
    if (
      next.size === this.backgroundTaskIds.size &&
      [...next].every((taskId) => this.backgroundTaskIds.has(taskId))
    ) {
      return
    }
    this.backgroundTaskIds.clear()
    for (const taskId of next) this.backgroundTaskIds.add(taskId)
    this.emitBackgroundTasks()
  }

  private emitBackgroundTasks(): void {
    this.emit({ type: 'background_tasks_changed', taskIds: [...this.backgroundTaskIds] })
  }

  private runtimeSnapshot(): L4PiChatRuntimeSnapshot {
    const session = this.session
    const model = session?.model
    const contextUsage = session?.getContextUsage()
    const acceptedSteering = this.acceptedInputs
      .filter((input) => input.deferredByCompaction && input.input.mode === 'auto')
      .map(runtimeAcceptedInput)
    const acceptedFollowUp = this.acceptedInputs
      .filter((input) => input.deferredByCompaction && input.input.mode === 'follow_up')
      .map(runtimeAcceptedInput)
    return {
      extensionMode: this.extensionMode,
      initializationError: this.initializationError,
      queues: {
        steering: [...this.steeringQueue.map(runtimeQueueItem), ...acceptedSteering],
        followUp: [...this.followUpQueue.map(runtimeQueueItem), ...acceptedFollowUp]
      },
      model: model
        ? {
            provider: model.provider,
            modelId: model.id,
            thinkingLevel: session.thinkingLevel
          }
        : null,
      contextUsage:
        contextUsage && contextUsage.contextWindow > 0
          ? { tokens: contextUsage.tokens, contextWindow: contextUsage.contextWindow }
          : null,
      plugins: this.pluginRuntime.snapshot(),
      capabilityMode: this.capabilities.mode()
    }
  }

  private emitRuntime(): void {
    if (this.session) this.emit({ type: 'runtime_changed', runtime: this.runtimeSnapshot() })
  }

  private emit(event: L4PiChatWorkerEvent): void {
    if (this.disposed || this.treeNavigation) return
    if (event.type === 'message_update') {
      this.scheduleLiveUpdate(event)
      return
    }

    // 非 update 事件是顺序屏障，确保状态、提交和运行态不会越过尚未发布的文本。
    this.flushLiveUpdates()
    if (event.type === 'message_start') {
      this.clearLiveUpdate(event.tempId)
      this.liveUpdatesByTempId.set(event.tempId, {
        lastPublishedAt: Date.now(),
        pending: null,
        timer: null,
        receivedCount: 0,
        publishedCount: 0
      })
    } else if (event.type === 'message_commit' || event.type === 'message_discard') {
      this.finishLiveUpdate(event.tempId)
    }
    if (event.type === 'message_commit' || event.type === 'session_info_changed') {
      invalidateL4PiSessionHistoryCache(this.cwd)
    }
    this.publish(event)
  }

  private scheduleLiveUpdate(event: L4PiChatMessageUpdateEvent): void {
    const state = this.liveUpdatesByTempId.get(event.tempId) ?? {
      lastPublishedAt: 0,
      pending: null,
      timer: null,
      receivedCount: 0,
      publishedCount: 0
    }
    state.pending = event
    state.receivedCount += 1
    this.liveUpdatesByTempId.set(event.tempId, state)
    if (state.timer) return

    const elapsed = Date.now() - state.lastPublishedAt
    const delay = Math.max(0, L4_PI_CHAT_LIVE_UPDATE_INTERVAL_MS - elapsed)
    if (delay === 0) {
      this.publishPendingLiveUpdate(state)
      return
    }

    state.timer = setTimeout(() => {
      if (this.liveUpdatesByTempId.get(event.tempId) !== state) return
      state.timer = null
      this.publishPendingLiveUpdate(state)
    }, delay)
  }

  private publishPendingLiveUpdate(state: L4PiChatLiveUpdateState): void {
    const event = state.pending
    if (!event || this.disposed) return
    state.pending = null
    state.lastPublishedAt = Date.now()
    state.publishedCount += 1
    this.publish(event)
  }

  private flushLiveUpdates(): void {
    for (const state of this.liveUpdatesByTempId.values()) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
      this.publishPendingLiveUpdate(state)
    }
  }

  private finishLiveUpdate(tempId: string): void {
    const state = this.liveUpdatesByTempId.get(tempId)
    this.clearLiveUpdate(tempId)
    if (!state || state.receivedCount === state.publishedCount) return

    console.debug('[Pi Desk][PiChatWorker] 流式消息更新已合并', {
      sessionId: this.sessionManager.getSessionId(),
      tempId,
      receivedCount: state.receivedCount,
      publishedCount: state.publishedCount
    })
  }

  private clearLiveUpdate(tempId: string): void {
    const state = this.liveUpdatesByTempId.get(tempId)
    if (state?.timer) clearTimeout(state.timer)
    this.liveUpdatesByTempId.delete(tempId)
  }

  private clearLiveUpdates(): void {
    for (const state of this.liveUpdatesByTempId.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    this.liveUpdatesByTempId.clear()
  }

  private publish(event: L4PiChatWorkerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[Pi Desk][PiChatWorker] 事件监听器执行失败', {
          sessionId: this.sessionManager.getSessionId(),
          eventType: event.type,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }

  private clearMemory(): void {
    this.steeringQueue.length = 0
    this.followUpQueue.length = 0
    this.pendingQueueText.clear()
    this.bashTempsById.clear()
    this.pendingPrompt = null
    this.activeMessage = null
    this.activeValidation = null
    this.activeCompactionTempId = null
    this.oversizedToolCallAbortRequested = false
    this.acceptedInputs.length = 0
    this.presentedInputTempIds.clear()
    this.committedEntryIds.clear()
    this.backgroundTaskIds.clear()
  }
}
