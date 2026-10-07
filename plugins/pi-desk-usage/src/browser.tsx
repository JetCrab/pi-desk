import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BrowserApplicationImplementation,
  BrowserPluginHost,
  PluginJsonObject
} from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginBadge,
  PluginButton,
  PluginEmptyState,
  PluginErrorBoundary,
  PluginScroll,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'
import { UsageReportChart } from './browser-report-chart.js'
import { useUsageTimeZone } from './browser-settings.js'
import {
  addDays,
  addMonths,
  buildUsageCalendar,
  buildUsageCalendarRange,
  dateKeyAt,
  dateStart,
  DAY_MS,
  formatMonth,
  monthKeyAt,
  monthRange,
  monthWeekdayOffset,
  zonedHourStart,
  type CalendarMetric,
  type UsageCalendarDay
} from './l4-usage-calendar.js'
import { formatTokens } from './l4-usage-format.js'
import type {
  UsageModelSnapshot,
  UsageReportSnapshot,
  UsageSeriesPoint,
  UsageSessionPage,
  UsageSessionSnapshot,
  UsageSubagentSessionSnapshot,
  UsageTotals
} from './protocol.js'

const EMPTY_TOTALS: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }

type RangeMode = '24h' | 'today' | '7d' | '30d' | 'month'

