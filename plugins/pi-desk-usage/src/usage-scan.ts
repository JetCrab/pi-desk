import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  UsageAnalysisCallKind,
  UsageStructureCounts,
  UsageTimelineIgnoreMode,
  UsageTimelineMarkerKind,
  UsageTotals
} from './protocol.js'

export interface UsageFileDescriptor {
  path: string
  size: number
  modifiedAt: number
  nestedSubagent: boolean
}

export interface ParsedUsageEvent {
  identity: string
  timestamp: number
  order: number
  kind: UsageAnalysisCallKind
  modelKey: string
  requestedModelKey: string | null
  provider: string | null
  model: string | null
  label: string
  totals: UsageTotals
}

export interface ParsedUsageMarker {
  identity: string
  timestamp: number
  order: number
  kind: UsageTimelineMarkerKind
  mode: UsageTimelineIgnoreMode | null
  projectedTokens: number | null
  tokensBefore: number | null
}

export interface ParsedToolActivity {
  identity: string
  toolCallId: string
  timestamp: number
  order: number
  toolName: string
  reasoning: string | null
  endAt: number | null
  status: 'completed' | 'failed' | 'running'
}

export interface ChildSessionReference {
  identity: string
  taskId: string
  agentType: string
  title: string
  sessionFile: string
  startedAt: number
  parentSessionId: string
}

export interface ChildSessionTerminal {
  taskId: string
  status: 'completed' | 'failed' | 'stopped' | 'interrupted'
  sessionFile: string
  endedAt: number
  timestamp: number
}

export interface ParsedUsageFile {
  path: string
  sessionId: string
  cwd: string
  name: string | null
  firstMessage: string | null
  createdAt: number
  updatedAt: number
  parentSessionPath: string | null
  events: ParsedUsageEvent[]
  markers: ParsedUsageMarker[]
  tools: ParsedToolActivity[]
  childSessions: ChildSessionReference[]
  childTerminals: ChildSessionTerminal[]
  counts: UsageStructureCounts
  parseErrors: number
}

export type UsageFileScanResult =
  | {
      descriptor: UsageFileDescriptor
      file: ParsedUsageFile
      error: null
    }
  | {
      descriptor: UsageFileDescriptor
      file: null
      error: string
    }

type JsonRecord = Record<string, unknown>

const TOOLS_SUMMARIES_KEY = 'Tools/summaries'

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function usageTotals(value: unknown): UsageTotals | null {
  const usage = record(value)
  if (!usage) return null
  const cost = record(usage.cost)
  const totals = {
    input: number(usage.input),
    output: number(usage.output),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    cost: number(cost?.total)
  }
  return totals.input > 0 ||
    totals.output > 0 ||
    totals.cacheRead > 0 ||
    totals.cacheWrite > 0 ||
    totals.cost > 0
    ? totals
    : null
}

