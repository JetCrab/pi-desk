import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  buildSessionContext,
  calculateContextTokens,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  getLastAssistantUsage,
  type LoadExtensionsResult,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type SessionEntry
} from '@earendil-works/pi-coding-agent'
import { isRetryableAssistantError, StringEnum, type AssistantMessage } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import {
  bindSessionPlugin,
  type SessionPluginFacade,
  type TaskHandle,
  type TaskInfoItem,
  type TaskInfoLoader,
  type TaskRuntimeSnapshot,
  type TaskStatus
} from '@jetcrab/pi-desk-sdk'
import {
  discoverSubagentConfigs,
  isSubagentName,
  type SubagentConfig,
  type SubagentName
} from './agent-config.js'
import { createExternalResearchExtension } from './external-research.js'
import { SubagentCapabilities } from './subagent-capabilities.js'
import { isCapabilityAllowed, type SessionCapabilityRules } from '@jetcrab/pi-desk-sdk/capabilities'
import {
  createResearchCoordinatorExtension,
  createResearchWorkerConfig,
  RESEARCH_WORKER_AGENT_TYPE,
  type ResearchDelegateTask,
  type ResearchWorkerOutcome
} from './research-runtime.js'
import {
  SUBAGENT_COMPLETION_CUSTOM_TYPE,
  SUBAGENT_LAUNCH_STATE_CUSTOM_TYPE,
  SUBAGENT_RECORD_VERSION,
  SUBAGENT_SHUTDOWN_STATE_CUSTOM_TYPE
} from './subagent-message.js'

const SUBAGENT_COMPLETION_NOTICE =
  '子代理结束后会异步主动通知结果并唤醒主代理。不要为等待结果调用 agent_list 查询状态，也不要通过 bash/sleep 等方式等待。可以继续独立工作；没有独立工作时结束当前轮，等待通知。'

export const CHILD_BOUNDARY = `# 子代理边界

- 你是由顶层主会话派发任务的 child subagent，只执行当前任务。
- 不启动、建议或编排其他子代理。
- 只在任务授权范围内操作；遇到未授权的产品、架构或范围决策时停止并在结果中说明。
- 最终回复遵循当前角色的输出要求；开发任务说明完成内容、修改文件和验证情况，只读任务直接返回分析或审查结果。`

const SUBAGENT_PACKAGE_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const CONTEXT_CHECKPOINT_TOOL = 'ctx'

export const RESEARCH_COORDINATOR_BOUNDARY = `# 子代理边界

- 你是由顶层主会话派发任务的 child subagent，只执行当前任务。
- 仅可通过 \`research_delegate\` 启动叶子 Research Worker；不得使用或模拟通用 Agent 委派。
- 只有至少两个范围互不依赖的研究轨道才可委派，Worker 数量由实际范围决定。
- 调用 \`research_delegate\` 后等待全部 Worker 终态，不在等待期间重复研究相同范围。
- 只在任务授权范围内操作；遇到未授权的产品、架构或范围决策时停止并在结果中说明。
- 最终回复遵循当前角色的输出要求；只读任务直接返回研究结果。`

type TerminalStatus = Exclude<TaskStatus, 'running'>

type LaunchDetails = {
  version: 1
  kind: 'launch'
  taskId: string
  agentType: SubagentName
  title: string
  sessionFile: string
  startedAt: number
}

type TerminalDetails = {
  version: 1
  kind: 'terminal'
  taskId: string
  status: TerminalStatus
  endedAt: number
  sessionFile: string
}

export interface SubagentRecord {
  taskId: string
  agentType: SubagentName
  title: string
  status: TaskStatus
  sessionFile: string
  startedAt: number
  endedAt: number | null
  session: AgentSession | null
  taskHandle: TaskHandle | null
  taskInfoUnsubscribe: (() => void) | null
  pendingSteers: string[]
  steerReady: boolean
  stopRequested: boolean
  ownerTaskId: string | null
  notifyParent: boolean
  persistLifecycle: boolean
  resolveRun: ((outcome: ResearchWorkerOutcome) => void) | null
}

export type SubagentParentContext = {
  cwd: string
  sessionId: string
  sessionDir: string
  sessionFile?: string
  model: ExtensionContext['model']
  thinkingLevel: ExtensionContext['thinkingLevel']
  projectTrusted: boolean
}

type StartRecordOptions = {
  ownerTaskId: string | null
  notifyParent: boolean
  persistLifecycle: boolean
  resolveRun: ((outcome: ResearchWorkerOutcome) => void) | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isInsidePath(parent: string, candidate: string): boolean {
  const path = relative(canonicalPath(parent), canonicalPath(candidate))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function excludeSubagentPackageExtensions(
  result: LoadExtensionsResult,
  packageRoot = SUBAGENT_PACKAGE_ROOT
): LoadExtensionsResult {
  return {
    ...result,
    extensions: result.extensions.filter(
      (extension) =>
        !isAbsolute(extension.resolvedPath) || !isInsidePath(packageRoot, extension.resolvedPath)
    )
  }
}

export function childAllowedTools(tools: readonly string[]): string[] {
  return [...new Set([...tools, CONTEXT_CHECKPOINT_TOOL])]
}

function isMcpToolName(name: string): boolean {
  return /^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/.test(name)
}

function isTerminalStatus(value: unknown): value is TerminalStatus {
  return (
    value === 'completed' || value === 'failed' || value === 'stopped' || value === 'interrupted'
  )
}

function launchDetails(value: unknown): LaunchDetails | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.version !== SUBAGENT_RECORD_VERSION ||
    value.kind !== 'launch' ||
    typeof value.taskId !== 'string' ||
    !isSubagentName(value.agentType) ||
    typeof value.title !== 'string' ||
    typeof value.sessionFile !== 'string' ||
    typeof value.startedAt !== 'number'
  ) {
    return undefined
  }
  return value as LaunchDetails
}

function terminalDetails(value: unknown): TerminalDetails | undefined {
  if (!isRecord(value)) return undefined
  if (
    value.version !== SUBAGENT_RECORD_VERSION ||
    value.kind !== 'terminal' ||
    typeof value.taskId !== 'string' ||
    !isTerminalStatus(value.status) ||
    typeof value.endedAt !== 'number' ||
    typeof value.sessionFile !== 'string'
  ) {
    return undefined
  }
  return value as TerminalDetails
}