const USAGE_STYLES = `
.usage-app{display:flex;flex-direction:column;width:min(1120px,calc(100dvw - 2rem));height:min(860px,calc(100dvh - 7rem));gap:1rem;padding:1rem;overflow:hidden}
.usage-toolbar,.usage-toolbar-actions,.usage-range-group,.usage-section-head,.usage-filter-state,.usage-session-head,.usage-session-secondary,.usage-session-child-head,.usage-chart-legend{display:flex;min-width:0;align-items:center;gap:.42rem}
.usage-toolbar{flex:0 0 auto;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}.usage-toolbar-actions{width:100%;justify-content:space-between;flex-wrap:wrap;gap:.75rem}.usage-month-controls{display:flex;align-items:center;gap:.25rem}.usage-range-group{flex-wrap:wrap}
.usage-body{min-height:0;flex:1}.usage-body-viewport{display:grid;min-height:0;align-content:start;gap:1.5rem;padding-right:0}.usage-summary{display:grid;gap:.42rem}.usage-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.45rem}.usage-kpi{display:grid;min-width:0;gap:.25rem;padding:.75rem;border-right:1px solid var(--border)}.usage-kpi:last-child{border-right:0}.usage-kpi-value{font-size:1.25rem;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.usage-kpi-label{font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.usage-secondary-strip{display:flex;gap:.8rem;align-items:center;flex-wrap:wrap;padding:0 .18rem;font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.usage-secondary-strip strong{color:var(--pi-desk-plugin-foreground,var(--foreground));font-weight:690}
.usage-panel{display:grid;min-width:0;gap:1rem;padding:1rem 0;border-top:1px solid var(--border);background:transparent}.usage-chart-panel{padding-bottom:0}.usage-calendar-panel{gap:.5rem}.usage-section-head{justify-content:space-between;align-items:flex-start}.usage-section-copy{display:grid;min-width:0;gap:.08rem}.usage-section-title{font-size:.875rem;font-weight:600}.usage-filter-state{justify-content:flex-end;flex-wrap:wrap}.usage-calendar-metrics{display:flex;flex-wrap:wrap;gap:.25rem}.usage-calendar{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:.3rem}.usage-calendar-weekday{padding:0 .2rem .1rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.75rem;font-weight:500;text-align:center}.usage-calendar-empty{min-height:3.7rem}.usage-calendar-day{display:grid;align-content:space-between;min-width:0;min-height:3.7rem;gap:.3rem;border:1px solid var(--pi-desk-plugin-border,var(--border));border-radius:.42rem;background:color-mix(in srgb,var(--pi-desk-plugin-background,var(--background)) 76%,transparent);padding:.42rem;color:inherit;text-align:left;cursor:pointer;transition:background .12s,border-color .12s}.usage-calendar-day:hover:not(:disabled){border-color:var(--pi-desk-plugin-primary,var(--primary))}.usage-calendar-day[data-level="1"]{background:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 5%,var(--pi-desk-plugin-background,var(--background)))}.usage-calendar-day[data-level="2"]{background:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 10%,var(--pi-desk-plugin-background,var(--background)))}.usage-calendar-day[data-level="3"]{background:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 16%,var(--pi-desk-plugin-background,var(--background)))}.usage-calendar-day[data-level="4"]{background:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 23%,var(--pi-desk-plugin-background,var(--background)))}.usage-calendar-day[data-level="5"]{background:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 32%,var(--pi-desk-plugin-background,var(--background)))}.usage-calendar-day[data-selected="true"]{border-color:var(--pi-desk-plugin-primary,var(--primary));box-shadow:0 0 0 1px var(--pi-desk-plugin-primary,var(--primary)) inset}.usage-calendar-day[data-linked="true"]{border-color:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 62%,var(--pi-desk-plugin-border,var(--border)))}.usage-calendar-day:disabled{cursor:default;opacity:.38}.usage-calendar-day-number{font-size:.75rem;font-weight:500}.usage-calendar-day-value{overflow:hidden;font-size:.75rem;font-weight:500;text-overflow:ellipsis;white-space:nowrap}.usage-lower{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.42fr);gap:.65rem;align-items:start}
.usage-report-chart{position:relative;min-height:245px}.usage-chart-legend{font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));padding:0 .1rem .12rem}.usage-chart-legend span{display:flex;align-items:center;gap:.28rem}.usage-chart-legend i{display:block;width:.78rem;height:.18rem;border-radius:999px}.usage-chart-legend i[data-series="prompt"]{background:var(--pi-desk-plugin-primary,var(--primary))}.usage-chart-legend i[data-series="rate"]{background:var(--status-warning,var(--foreground))}.usage-chart-scale{margin-left:auto}.usage-report-chart svg{display:block;width:100%;height:auto;overflow:visible}.usage-chart-grid{stroke:var(--pi-desk-plugin-border,var(--border));stroke-width:1;opacity:.55;vector-effect:non-scaling-stroke}.usage-chart-axis-label{fill:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:12px}.usage-chart-area{fill:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 20%,transparent)}.usage-chart-prompt-line{fill:none;stroke:var(--pi-desk-plugin-primary,var(--primary));stroke-width:2;vector-effect:non-scaling-stroke}.usage-chart-rate-line{fill:none;stroke:var(--status-warning,var(--foreground));stroke-width:1.6;stroke-dasharray:5 4;vector-effect:non-scaling-stroke}.usage-chart-hit-zone{fill:transparent;cursor:pointer;outline:none}.usage-chart-hit-zone:focus{stroke:var(--pi-desk-plugin-ring,var(--ring));stroke-width:2;vector-effect:non-scaling-stroke}.usage-chart-selection{fill:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 9%,transparent)}.usage-chart-cursor{stroke:var(--pi-desk-plugin-foreground,var(--foreground));stroke-width:1;stroke-dasharray:3 4;opacity:.55;vector-effect:non-scaling-stroke}.usage-chart-tooltip{position:absolute;z-index:2;top:2.2rem;display:grid;gap:.12rem;min-width:145px;transform:translateX(-50%);border:1px solid var(--pi-desk-plugin-border,var(--border));border-radius:.48rem;background:var(--popover);box-shadow:0 8px 28px rgb(0 0 0/.14);padding:.46rem .55rem;pointer-events:none;font-size:.75rem}.usage-chart-tooltip strong{font-size:.75rem}.usage-chart-tooltip span{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.usage-model-list,.usage-sessions,.usage-session-children{display:grid;gap:.4rem}.usage-model{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem;align-items:center;width:100%;border:1px solid transparent;border-bottom-color:var(--border);border-radius:.5rem;background:transparent;padding:.75rem;color:inherit;text-align:left;font:inherit;cursor:pointer}.usage-model:focus-visible,.usage-calendar-day:focus-visible,.usage-session-toggle:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}.usage-model:hover{background:var(--pi-desk-plugin-muted,var(--muted))}.usage-model[data-selected="true"]{border-color:var(--pi-desk-plugin-primary,var(--primary));background:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 9%,transparent)}.usage-model-copy{display:grid;min-width:0;grid-column:1/-1;gap:.25rem}.usage-model-name{font-size:.875rem;font-weight:500;overflow-wrap:anywhere}.usage-model-detail{font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.usage-compact-metric{display:grid;min-width:0;gap:.02rem}.usage-compact-metric-label{font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.usage-compact-metric-value{font-size:.875rem;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.usage-session{display:grid;gap:.75rem;padding:.75rem 0;border-bottom:1px solid var(--border)}.usage-session:last-child{border-bottom:0}button.usage-session-toggle{display:grid;width:100%;gap:.42rem;border:0;background:transparent;padding:0;color:inherit;text-align:left;cursor:pointer}.usage-session-head{align-items:flex-start}.usage-session-chevron{flex:0 0 auto;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:1rem;line-height:1.3}.usage-session-copy{display:grid;min-width:0;flex:1;gap:.06rem}.usage-session-title{font-size:.875rem;font-weight:500;overflow-wrap:anywhere}.usage-session-path{font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.usage-session-metrics,.usage-session-child-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.35rem}.usage-session-secondary{flex-wrap:wrap;font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.usage-session-secondary strong{color:var(--pi-desk-plugin-foreground,var(--foreground));font-weight:680}.usage-session-children{border-top:1px solid var(--pi-desk-plugin-border,var(--border));padding-top:.42rem}.usage-session-child{display:grid;gap:.28rem;border-left:2px solid color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 40%,transparent);padding:.38rem .42rem}.usage-session-child-head{justify-content:space-between;align-items:flex-start}.usage-session-child-title{font-size:.875rem;font-weight:500;overflow-wrap:anywhere}.usage-load-more{justify-self:center}.usage-empty-inline{padding:.5rem 0;text-align:center}
@container (max-width:52rem){.usage-lower{grid-template-columns:minmax(0,1fr)}.usage-model-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width:32rem){.usage-section-head,.usage-session-head{flex-wrap:wrap}.usage-toolbar-actions{justify-content:flex-start}.usage-model-list{grid-template-columns:minmax(0,1fr)}.usage-session-path{white-space:normal}.usage-chart-legend{flex-wrap:wrap}.usage-chart-scale{margin-left:0}.usage-calendar{gap:.25rem}.usage-calendar-day{padding:.375rem .25rem}.usage-kpi{padding:.5rem .25rem}}
`

