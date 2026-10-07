import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent'
import { getIgnoredMessageReferences, transformContextMessages } from './context-transform.js'
import type { ContextIgnoreTransformOptions } from './context-skill-path.js'
import type { ContextIgnoreState } from './types.js'

export function transformCompactionPreparation(
  preparation: SessionBeforeCompactEvent['preparation'],
  sessionMessages: AgentMessage[],
  state: ContextIgnoreState,
  ignoredTokens: number,
  options: ContextIgnoreTransformOptions = {}
) {
  if (
    !state.enabled ||
    (state.cutoffTimestamp === undefined && state.internalTurnCutoffs === undefined)
  ) {
    return
  }

  const transformOptions = {
    ...options,
    ignoredMessages: getIgnoredMessageReferences(sessionMessages, state)
  }
  preparation.messagesToSummarize = transformContextMessages(
    preparation.messagesToSummarize,
    state,
    transformOptions
  ).messages
  preparation.turnPrefixMessages = transformContextMessages(
    preparation.turnPrefixMessages,
    state,
    transformOptions
  ).messages
  preparation.tokensBefore = Math.max(0, preparation.tokensBefore - ignoredTokens)
}