function entryTimestamp(entry: SessionEntry): number {
  const value = Date.parse(entry.timestamp)
  return Number.isFinite(value) ? value : 0
}

function historicalRecord(details: LaunchDetails, persistLifecycle: boolean): SubagentRecord {
  return {
    taskId: details.taskId,
    agentType: details.agentType,
    title: details.title,
    status: 'running',
    sessionFile: details.sessionFile,
    startedAt: details.startedAt,
    endedAt: null,
    session: null,
    taskHandle: null,
    taskInfoUnsubscribe: null,
    pendingSteers: [],
    steerReady: false,
    stopRequested: false,
    ownerTaskId: null,
    notifyParent: !persistLifecycle,
    persistLifecycle,
    resolveRun: null
  }
}

export function restoreSubagentRecords(
  branch: readonly SessionEntry[]
): Map<string, SubagentRecord> {
  const records = new Map<string, SubagentRecord>()
  const lastEventAt = new Map<string, number>()

  for (const entry of branch) {
    const launch =
      entry.type === 'message' &&
      entry.message.role === 'toolResult' &&
      (entry.message.toolName === 'agent' || entry.message.toolName === 'agent_resume')
        ? { details: launchDetails(entry.message.details), persistLifecycle: false }
        : entry.type === 'custom' &&
            (entry.customType === SUBAGENT_LAUNCH_STATE_CUSTOM_TYPE ||
              entry.customType === 'pi-super-subagent:launch:v1')
          ? { details: launchDetails(entry.data), persistLifecycle: true }
          : undefined
    if (launch?.details) {
      records.set(launch.details.taskId, historicalRecord(launch.details, launch.persistLifecycle))
      lastEventAt.set(launch.details.taskId, entryTimestamp(entry))
      continue
    }

    const details =
      entry.type === 'custom_message' &&
      (entry.customType === SUBAGENT_COMPLETION_CUSTOM_TYPE ||
        entry.customType === 'pi-super-subagent:completion:v1')
        ? terminalDetails(entry.details)
        : entry.type === 'custom' &&
            (entry.customType === SUBAGENT_SHUTDOWN_STATE_CUSTOM_TYPE ||
              entry.customType === 'pi-super-subagent:state:v1')
          ? terminalDetails(entry.data)
          : undefined
    if (!details) continue
    const record = records.get(details.taskId)
    if (!record) continue
    record.status = details.status
    record.endedAt = details.endedAt
    record.sessionFile = details.sessionFile
    lastEventAt.set(details.taskId, entryTimestamp(entry))
  }

  for (const record of records.values()) {
    if (record.status !== 'running') continue
    record.status = 'interrupted'
    record.endedAt = lastEventAt.get(record.taskId) ?? record.startedAt
  }
  return records
}

function activityForStatus(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return '执行中'
    case 'completed':
      return '执行完成'
    case 'failed':
      return '执行失败'
    case 'stopped':
      return '已停止'
    case 'interrupted':
      return '执行中断'
  }
}

const taskNumberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export function normalizeRetryableAbortedAssistantMessage(
  message: AssistantMessage,
  stopRequested: boolean
): AssistantMessage | undefined {
  if (stopRequested || message.stopReason !== 'aborted' || !message.errorMessage) return undefined
  const retryCandidate: AssistantMessage = { ...message, stopReason: 'error' }
  return isRetryableAssistantError(retryCandidate) ? retryCandidate : undefined
}

export function createRetryCompatibilityExtension(
  isStopRequested: (sessionId: string) => boolean
): ExtensionFactory {
  return (pi) => {
    pi.on('message_end', (event, ctx) => {
      if (event.message.role !== 'assistant') return
      const message = normalizeRetryableAbortedAssistantMessage(
        event.message,
        isStopRequested(ctx.sessionManager.getSessionId())
      )
      if (!message) return
      console.warn('[pi-desk-subagent] 瞬时流中断交由 AgentSession 自动重试', {
        sessionId: ctx.sessionManager.getSessionId(),
        error: message.errorMessage
      })
      return { message }
    })
  }
}

function taskMessageCounts(entries: readonly SessionEntry[]): { user: number; total: number } {
  let user = 0
  let total = 0
  for (const entry of entries) {
    if (entry.type === 'message') {
      if (entry.message.role === 'custom' && !entry.message.display) continue
      if (
        entry.message.role !== 'user' &&
        entry.message.role !== 'assistant' &&
        entry.message.role !== 'toolResult' &&
        entry.message.role !== 'bashExecution' &&
        entry.message.role !== 'custom'
      ) {
        continue
      }
      total += 1
      if (entry.message.role === 'user') user += 1
      continue
    }
    if (entry.type === 'custom_message') {
      if (entry.display) total += 1
      continue
    }
    if (entry.type === 'compaction') total += 1
  }
  return { user, total }
}

function taskInfo(
  model: { id: string; name?: string } | undefined,
  usage: { tokens: number | null; contextWindow: number } | undefined,
  sessionFile: string,
  entries: readonly SessionEntry[]
): TaskInfoItem[] {
  const info: TaskInfoItem[] = []
  if (model) {
    const context = usage
      ? `${usage.tokens === null ? '未计算' : taskNumberFormatter.format(usage.tokens)}/${taskNumberFormatter.format(usage.contextWindow)} tokens`
      : null
    info.push({
      label: '运行信息',
      value: [model.name || model.id, context].filter(Boolean).join(' · ')
    })
  }
  const counts = taskMessageCounts(entries)
  info.push({ label: '消息数', value: `${counts.user}/${counts.total}（用户/总数）` })
  info.push({ label: '会话文件', value: sessionFile })
  return info
}

function currentTaskInfo(session: AgentSession | null): TaskInfoItem[] {
  if (!session?.sessionFile) return []
  let usage: ReturnType<AgentSession['getContextUsage']> = undefined
  try {
    usage = session.getContextUsage()
  } catch {
    // Session 初始化期间用量可能暂不可得，模型信息仍可展示。
  }
  return taskInfo(session.model, usage, session.sessionFile, session.sessionManager.getBranch())
}

