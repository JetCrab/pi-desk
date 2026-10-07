import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { emptyContextIgnorePotential } from './auto-ignore.js'
import { estimateTokens } from '@earendil-works/pi-coding-agent'
import {
  estimateReasoningReplayTokens,
  estimateThinkingBlockTokens,
  estimateToolCallTokens
} from './context-token-estimate.js'
import { getIgnoredMessageIndexes, transformContextMessages } from './context-transform.js'
import {
  getSkillBaseDirs,
  isSkillContentRead,
  type ContextIgnoreTransformOptions
} from './context-skill-path.js'
import type { ContextIgnoreAnalysis, ContextIgnorePotential, ContextIgnoreState } from './types.js'

function sumReasoningReplayTokens(messages: AgentMessage[]): number {
  let tokens = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'thinking') tokens += estimateReasoningReplayTokens(block)
    }
  }
  return tokens
}

/**
 * 用当前请求的真实 Provider 上下文校正本地字符估算。
 * signature 是不透明的编码内容，不能假定固定的字符/token 比例。
 */
export function calibrateProviderTokens(
  estimatedTokens: number,
  estimatedContextTokens: number,
  actualContextTokens: number | null | undefined
): number {
  if (
    actualContextTokens === null ||
    actualContextTokens === undefined ||
    estimatedTokens <= 0 ||
    estimatedContextTokens <= 0
  ) {
    return Math.max(0, estimatedTokens)
  }

  return Math.max(0, Math.round((estimatedTokens * actualContextTokens) / estimatedContextTokens))
}

export function analyzeContext(
  messages: AgentMessage[],
  state: ContextIgnoreState,
  options: ContextIgnoreTransformOptions = {}
): ContextIgnoreAnalysis {
  const transformed = transformContextMessages(messages, state, options)
  const ignoredMessageIndexes = getIgnoredMessageIndexes(messages, state)
  let completeTurns = 0
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user' && !ignoredMessageIndexes.has(index)) completeTurns += 1
  }

  const rawTokens = messages.reduce((total, message) => total + estimateTokens(message), 0)
  const effectiveTokens = transformed.messages.reduce(
    (total, message) => total + estimateTokens(message),
    0
  )
  const ignoredTokens = Math.max(0, rawTokens - effectiveTokens)
  const effectiveReasoningReplayTokens = sumReasoningReplayTokens(transformed.messages)
  const reasoningReplayTokens = Math.max(
    0,
    sumReasoningReplayTokens(messages) - effectiveReasoningReplayTokens
  )

  return {
    rawTokens,
    effectiveTokens,
    providerEffectiveTokens: effectiveTokens + effectiveReasoningReplayTokens,
    ignoredTokens,
    providerIgnoredTokens: ignoredTokens + reasoningReplayTokens,
    reasoningReplayTokens,
    completeTurns
  }
}

export function findCutoffTimestamp(
  messages: AgentMessage[],
  keepTurns: number
): number | undefined {
  const userMessages = messages.filter((message) => message.role === 'user')
  if (userMessages.length === 0) {
    // 压缩可能将用户消息收进摘要，只保留当前轮的助手过程，仍需按过程预算处理。
    return messages.find((message) => message.role === 'assistant')?.timestamp
  }
  const index = Math.max(0, userMessages.length - keepTurns)
  return userMessages[index]?.timestamp
}

export interface RecentProcessCandidate {
  cutoffTimestamp: number
  nextState: ContextIgnoreState
  potential: ContextIgnorePotential
}

function createUserTurnCandidateState(
  currentState: ContextIgnoreState,
  cutoffTimestamp: number,
  keepTurns: number
): ContextIgnoreState {
  return {
    ...currentState,
    enabled: true,
    mode: currentState.internalTurnCutoffs === undefined ? 'user-turns' : 'combined',
    cutoffTimestamp: Math.max(currentState.cutoffTimestamp ?? 0, cutoffTimestamp),
    keepTurns,
    updatedAt: Date.now()
  }
}

function createPotential(
  current: ContextIgnoreAnalysis,
  candidate: ContextIgnoreAnalysis
): ContextIgnorePotential {
  const reasoningReplayTokens = Math.max(
    0,
    candidate.reasoningReplayTokens - current.reasoningReplayTokens
  )
  const netTokens = Math.max(0, current.effectiveTokens - candidate.effectiveTokens)

  return {
    reasoningReplayTokens,
    netTokens,
    providerNetTokens: netTokens + reasoningReplayTokens
  }
}

function afterTimestamp(timestamp: number): number {
  return timestamp < Number.MAX_SAFE_INTEGER ? timestamp + 1 : timestamp
}

interface RetainedProcessBudgetIndex {
  internalIgnoredIndexes: Set<number>
  assistantTokens: Array<{ messageIndex: number; tokens: number }>
  nonSkillToolCalls: Array<{ messageIndex: number; toolCallId: string }>
  toolResults: Array<{ messageIndex: number; toolCallId: string; tokens: number }>
}

