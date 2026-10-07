import type {
  UsageActivity,
  UsageSessionTimelineSnapshot,
  UsageTimelineBucket,
  UsageTimelineMarker,
  UsageTimelinePoint,
  UsageTimelineRun,
  UsageTimelineSourceSnapshot,
  UsageTotals
} from './protocol.js'
import type { ParsedToolActivity, ParsedUsageEvent, ParsedUsageMarker } from './usage-scan.js'

import { usageBucketRanges, usageBucketIndex } from './l4-usage-calendar.js'

const MAX_DISPLAY_POINTS = 800
const MAX_TRACK_ACTIVITIES = 160
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export interface UsageTimelineSourceInput {
  key: string
  kind: 'main' | 'subagent'
  title: string
  agentType: string | null
  updatedAt: number
  runs: UsageTimelineRun[]
  events: ParsedUsageEvent[]
  markers: ParsedUsageMarker[]
  tools: ParsedToolActivity[]
}

interface TimelineCall {
  timestamp: number
  order: number
  prompt: number
  cacheRead: number
}

interface SourceBuildState {
  input: UsageTimelineSourceInput
  calls: TimelineCall[]
  markers: ParsedUsageMarker[]
  segments: UsageTimelinePoint[][]
  mandatoryAt: Set<number>
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

function addTotals(target: UsageTotals, value: UsageTotals): void {
  target.input += value.input
  target.output += value.output
  target.cacheRead += value.cacheRead
  target.cacheWrite += value.cacheWrite
  target.cost += value.cost
}

function promptTokens(event: ParsedUsageEvent): number {
  return event.totals.input + event.totals.cacheRead + event.totals.cacheWrite
}

function rate(point: UsageTimelinePoint): number {
  return point.prompt > 0 ? point.cacheRead / point.prompt : 0
}

function pointKey(point: UsageTimelinePoint): string {
  return `${point.at}:${point.prompt}:${point.cacheRead}`
}

function trimToTarget(
  points: UsageTimelinePoint[],
  target: number,
  mandatoryAt: ReadonlySet<number>
): UsageTimelinePoint[] {
  if (points.length <= target) return points
  const mandatory = points.filter(
    (point, index) => index === 0 || index === points.length - 1 || mandatoryAt.has(point.at)
  )
  const mandatoryKeys = new Set(mandatory.map(pointKey))
  const optional = points.filter((point) => !mandatoryKeys.has(pointKey(point)))
  const remaining = Math.max(0, target - mandatory.length)
  if (remaining === 0) return mandatory.sort((left, right) => left.at - right.at)

  const selected: UsageTimelinePoint[] = [...mandatory]
  const bucketCount = Math.max(1, Math.floor(remaining / 2))
  const bucketSize = optional.length / bucketCount
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize)
    const end = Math.max(start + 1, Math.floor((bucket + 1) * bucketSize))
    const values = optional.slice(start, end)
    if (values.length === 0) continue
    const promptMin = values.reduce((best, point) => (point.prompt < best.prompt ? point : best))
    const promptMax = values.reduce((best, point) => (point.prompt > best.prompt ? point : best))
    const rateMin = values.reduce((best, point) => (rate(point) < rate(best) ? point : best))
    const rateMax = values.reduce((best, point) => (rate(point) > rate(best) ? point : best))
    for (const point of [promptMin, promptMax, rateMin, rateMax].sort(
      (left, right) => left.at - right.at
    )) {
      if (selected.length >= target) break
      if (!selected.some((item) => pointKey(item) === pointKey(point))) selected.push(point)
    }
  }

  return selected.sort((left, right) => left.at - right.at)
}

function chooseBucketMs(duration: number): number {
  if (duration <= 2 * HOUR_MS) return MINUTE_MS
  if (duration <= 10 * HOUR_MS) return 5 * MINUTE_MS
  if (duration <= 30 * HOUR_MS) return 15 * MINUTE_MS
  if (duration <= 60 * HOUR_MS) return 30 * MINUTE_MS
  if (duration <= 5 * DAY_MS) return HOUR_MS
  if (duration <= 15 * DAY_MS) return 3 * HOUR_MS
  if (duration <= 30 * DAY_MS) return 6 * HOUR_MS
  if (duration <= 90 * DAY_MS) return 12 * HOUR_MS
  return DAY_MS
}

function runIndex(runs: readonly UsageTimelineRun[], timestamp: number): number {
  if (runs.length <= 1) return 0
  let result = 0
  for (let index = 1; index < runs.length; index += 1) {
    if (timestamp < runs[index]!.startAt) break
    result = index
  }
  return result
}

function inRange(timestamp: number, startAt: number, endAt: number): boolean {
  return timestamp >= startAt && timestamp < endAt
}

function intersects(
  startAt: number,
  endAt: number | null,
  rangeStart: number,
  rangeEnd: number
): boolean {
  return startAt < rangeEnd && (endAt === null || endAt >= rangeStart)
}

