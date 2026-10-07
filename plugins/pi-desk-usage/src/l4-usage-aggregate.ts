import type { UsageModelSnapshot, UsageStructureCounts, UsageTotals } from './protocol.js'
import type { ParsedUsageEvent } from './usage-scan.js'

export function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

export function addTotals(target: UsageTotals, value: UsageTotals): void {
  target.input += value.input
  target.output += value.output
  target.cacheRead += value.cacheRead
  target.cacheWrite += value.cacheWrite
  target.cost += value.cost
}

export function promptTokens(totals: UsageTotals): number {
  return totals.input + totals.cacheRead + totals.cacheWrite
}

export function aggregateEventModels(
  events: readonly ParsedUsageEvent[],
  modelNames: ReadonlyMap<string, string>
): UsageModelSnapshot[] {
  const models = new Map<string, { event: ParsedUsageEvent; totals: UsageTotals; calls: number }>()
  for (const event of events) {
    let aggregate = models.get(event.modelKey)
    if (!aggregate) {
      aggregate = { event, totals: emptyTotals(), calls: 0 }
      models.set(event.modelKey, aggregate)
    }
    addTotals(aggregate.totals, event.totals)
    aggregate.calls += 1
  }
  return [...models.entries()]
    .map(([key, aggregate]) => ({
      key,
      provider: aggregate.event.provider,
      model: aggregate.event.model,
      label: modelNames.get(key) || aggregate.event.label,
      calls: aggregate.calls,
      totals: { ...aggregate.totals }
    }))
    .sort(
      (left, right) =>
        promptTokens(right.totals) - promptTokens(left.totals) ||
        right.totals.output - left.totals.output
    )
}

export function totalEvents(events: readonly ParsedUsageEvent[]): UsageTotals {
  const totals = emptyTotals()
  for (const event of events) addTotals(totals, event.totals)
  return totals
}

export function emptyStructureCounts(): UsageStructureCounts {
  return {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    compactions: 0,
    branchSummaries: 0
  }
}

export function hasUsage(totals: UsageTotals): boolean {
  return (
    totals.input > 0 ||
    totals.output > 0 ||
    totals.cacheRead > 0 ||
    totals.cacheWrite > 0 ||
    totals.cost > 0
  )
}