function parseReport(value: PluginJsonObject): UsageReportSnapshot {
  return JSON.parse(JSON.stringify(value)) as UsageReportSnapshot
}

function parseSessions(value: PluginJsonObject): UsageSessionPage {
  return JSON.parse(JSON.stringify(value)) as UsageSessionPage
}

function renderReact(container: HTMLElement, children: ReactNode): () => void {
  const root = createRoot(container)
  root.render(<PluginErrorBoundary>{children}</PluginErrorBoundary>)
  return (): void => root.unmount()
}

async function invoke(
  host: BrowserPluginHost,
  method: string,
  input: PluginJsonObject
): Promise<PluginJsonObject> {
  return host.piDesk.invokeGlobal(method, input)
}

function rangeFor(
  mode: RangeMode,
  monthKey: string,
  timeZone: string
): { startAt: number; endAt: number } {
  if (mode === '24h') {
    const endAt = zonedHourStart(Date.now(), timeZone)
    return { startAt: endAt - DAY_MS, endAt }
  }
  const now = Date.now()
  const today = dateKeyAt(now, timeZone)
  if (mode === 'today') return { startAt: dateStart(today, timeZone), endAt: now }
  if (mode === '7d') return { startAt: dateStart(addDays(today, -6), timeZone), endAt: now }
  if (mode === '30d') return { startAt: dateStart(addDays(today, -29), timeZone), endAt: now }
  const range = monthRange(monthKey, timeZone)
  return monthKey === monthKeyAt(now, timeZone) ? { ...range, endAt: now } : range
}

function formatCost(value: number): string {
  if (value === 0) return '$0'
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

function promptTokens(totals: UsageTotals): number {
  return totals.input + totals.cacheRead + totals.cacheWrite
}

function cacheRate(totals: UsageTotals): number | null {
  const prompt = promptTokens(totals)
  return prompt > 0 ? totals.cacheRead / prompt : null
}

function formatTime(value: number, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(value)
}

function pointTotals(point: UsageSeriesPoint, modelKey: string | null): UsageTotals {
  if (!modelKey) return point.totals
  return point.models.find((model) => model.key === modelKey)?.totals ?? EMPTY_TOTALS
}

function reportTotals(
  report: UsageReportSnapshot,
  selectedStartAt: number | null,
  modelKey: string | null
): UsageTotals {
  if (selectedStartAt !== null) {
    const point = report.series.find((item) => item.startAt === selectedStartAt)
    return point ? pointTotals(point, modelKey) : EMPTY_TOTALS
  }
  if (modelKey) return report.models.find((model) => model.key === modelKey)?.totals ?? EMPTY_TOTALS
  return report.totals
}

function CompactMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span className="usage-compact-metric">
      <span className="usage-compact-metric-label">{label}</span>
      <span className="usage-compact-metric-value">{value}</span>
    </span>
  )
}

