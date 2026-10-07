import { useEffect, useMemo, useRef, useState } from 'react'
import { DAY_MS } from './l4-usage-calendar.js'
import { formatTokens } from './l4-usage-format.js'
import type { UsageSeriesPoint, UsageTotals } from './protocol.js'

const DEFAULT_WIDTH = 960
const HEIGHT = 228
const LEFT = 56
const RIGHT = 18
const TOP = 18
const BOTTOM = 28
const EMPTY_TOTALS: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }

function promptTokens(totals: UsageTotals): number {
  return totals.input + totals.cacheRead + totals.cacheWrite
}

function cacheRate(totals: UsageTotals): number | null {
  const prompt = promptTokens(totals)
  return prompt > 0 ? totals.cacheRead / prompt : null
}

function formatCost(value: number): string {
  if (value === 0) return '$0'
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

function formatRange(point: UsageSeriesPoint, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }
  const formatter = new Intl.DateTimeFormat('zh-CN', options)
  return `${formatter.format(point.startAt)} – ${formatter.format(point.endAt)}`
}

function formatAxisLabel(value: number, span: number, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions =
    span > DAY_MS
      ? { timeZone, month: '2-digit', day: '2-digit' }
      : { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }
  return new Intl.DateTimeFormat('zh-CN', options).format(value)
}

function axisIndexes(length: number, plotWidth: number): number[] {
  if (length === 0) return []
  const intervals = Math.max(1, Math.min(5, Math.floor(plotWidth / 80)))
  return [
    ...new Set(
      Array.from({ length: intervals + 1 }, (_, index) =>
        Math.round((index * (length - 1)) / intervals)
      )
    )
  ]
}

function pointTotals(point: UsageSeriesPoint, modelKey: string | null): UsageTotals {
  if (!modelKey) return point.totals
  return point.models.find((model) => model.key === modelKey)?.totals ?? EMPTY_TOTALS
}

