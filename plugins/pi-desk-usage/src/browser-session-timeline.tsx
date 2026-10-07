import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatTokens } from './l4-usage-format.js'
import type {
  UsageSessionTimelineSnapshot,
  UsageTimelineBucket,
  UsageTimelinePoint,
  UsageTimelineSourceSnapshot,
  UsageTotals
} from './protocol.js'

const WIDTH = 960
const LEFT = 56
const RIGHT = 14
const TOP = 20
const BOTTOM = 24
const TREND_HEIGHT = 238
const CONTEXT_HEIGHT = 92
const ACTIVITY_ROW_HEIGHT = 26
const CHILD_COLORS = [
  'light-dark(#316baa, #83aed8)',
  'light-dark(#946619, #d7b474)',
  'light-dark(#27795c, #81b6a0)',
  'light-dark(#a54c43, #d5918a)',
  'light-dark(#7557a9, #b4a0d8)',
  'light-dark(#a34e80, #d397b8)',
  'light-dark(#277a85, #82b9c1)'
]

export type TimelineMetric = 'tokens' | 'calls' | 'cost' | 'cache'

export function usageTimelineSourceColor(
  source: UsageTimelineSourceSnapshot,
  index: number
): string {
  return source.kind === 'main'
    ? 'var(--pi-desk-plugin-primary,var(--primary))'
    : CHILD_COLORS[Math.max(0, index - 1) % CHILD_COLORS.length]!
}

function promptTokens(totals: UsageTotals): number {
  return totals.input + totals.cacheRead + totals.cacheWrite
}

function totalTokens(totals: UsageTotals): number {
  return promptTokens(totals) + totals.output
}

function cacheRate(totals: UsageTotals): number | null {
  const prompt = promptTokens(totals)
  return prompt > 0 ? totals.cacheRead / prompt : null
}

function formatMetric(value: number, metric: TimelineMetric): string {
  if (metric === 'calls') return value.toFixed(value < 10 ? 1 : 0)
  if (metric === 'cost') return `$${value.toFixed(value < 1 ? 3 : 2)}`
  if (metric === 'cache') return `${(value * 100).toFixed(0)}%`
  return formatTokens(value)
}

function bucketMinutes(bucket: UsageTimelineBucket): number {
  return Math.max(1 / 60, (bucket.endAt - bucket.startAt) / 60_000)
}

function sourceValue(
  bucket: UsageTimelineBucket,
  key: string,
  metric: TimelineMetric
): number | null {
  const source = bucket.sources.find((item) => item.sourceKey === key)
  if (!source) return null
  const minutes = bucketMinutes(bucket)
  if (metric === 'tokens') return totalTokens(source.totals) / minutes
  if (metric === 'calls') return source.calls / minutes
  if (metric === 'cost') return source.totals.cost / minutes
  return cacheRate(source.totals)
}

function totalValue(bucket: UsageTimelineBucket, metric: TimelineMetric): number | null {
  const minutes = bucketMinutes(bucket)
  if (metric === 'tokens') return totalTokens(bucket.totals) / minutes
  if (metric === 'calls') return bucket.calls / minutes
  if (metric === 'cost') return bucket.totals.cost / minutes
  return cacheRate(bucket.totals)
}

function linePath(
  values: Array<number | null>,
  xAt: (index: number) => number,
  yAt: (value: number) => number
): string {
  let path = ''
  let open = false
  values.forEach((value, index) => {
    if (value === null) {
      open = false
      return
    }
    path += `${open ? 'L' : 'M'} ${xAt(index)} ${yAt(value)} `
    open = true
  })
  return path
}

function areaPath(
  values: Array<number | null>,
  xAt: (index: number) => number,
  yAt: (value: number) => number,
  bottom: number
): string {
  const defined = values
    .map((value, index) => ({ value, index }))
    .filter((item): item is { value: number; index: number } => item.value !== null)
  if (defined.length === 0) return ''
  const line = linePath(values, xAt, yAt)
  return `${line}L ${xAt(defined.at(-1)!.index)} ${bottom} L ${xAt(defined[0]!.index)} ${bottom} Z`
}

function formatTime(value: number, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(value)
}

function formatRange(bucket: UsageTimelineBucket, timeZone: string): string {
  return `${formatTime(bucket.startAt, timeZone)}–${formatTime(bucket.endAt, timeZone)}`
}