function PrimaryMetrics({
  totals,
  className
}: {
  totals: UsageTotals
  className: string
}): React.JSX.Element {
  const rate = cacheRate(totals)
  return (
    <div className={className}>
      <CompactMetric label="输入" value={formatTokens(promptTokens(totals))} />
      <CompactMetric label="命中率" value={rate === null ? '—' : `${(rate * 100).toFixed(1)}%`} />
      <CompactMetric label="费用" value={formatCost(totals.cost)} />
    </div>
  )
}

function SessionChild({
  child,
  timeZone
}: {
  child: UsageSubagentSessionSnapshot
  timeZone: string
}): React.JSX.Element {
  return (
    <div className="usage-session-child">
      <div className="usage-session-child-head">
        <span className="usage-session-child-title">{child.title}</span>
        <div className="usage-filter-state">
          {child.agentType ? <PluginBadge tone="info">{child.agentType}</PluginBadge> : null}
          <PluginBadge tone="neutral">{formatTime(child.updatedAt, timeZone)}</PluginBadge>
        </div>
      </div>
      <PrimaryMetrics totals={child.totals} className="usage-session-child-metrics" />
      <div className="usage-session-secondary">
        <span>
          输出 <strong>{formatTokens(child.totals.output)}</strong>
        </span>
        <span>
          缓存读取 <strong>{formatTokens(child.totals.cacheRead)}</strong>
        </span>
      </div>
    </div>
  )
}

function SessionCard({
  session,
  timeZone,
  expanded,
  onToggle
}: {
  session: UsageSessionSnapshot
  timeZone: string
  expanded: boolean
  onToggle(): void
}): React.JSX.Element {
  const mainShare =
    promptTokens(session.totals) > 0
      ? promptTokens(session.mainTotals) / promptTokens(session.totals)
      : 0
  return (
    <article className="usage-session" data-usage-session={session.sessionId}>
      <button
        type="button"
        className="usage-session-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <div className="usage-session-head">
          <span className="usage-session-chevron">{expanded ? '▾' : '▸'}</span>
          <div className="usage-session-copy">
            <span className="usage-session-title">{session.title}</span>
            <span className="usage-session-path">{session.cwd}</span>
          </div>
          <PluginBadge tone="neutral">{formatTime(session.updatedAt, timeZone)}</PluginBadge>
        </div>
        <PrimaryMetrics totals={session.totals} className="usage-session-metrics" />
        <div className="usage-session-secondary">
          <span>
            主代理 <strong>{formatTokens(promptTokens(session.mainTotals))}</strong>（
            {(mainShare * 100).toFixed(0)}%）
          </span>
          <span>{session.subagents.length} 个子代理</span>
          <span>
            输出 <strong>{formatTokens(session.totals.output)}</strong>
          </span>
          <span>
            缓存读取 <strong>{formatTokens(session.totals.cacheRead)}</strong>
          </span>
        </div>
      </button>
      {expanded ? (
        <div className="usage-session-children">
          <div className="usage-session-child">
            <div className="usage-session-child-head">
              <span className="usage-session-child-title">主代理自身</span>
              <PluginBadge tone="neutral">main</PluginBadge>
            </div>
            <PrimaryMetrics totals={session.mainTotals} className="usage-session-child-metrics" />
          </div>
          {session.subagents.map((child) => (
            <SessionChild child={child} timeZone={timeZone} key={child.taskId} />
          ))}
        </div>
      ) : null}
    </article>
  )
}

type SelectedUsageWindow =
  | { kind: 'bucket'; startAt: number; endAt: number; date: string }
  | { kind: 'day'; startAt: number; endAt: number; date: string }
  | null

type CalendarLayout = 'month' | 'range'

const CALENDAR_METRICS: readonly [CalendarMetric, string][] = [
  ['prompt', '输入'],
  ['output', '输出'],
  ['cacheRead', '缓存'],
  ['cost', '费用']
]

function formatDayLabel(date: string): string {
  const [, month, day] = date.split('-')
  return `${Number(month)}月${Number(day)}日`
}

function formatRangeDayLabel(date: string): string {
  const [, month, day] = date.split('-')
  return `${month}/${day}`
}

function calendarMetricValue(day: UsageCalendarDay, metric: CalendarMetric): number {
  if (metric === 'prompt') return promptTokens(day.totals)
  if (metric === 'output') return day.totals.output
  if (metric === 'cacheRead') return day.totals.cacheRead
  return day.totals.cost
}

function calendarMetricText(value: number, metric: CalendarMetric): string {
  return metric === 'cost' ? formatCost(value) : formatTokens(value)
}