function messageText(content: unknown): string | null {
  if (typeof content === 'string') return text(content)
  if (!Array.isArray(content)) return null
  const value = content
    .flatMap((part) => {
      const item = record(part)
      return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return value ? value.slice(0, 120) : null
}

function eventIdentity(entry: JsonRecord, line: string): string {
  const digest = createHash('sha256').update(line).digest('hex').slice(0, 24)
  return typeof entry.id === 'string' ? `${entry.id}:${digest}` : digest
}

function usageEvent(entry: JsonRecord, line: string, order: number): ParsedUsageEvent | null {
  const entryType = entry.type
  if (entryType === 'message') {
    const message = record(entry.message)
    if (!message) return null
    if (message.role === 'assistant') {
      const totals = usageTotals(message.usage)
      if (!totals) return null
      const provider = text(message.provider) ?? 'unknown'
      const requestedModel = text(message.model) ?? 'unknown'
      const model = text(message.responseModel) ?? requestedModel
      const key = `${provider}/${model}`
      return {
        identity: eventIdentity(entry, line),
        timestamp: timestamp(entry.timestamp) || timestamp(message.timestamp),
        order,
        kind: 'assistant',
        modelKey: key,
        requestedModelKey: `${provider}/${requestedModel}`,
        provider,
        model,
        label: key,
        totals
      }
    }
    if (message.role === 'toolResult') {
      const totals = usageTotals(message.usage)
      if (!totals) return null
      return {
        identity: eventIdentity(entry, line),
        timestamp: timestamp(entry.timestamp) || timestamp(message.timestamp),
        order,
        kind: 'tool-result',
        modelKey: TOOLS_SUMMARIES_KEY,
        requestedModelKey: null,
        provider: null,
        model: null,
        label: '工具与摘要',
        totals
      }
    }
    return null
  }

  if (entryType === 'usage') {
    const totals = usageTotals(entry.usage)
    if (!totals) return null
    const provider = text(entry.provider) ?? 'unknown'
    const model = text(entry.model) ?? 'unknown'
    const key = `${provider}/${model}`
    return {
      identity: eventIdentity(entry, line),
      timestamp: timestamp(entry.timestamp),
      order,
      kind: entry.kind === 'cache_warm' ? 'cache-warm' : 'usage',
      modelKey: key,
      requestedModelKey: null,
      provider,
      model,
      label: key,
      totals
    }
  }

  if (entryType !== 'compaction' && entryType !== 'branch_summary') return null
  const totals = usageTotals(entry.usage)
  if (!totals) return null
  return {
    identity: eventIdentity(entry, line),
    timestamp: timestamp(entry.timestamp),
    order,
    kind: entryType === 'compaction' ? 'compaction' : 'branch-summary',
    modelKey: TOOLS_SUMMARIES_KEY,
    requestedModelKey: null,
    provider: null,
    model: null,
    label: '工具与摘要',
    totals
  }
}

function toolActivities(entry: JsonRecord, line: string, order: number): ParsedToolActivity[] {
  if (entry.type !== 'message') return []
  const message = record(entry.message)
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return []
  const timestampValue = timestamp(entry.timestamp) || timestamp(message.timestamp)
  if (!timestampValue) return []
  return message.content.flatMap((value, index) => {
    const block = record(value)
    if (!block || block.type !== 'toolCall') return []
    const toolCallId = text(block.id)
    const toolName = text(block.name)
    if (!toolCallId || !toolName) return []
    const argumentsValue = record(block.arguments)
    return [
      {
        identity: `${eventIdentity(entry, line)}:${index}`,
        toolCallId,
        timestamp: timestampValue,
        order,
        toolName,
        reasoning: text(argumentsValue?.reasoning),
        endAt: null,
        status: 'running' as const
      }
    ]
  })
}

function childReference(
  entry: JsonRecord,
  line: string,
  parentSessionId: string
): ChildSessionReference | null {
  let details: JsonRecord | null = null
  if (entry.type === 'message') {
    const message = record(entry.message)
    if (
      message?.role === 'toolResult' &&
      (message.toolName === 'agent' || message.toolName === 'agent_resume')
    ) {
      details = record(message.details)
    }
  } else if (
    entry.type === 'custom' &&
    (entry.customType === 'pi-desk-subagent:launch:v1' ||
      entry.customType === 'pi-super-subagent:launch:v1')
  ) {
    details = record(entry.data)
  }
  if (!details || details.version !== 1 || details.kind !== 'launch') return null
  const taskId = text(details.taskId)
  const agentType = text(details.agentType)
  const title = text(details.title)
  const sessionFile = text(details.sessionFile)
  if (!taskId || !agentType || !title || !sessionFile) return null
  return {
    identity: eventIdentity(entry, line),
    taskId,
    agentType,
    title,
    sessionFile: resolve(sessionFile),
    startedAt: timestamp(details.startedAt),
    parentSessionId
  }
}

function childTerminal(entry: JsonRecord): ChildSessionTerminal | null {
  const details =
    entry.type === 'custom_message' &&
    (entry.customType === 'pi-desk-subagent:completion:v1' ||
      entry.customType === 'pi-super-subagent:completion:v1')
      ? record(entry.details)
      : entry.type === 'custom' &&
          (entry.customType === 'pi-desk-subagent:state:v1' ||
            entry.customType === 'pi-super-subagent:state:v1')
        ? record(entry.data)
        : null
  if (!details || details.version !== 1 || details.kind !== 'terminal') return null
  const taskId = text(details.taskId)
  const sessionFile = text(details.sessionFile)
  const status = details.status
  if (
    !taskId ||
    !sessionFile ||
    (status !== 'completed' &&
      status !== 'failed' &&
      status !== 'stopped' &&
      status !== 'interrupted')
  ) {
    return null
  }
  return {
    taskId,
    status,
    sessionFile: resolve(sessionFile),
    endedAt: timestamp(details.endedAt),
    timestamp: timestamp(entry.timestamp)
  }
}

interface ParsedIgnoreBoundary {
  fingerprint: string
  enabled: boolean
  mode: UsageTimelineIgnoreMode
  projectedTokens: number | null
}

function parseIgnoreBoundary(value: unknown): ParsedIgnoreBoundary | null {
  const state = record(value)
  if (!state || typeof state.enabled !== 'boolean') return null
  const mode: UsageTimelineIgnoreMode =
    state.mode === 'internal-turns' || state.mode === 'combined' ? state.mode : 'user-turns'
  const cutoffTimestamp = optionalNumber(state.cutoffTimestamp)
  const internalTurnCutoffs = Array.isArray(state.internalTurnCutoffs)
    ? state.internalTurnCutoffs.flatMap((value) => {
        const cutoff = record(value)
        const cutoffTimestamp = optionalNumber(cutoff?.cutoffTimestamp)
        if (cutoffTimestamp === null) return []
        return [
          {
            cutoffTimestamp,
            userTimestamp: optionalNumber(cutoff?.userTimestamp)
          }
        ]
      })
    : []
  return {
    fingerprint: JSON.stringify({
      enabled: state.enabled,
      mode,
      cutoffTimestamp,
      internalTurnCutoffs
    }),
    enabled: state.enabled,
    mode,
    projectedTokens: optionalNumber(state.estimatedContextTokens)
  }
}

function emptyCounts(): UsageStructureCounts {
  return {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    compactions: 0,
    branchSummaries: 0
  }
}

export async function scanUsageFile(descriptor: UsageFileDescriptor): Promise<ParsedUsageFile> {
  const input = createReadStream(descriptor.path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let sessionId = ''
  let cwd = ''
  let name: string | null = null
  let firstMessage: string | null = null
  let createdAt = 0
  let updatedAt = descriptor.modifiedAt
  let parentSessionPath: string | null = null
  let parseErrors = 0
  const events: ParsedUsageEvent[] = []
  const markers: ParsedUsageMarker[] = []
  const tools: ParsedToolActivity[] = []
  const toolsByCallId = new Map<string, ParsedToolActivity>()
  const childSessions: ChildSessionReference[] = []
  const childTerminals: ChildSessionTerminal[] = []
  const counts = emptyCounts()
  let entryOrder = 0
  let previousIgnoreBoundary: string | null = null

  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    let entry: JsonRecord
    try {
      const parsed = JSON.parse(line)
      const parsedRecord = record(parsed)
      if (!parsedRecord) {
        parseErrors += 1
        continue
      }
      entry = parsedRecord
    } catch {
      parseErrors += 1
      continue
    }
    entryOrder += 1

    if (entry.type === 'session') {
      sessionId = text(entry.id) ?? sessionId
      cwd = text(entry.cwd) ?? cwd
      createdAt = timestamp(entry.timestamp) || createdAt
      const parentSession = text(entry.parentSession)
      parentSessionPath = parentSession ? resolve(parentSession) : null
      continue
    }

    const entryAt = timestamp(entry.timestamp)
    if (entryAt > updatedAt) updatedAt = entryAt
    if (entry.type === 'session_info') name = text(entry.name)

    if (entry.type === 'message') {
      const message = record(entry.message)
      if (message?.role === 'user') {
        counts.userMessages += 1
        if (!firstMessage) firstMessage = messageText(message.content)
      } else if (message?.role === 'assistant') {
        counts.assistantMessages += 1
        if (Array.isArray(message.content)) {
          counts.toolCalls += message.content.filter(
            (part) => record(part)?.type === 'toolCall'
          ).length
        }
      } else if (message?.role === 'toolResult') {
        counts.toolResults += 1
      }
    } else if (entry.type === 'compaction') {
      counts.compactions += 1
    } else if (entry.type === 'branch_summary') {
      counts.branchSummaries += 1
    }

    const event = usageEvent(entry, line, entryOrder)
    if (event && event.timestamp > 0) events.push(event)
    for (const tool of toolActivities(entry, line, entryOrder)) {
      tools.push(tool)
      toolsByCallId.set(tool.toolCallId, tool)
    }
    if (entry.type === 'message') {
      const message = record(entry.message)
      if (message?.role === 'toolResult') {
        const toolCallId = text(message.toolCallId)
        const tool = toolCallId ? toolsByCallId.get(toolCallId) : undefined
        if (tool) {
          tool.endAt = timestamp(entry.timestamp) || timestamp(message.timestamp) || null
          tool.status = message.isError === true ? 'failed' : 'completed'
        }
      }
    }
    if (entry.type === 'compaction' && entryAt > 0) {
      markers.push({
        identity: eventIdentity(entry, line),
        timestamp: entryAt,
        order: entryOrder,
        kind: 'compaction',
        mode: null,
        projectedTokens: null,
        tokensBefore: optionalNumber(entry.tokensBefore)
      })
    } else if (entry.type === 'custom' && entry.customType === 'context-ignore-state') {
      const boundary = parseIgnoreBoundary(entry.data)
      if (boundary) {
        const changed = boundary.fingerprint !== previousIgnoreBoundary
        previousIgnoreBoundary = boundary.fingerprint
        if (boundary.enabled && changed && entryAt > 0) {
          markers.push({
            identity: eventIdentity(entry, line),
            timestamp: entryAt,
            order: entryOrder,
            kind: 'context-ignore',
            mode: boundary.mode,
            projectedTokens: boundary.projectedTokens,
            tokensBefore: null
          })
        }
      }
    }
    const child = childReference(entry, line, sessionId)
    if (child) childSessions.push(child)
    const terminal = childTerminal(entry)
    if (terminal) childTerminals.push(terminal)
  }

  if (!sessionId) throw new Error('Session header 缺少 id')
  if (!cwd) throw new Error('Session header 缺少 cwd')
  if (!createdAt) createdAt = events[0]?.timestamp ?? descriptor.modifiedAt

  return {
    path: resolve(descriptor.path),
    sessionId,
    cwd,
    name,
    firstMessage,
    createdAt,
    updatedAt,
    parentSessionPath,
    events,
    markers,
    tools,
    childSessions,
    childTerminals,
    counts,
    parseErrors
  }
}

export async function scanUsageFiles(
  descriptors: readonly UsageFileDescriptor[],
  concurrency = 2
): Promise<UsageFileScanResult[]> {
  const results = new Array<UsageFileScanResult>(descriptors.length)
  let nextIndex = 0

  async function run(): Promise<void> {
    while (nextIndex < descriptors.length) {
      const index = nextIndex
      nextIndex += 1
      const descriptor = descriptors[index]!
      try {
        results[index] = {
          descriptor,
          file: await scanUsageFile(descriptor),
          error: null
        }
      } catch (error) {
        results[index] = {
          descriptor,
          file: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), descriptors.length) }, () => run())
  )
  return results
}