function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(WIDTH)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (): void => setWidth(Math.max(180, Math.round(element.clientWidth)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

function ChartFrame({
  children,
  className
}: {
  children: React.ReactNode
  className: string
}): React.JSX.Element {
  return <div className={className}>{children}</div>
}

export function UsageTrendChart({
  snapshot,
  timeZone,
  metric,
  visibleSourceKeys,
  selectedIndex,
  onSelect
}: {
  snapshot: UsageSessionTimelineSnapshot
  metric: TimelineMetric
  timeZone: string
  visibleSourceKeys: readonly string[]
  selectedIndex: number | null
  onSelect(index: number): void
}): React.JSX.Element {
  const [containerRef, width] = useChartWidth()
  const plotWidth = width - LEFT - RIGHT
  const plotHeight = TREND_HEIGHT - TOP - BOTTOM
  const buckets = snapshot.buckets
  const xAt = (index: number): number =>
    buckets.length <= 1 ? LEFT + plotWidth / 2 : LEFT + (index / (buckets.length - 1)) * plotWidth
  const visibleSources = snapshot.sources.filter((source) => visibleSourceKeys.includes(source.key))
  const series = visibleSources.map((source) => ({
    source,
    values: buckets.map((bucket) => sourceValue(bucket, source.key, metric))
  }))
  const totalValues = buckets.map((bucket) => totalValue(bucket, metric))
  const maximum = Math.max(
    1,
    ...totalValues.filter((value): value is number => value !== null),
    ...series.flatMap((item) => item.values.filter((value): value is number => value !== null))
  )
  const yAt = (value: number): number => TOP + plotHeight - (value / maximum) * plotHeight
  const selectAtPointer = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const ratio = Math.min(
      1,
      Math.max(
        0,
        (x - (LEFT / width) * rect.width) /
          Math.max(1, rect.width - ((LEFT + RIGHT) / width) * rect.width)
      )
    )
    onSelect(Math.round(ratio * Math.max(0, buckets.length - 1)))
  }
  const selected = selectedIndex === null ? null : (buckets[selectedIndex] ?? null)
  const unit =
    metric === 'cache'
      ? '命中率'
      : `${metric === 'tokens' ? 'Token' : metric === 'calls' ? '调用' : '费用'}/分`

  return (
    <ChartFrame className="usage-profiler-chart">
      <div className="usage-profiler-chart-head">
        <strong>{unit}</strong>
      </div>
      <div className="usage-profiler-chart-canvas" ref={containerRef}>
        <svg
          viewBox={`0 0 ${width} ${TREND_HEIGHT}`}
          role="img"
          aria-label={`${unit}趋势`}
          onPointerDown={selectAtPointer}
          onPointerMove={(event) => {
            if (event.buttons === 1) selectAtPointer(event)
          }}
        >
          {[0, 0.5, 1].map((ratio) => {
            const y = TOP + plotHeight * ratio
            return (
              <line
                className="usage-profiler-grid"
                x1={LEFT}
                x2={width - RIGHT}
                y1={y}
                y2={y}
                key={ratio}
              />
            )
          })}
          <text className="usage-profiler-axis" x={LEFT - 7} y={TOP + 4} textAnchor="end">
            {formatMetric(maximum, metric)}
          </text>
          <text
            className="usage-profiler-axis"
            x={LEFT - 7}
            y={TOP + plotHeight + 4}
            textAnchor="end"
          >
            0
          </text>
          {metric !== 'cache' ? (
            <path
              className="usage-profiler-total-area"
              d={areaPath(totalValues, xAt, yAt, TOP + plotHeight)}
            />
          ) : null}
          {series.map(({ source, values }) => {
            const index = snapshot.sources.indexOf(source)
            const color = usageTimelineSourceColor(source, index)
            return (
              <g key={source.key}>
                {metric !== 'cache' ? (
                  <path
                    className="usage-profiler-source-area"
                    d={areaPath(values, xAt, yAt, TOP + plotHeight)}
                    style={{ fill: color }}
                  />
                ) : null}
                <path
                  className="usage-profiler-source-line"
                  d={linePath(values, xAt, yAt)}
                  style={{ stroke: color }}
                />
              </g>
            )
          })}
          {selectedIndex !== null ? (
            <line
              className="usage-profiler-cursor"
              x1={xAt(selectedIndex)}
              x2={xAt(selectedIndex)}
              y1={TOP}
              y2={TOP + plotHeight}
            />
          ) : null}
          <text className="usage-profiler-axis" x={LEFT} y={TREND_HEIGHT - 7}>
            {formatTime(snapshot.startAt, timeZone)}
          </text>
          <text
            className="usage-profiler-axis"
            x={width - RIGHT}
            y={TREND_HEIGHT - 7}
            textAnchor="end"
          >
            {formatTime(snapshot.endAt, timeZone)}
          </text>
        </svg>
      </div>
      {selected ? (
        <span className="usage-profiler-selected-range">
          已选 {formatRange(selected, timeZone)}
        </span>
      ) : null}
    </ChartFrame>
  )
}

function stepPath(
  points: readonly UsageTimelinePoint[],
  xAt: (value: number) => number,
  yAt: (value: number) => number
): string {
  if (points.length === 0) return ''
  let path = `M ${xAt(points[0]!.at)} ${yAt(points[0]!.prompt)}`
  for (const point of points.slice(1)) path += ` H ${xAt(point.at)} V ${yAt(point.prompt)}`
  return path
}

export function ContextTimelineChart({
  snapshot,
  visibleSourceKeys
}: {
  snapshot: UsageSessionTimelineSnapshot
  visibleSourceKeys: readonly string[]
}): React.JSX.Element {
  const [containerRef, width] = useChartWidth()
  const plotWidth = width - LEFT - RIGHT
  const plotHeight = CONTEXT_HEIGHT - TOP - BOTTOM
  const sources = snapshot.sources.filter((source) => visibleSourceKeys.includes(source.key))
  const maximum = Math.max(
    1,
    ...sources.flatMap((source) =>
      source.segments.flatMap((segment) => segment.map((point) => point.prompt))
    )
  )
  const xAt = (at: number): number =>
    LEFT + ((at - snapshot.startAt) / Math.max(1, snapshot.endAt - snapshot.startAt)) * plotWidth
  const yAt = (value: number): number => TOP + plotHeight - (value / maximum) * plotHeight
  const visibleMarkers = snapshot.markers.filter((marker) =>
    visibleSourceKeys.includes(marker.sourceKey)
  )
  return (
    <ChartFrame className="usage-profiler-context">
      <div className="usage-profiler-chart-head">
        <strong>上下文大小</strong>
      </div>
      <div ref={containerRef}>
        <svg viewBox={`0 0 ${width} ${CONTEXT_HEIGHT}`} role="img" aria-label="上下文大小趋势">
          {[0, 0.5, 1].map((ratio) => {
            const y = TOP + plotHeight * ratio
            return (
              <line
                className="usage-profiler-grid"
                x1={LEFT}
                x2={width - RIGHT}
                y1={y}
                y2={y}
                key={ratio}
              />
            )
          })}
          <text className="usage-profiler-axis" x={LEFT - 7} y={TOP + 4} textAnchor="end">
            {formatTokens(maximum)}
          </text>
          {visibleMarkers.map((marker) => (
            <line
              className="usage-profiler-marker"
              data-kind={marker.kind}
              x1={xAt(marker.timestamp)}
              x2={xAt(marker.timestamp)}
              y1={TOP}
              y2={TOP + plotHeight}
              key={marker.sourceKey + marker.timestamp}
            />
          ))}
          {sources.map((source) =>
            source.segments.map((segment, index) => (
              <path
                className="usage-profiler-context-line"
                data-main={source.kind === 'main'}
                d={stepPath(segment, xAt, yAt)}
                key={`${source.key}:${index}`}
                style={{
                  stroke: usageTimelineSourceColor(source, snapshot.sources.indexOf(source))
                }}
              />
            ))
          )}
        </svg>
      </div>
    </ChartFrame>
  )
}

export function ActivityTimeline({
  snapshot,
  visibleSourceKeys
}: {
  snapshot: UsageSessionTimelineSnapshot
  visibleSourceKeys: readonly string[]
}): React.JSX.Element {
  const [containerRef, width] = useChartWidth()
  const sources = snapshot.sources.filter((source) => visibleSourceKeys.includes(source.key))
  const height = Math.max(42, sources.length * ACTIVITY_ROW_HEIGHT + 16)
  const plotWidth = width - LEFT - RIGHT
  const xAt = (at: number): number =>
    LEFT + ((at - snapshot.startAt) / Math.max(1, snapshot.endAt - snapshot.startAt)) * plotWidth
  return (
    <ChartFrame className="usage-profiler-activity">
      <div className="usage-profiler-chart-head">
        <strong>活动</strong>
      </div>
      <div ref={containerRef}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="工具和子代理活动轨道">
          {sources.map((source, index) => {
            const top = 8 + index * ACTIVITY_ROW_HEIGHT
            const color = usageTimelineSourceColor(source, snapshot.sources.indexOf(source))
            const activities = snapshot.activities.filter(
              (activity) => activity.sourceKey === source.key
            )
            return (
              <g key={source.key}>
                <title>{source.title}</title>
                <text
                  className="usage-profiler-lane-label"
                  x={LEFT - 7}
                  y={top + 12}
                  textAnchor="end"
                >
                  {source.kind === 'main' ? '主代理' : `代理 ${snapshot.sources.indexOf(source)}`}
                </text>
                <line
                  className="usage-profiler-lane"
                  x1={LEFT}
                  x2={width - RIGHT}
                  y1={top + 10}
                  y2={top + 10}
                />
                {source.runs.map((run, runIndex) => {
                  const start = xAt(run.startAt)
                  const end = xAt(run.endAt ?? snapshot.endAt)
                  return (
                    <rect
                      className="usage-profiler-run"
                      x={start}
                      y={top + 4}
                      width={Math.max(2, end - start)}
                      height="12"
                      key={runIndex}
                      style={{ fill: color }}
                    />
                  )
                })}
                {activities
                  .filter((activity) => activity.kind === 'tool')
                  .map((activity) => {
                    const start = xAt(activity.timestamp)
                    const end = xAt(activity.endAt ?? snapshot.endAt)
                    return (
                      <rect
                        className="usage-profiler-tool"
                        data-running={activity.status === 'running'}
                        x={start}
                        y={top + 6}
                        width={Math.max(3, end - start)}
                        height="8"
                        key={activity.id}
                        style={{ fill: color }}
                      >
                        <title>{`${activity.label} · ${activity.detail ?? '无说明'}`}</title>
                      </rect>
                    )
                  })}
              </g>
            )
          })}
        </svg>
      </div>
    </ChartFrame>
  )
}
