import type { ContextIgnorePotential, ContextIgnoreState } from './types.js'

export interface AutoIgnoreDecision {
  shouldIgnore: boolean
  cutoffTimestamp?: number
  nextState?: ContextIgnoreState
  potential: ContextIgnorePotential
  matchedRuleIndex?: number
}

export function emptyContextIgnorePotential(): ContextIgnorePotential {
  return {
    reasoningReplayTokens: 0,
    netTokens: 0,
    providerNetTokens: 0
  }
}
