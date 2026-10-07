import type { CompactionResult } from '@earendil-works/pi-coding-agent'
import type { AutoIgnoreDecision } from './auto-ignore.js'

export const CONTEXT_IGNORE_RETRY_SUMMARY =
  '已通过上下文忽略降低旧过程信息；本检查点未生成会话摘要。'

export interface ContextIgnoreRetryDetails {
  contextIgnoreRetry: true
  ignoredTokens: number
  reasoningReplayTokens: number
  providerIgnoredTokens: number
}

export type AutoCompactionReason = 'manual' | 'threshold' | 'overflow'

export type AutoCompactionIgnoreAction =
  | { type: 'none' }
  | { type: 'compact' }
  | { type: 'cancel' }
  | {
      type: 'retry'
      compaction: CompactionResult<ContextIgnoreRetryDetails>
    }

export function resolveAutoCompactionIgnoreAction(
  reason: AutoCompactionReason,
  willRetry: boolean,
  decision: AutoIgnoreDecision,
  firstActiveEntryId: string | undefined,
  contextTokens: number,
  contextWindow: number,
  reserveTokens: number
): AutoCompactionIgnoreAction {
  if (reason === 'manual' || !decision.shouldIgnore || decision.cutoffTimestamp === undefined) {
    return { type: 'none' }
  }

  const projectedContextTokens = Math.max(0, contextTokens - decision.potential.providerNetTokens)
  const compactionThreshold = Math.max(0, contextWindow - reserveTokens)
  if (contextWindow <= 0 || projectedContextTokens > compactionThreshold) {
    return { type: 'compact' }
  }

  if (reason === 'threshold' || !willRetry) {
    return { type: 'cancel' }
  }

  if (firstActiveEntryId === undefined) {
    return { type: 'compact' }
  }

  return {
    type: 'retry',
    compaction: {
      summary: CONTEXT_IGNORE_RETRY_SUMMARY,
      firstKeptEntryId: firstActiveEntryId,
      tokensBefore: Math.max(0, contextTokens),
      details: {
        contextIgnoreRetry: true,
        ignoredTokens: decision.potential.netTokens,
        reasoningReplayTokens: decision.potential.reasoningReplayTokens,
        providerIgnoredTokens: decision.potential.providerNetTokens
      }
    }
  }
}
