import type { ToolCall } from '@earendil-works/pi-ai'

const CHARS_PER_ESTIMATED_TOKEN = 4

export function estimateContextTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_ESTIMATED_TOKEN)
}

export function estimateThinkingBlockTokens(block: { thinking: string }): number {
  return estimateContextTextTokens(block.thinking)
}

export function estimateReasoningReplayTokens(block: { thinkingSignature?: string }): number {
  return estimateContextTextTokens(block.thinkingSignature ?? '')
}

export function estimateToolCallTokens(toolCall: Pick<ToolCall, 'name' | 'arguments'>): number {
  const serializedArguments = JSON.stringify(toolCall.arguments) ?? ''
  return estimateContextTextTokens(toolCall.name + serializedArguments)
}
