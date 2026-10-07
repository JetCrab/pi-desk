import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  getSkillBaseDirs,
  isSkillContentRead,
  type ContextIgnoreTransformOptions
} from './context-skill-path.js'
import type { ContextIgnoreState } from './types.js'

export const COMPRESSED_TOOL_CONTEXT_TAG = 'compressed_tool_context'
export const COMPRESSED_TOOL_CONTEXT_CUSTOM_TYPE = 'context-ignore-compressed-tools'

export type CompressedToolStatus = 'ok' | 'error' | 'missing'

export interface CompressedToolRecord {
  ref: number
  name: string
  arguments: ToolCall['arguments']
  status: CompressedToolStatus
}

type PendingCompressedTool = {
  record: CompressedToolRecord
  timestamp: number
}

function compressedToolStatus(result: ToolResultMessage | undefined): CompressedToolStatus {
  if (result === undefined) return 'missing'
  return result.isError ? 'error' : 'ok'
}

export function createCompressedToolRecord(
  ref: number,
  toolCall: ToolCall,
  result: ToolResultMessage | undefined
): CompressedToolRecord {
  return {
    ref,
    name: toolCall.name,
    arguments: toolCall.arguments,
    status: compressedToolStatus(result)
  }
}

function serializeCompressedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function createToolSummaryText(records: CompressedToolRecord[]): string {
  return `<${COMPRESSED_TOOL_CONTEXT_TAG}>${serializeCompressedJson(records)}</${COMPRESSED_TOOL_CONTEXT_TAG}>`
}

function findAssistantCutoffIndex(messages: AgentMessage[], cutoffTimestamp: number): number {
  const cutoffIndex = messages.findIndex(
    (message) => message.role === 'assistant' && message.timestamp >= cutoffTimestamp
  )
  return cutoffIndex >= 0 ? cutoffIndex : messages.length
}

function findScopedUserIndex(messages: AgentMessage[], userTimestamp: number): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && message.timestamp === userTimestamp) return index
  }
  return undefined
}

/** Returns message indexes whose process details are replaced by the current ignore boundaries. */
export function getIgnoredMessageIndexes(
  messages: AgentMessage[],
  state: ContextIgnoreState,
  ignoredMessages?: WeakSet<AgentMessage>
): Set<number> {
  const ignoredIndexes = new Set<number>()
  if (!state.enabled) return ignoredIndexes

  if (ignoredMessages !== undefined) {
    for (const [index, message] of messages.entries()) {
      if (ignoredMessages.has(message)) ignoredIndexes.add(index)
    }
    return ignoredIndexes
  }

  if (state.cutoffTimestamp !== undefined) {
    for (const [index, message] of messages.entries()) {
      if (message.timestamp < state.cutoffTimestamp) ignoredIndexes.add(index)
    }
  }

  for (const internalTurnCutoff of state.internalTurnCutoffs ?? []) {
    const cutoffIndex = findAssistantCutoffIndex(messages, internalTurnCutoff.cutoffTimestamp)

    const startIndex =
      internalTurnCutoff.userTimestamp === undefined
        ? 0
        : findScopedUserIndex(messages, internalTurnCutoff.userTimestamp)
    if (startIndex === undefined) continue

    for (let index = startIndex; index < cutoffIndex; index += 1) {
      ignoredIndexes.add(index)
    }
  }
  return ignoredIndexes
}

/** Captures full-session ignore decisions for strict projection onto compaction slices. */
export function getIgnoredMessageReferences(
  messages: AgentMessage[],
  state: ContextIgnoreState
): WeakSet<AgentMessage> {
  const ignoredMessages = new WeakSet<AgentMessage>()
  for (const index of getIgnoredMessageIndexes(messages, state)) {
    ignoredMessages.add(messages[index]!)
  }
  return ignoredMessages
}

export interface TransformResult {
  messages: AgentMessage[]
  toolReferences: Map<number, string>
}

export function transformContextMessages(
  messages: AgentMessage[],
  state: ContextIgnoreState,
  options: ContextIgnoreTransformOptions = {}
): TransformResult {
  const ignoredIndexes = getIgnoredMessageIndexes(messages, state, options.ignoredMessages)

  if (ignoredIndexes.size === 0) {
    return {
      messages,
      toolReferences: new Map()
    }
  }

  const skillBaseDirs = getSkillBaseDirs(messages, options)
  const compressedToolCallIds = new Set<string>()
  const toolResults = new Map<string, ToolResultMessage>()
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'toolResult') {
      toolResults.set(message.toolCallId, message)
      continue
    }
    if (message.role !== 'assistant' || !ignoredIndexes.has(messageIndex)) continue
    for (const block of message.content) {
      if (block.type === 'toolCall' && !isSkillContentRead(block, skillBaseDirs, options)) {
        compressedToolCallIds.add(block.id)
      }
    }
  }

  let latestAssistantIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'assistant') continue
    latestAssistantIndex = index
    break
  }

  const toolReferences = new Map<number, string>()
  const transformed: AgentMessage[] = []
  const pendingPreservedToolResults = new Set<string>()
  let nextToolReference = 1
  let pendingTools: PendingCompressedTool[] = []

  const flushPendingTools = () => {
    if (pendingTools.length === 0) return

    const records = pendingTools.map((item) => item.record)
    const content = createToolSummaryText(records)
    transformed.push({
      role: 'custom',
      customType: COMPRESSED_TOOL_CONTEXT_CUSTOM_TYPE,
      content,
      display: false,
      timestamp: Math.max(...pendingTools.map((item) => item.timestamp))
    })
    pendingTools = []
  }

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'toolResult') {
      if (compressedToolCallIds.has(message.toolCallId)) {
        continue
      }

      if (pendingPreservedToolResults.has(message.toolCallId)) {
        transformed.push(message)
        pendingPreservedToolResults.delete(message.toolCallId)
        if (pendingPreservedToolResults.size === 0) flushPendingTools()
        continue
      }

      flushPendingTools()
      transformed.push(message)
      continue
    }

    if (!ignoredIndexes.has(messageIndex) || message.role !== 'assistant') {
      flushPendingTools()
      transformed.push(message)
      continue
    }
    if (
      messageIndex === latestAssistantIndex &&
      message.content.length > 0 &&
      message.content.every((block) => block.type === 'thinking')
    ) {
      flushPendingTools()
      transformed.push(message)
      continue
    }

    const retainedContent: AssistantMessage['content'] = []
    const compressedBlocks: ToolCall[] = []
    const preservedToolCallIds: string[] = []
    for (const block of message.content) {
      if (block.type === 'thinking') {
        continue
      }
      if (block.type === 'text') {
        retainedContent.push(block)
        continue
      }
      if (isSkillContentRead(block, skillBaseDirs, options)) {
        retainedContent.push(block)
        preservedToolCallIds.push(block.id)
        continue
      }
      compressedBlocks.push(block)
    }

    if (retainedContent.length > 0) {
      flushPendingTools()
      transformed.push({ ...message, content: retainedContent })
      for (const toolCallId of preservedToolCallIds) {
        pendingPreservedToolResults.add(toolCallId)
      }
    }

    for (const block of compressedBlocks) {
      const result = toolResults.get(block.id)
      const ref = nextToolReference
      nextToolReference += 1
      toolReferences.set(ref, block.id)
      const record = createCompressedToolRecord(ref, block, result)
      pendingTools.push({
        record,
        timestamp: Math.max(message.timestamp, result?.timestamp ?? message.timestamp)
      })
    }
  }

  flushPendingTools()
  return {
    messages: transformed,
    toolReferences
  }
}