function contextStates(inputs: readonly UsageTimelineSourceInput[]): SourceBuildState[] {
  return inputs.map((input) => {
    const calls = input.events
      .filter((event) => event.kind === 'assistant' && promptTokens(event) > 0)
      .map((event) => ({
        timestamp: event.timestamp,
        order: event.order,
        prompt: promptTokens(event),
        cacheRead: event.totals.cacheRead
      }))
      .sort((left, right) => left.timestamp - right.timestamp || left.order - right.order)
    const markers = [...input.markers].sort(
      (left, right) => left.timestamp - right.timestamp || left.order - right.order
    )
    const segments = Array.from(
      { length: Math.max(1, input.kind === 'main' ? 1 : input.runs.length) },
      () => [] as UsageTimelinePoint[]
    )
    const mandatoryAt = new Set<number>()
    for (const call of calls) {
      segments[input.kind === 'main' ? 0 : runIndex(input.runs, call.timestamp)]!.push({
        at: call.timestamp,
        prompt: call.prompt,
        cacheRead: call.cacheRead
      })
    }
    for (const marker of markers) {
      const previous = [...calls].reverse().find((call) => call.timestamp < marker.timestamp)
      const next = calls.find((call) => call.timestamp > marker.timestamp)
      mandatoryAt.add(marker.timestamp)
      if (previous) mandatoryAt.add(previous.timestamp)
      if (next) {
        mandatoryAt.add(next.timestamp)
        const segment = input.kind === 'main' ? 0 : runIndex(input.runs, marker.timestamp)
        segments[segment]!.push({
          at: marker.timestamp,
          prompt: next.prompt,
          cacheRead: next.cacheRead
        })
      }
    }
    for (const segment of segments) segment.sort((left, right) => left.at - right.at)
    return {
      input,
      calls,
      markers,
      segments: segments.filter((segment) => segment.length > 0),
      mandatoryAt
    }
  })
}

function sampledSources(states: readonly SourceBuildState[]): {
  sources: UsageTimelineSourceSnapshot[]
  sampled: boolean
} {
  const totalPoints = states.reduce(
    (total, state) => total + state.segments.reduce((sum, segment) => sum + segment.length, 0),
    0
  )
  const sampled = totalPoints > MAX_DISPLAY_POINTS
  const ratio = sampled ? MAX_DISPLAY_POINTS / totalPoints : 1
  return {
    sampled,
    sources: states.map((state) => {
      const pointCount = state.segments.reduce((sum, segment) => sum + segment.length, 0)
      let remainingTarget = sampled
        ? Math.max(state.segments.length * 2, Math.floor(pointCount * ratio))
        : pointCount
      let remainingPoints = pointCount
      const segments = state.segments.map((segment, index) => {
        const target = sampled
          ? Math.min(
              segment.length,
              Math.max(
                Math.min(segment.length, 2),
                index === state.segments.length - 1
                  ? remainingTarget
                  : Math.floor((segment.length / Math.max(1, remainingPoints)) * remainingTarget)
              )
            )
          : segment.length
        remainingTarget = Math.max(0, remainingTarget - target)
        remainingPoints -= segment.length
        return trimToTarget(segment, target, state.mandatoryAt)
      })
      return {
        key: state.input.key,
        kind: state.input.kind,
        title: state.input.kind === 'main' ? '主代理' : state.input.title,
        agentType: state.input.agentType,
        calls: state.calls.length,
        segments,
        runs: state.input.runs
      }
    })
  }
}

function timelineMarkers(states: readonly SourceBuildState[]): UsageTimelineMarker[] {
  return states
    .flatMap((state) =>
      state.markers.map((marker) => {
        const previous = [...state.calls]
          .reverse()
          .find((call) => call.timestamp < marker.timestamp)
        const next = state.calls.find((call) => call.timestamp > marker.timestamp)
        return {
          x: marker.timestamp,
          sourceKey: state.input.key,
          kind: marker.kind,
          timestamp: marker.timestamp,
          mode: marker.mode,
          beforePrompt: previous?.prompt ?? null,
          projectedPrompt: marker.projectedTokens,
          afterPrompt: next?.prompt ?? null,
          tokensBefore: marker.tokensBefore
        }
      })
    )
    .sort((left, right) => left.timestamp - right.timestamp)
}

function createBuckets(
  inputs: readonly UsageTimelineSourceInput[],
  startAt: number,
  endAt: number,
  bucketMs: number,
  timeZone: string
): UsageTimelineBucket[] {
  const buckets = usageBucketRanges(startAt, endAt, bucketMs, timeZone).map((range) => ({
    ...range,
    totals: emptyTotals(),
    calls: 0,
    sources: inputs.map((source) => ({ sourceKey: source.key, totals: emptyTotals(), calls: 0 }))
  }))
  const sourceIndexes = new Map(inputs.map((source, index) => [source.key, index]))
  for (const source of inputs) {
    const sourceIndex = sourceIndexes.get(source.key)!
    for (const event of source.events) {
      if (!inRange(event.timestamp, startAt, endAt)) continue
      const index = usageBucketIndex(buckets, event.timestamp)
      const bucket = buckets[index]!
      const sourceBucket = bucket.sources[sourceIndex]!
      addTotals(bucket.totals, event.totals)
      addTotals(sourceBucket.totals, event.totals)
      if (event.kind === 'assistant') {
        bucket.calls += 1
        sourceBucket.calls += 1
      }
    }
  }
  return buckets
}