function createHistoricalTaskInfoLoader(
  sessionFile: string,
  modelRuntime: ModelRuntime
): TaskInfoLoader {
  return () => {
    const sessionManager = SessionManager.open(sessionFile)
    const entries = sessionManager.getEntries()
    const sessionContext = buildSessionContext(entries, sessionManager.getLeafId())
    const model = sessionContext.model
    if (!model) return taskInfo(undefined, undefined, sessionFile, sessionManager.getBranch())

    const configuredModel = modelRuntime.getModel(model.provider, model.modelId)
    const usage = getLastAssistantUsage(sessionManager.buildContextEntries())
    const contextUsage =
      usage && configuredModel
        ? { tokens: calculateContextTokens(usage), contextWindow: configuredModel.contextWindow }
        : undefined
    return taskInfo(
      configuredModel ?? { id: model.modelId },
      contextUsage,
      sessionFile,
      sessionManager.getBranch()
    )
  }
}

function taskSnapshot(record: SubagentRecord, modelRuntime: ModelRuntime): TaskRuntimeSnapshot {
  return {
    taskId: record.taskId,
    taskKind: '子代理',
    taskType: record.agentType,
    title: record.title,
    info: currentTaskInfo(record.session),
    ...(record.session
      ? {}
      : { infoLoader: createHistoricalTaskInfoLoader(record.sessionFile, modelRuntime) }),
    status: record.status,
    activity: activityForStatus(record.status),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    detailSource: record.sessionFile
      ? { kind: 'pi-conversation', sessionFile: record.sessionFile }
      : null,
    interrupt: null
  }
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function finalAssistant(session: AgentSession): {
  text: string
  stopReason: string
  errorMessage?: string
} | null {
  const entries = session.sessionManager.getEntries()
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    return {
      text: entry.message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
      stopReason: entry.message.stopReason,
      errorMessage: entry.message.errorMessage
    }
  }
  return null
}

function lastAssistantText(session: AgentSession): string | null {
  const entries = session.sessionManager.getEntries()
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    const text = entry.message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim()
    if (text) return text
  }
  return null
}

async function closeChildSession(session: AgentSession): Promise<void> {
  try {
    // AgentSession.dispose() 不发送关闭事件，扩展须先在有效上下文中释放资源。
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  } catch (error) {
    console.warn(`[pi-desk-subagent] 子会话 ${session.sessionId} 扩展关闭失败`, error)
  } finally {
    session.dispose()
  }
}

