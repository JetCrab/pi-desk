import type {
  L3ConversationMessageDetailPatch,
  L3ConversationMessageFixedPatch,
  L3ConversationMessageIncrements,
  L3ConversationMessageSummaryPatch,
  L3ConversationMessageUsage,
  L3ConversationTemporaryMessageSnapshot
} from './l3-conversation-contract'
import {
  L3ConversationMessageUpdateEventSchema,
  type L3ConversationMessageUpdateEvent
} from './l3-conversation-event-contract'

function sameUsage(
  left: L3ConversationMessageUsage | null,
  right: L3ConversationMessageUsage | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.inputTokens === right.inputTokens &&
      left.outputTokens === right.outputTokens &&
      left.cacheReadTokens === right.cacheReadTokens &&
      left.costUsd === right.costUsd)
  )
}

function fixedPatch(
  previous: L3ConversationTemporaryMessageSnapshot,
  next: L3ConversationTemporaryMessageSnapshot
): L3ConversationMessageFixedPatch | undefined {
  const patch: L3ConversationMessageFixedPatch = {}
  if (previous.fixed.viewKey !== next.fixed.viewKey) patch.viewKey = next.fixed.viewKey
  if (
    'status' in previous.fixed &&
    'status' in next.fixed &&
    previous.fixed.status !== next.fixed.status
  ) {
    patch.status = next.fixed.status
  }
  if (previous.fixed.hasDetail !== next.fixed.hasDetail) patch.hasDetail = next.fixed.hasDetail
  if (
    'usage' in previous.fixed &&
    'usage' in next.fixed &&
    !sameUsage(previous.fixed.usage, next.fixed.usage)
  ) {
    patch.usage = next.fixed.usage
  }
  return Object.keys(patch).length > 0 ? patch : undefined
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function escapedPathSegment(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\./g, '\\.')
}

type L3ConversationIncrementValue = Exclude<L3ConversationMessageIncrements[string], undefined>

function appendValue(previous: unknown, next: unknown): L3ConversationIncrementValue | null {
  if (typeof previous === 'string' && typeof next === 'string' && next.startsWith(previous)) {
    const increment = next.slice(previous.length)
    return increment || null
  }
  if (
    Array.isArray(previous) &&
    Array.isArray(next) &&
    previous.length <= next.length &&
    previous.every((item, index) => sameJson(item, next[index]))
  ) {
    const increment = next.slice(previous.length)
    return increment.length > 0 ? increment : null
  }
  return null
}

function diffJsonLayer(
  root: 'summary' | 'detail',
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  replacements: Record<string, unknown>,
  increments: L3ConversationMessageIncrements
): void {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const key of keys) {
    const previousValue = previous[key]
    const nextHasKey = Object.hasOwn(next, key)
    const nextValue = nextHasKey ? next[key] : null
    if (sameJson(previousValue, nextValue)) continue
    const increment = nextHasKey ? appendValue(previousValue, nextValue) : null
    if (increment !== null) {
      increments[`${root}.${escapedPathSegment(key)}`] = increment
    } else {
      replacements[key] = nextValue
    }
  }
}

export function buildL3ConversationMessageUpdate(
  previous: L3ConversationTemporaryMessageSnapshot,
  next: L3ConversationTemporaryMessageSnapshot
): L3ConversationMessageUpdateEvent | null {
  if (previous.fixed.type !== next.fixed.type) {
    throw new Error(`Chat message type changed: ${previous.fixed.type}/${next.fixed.type}`)
  }

  const fixed = fixedPatch(previous, next)
  const summary: L3ConversationMessageSummaryPatch = {}
  const detail: L3ConversationMessageDetailPatch = {}
  const increments: L3ConversationMessageIncrements = {}
  diffJsonLayer('summary', previous.summary, next.summary, summary, increments)
  if (next.fixed.hasDetail) {
    diffJsonLayer('detail', previous.detail ?? {}, next.detail ?? {}, detail, increments)
  }

  const hasSummary = Object.keys(summary).length > 0
  const hasDetail = Object.keys(detail).length > 0
  const hasIncrements = Object.keys(increments).length > 0
  if (!fixed && !hasSummary && !hasDetail && !hasIncrements) return null

  return L3ConversationMessageUpdateEventSchema.parse({
    type: 'message_update',
    location: previous.location,
    ...(fixed ? { fixed } : {}),
    ...(hasSummary ? { summary } : {}),
    ...(hasDetail ? { detail } : {}),
    ...(hasIncrements ? { increments } : {})
  })
}