function linePath(
  values: readonly number[],
  xAt: (index: number) => number,
  yAt: (value: number) => number
): string {
  return values
    .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xAt(index)} ${yAt(value)}`)
    .join(' ')
}

export function UsageReportChart({
  points,
  timeZone,
  modelKey,
  selectedStartAt,
  selectedRange,
  onSelect
}: {
  points: UsageSeriesPoint[]
  timeZone: string
  modelKey: string | null
  selectedStartAt: number | null
  selectedRange: { startAt: number; endAt: number } | null
  onSelect(point: UsageSeriesPoint): void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [chartWidth, setChartWidth] = useState(DEFAULT_WIDTH)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = (): void => setChartWidth(Math.max(200, Math.round(container.clientWidth)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const totals = useMemo(
    () => points.map((point) => pointTotals(point, modelKey)),
    [modelKey, points]
  )
  const prompts = totals.map(promptTokens)
  const rates = totals.map((value) => cacheRate(value) ?? 0)
  const maximum = Math.max(1, ...prompts)
  const plotWidth = chartWidth - LEFT - RIGHT
  const plotHeight = HEIGHT - TOP - BOTTOM
  const xAt = (index: number): number =>
    points.length <= 1 ? LEFT + plotWidth / 2 : LEFT + (index / (points.length - 1)) * plotWidth
  const promptY = (value: number): number => TOP + plotHeight - (value / maximum) * plotHeight
  const rateY = (value: number): number => TOP + plotHeight - value * plotHeight
  const promptLine = linePath(prompts, xAt, promptY)
  const area = points.length
    ? `${promptLine} L ${xAt(points.length - 1)} ${TOP + plotHeight} L ${xAt(0)} ${TOP + plotHeight} Z`
    : ''
  const rateLine = linePath(rates, xAt, rateY)
  const axisSpan = points.length > 0 ? points.at(-1)!.endAt - points[0]!.startAt : 0
  const xAxisIndexes = axisIndexes(points.length, plotWidth)
  const activeIndex = hoveredIndex ?? points.findIndex((point) => point.startAt === selectedStartAt)
  const activePoint = activeIndex >= 0 ? points[activeIndex] : null
  const activeTotals = activeIndex >= 0 ? totals[activeIndex] : null
  const zoneWidth = plotWidth / Math.max(1, points.length)
  const tooltipWidth = Math.min(240, chartWidth)

  return (
    <div
      ref={containerRef}
      className="usage-report-chart"
      onPointerLeave={() => setHoveredIndex(null)}
    >
      <div className="usage-chart-legend">
        <span>
          <i data-series="prompt" />
          输入总量
        </span>
        <span>
          <i data-series="rate" />
          缓存命中率
        </span>
        <span className="usage-chart-scale">最高 {formatTokens(maximum)}</span>
      </div>
      <svg viewBox={`0 0 ${chartWidth} ${HEIGHT}`} role="img" aria-label="输入总量和缓存命中率趋势">
        {[0, 0.5, 1].map((ratio) => {
          const y = TOP + plotHeight * ratio
          return (
            <line
              className="usage-chart-grid"
              x1={LEFT}
              x2={chartWidth - RIGHT}
              y1={y}
              y2={y}
              key={ratio}
            />
          )
        })}
        <text className="usage-chart-axis-label" x={LEFT - 7} y={TOP + 4} textAnchor="end">
          {formatTokens(maximum)}
        </text>
        <text
          className="usage-chart-axis-label"
          x={LEFT - 7}
          y={TOP + plotHeight + 4}
          textAnchor="end"
        >
          0
        </text>
        <text
          className="usage-chart-axis-label"
          x={chartWidth - RIGHT}
          y={TOP + 4}
          textAnchor="end"
        >
          100%
        </text>
        {xAxisIndexes.map((index) => {
          const point = points[index]!
          const value = index === points.length - 1 ? point.endAt : point.startAt
          return (
            <text
              className="usage-chart-axis-label"
              x={xAt(index)}
              y={HEIGHT - 5}
              textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
              key={index}
            >
              {formatAxisLabel(value, axisSpan, timeZone)}
            </text>
          )
        })}
        {area ? <path className="usage-chart-area" d={area} /> : null}
        {promptLine ? <path className="usage-chart-prompt-line" d={promptLine} /> : null}
        {rateLine ? <path className="usage-chart-rate-line" d={rateLine} /> : null}
        {points.map((point, index) => {
          const x = xAt(index)
          const selected =
            point.startAt === selectedStartAt ||
            (selectedRange !== null &&
              point.startAt >= selectedRange.startAt &&
              point.startAt < selectedRange.endAt)
          return (
            <g key={point.startAt}>
              {selected ? (
                <rect
                  className="usage-chart-selection"
                  x={Math.max(LEFT, x - zoneWidth / 2)}
                  y={TOP}
                  width={zoneWidth}
                  height={plotHeight}
                />
              ) : null}
              <rect
                className="usage-chart-hit-zone"
                x={Math.max(LEFT, x - zoneWidth / 2)}
                y={TOP}
                width={zoneWidth}
                height={plotHeight}
                tabIndex={0}
                role="button"
                aria-label={`${formatRange(point, timeZone)}，输入 ${formatTokens(prompts[index] ?? 0)}`}
                onPointerEnter={() => setHoveredIndex(index)}
                onFocus={() => setHoveredIndex(index)}
                onBlur={() => setHoveredIndex(null)}
                onClick={() => onSelect(point)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(point)
                  }
                }}
              />
            </g>
          )
        })}
        {activeIndex >= 0 ? (
          <line
            className="usage-chart-cursor"
            x1={xAt(activeIndex)}
            x2={xAt(activeIndex)}
            y1={TOP}
            y2={TOP + plotHeight}
          />
        ) : null}
      </svg>
      {activePoint && activeTotals ? (
        <div
          className="usage-chart-tooltip"
          style={{
            left: `${Math.min(chartWidth - tooltipWidth / 2, Math.max(tooltipWidth / 2, xAt(activeIndex)))}px`,
            width: `${tooltipWidth}px`
          }}
        >
          <strong>{formatRange(activePoint, timeZone)}</strong>
          <span>输入 {formatTokens(promptTokens(activeTotals))}</span>
          <span>
            命中率{' '}
            {cacheRate(activeTotals) === null
              ? '—'
              : `${(cacheRate(activeTotals)! * 100).toFixed(1)}%`}
          </span>
          <span>输出 {formatTokens(activeTotals.output)}</span>
          <span>缓存读取 {formatTokens(activeTotals.cacheRead)}</span>
          <span>费用 {formatCost(activeTotals.cost)}</span>
        </div>
      ) : null}
    </div>
  )
}