export function createUsageActivities(
  inputs: readonly UsageTimelineSourceInput[],
  startAt: number,
  endAt: number
): UsageActivity[] {
  const activities: UsageActivity[] = []
  for (const source of inputs) {
    for (const event of source.events) {
      if (!inRange(event.timestamp, startAt, endAt)) continue
      activities.push({
        id: event.identity,
        timestamp: event.timestamp,
        endAt: null,
        sourceKey: source.key,
        kind: 'model',
        label: event.label,
        detail:
          event.kind === 'cache-warm'
            ? '缓存保温'
            : event.kind === 'usage'
              ? '其他模型调用'
              : event.kind === 'assistant'
                ? '模型调用'
                : '工具与摘要用量',
        status: null,
        totals: { ...event.totals }
      })
    }
    for (const tool of source.tools) {
      if (!intersects(tool.timestamp, tool.endAt, startAt, endAt)) continue
      activities.push({
        id: tool.identity,
        timestamp: tool.timestamp,
        endAt: tool.endAt,
        sourceKey: source.key,
        kind: 'tool',
        label: tool.toolName,
        detail: tool.reasoning,
        status: tool.status,
        totals: null
      })
    }
    if (source.kind === 'subagent') {
      for (const [index, run] of source.runs.entries()) {
        if (!intersects(run.startAt, run.endAt, startAt, endAt)) continue
        activities.push({
          id: `${source.key}:run:${index}`,
          timestamp: run.startAt,
          endAt: run.endAt,
          sourceKey: source.key,
          kind: 'subagent-run',
          label: '子代理运行',
          detail: source.title,
          status: run.endAt === null ? 'running' : 'completed',
          totals: null
        })
      }
    }
    for (const marker of source.markers) {
      if (!inRange(marker.timestamp, startAt, endAt)) continue
      activities.push({
        id: marker.identity,
        timestamp: marker.timestamp,
        endAt: null,
        sourceKey: source.key,
        kind: marker.kind,
        label: marker.kind === 'compaction' ? '上下文压缩' : '上下文忽略',
        detail: null,
        status: null,
        totals: null
      })
    }
  }
  return activities.sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id)
  )
}

export function createUsageTimeline(
  inputs: readonly UsageTimelineSourceInput[],
  requestedStartAt?: number,
  requestedEndAt?: number,
  timeZone = 'UTC'
): UsageSessionTimelineSnapshot {
  const observedStarts = inputs.flatMap((source) => [
    ...source.events.map((event) => event.timestamp),
    ...source.tools.map((tool) => tool.timestamp),
    ...source.runs.map((run) => run.startAt)
  ])
  const observedEnds = inputs.flatMap((source) => [
    ...source.events.map((event) => event.timestamp),
    ...source.tools.flatMap((tool) => (tool.endAt === null ? [] : [tool.endAt])),
    ...source.runs.flatMap((run) => (run.endAt === null ? [] : [run.endAt])),
    source.updatedAt
  ])
  const fallback = Date.now()
  const startAt = requestedStartAt ?? Math.min(...observedStarts, fallback)
  const defaultEndAt = observedEnds.length > 0 ? Math.max(...observedEnds) : fallback
  const endAt = Math.max(startAt + 1, requestedEndAt ?? defaultEndAt)
  const bucketMs = chooseBucketMs(endAt - startAt)
  const states = contextStates(inputs)
  const sampled = sampledSources(states)
  const markers = timelineMarkers(states).filter((marker) =>
    inRange(marker.timestamp, startAt, endAt)
  )
  const allActivities = createUsageActivities(inputs, startAt, endAt)
  const activities = allActivities
    .filter((activity) => {
      if (activity.kind === 'subagent-run') return true
      if (activity.kind !== 'tool') return false
      const end = activity.endAt ?? endAt
      return end - activity.timestamp >= bucketMs
    })
    .sort(
      (left, right) =>
        (right.endAt ?? endAt) - right.timestamp - ((left.endAt ?? endAt) - left.timestamp)
    )
    .slice(0, MAX_TRACK_ACTIVITIES)
    .sort((left, right) => left.timestamp - right.timestamp)

  return {
    generatedAt: Date.now(),
    startAt,
    endAt,
    bucketMs,
    totalCalls: inputs.reduce(
      (total, source) => total + source.events.filter((event) => event.kind === 'assistant').length,
      0
    ),
    displayedPoints: sampled.sources.reduce(
      (total, source) => total + source.segments.reduce((sum, segment) => sum + segment.length, 0),
      0
    ),
    sampled: sampled.sampled,
    buckets: createBuckets(inputs, startAt, endAt, bucketMs, timeZone),
    sources: sampled.sources,
    markers,
    activities
  }
}