function createRetainedProcessBudgetIndex(
  messages: AgentMessage[],
  state: ContextIgnoreState,
  options: ContextIgnoreTransformOptions
): RetainedProcessBudgetIndex {
  const internalIgnoredIndexes = getIgnoredMessageIndexes(messages, {
    ...state,
    enabled: true,
    cutoffTimestamp: undefined
  })
  const skillBaseDirs = getSkillBaseDirs(messages, options)
  const assistantTokens: RetainedProcessBudgetIndex['assistantTokens'] = []
  const nonSkillToolCalls: RetainedProcessBudgetIndex['nonSkillToolCalls'] = []
  const toolResults: RetainedProcessBudgetIndex['toolResults'] = []
  const skillToolCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'toolCall' && isSkillContentRead(block, skillBaseDirs, options)) {
        skillToolCallIds.add(block.id)
      }
    }
  }

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'toolResult') {
      if (!skillToolCallIds.has(message.toolCallId)) {
        toolResults.push({
          messageIndex,
          toolCallId: message.toolCallId,
          tokens: estimateTokens(message)
        })
      }
      continue
    }
    if (message.role !== 'assistant') continue

    let tokens = 0
    for (const block of message.content) {
      if (block.type === 'thinking') {
        tokens += estimateThinkingBlockTokens(block)
        tokens += estimateReasoningReplayTokens(block)
      } else if (block.type === 'toolCall' && !skillToolCallIds.has(block.id)) {
        tokens += estimateToolCallTokens(block)
        nonSkillToolCalls.push({ messageIndex, toolCallId: block.id })
      }
    }
    if (tokens > 0) assistantTokens.push({ messageIndex, tokens })
  }

  return {
    internalIgnoredIndexes,
    assistantTokens,
    nonSkillToolCalls,
    toolResults
  }
}

function estimateRetainedCompressibleProcessTokens(
  messages: AgentMessage[],
  state: ContextIgnoreState,
  index: RetainedProcessBudgetIndex
): number {
  const cutoffTimestamp = state.cutoffTimestamp
  const isIgnored = (messageIndex: number): boolean =>
    index.internalIgnoredIndexes.has(messageIndex) ||
    (cutoffTimestamp !== undefined && messages[messageIndex]!.timestamp < cutoffTimestamp)
  const ignoredToolCallIds = new Set<string>()

  for (const toolCall of index.nonSkillToolCalls) {
    if (isIgnored(toolCall.messageIndex)) ignoredToolCallIds.add(toolCall.toolCallId)
  }

  let tokens = 0
  for (const assistant of index.assistantTokens) {
    if (!isIgnored(assistant.messageIndex)) tokens += assistant.tokens
  }
  for (const result of index.toolResults) {
    if (!isIgnored(result.messageIndex) && !ignoredToolCallIds.has(result.toolCallId)) {
      tokens += result.tokens
    }
  }
  return tokens
}

/**
 * Keeps compressible process details from at most the latest user turns within one shared budget.
 * User messages, assistant text, and protected Skill reads are retained regardless of this boundary.
 */
export function selectRecentProcessCandidate(
  messages: AgentMessage[],
  currentState: ContextIgnoreState,
  keepTurns: number,
  processTokenBudget: number,
  options: ContextIgnoreTransformOptions = {}
): RecentProcessCandidate | undefined {
  const userCutoffTimestamp = findCutoffTimestamp(messages, keepTurns)
  if (userCutoffTimestamp === undefined) return undefined

  const current = analyzeContext(messages, currentState, options)
  const assistants = messages.filter(
    (message): message is AgentMessage & { role: 'assistant' } =>
      message.role === 'assistant' && message.timestamp >= userCutoffTimestamp
  )
  const latestMessageTimestamp = messages.reduce(
    (latest, message) => Math.max(latest, message.timestamp),
    userCutoffTimestamp
  )
  const candidateCutoffs = [
    userCutoffTimestamp,
    ...assistants.map((message) => message.timestamp),
    afterTimestamp(latestMessageTimestamp)
  ]
  const budgetIndex = createRetainedProcessBudgetIndex(messages, currentState, options)

  for (const cutoffTimestamp of [...new Set(candidateCutoffs)]) {
    const nextState = createUserTurnCandidateState(currentState, cutoffTimestamp, keepTurns)
    const retainedProcessTokens = estimateRetainedCompressibleProcessTokens(
      messages,
      nextState,
      budgetIndex
    )
    if (retainedProcessTokens > processTokenBudget) continue

    const candidate = analyzeContext(messages, nextState, options)
    return {
      cutoffTimestamp: nextState.cutoffTimestamp!,
      nextState,
      potential: createPotential(current, candidate)
    }
  }

  return undefined
}

export function analyzeIgnorePotential(
  messages: AgentMessage[],
  currentState: ContextIgnoreState,
  keepTurns: number,
  processTokenBudget: number,
  options: ContextIgnoreTransformOptions = {}
): ContextIgnorePotential {
  return (
    selectRecentProcessCandidate(messages, currentState, keepTurns, processTokenBudget, options)
      ?.potential ?? emptyContextIgnorePotential()
  )
}