function UsageCalendar({
  title,
  layout,
  timeZone,
  monthKey,
  days,
  rangeEndAt,
  metric,
  selectedDate,
  linkedDate,
  onMetricChange,
  onSelect
}: {
  title: string
  layout: CalendarLayout
  timeZone: string
  monthKey: string
  days: readonly UsageCalendarDay[]
  rangeEndAt: number
  metric: CalendarMetric
  selectedDate: string | null
  linkedDate: string | null
  onMetricChange(metric: CalendarMetric): void
  onSelect(day: UsageCalendarDay): void
}): React.JSX.Element {
  const isMonth = layout === 'month'
  const leadingEmptyCount = isMonth ? monthWeekdayOffset(monthKey) : 0
  const trailingEmptyCount = isMonth ? (7 - ((leadingEmptyCount + days.length) % 7)) % 7 : 0
  const maximum = Math.max(0, ...days.map((day) => calendarMetricValue(day, metric)))

  return (
    <section className="usage-panel usage-calendar-panel" data-usage-calendar={layout}>
      <div className="usage-section-head">
        <span className="usage-section-title">
          {isMonth ? formatMonth(monthKey, timeZone) : title}
        </span>
        <div className="usage-calendar-metrics" aria-label="月历指标">
          {CALENDAR_METRICS.map(([value, label]) => (
            <PluginButton
              key={value}
              variant="ghost"
              size="sm"
              aria-pressed={metric === value}
              onClick={() => onMetricChange(value)}
            >
              {label}
            </PluginButton>
          ))}
        </div>
      </div>
      <div
        className={`usage-calendar ${isMonth ? 'usage-calendar-month' : 'usage-calendar-range'}`}
      >
        {isMonth
          ? (['一', '二', '三', '四', '五', '六', '日'] as const).map((weekday) => (
              <span className="usage-calendar-weekday" key={weekday}>
                {weekday}
              </span>
            ))
          : null}
        {isMonth
          ? Array.from({ length: leadingEmptyCount }, (_, index) => (
              <span className="usage-calendar-empty" aria-hidden="true" key={`leading-${index}`} />
            ))
          : null}
        {days.map((day) => {
          const value = calendarMetricValue(day, metric)
          const disabled = day.startAt >= rangeEndAt
          const level =
            disabled || value === 0 || maximum === 0
              ? 0
              : Math.max(1, Math.ceil((value / maximum) * 5))
          return (
            <button
              type="button"
              className="usage-calendar-day"
              data-usage-date={day.date}
              data-level={level}
              data-selected={selectedDate === day.date}
              data-linked={linkedDate === day.date && selectedDate !== day.date}
              disabled={disabled}
              aria-label={`${day.date} ${calendarMetricText(value, metric)}`}
              key={day.date}
              onClick={() => onSelect(day)}
            >
              <span className="usage-calendar-day-number">
                {isMonth ? Number(day.date.slice(-2)) : formatRangeDayLabel(day.date)}
              </span>
              <span className="usage-calendar-day-value">{calendarMetricText(value, metric)}</span>
            </button>
          )
        })}
        {isMonth
          ? Array.from({ length: trailingEmptyCount }, (_, index) => (
              <span className="usage-calendar-empty" aria-hidden="true" key={`trailing-${index}`} />
            ))
          : null}
      </div>
    </section>
  )
}

function UsageApplication({
  host,
  signal
}: {
  host: BrowserPluginHost
  signal: AbortSignal
}): React.JSX.Element {
  const timeZone = useUsageTimeZone(host)
  const [mode, setMode] = useState<RangeMode>('24h')
  return (
    <UsageDashboard
      key={timeZone}
      host={host}
      signal={signal}
      timeZone={timeZone}
      mode={mode}
      setMode={setMode}
    />
  )
}