export class SubagentRuntime {
  private readonly plugin: SessionPluginFacade
  private readonly records = new Map<string, SubagentRecord>()
  private readonly activeRuns = new Set<Promise<void>>()
  private readonly pendingCreates = new Set<Promise<AgentSession>>()
  private stopping = false
  private configs = new Map<SubagentName, SubagentConfig>()
  private capabilityRules: SessionCapabilityRules = { tools: {}, skills: {}, capabilities: {} }
  private readonly childCapabilities = new WeakMap<AgentSession, SubagentCapabilities>()
  private activeParent: SubagentParentContext | null = null
  private sessionActive = false

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly modelRuntime: ModelRuntime,
    private readonly agentDir = getAgentDir()
  ) {
    this.plugin = bindSessionPlugin(pi, 'subagent')
    this.plugin.onCapabilitiesChange((rules) => {
      this.capabilityRules = rules
      if (!this.sessionActive) return
      this.registerTools()
      for (const record of this.records.values()) {
        if (record.session) this.childCapabilities.get(record.session)?.refresh()
      }
    })
  }

  async startSession(ctx: ExtensionContext): Promise<void> {
    this.sessionActive = true
    this.activeParent = {
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      projectTrusted: ctx.isProjectTrusted()
    }
    this.records.clear()
    for (const [taskId, record] of restoreSubagentRecords(ctx.sessionManager.getBranch())) {
      this.records.set(taskId, record)
    }
    if (this.records.size > 0) {
      this.plugin.reportTasks(
        [...this.records.values()].map((record) => taskSnapshot(record, this.modelRuntime))
      )
    }

    this.refreshConfigs()
    if (this.configs.size === 0) this.registerTools()
  }

  refreshConfigs(): void {
    const parent = this.activeParent
    if (!this.sessionActive || !parent) return
    const discovery = discoverSubagentConfigs({
      cwd: parent.cwd,
      projectTrusted: parent.projectTrusted,
      agentDir: this.agentDir
    })
    const previous = [...this.configs.values()].map(({ name, description }) => [name, description])
    this.configs = discovery.configs
    for (const diagnostic of discovery.diagnostics) {
      console.warn(`[pi-desk-subagent] ${diagnostic}`)
    }
    const current = [...this.configs.values()].map(({ name, description }) => [name, description])
    if (JSON.stringify(previous) !== JSON.stringify(current)) this.registerTools()
  }

  async beforeTree(signal: AbortSignal): Promise<{ cancel: true } | undefined> {
    if (signal.aborted) return { cancel: true }
    this.stopping = true
    // 失效创建期 owner；即使导航被其他扩展取消，迟到创建也不能重新启动。
    if (this.activeParent) this.activeParent = { ...this.activeParent }
    try {
      await this.stopAndWait(false)
      return signal.aborted ? { cancel: true } : undefined
    } finally {
      this.stopping = false
    }
  }

  async shutdown(): Promise<void> {
    this.sessionActive = false
    await this.stopAndWait(true)
    this.activeParent = null
    this.configs.clear()
  }

  private async stopAndWait(shutdown: boolean): Promise<void> {
    const running = [...this.records.values()].filter(
      (record) => record.status === 'running' && record.session
    )
    const endedAt = Date.now()
    for (const record of running) {
      if (shutdown) {
        this.pi.appendEntry(
          SUBAGENT_SHUTDOWN_STATE_CUSTOM_TYPE,
          this.makeTerminalDetails(record, 'interrupted', endedAt)
        )
        record.stopRequested = true
      }
    }
    const results = await Promise.allSettled(
      running.map((record) =>
        shutdown
          ? record.session!.abort()
          : record.stopRequested
            ? undefined
            : this.requestStop(record)
      )
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected' && !shutdown) throw failure.reason
    await Promise.allSettled([...this.pendingCreates])
    await Promise.allSettled([...this.activeRuns])
    for (const record of running) {
      if (record.status === 'running') {
        if (!shutdown) throw new Error(`Agent ${record.taskId} 尚未完成关闭`)
        this.finishRecord(record, 'interrupted', null, '父会话已关闭', false, endedAt)
      }
    }
  }

  private registerTools(): void {
    const configs = [...this.configs.values()].filter((config) => this.agentAllowed(config.name))
    const names = configs.map((config) => config.name)
    if (names.length > 0) {
      const agentRoles = configs
        .map((config) => `- ${config.name}: ${config.description}`)
        .join('\n')
      const roleGuide = `可用子代理及职责：\n${agentRoles}`
      const nameSchema = StringEnum(names as [SubagentName, ...SubagentName[]], {
        description: '执行任务的子代理类型'
      })
      this.pi.registerTool({
        name: 'agent',
        exposure: 'model-only',
        label: 'Agent',
        description: `启动后台子代理执行派发任务。当前可用类型：${names.join(', ')}。`,
        promptSnippet: '启动后台子代理执行派发任务',
        promptGuidelines: [roleGuide],
        parameters: Type.Object({
          subagent_type: nameSchema,
          prompt: Type.String({ description: '完整、自包含的任务说明' }),
          description: Type.String({ description: '用于任务中心显示的简短任务标题' })
        }),
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
          this.startAgent(params.subagent_type, params.prompt, params.description, ctx)
      })
    }

    this.pi.registerTool({
      name: 'agent_resume',
      exposure: 'model-only',
      label: 'Resume Agent',
      description: '继续当前父会话 branch 中已经进入终态的子代理，并沿用原 Conversation。',
      parameters: Type.Object({
        agent_id: Type.String({ description: '完整 Agent ID 或唯一短前缀' }),
        prompt: Type.String({ description: '追加到原 Conversation 的新任务说明' })
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
        this.resumeAgent(params.agent_id, params.prompt, ctx)
    })

    this.pi.registerTool({
      name: 'agent_steer',
      label: 'Steer Agent',
      description: '向当前 running 子代理补充条件，不停止、重建或恢复子代理。',
      parameters: Type.Object({
        agent_id: Type.String({ description: '完整 Agent ID 或唯一短前缀' }),
        prompt: Type.String({ description: '要补充给子代理的条件或要求' })
      }),
      execute: async (_toolCallId, params) => this.steerAgent(params.agent_id, params.prompt)
    })

    this.pi.registerTool({
      name: 'agent_list',
      label: 'List Agents',
      description:
        '查询当前父会话分支的子代理状态；可传 agent_id，默认按最近启动时间返回最多20条记录。',
      parameters: Type.Object({
        agent_id: Type.Optional(
          Type.String({ description: '完整 Agent ID 或唯一短前缀；省略时列出最近记录' })
        )
      }),
      execute: async (_toolCallId, params) => this.listAgents(params.agent_id)
    })

    this.pi.registerTool({
      name: 'agent_stop',
      label: 'Stop Agent',
      description: '立即请求中断当前 running 子代理。',
      promptGuidelines: ['agent_stop 成功返回只表示已请求中断，最终状态以后续终态通知为准。'],
      parameters: Type.Object({
        agent_id: Type.String({ description: '完整 Agent ID 或唯一短前缀' })
      }),
      execute: async (_toolCallId, params) => this.stopAgent(params.agent_id)
    })
    const managed = ['agent', 'agent_resume', 'agent_steer']
    const active = this.pi.getActiveTools().filter((name) => !managed.includes(name))
    this.pi.setActiveTools(names.length > 0 ? [...active, ...managed] : active)
  }

  private requireParent(ctx: ExtensionContext): SubagentParentContext {
    const parent = this.activeParent
    if (
      !this.sessionActive ||
      this.stopping ||
      !parent ||
      parent.sessionId !== ctx.sessionManager.getSessionId() ||
      parent.cwd !== ctx.cwd
    ) {
      throw new Error('当前父会话已变化')
    }
    parent.model = ctx.model
    parent.thinkingLevel = ctx.thinkingLevel
    return parent
  }

  private requireText(value: string, field: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${field} 不能为空`)
    return text
  }

  private resolveRecord(
    agentIdOrPrefix: string,
    records: readonly SubagentRecord[] = [...this.records.values()]
  ): SubagentRecord {
    const query = this.requireText(agentIdOrPrefix, 'agent_id').toLowerCase()
    const exact = records.find((record) => record.taskId.toLowerCase() === query)
    if (exact) return exact
    const matches = records.filter((record) => record.taskId.toLowerCase().startsWith(query))
    if (matches.length === 0) throw new Error(`未知 Agent ID：${agentIdOrPrefix}`)
    if (matches.length > 1) throw new Error(`Agent ID 前缀不唯一：${agentIdOrPrefix}`)
    return matches[0]!
  }

  private agentAllowed(agentType: SubagentName): boolean {
    const type = agentType === RESEARCH_WORKER_AGENT_TYPE ? 'research' : agentType
    return isCapabilityAllowed(this.capabilityRules.capabilities.agents, type)
  }

  private resolveAgentConfig(agentType: SubagentName): SubagentConfig | undefined {
    if (!this.agentAllowed(agentType)) return undefined
    if (agentType !== RESEARCH_WORKER_AGENT_TYPE) return this.configs.get(agentType)
    const research = this.configs.get('research')
    return research ? createResearchWorkerConfig(research) : undefined
  }

  private createSessionManager(parent: SubagentParentContext): SessionManager {
    const childSessionDir = parent.sessionDir
      ? join(parent.sessionDir, 'subagents', safePathPart(parent.sessionId))
      : join(parent.cwd, 'temp', 'pi', 'pi-desk-subagent', safePathPart(parent.sessionId))
    return SessionManager.create(
      parent.cwd,
      childSessionDir,
      parent.sessionFile ? { parentSession: parent.sessionFile } : undefined
    )
  }

  private async startRecord(
    config: SubagentConfig,
    title: string,
    prompt: string,
    parent: SubagentParentContext,
    options: StartRecordOptions
  ): Promise<SubagentRecord> {
    const session = await this.createOwnedChildSession(
      config,
      parent,
      this.createSessionManager(parent)
    )
    if (!this.sessionActive || this.stopping || this.activeParent !== parent) {
      await closeChildSession(session)
      throw new Error('当前父会话已变化，子代理未启动')
    }
    const sessionFile = session.sessionFile
    if (!this.agentAllowed(config.name)) {
      await closeChildSession(session)
      throw new Error(`当前能力模式不允许 ${config.name} Agent`)
    }
    if (!sessionFile) {
      await closeChildSession(session)
      throw new Error('子代理没有持久 Session 文件')
    }
    const record: SubagentRecord = {
      taskId: session.sessionId,
      agentType: config.name,
      title,
      status: 'running',
      sessionFile,
      startedAt: Date.now(),
      endedAt: null,
      session,
      taskHandle: null,
      taskInfoUnsubscribe: null,
      pendingSteers: [],
      steerReady: false,
      stopRequested: false,
      ownerTaskId: options.ownerTaskId,
      notifyParent: options.notifyParent,
      persistLifecycle: options.persistLifecycle,
      resolveRun: options.resolveRun
    }
    this.records.set(record.taskId, record)
    let launchPersisted = false
    try {
      if (record.persistLifecycle) {
        this.pi.appendEntry(SUBAGENT_LAUNCH_STATE_CUSTOM_TYPE, this.makeLaunchDetails(record))
        launchPersisted = true
      }
      this.launchRecord(record, prompt)
      return record
    } catch (error) {
      record.taskInfoUnsubscribe?.()
      record.taskInfoUnsubscribe = null
      this.records.delete(record.taskId)
      if (launchPersisted) {
        try {
          this.pi.appendEntry(
            SUBAGENT_SHUTDOWN_STATE_CUSTOM_TYPE,
            this.makeTerminalDetails(record, 'failed')
          )
        } catch (persistError) {
          console.warn(
            `[pi-desk-subagent] Agent ${record.taskId} 启动失败终态写入失败`,
            persistError
          )
        }
      }
      await closeChildSession(session)
      throw error
    }
  }

  private async startAgent(
    agentType: SubagentName,
    prompt: string,
    description: string,
    ctx: ExtensionContext
  ) {
    const parent = this.requireParent(ctx)
    this.refreshConfigs()
    const config = this.resolveAgentConfig(agentType)
    if (!config) throw new Error(`当前会话没有可用的 ${agentType} Agent`)
    const record = await this.startRecord(
      config,
      this.requireText(description, 'description'),
      this.requireText(prompt, 'prompt'),
      parent,
      {
        ownerTaskId: null,
        notifyParent: true,
        persistLifecycle: false,
        resolveRun: null
      }
    )
    return {
      content: [
        {
          type: 'text' as const,
          text: `子代理已在后台启动。\n\nAgent ID: ${record.taskId}\n${SUBAGENT_COMPLETION_NOTICE}`
        }
      ],
      details: this.makeLaunchDetails(record)
    }
  }

  private async resumeAgent(agentId: string, prompt: string, ctx: ExtensionContext) {
    const parent = this.requireParent(ctx)
    this.refreshConfigs()
    const record = this.resolveRecord(agentId)
    if (record.status === 'running') throw new Error(`Agent ${record.taskId} 仍在运行`)
    if (!existsSync(record.sessionFile)) {
      throw new Error(`子代理 Session 文件不存在：${record.sessionFile}`)
    }
    const config = this.resolveAgentConfig(record.agentType)
    if (!config) throw new Error(`当前会话没有可用的 ${record.agentType} Agent`)
    const taskPrompt = this.requireText(prompt, 'prompt')
    const sessionManager = SessionManager.open(record.sessionFile)
    if (sessionManager.getSessionId() !== record.taskId) {
      throw new Error(`子代理 Session ID 与 Agent ID 不一致：${record.taskId}`)
    }
    const session = await this.createOwnedChildSession(config, parent, sessionManager)
    if (!this.sessionActive || this.stopping || this.activeParent !== parent) {
      await closeChildSession(session)
      throw new Error('当前父会话已变化，子代理未启动')
    }
    if (!this.agentAllowed(record.agentType)) {
      await closeChildSession(session)
      throw new Error(`当前能力模式不允许 ${record.agentType} Agent`)
    }
    const previous = {
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt
    }
    record.status = 'running'
    record.startedAt = Date.now()
    record.endedAt = null
    record.session = session
    record.pendingSteers = []
    record.steerReady = false
    record.stopRequested = false
    record.ownerTaskId = null
    record.notifyParent = true
    record.persistLifecycle = false
    record.resolveRun = null
    try {
      this.launchRecord(record, taskPrompt)
    } catch (error) {
      record.taskInfoUnsubscribe?.()
      record.taskInfoUnsubscribe = null
      record.status = previous.status
      record.startedAt = previous.startedAt
      record.endedAt = previous.endedAt
      record.session = null
      await closeChildSession(session)
      throw error
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `子代理已恢复运行。\n\nAgent ID: ${record.taskId}\n${SUBAGENT_COMPLETION_NOTICE}`
        }
      ],
      details: this.makeLaunchDetails(record)
    }
  }

  private async steerAgent(
    agentId: string,
    prompt: string
  ): Promise<
    AgentToolResult<
      Pick<SubagentRecord, 'taskId' | 'agentType' | 'title'> & { delivery: 'queued' | 'delivered' }
    >
  > {
    const record = this.resolveRecord(agentId)
    if (!this.agentAllowed(record.agentType))
      throw new Error(`当前能力模式不允许 ${record.agentType} Agent`)
    const text = this.requireText(prompt, 'prompt')
    if (record.status !== 'running' || !record.session) {
      throw new Error(`Agent ${record.taskId} 当前不是 running`)
    }
    if (!record.steerReady) {
      record.pendingSteers.push(text)
      return {
        content: [
          {
            type: 'text' as const,
            text: `补充要求已排队，子代理开始处理后会收到。\n\nAgent ID: ${record.taskId}`
          }
        ],
        details: {
          taskId: record.taskId,
          agentType: record.agentType,
          title: record.title,
          delivery: 'queued'
        }
      }
    }
    await record.session.steer(text)
    return {
      content: [
        {
          type: 'text' as const,
          text: `补充要求已发送。\n\nAgent ID: ${record.taskId}`
        }
      ],
      details: {
        taskId: record.taskId,
        agentType: record.agentType,
        title: record.title,
        delivery: 'delivered'
      }
    }
  }

  private async stopAgent(
    agentId: string
  ): Promise<AgentToolResult<Pick<SubagentRecord, 'taskId' | 'agentType' | 'title'>>> {
    const record = this.resolveRecord(agentId)
    if (record.status !== 'running' || !record.session) {
      throw new Error(`Agent ${record.taskId} 当前不是 running`)
    }
    await this.requestStop(record)
    return {
      content: [
        {
          type: 'text' as const,
          text: `已请求停止子代理。最终状态以后续结束通知为准。\n\nAgent ID: ${record.taskId}`
        }
      ],
      details: {
        taskId: record.taskId,
        agentType: record.agentType,
        title: record.title
      }
    }
  }

  private async requestStop(record: SubagentRecord): Promise<void> {
    if (record.stopRequested) throw new Error(`Agent ${record.taskId} 已在中断中`)
    if (record.status !== 'running' || !record.session) {
      throw new Error(`Agent ${record.taskId} 当前不是 running`)
    }
    record.stopRequested = true
    try {
      await record.session.abort()
    } catch (error) {
      record.stopRequested = false
      throw error
    }
  }

  private async stopOwnedRecords(ownerTaskId: string): Promise<void> {
    const running = [...this.records.values()].filter(
      (record) =>
        record.ownerTaskId === ownerTaskId &&
        record.status === 'running' &&
        record.session &&
        !record.stopRequested
    )
    await Promise.allSettled(running.map((record) => this.requestStop(record)))
  }

  private updateRootActivity(root: SubagentRecord, activity: string): void {
    if (this.records.get(root.taskId) !== root || root.status !== 'running' || !root.taskHandle)
      return
    root.taskHandle.update({ activity })
  }

  private async runDelegatedResearchWorker(
    ownerTaskId: string,
    task: ResearchDelegateTask,
    signal: AbortSignal | undefined
  ): Promise<ResearchWorkerOutcome> {
    const parent = this.activeParent
    this.refreshConfigs()
    const research = this.resolveAgentConfig('research')
    if (!this.sessionActive || this.stopping || !parent) throw new Error('当前父会话已变化')
    if (!research) throw new Error('当前会话没有可用的 research Agent')

    let resolveRun: ((outcome: ResearchWorkerOutcome) => void) | undefined
    const settled = new Promise<ResearchWorkerOutcome>((resolve) => {
      resolveRun = resolve
    })
    const record = await this.startRecord(
      createResearchWorkerConfig(research),
      task.title,
      task.prompt,
      parent,
      {
        ownerTaskId,
        notifyParent: false,
        persistLifecycle: true,
        resolveRun: (outcome) => resolveRun?.(outcome)
      }
    )
    if (signal?.aborted && record.status === 'running' && record.session) {
      await this.requestStop(record)
    }
    return settled
  }

  protected async delegateResearchWorkers(
    ownerTaskId: string,
    tasks: readonly ResearchDelegateTask[],
    signal: AbortSignal | undefined,
    onProgress: (completed: number, total: number) => void
  ): Promise<ResearchWorkerOutcome[]> {
    if (tasks.length < 2) throw new Error('research_delegate 至少需要两个研究任务')
    const root = this.records.get(ownerTaskId)
    if (!root || root.status !== 'running' || root.agentType !== 'research') {
      throw new Error(`Research Root ${ownerTaskId} 当前不可用`)
    }
    if (signal?.aborted) throw new Error('Research 委派已取消')

    const total = tasks.length
    const startedAt = Date.now()
    let completed = 0
    console.info('[pi-desk-subagent] Research Worker 批次启动', {
      rootTaskId: ownerTaskId,
      total
    })
    this.updateRootActivity(root, `正在启动 ${total} 个 Research Worker`)
    const abort = (): void => {
      void this.stopOwnedRecords(ownerTaskId).catch((error) => {
        console.warn(`[pi-desk-subagent] Root ${ownerTaskId} 中断 Worker 失败`, error)
      })
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const outcomes = await Promise.all(
        tasks.map(async (task) => {
          let outcome: ResearchWorkerOutcome
          try {
            outcome = await this.runDelegatedResearchWorker(ownerTaskId, task, signal)
          } catch (error) {
            outcome = {
              taskId: null,
              title: task.title,
              status: 'failed',
              result: null,
              error: error instanceof Error ? error.message : String(error),
              sessionFile: null
            }
          }
          completed += 1
          onProgress(completed, total)
          this.updateRootActivity(root, `等待 Research Worker：${completed}/${total} 已进入终态`)
          return outcome
        })
      )
      this.updateRootActivity(root, `正在汇总 ${total} 个 Research Worker 结果`)
      console.info('[pi-desk-subagent] Research Worker 批次结束', {
        rootTaskId: ownerTaskId,
        total,
        completed: outcomes.filter((outcome) => outcome.status === 'completed').length,
        elapsedMs: Date.now() - startedAt
      })
      return outcomes
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  private listAgents(agentId?: string): AgentToolResult<{
    agents: Array<Pick<SubagentRecord, 'taskId' | 'agentType' | 'title' | 'status' | 'startedAt'>>
  }> {
    const visible = [...this.records.values()].filter(
      (record) => record.agentType !== RESEARCH_WORKER_AGENT_TYPE
    )
    const records = agentId?.trim()
      ? [this.resolveRecord(agentId, visible)]
      : visible.sort((left, right) => right.startedAt - left.startedAt).slice(0, 20)
    const text = [
      `下面是最近执行的${records.length}条记录。`,
      records.length === 0
        ? '当前会话分支没有子代理。'
        : records
            .map(
              (record) =>
                `- ${record.taskId} · ${record.agentType} · ${record.status} · ${record.title}`
            )
            .join('\n')
    ].join('\n\n')
    return {
      content: [{ type: 'text' as const, text }],
      details: {
        agents: records.map(({ taskId, agentType, title, status, startedAt }) => ({
          taskId,
          agentType,
          title,
          status,
          startedAt
        }))
      }
    }
  }

  private async createOwnedChildSession(
    config: SubagentConfig,
    parent: SubagentParentContext,
    sessionManager: SessionManager
  ): Promise<AgentSession> {
    const creation = (async (): Promise<AgentSession> => {
      const session = await this.createChildSession(config, parent, sessionManager)
      if (!this.sessionActive || this.stopping || this.activeParent !== parent) {
        await closeChildSession(session)
        throw new Error('当前父会话已变化，子代理未启动')
      }
      return session
    })()
    this.pendingCreates.add(creation)
    try {
      return await creation
    } finally {
      this.pendingCreates.delete(creation)
    }
  }

  protected async createChildSession(
    config: SubagentConfig,
    parent: SubagentParentContext,
    sessionManager: SessionManager
  ): Promise<AgentSession> {
    const agentDir = this.agentDir
    const settingsManager = SettingsManager.create(parent.cwd, agentDir)
    settingsManager.setProjectTrusted(parent.projectTrusted)
    const capabilityRuntime = new SubagentCapabilities(() => this.capabilityRules)
    const extensionFactories = [
      ...(config.tools.includes('codemode')
        ? [
            {
              name: 'codemode',
              builtin: true,
              replaceable: true,
              factory: createCodemodeExtension()
            }
          ]
        : []),
      ...(config.tools.includes('tool_search')
        ? [
            {
              name: 'tool-search',
              builtin: true,
              replaceable: true,
              factory: createToolSearchExtension()
            }
          ]
        : []),
      ...(config.tools.some(isMcpToolName)
        ? [{ name: 'mcp', builtin: true, replaceable: true, factory: createMcpExtension() }]
        : []),
      {
        name: 'subagent-capabilities',
        hidden: true,
        factory: (pi: ExtensionAPI): void => capabilityRuntime.extension(pi)
      },
      {
        name: 'subagent-retry-compatibility',
        hidden: true,
        factory: createRetryCompatibilityExtension(
          (sessionId) => this.records.get(sessionId)?.stopRequested ?? true
        )
      },
      ...(config.tools.includes('external_research')
        ? [
            {
              name: 'external-research-subagent',
              hidden: true,
              factory: createExternalResearchExtension()
            }
          ]
        : []),
      ...(config.name === 'research' && config.tools.includes('research_delegate')
        ? [
            {
              name: 'research-coordinator-subagent',
              hidden: true,
              factory: createResearchCoordinatorExtension((tasks, signal, onProgress) =>
                this.delegateResearchWorkers(
                  sessionManager.getSessionId(),
                  tasks,
                  signal,
                  (completed, total) => onProgress({ completed, total })
                )
              )
            }
          ]
        : [])
    ]
    const services = await createAgentSessionServices({
      cwd: parent.cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        noExtensions: false,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories,
        extensionsOverride: excludeSubagentPackageExtensions
      }
    })
    for (const diagnostic of services.diagnostics) {
      console.warn(`[pi-desk-subagent] Child 资源诊断：${diagnostic.message}`)
    }
    services.resourceLoader = capabilityRuntime.resources(services.resourceLoader, () => [
      config.name === 'research' &&
      config.tools.includes('research_delegate') &&
      isCapabilityAllowed(this.capabilityRules.tools, 'research_delegate')
        ? RESEARCH_COORDINATOR_BOUNDARY
        : CHILD_BOUNDARY,
      `# 当前子代理角色\n\n${config.systemPrompt}`
    ])
    const model = this.resolveModel(config, parent, services.modelRuntime)
    const { session } = await createAgentSessionFromServices({
      services,
      model,
      thinkingLevel: config.thinking ?? parent.thinkingLevel ?? 'off',
      tools: childAllowedTools(config.tools),
      sessionManager
    })
    capabilityRuntime.attach(session)
    this.childCapabilities.set(session, capabilityRuntime)
    try {
      await session.bindExtensions({
        mode: 'rpc',
        onError: (error) => {
          console.warn(`[pi-desk-subagent] Child Extension 错误：${error.error}`)
        }
      })
      capabilityRuntime.refresh()
      const availableTools = new Set(session.getAllTools().map((tool) => tool.name))
      // MCP 在官方启动／执行边界等待连接，bind 后尚未登记不代表角色配置无效。
      const missingTools = config.tools.filter(
        (tool) => !isMcpToolName(tool) && !availableTools.has(tool)
      )
      if (missingTools.length > 0) {
        throw new Error(`Agent "${config.name}" 配置了不可用工具：${missingTools.join(', ')}`)
      }
      return session
    } catch (error) {
      await closeChildSession(session)
      throw error
    }
  }

  private resolveModel(
    config: SubagentConfig,
    parent: SubagentParentContext,
    modelRuntime: ModelRuntime
  ): NonNullable<ExtensionContext['model']> {
    if (config.model) {
      const separator = config.model.indexOf('/')
      if (separator <= 0 || separator === config.model.length - 1) {
        throw new Error(`Agent "${config.name}" model 必须使用 provider/model 格式`)
      }
      const model = modelRuntime.getModel(
        config.model.slice(0, separator),
        config.model.slice(separator + 1)
      )
      if (!model) throw new Error(`找不到 Agent 模型：${config.model}`)
      return model
    }
    if (!parent.model) throw new Error(`Agent "${config.name}" 没有可用模型`)
    const model = modelRuntime.getModel(parent.model.provider, parent.model.id)
    if (!model) throw new Error(`找不到 Agent 模型：${parent.model.provider}/${parent.model.id}`)
    return model
  }

  private launchRecord(record: SubagentRecord, prompt: string): void {
    const session = record.session
    if (!session) throw new Error(`Agent ${record.taskId} 缺少运行 Session`)
    record.taskHandle = this.plugin.startTask({
      taskId: record.taskId,
      taskKind: '子代理',
      taskType: record.agentType,
      title: record.title,
      info: currentTaskInfo(session),
      activity: '执行中',
      startedAt: record.startedAt,
      detailSource: { kind: 'pi-conversation', session },
      interrupt: async () => this.requestStop(record)
    })
    record.taskInfoUnsubscribe?.()
    record.taskInfoUnsubscribe = session.agent?.subscribe?.((event) => {
      if (event.type !== 'message_end') return
      if (
        this.records.get(record.taskId) !== record ||
        record.status !== 'running' ||
        record.session !== session ||
        !record.taskHandle
      )
        return
      record.taskHandle.update({ info: currentTaskInfo(session) })
    })
    const promptPromise = session.prompt(prompt, {
      preflightResult: (success) => {
        if (!success || record.status !== 'running' || record.session !== session) return
        record.steerReady = true
        void this.flushPendingSteers(record, session)
      }
    })
    const run = this.finishRun(record, session, promptPromise)
      .catch((error) => {
        console.warn(`[pi-desk-subagent] 子会话 ${session.sessionId} 收尾失败`, error)
      })
      .finally(() => {
        this.activeRuns.delete(run)
      })
    this.activeRuns.add(run)
  }

  private async flushPendingSteers(record: SubagentRecord, session: AgentSession): Promise<void> {
    while (
      record.status === 'running' &&
      record.session === session &&
      record.pendingSteers.length > 0
    ) {
      const prompt = record.pendingSteers.shift()
      if (!prompt) continue
      try {
        await session.steer(prompt)
      } catch (error) {
        console.warn(`[pi-desk-subagent] Agent ${record.taskId} 补充条件投递失败`, error)
      }
    }
  }

  private async finishRun(
    record: SubagentRecord,
    session: AgentSession,
    promptPromise: Promise<void>
  ): Promise<void> {
    let status: TerminalStatus = 'failed'
    let result: string | null = null
    let errorMessage: string | null = null
    try {
      await promptPromise
      const assistant = finalAssistant(session)
      result = assistant?.text.trim() || null
      if (record.stopRequested || assistant?.stopReason === 'aborted') {
        status = 'interrupted'
      } else if (assistant?.stopReason === 'stop' && result) {
        status = 'completed'
      } else {
        status = 'failed'
        errorMessage =
          assistant?.errorMessage ??
          (assistant
            ? `子代理结束原因：${assistant.stopReason}`
            : '子代理结束但没有最终 Assistant 消息')
      }
    } catch (error) {
      if (record.stopRequested) {
        status = 'interrupted'
      } else {
        status = 'failed'
        errorMessage = error instanceof Error ? error.message : String(error)
      }
    } finally {
      record.steerReady = false
      await closeChildSession(session)
      if (record.status === 'running' && record.session === session) {
        this.finishRecord(
          record,
          record.stopRequested ? 'interrupted' : status,
          result,
          errorMessage,
          record.notifyParent
        )
      } else if (record.session === session) {
        record.taskInfoUnsubscribe?.()
        record.taskInfoUnsubscribe = null
        record.session = null
      }
    }
  }

  private finishRecord(
    record: SubagentRecord,
    status: TerminalStatus,
    result: string | null,
    errorMessage: string | null,
    notifyParent: boolean,
    endedAt = Date.now()
  ): void {
    if (record.status !== 'running') return
    record.status = status
    record.endedAt = endedAt
    record.pendingSteers = []
    record.steerReady = false
    const handle = record.taskHandle
    const session = record.session
    const current = this.records.get(record.taskId) === record
    if (current && handle && session) handle.update({ info: currentTaskInfo(session) })
    record.taskHandle = null
    record.taskInfoUnsubscribe?.()
    record.taskInfoUnsubscribe = null
    if (current && handle) {
      if (status === 'completed') handle.complete('执行完成')
      else if (status === 'failed') handle.fail(errorMessage ?? '执行失败')
      else if (status === 'stopped') handle.stopped('已停止')
      else handle.interrupted('执行中断')
    }
    const resolvedResult = result ?? (session ? lastAssistantText(session) : null)
    record.session = null
    if (current && (record.persistLifecycle || this.stopping) && this.sessionActive) {
      try {
        this.pi.appendEntry(
          SUBAGENT_SHUTDOWN_STATE_CUSTOM_TYPE,
          this.makeTerminalDetails(record, status, endedAt)
        )
      } catch (error) {
        console.warn(`[pi-desk-subagent] Agent ${record.taskId} 终态写入失败`, error)
      }
    }
    const resolveRun = record.resolveRun
    record.resolveRun = null
    record.ownerTaskId = null
    if (resolveRun) {
      resolveRun({
        taskId: record.taskId,
        title: record.title,
        status,
        result: resolvedResult,
        error: errorMessage,
        sessionFile: record.sessionFile
      })
    }
    if (current && notifyParent && this.sessionActive && !this.stopping) {
      this.notifyCompletion(record, resolvedResult, errorMessage)
    }
  }

  private notifyCompletion(
    record: SubagentRecord,
    result: string | null,
    errorMessage: string | null
  ): void {
    const details = this.makeTerminalDetails(record, record.status as TerminalStatus)
    const outcome =
      record.status === 'completed'
        ? '已完成'
        : record.status === 'interrupted'
          ? '已中断'
          : record.status === 'stopped'
            ? '已停止'
            : '执行失败'
    const body = result ?? errorMessage ?? '(没有结果)'
    try {
      this.pi.sendMessage(
        {
          customType: SUBAGENT_COMPLETION_CUSTOM_TYPE,
          content: `子代理${outcome}。\n\nAgent ID: ${record.taskId}\n类型: ${record.agentType}\n任务: ${record.title}\n\n结果:\n${body}`,
          display: true,
          details
        },
        { deliverAs: 'steer', triggerTurn: true }
      )
    } catch (error) {
      console.warn(`[pi-desk-subagent] Agent ${record.taskId} 完成通知失败`, error)
    }
  }

  private makeLaunchDetails(record: SubagentRecord): LaunchDetails {
    return {
      version: SUBAGENT_RECORD_VERSION,
      kind: 'launch',
      taskId: record.taskId,
      agentType: record.agentType,
      title: record.title,
      sessionFile: record.sessionFile,
      startedAt: record.startedAt
    }
  }

  private makeTerminalDetails(
    record: SubagentRecord,
    status: TerminalStatus,
    endedAt = record.endedAt ?? Date.now()
  ): TerminalDetails {
    return {
      version: SUBAGENT_RECORD_VERSION,
      kind: 'terminal',
      taskId: record.taskId,
      status,
      endedAt,
      sessionFile: record.sessionFile
    }
  }
}

export function registerSubagentExtension(pi: ExtensionAPI): void {
  let runtimePromise: Promise<SubagentRuntime> | undefined
  const runtime = (): Promise<SubagentRuntime> => {
    runtimePromise ??= ModelRuntime.create().then(
      (modelRuntime) => new SubagentRuntime(pi, modelRuntime)
    )
    return runtimePromise
  }

  pi.on('session_start', async (_event, ctx) => (await runtime()).startSession(ctx))
  pi.on('session_before_tree', async (event, ctx) => {
    if (event.signal.aborted) return { cancel: true }
    if (!runtimePromise) return
    try {
      return await (await runtimePromise).beforeTree(event.signal)
    } catch (error) {
      console.error('[pi-desk-subagent] 树导航前停止子代理失败', error)
      ctx.ui.notify(
        `无法切换分支：${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
      return { cancel: true }
    }
  })
  pi.on('session_tree', async (_event, ctx) => (await runtime()).startSession(ctx))
  pi.on('before_agent_start', async () => {
    if (runtimePromise) (await runtimePromise).refreshConfigs()
  })
  pi.on('session_shutdown', async () => {
    if (runtimePromise) await (await runtimePromise).shutdown()
  })
}