function UsageDashboard({
  host,
  signal,
  timeZone,
  mode,
  setMode
}: {
  host: BrowserPluginHost
  signal: AbortSignal
  timeZone: string
  mode: RangeMode
  setMode: React.Dispatch<React.SetStateAction<RangeMode>>
}): React.JSX.Element {
  const [currentMonth] = useState(() => monthKeyAt(Date.now(), timeZone))
  const [viewMonth, setViewMonth] = useState(currentMonth)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [calendarMetric, setCalendarMetric] = useState<CalendarMetric>('prompt')
  const [selectedWindow, setSelectedWindow] = useState<SelectedUsageWindow>(null)
  const [report, setReport] = useState<UsageReportSnapshot | null>(null)
  const [reportLoading, setReportLoading] = useState(true)
  const [reportError, setReportError] = useState<string | null>(null)
  const [sessionPage, setSessionPage] = useState<UsageSessionPage | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set())
  const reportRequest = useRef(0)
  const sessionRequest = useRef(0)
  const sessionPageRef = useRef<UsageSessionPage | null>(null)
  const range = useMemo(() => rangeFor(mode, viewMonth, timeZone), [mode, viewMonth, timeZone])

  const loadReport = useCallback(
    async (force: boolean): Promise<void> => {
      const request = ++reportRequest.current
      setReportLoading(true)
      setReportError(null)
      try {
        const next = parseReport(
          await invoke(host, 'report-get', { startAt: range.startAt, endAt: range.endAt, force })
        )
        if (signal.aborted || request !== reportRequest.current) return
        setReport(next)
        setSelectedModel((current) =>
          current && !next.models.some((model) => model.key === current) ? null : current
        )
        setSelectedWindow((current) =>
          current?.kind === 'bucket' &&
          !next.series.some((point) => point.startAt === current.startAt)
            ? null
            : current
        )
      } catch (cause) {
        if (!signal.aborted && request === reportRequest.current)
          setReportError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!signal.aborted && request === reportRequest.current) setReportLoading(false)
      }
    },
    [host, range.endAt, range.startAt, signal]
  )

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void loadReport(false)
    })
    const dispose = host.connection.subscribe(() => {
      if (host.connection.getSnapshot().status === 'ready') void loadReport(false)
    })
    return () => {
      active = false
      reportRequest.current += 1
      void dispose()
    }
  }, [host, loadReport])

  const calendarLayout: CalendarLayout | null =
    mode === 'month' || mode === '7d' || mode === '30d'
      ? mode === 'month'
        ? 'month'
        : 'range'
      : null
  const calendarDays = useMemo(() => {
    if (!report || !calendarLayout) return []
    return calendarLayout === 'month'
      ? buildUsageCalendar(viewMonth, report.series, selectedModel, range.endAt, timeZone)
      : buildUsageCalendarRange(range.startAt, range.endAt, report.series, selectedModel, timeZone)
  }, [calendarLayout, range.endAt, range.startAt, report, selectedModel, viewMonth, timeZone])
  const selectedDay =
    selectedWindow?.kind === 'day'
      ? (calendarDays.find((day) => day.date === selectedWindow.date) ?? null)
      : null
  const sessionRange = selectedWindow
    ? { startAt: selectedWindow.startAt, endAt: selectedWindow.endAt }
    : range
  useEffect(() => {
    sessionPageRef.current = sessionPage
  }, [sessionPage])

  const loadSessions = useCallback(
    async (append: boolean): Promise<void> => {
      if (!report) return
      const request = ++sessionRequest.current
      const offset = append ? (sessionPageRef.current?.items.length ?? 0) : 0
      setSessionLoading(true)
      setSessionError(null)
      try {
        const next = parseSessions(
          await invoke(host, 'session-list', {
            startAt: sessionRange.startAt,
            endAt: sessionRange.endAt,
            ...(selectedModel ? { model: selectedModel } : {}),
            offset,
            limit: 30
          })
        )
        if (signal.aborted || request !== sessionRequest.current) return
        setSessionPage((current) =>
          append && current
            ? { ...next, offset: 0, items: [...current.items, ...next.items] }
            : next
        )
      } catch (cause) {
        if (!signal.aborted && request === sessionRequest.current)
          setSessionError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!signal.aborted && request === sessionRequest.current) setSessionLoading(false)
      }
    },
    [host, report, selectedModel, sessionRange.endAt, sessionRange.startAt, signal]
  )

  useEffect(() => {
    let active = true
    sessionRequest.current += 1
    queueMicrotask(() => {
      if (active && report) void loadSessions(false)
    })
    return () => {
      active = false
      sessionRequest.current += 1
    }
  }, [loadSessions, report, selectedModel, selectedWindow])

  const chooseRange = (next: RangeMode): void => {
    setReport(null)
    setSessionPage(null)
    setMode(next)
    setViewMonth(currentMonth)
    setSelectedWindow(null)
  }
  const changeMonth = (amount: number): void => {
    setReport(null)
    setSessionPage(null)
    setMode('month')
    setViewMonth((current) => addMonths(current, amount))
    setSelectedWindow(null)
  }
  const visibleTotals = report
    ? selectedDay
      ? selectedDay.totals
      : reportTotals(
          report,
          selectedWindow?.kind === 'bucket' ? selectedWindow.startAt : null,
          selectedModel
        )
    : EMPTY_TOTALS
  const selectedModelLabel = report?.models.find((model) => model.key === selectedModel)?.label
  const sessionItems = sessionPage?.items ?? []
  const hasMoreSessions = Boolean(sessionPage && sessionItems.length < sessionPage.total)
  const rate = cacheRate(visibleTotals)

  return (
    <PluginSurface className="usage-app" data-usage-application="">
      <style>{USAGE_STYLES}</style>
      <div className="usage-toolbar">
        <div className="usage-toolbar-actions">
          <div className="usage-range-group" aria-label="时间范围">
            {(
              [
                ['24h', '24 小时'],
                ['today', '今天'],
                ['7d', '7 天'],
                ['30d', '30 天'],
                ['month', '本月']
              ] as const
            ).map(([value, label]) => (
              <PluginButton
                key={value}
                variant="ghost"
                size="sm"
                aria-pressed={mode === value}
                onClick={() => chooseRange(value)}
              >
                {label}
              </PluginButton>
            ))}
          </div>
          {mode === 'month' ? (
            <div className="usage-month-controls">
              <PluginButton variant="ghost" aria-label="上个月" onClick={() => changeMonth(-1)}>
                ‹
              </PluginButton>
              <PluginBadge tone="neutral">{formatMonth(viewMonth, timeZone)}</PluginBadge>
              <PluginButton
                variant="ghost"
                aria-label="下个月"
                disabled={viewMonth >= currentMonth}
                onClick={() => changeMonth(1)}
              >
                ›
              </PluginButton>
            </div>
          ) : null}
          <PluginButton
            variant="secondary"
            disabled={reportLoading}
            onClick={() => void loadReport(true)}
          >
            {reportLoading ? '统计中…' : '刷新'}
          </PluginButton>
        </div>
      </div>
      {reportError ? <PluginAlert tone="error">{reportError}</PluginAlert> : null}
      {report?.skippedFiles ? (
        <PluginAlert tone="warning">
          有 {report.skippedFiles} 个 Session 文件包含无法读取的内容，当前结果已忽略对应部分。
        </PluginAlert>
      ) : null}
      <PluginScroll
        className="usage-body"
        viewportClassName="usage-body-viewport"
        aria-label="模型用量内容"
      >
        <div className="usage-summary">
          <div className="usage-kpis">
            {[
              ['输入总量', formatTokens(promptTokens(visibleTotals))],
              ['缓存命中率', rate === null ? '—' : `${(rate * 100).toFixed(1)}%`],
              ['费用', formatCost(visibleTotals.cost)]
            ].map(([label, value]) => (
              <div className="usage-kpi" key={label}>
                <span className="usage-kpi-value">{value}</span>
                <span className="usage-kpi-label">{label}</span>
              </div>
            ))}
          </div>
          <div className="usage-secondary-strip">
            <span>
              输出 <strong>{formatTokens(visibleTotals.output)}</strong>
            </span>
            <span>
              缓存读取 <strong>{formatTokens(visibleTotals.cacheRead)}</strong>
            </span>
            {selectedWindow ? (
              <PluginBadge tone="info">
                {selectedWindow.kind === 'day'
                  ? formatDayLabel(selectedWindow.date)
                  : '已筛选时间桶'}
              </PluginBadge>
            ) : null}
            {selectedModelLabel ? (
              <PluginBadge tone="neutral">{selectedModelLabel}</PluginBadge>
            ) : null}
          </div>
        </div>
        <section className="usage-panel usage-chart-panel">
          <div className="usage-section-head">
            <div className="usage-section-copy">
              <span className="usage-section-title">消耗趋势</span>
            </div>
            {selectedWindow !== null ? (
              <PluginButton
                variant="ghost"
                onClick={() => {
                  setSessionPage(null)
                  setSelectedWindow(null)
                }}
              >
                清除筛选
              </PluginButton>
            ) : null}
          </div>
          {reportLoading && !report ? (
            <PluginEmptyState>正在统计近期模型用量…</PluginEmptyState>
          ) : report ? (
            <UsageReportChart
              points={report.series}
              timeZone={timeZone}
              modelKey={selectedModel}
              selectedStartAt={selectedWindow?.kind === 'bucket' ? selectedWindow.startAt : null}
              selectedRange={selectedWindow?.kind === 'day' ? selectedWindow : null}
              onSelect={(point) => {
                setSessionPage(null)
                setSelectedWindow((current) =>
                  current?.kind === 'bucket' && current.startAt === point.startAt
                    ? null
                    : {
                        kind: 'bucket',
                        startAt: point.startAt,
                        endAt: point.endAt,
                        date: dateKeyAt(point.startAt, timeZone)
                      }
                )
              }}
            />
          ) : null}
        </section>
        {calendarLayout && report ? (
          <UsageCalendar
            title={mode === '7d' ? '7 天' : mode === '30d' ? '30 天' : ''}
            layout={calendarLayout}
            timeZone={timeZone}
            monthKey={viewMonth}
            days={calendarDays}
            rangeEndAt={range.endAt}
            metric={calendarMetric}
            selectedDate={selectedWindow?.kind === 'day' ? selectedWindow.date : null}
            linkedDate={selectedWindow?.kind === 'bucket' ? selectedWindow.date : null}
            onMetricChange={setCalendarMetric}
            onSelect={(day) => {
              setSessionPage(null)
              setSelectedWindow((current) =>
                current?.kind === 'day' && current.date === day.date
                  ? null
                  : { kind: 'day', startAt: day.startAt, endAt: day.endAt, date: day.date }
              )
            }}
          />
        ) : null}
        <div className="usage-lower">
          <section className="usage-panel">
            <div className="usage-section-head">
              <div className="usage-section-copy">
                <span className="usage-section-title">Session 用量</span>
              </div>
              <div className="usage-filter-state">
                {selectedModelLabel ? (
                  <PluginBadge tone="info">{selectedModelLabel}</PluginBadge>
                ) : null}
              </div>
            </div>
            {sessionError ? <PluginAlert tone="error">{sessionError}</PluginAlert> : null}
            {sessionLoading && sessionItems.length === 0 ? (
              <PluginEmptyState>正在读取 Session 用量…</PluginEmptyState>
            ) : sessionItems.length === 0 ? (
              <PluginEmptyState>当前筛选范围内没有 Session</PluginEmptyState>
            ) : (
              <div className="usage-sessions">
                {sessionItems.map((session) => (
                  <SessionCard
                    session={session}
                    timeZone={timeZone}
                    expanded={expandedSessions.has(session.sessionId)}
                    onToggle={() =>
                      setExpandedSessions((current) => {
                        const next = new Set(current)
                        if (next.has(session.sessionId)) next.delete(session.sessionId)
                        else next.add(session.sessionId)
                        return next
                      })
                    }
                    key={session.sessionId}
                  />
                ))}
                {hasMoreSessions ? (
                  <PluginButton
                    className="usage-load-more"
                    variant="secondary"
                    disabled={sessionLoading}
                    onClick={() => void loadSessions(true)}
                  >
                    {sessionLoading
                      ? '加载中…'
                      : `加载更多（${sessionItems.length}/${sessionPage?.total}）`}
                  </PluginButton>
                ) : null}
              </div>
            )}
          </section>
          <section className="usage-panel">
            <div className="usage-section-head">
              <div className="usage-section-copy">
                <span className="usage-section-title">模型用量</span>
              </div>
              {selectedModel ? (
                <PluginButton
                  variant="ghost"
                  onClick={() => {
                    setSessionPage(null)
                    setSelectedModel(null)
                  }}
                >
                  清除
                </PluginButton>
              ) : null}
            </div>
            {report?.models.length ? (
              <div className="usage-model-list">
                {report.models.map((model: UsageModelSnapshot) => {
                  const modelRate = cacheRate(model.totals)
                  return (
                    <button
                      type="button"
                      className="usage-model"
                      data-selected={selectedModel === model.key}
                      key={model.key}
                      onClick={() => {
                        setSessionPage(null)
                        setSelectedModel((current) => (current === model.key ? null : model.key))
                      }}
                    >
                      <span className="usage-model-copy">
                        <span className="usage-model-name" title={model.label}>
                          {model.label}
                        </span>
                        <span className="usage-model-detail">
                          {model.calls} 次 · 输出 {formatTokens(model.totals.output)} · 缓存{' '}
                          {formatTokens(model.totals.cacheRead)}
                        </span>
                      </span>
                      <CompactMetric
                        label="输入"
                        value={formatTokens(promptTokens(model.totals))}
                      />
                      <CompactMetric
                        label="命中率"
                        value={modelRate === null ? '—' : `${(modelRate * 100).toFixed(1)}%`}
                      />
                      <CompactMetric label="费用" value={formatCost(model.totals.cost)} />
                    </button>
                  )
                })}
              </div>
            ) : (
              <PluginEmptyState>当前范围内没有模型用量</PluginEmptyState>
            )}
          </section>
        </div>
      </PluginScroll>
    </PluginSurface>
  )
}

const implementation: BrowserApplicationImplementation = {
  mount({ container, host, signal }) {
    return renderReact(container, <UsageApplication host={host} signal={signal} />)
  }
}

export default implementation
