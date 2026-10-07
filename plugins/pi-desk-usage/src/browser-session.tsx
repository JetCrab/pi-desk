import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrowserComposerPanelTarget,
  BrowserPluginHost,
  PluginJsonObject
} from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginAlert,
  PluginBadge,
  PluginButton,
  PluginEmptyState,
  PluginScroll,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'
import {
  ActivityTimeline,
  ContextTimelineChart,
  UsageTrendChart,
  usageTimelineSourceColor,
  type TimelineMetric
} from './browser-session-timeline.js'
import { formatTokens } from './l4-usage-format.js'
import { useUsageTimeZone } from './browser-settings.js'
import type {
  UsageActivity,
  UsageAnalysisSource,
  UsageSessionActivityPage,
  UsageSessionAnalysisSnapshot,
  UsageSessionTimelineSnapshot,
  UsageTimelineBucket,
  UsageTotals
} from './protocol.js'

const EMPTY_TOTALS: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }

type AnalysisTab = 'trend' | 'agents' | 'events'

const SESSION_ANALYSIS_STYLES = `
.usage-session-analysis{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--pi-desk-plugin-background,var(--background));color:var(--pi-desk-plugin-foreground,var(--foreground))}.usage-profiler-toolbar,.usage-profiler-tabs,.usage-profiler-actions,.usage-profiler-summary,.usage-profiler-controls,.usage-profiler-source-filters,.usage-profiler-chart-head,.usage-profiler-detail-head,.usage-profiler-detail-stats,.usage-profiler-agent-head,.usage-profiler-activity-head{display:flex;min-width:0;align-items:center;gap:.45rem}.usage-profiler-toolbar{flex:0 0 auto;justify-content:space-between;flex-wrap:wrap;border-bottom:1px solid var(--pi-desk-plugin-border,var(--border));padding:.52rem .68rem}.usage-profiler-tabs,.usage-profiler-actions,.usage-profiler-controls,.usage-profiler-source-filters{flex-wrap:wrap}.usage-profiler-body{min-height:0;flex:1}.usage-profiler-body-viewport{display:grid;align-content:start;min-height:0;gap:1.5rem;padding:1rem}.usage-profiler-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(7rem,1fr));gap:.75rem;border-bottom:1px solid var(--border);padding-bottom:1rem}.usage-profiler-kpi{display:grid;min-width:0;gap:.25rem}.usage-profiler-kpi strong{font-size:1.25rem;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums}.usage-profiler-kpi span{font-size:.75rem;color:var(--muted-foreground)}.usage-profiler-muted{font-size:.875rem;line-height:1.5;color:var(--muted-foreground);overflow-wrap:anywhere}.usage-profiler-controls{justify-content:space-between}.usage-profiler-control-group{display:flex;flex-wrap:wrap;gap:.25rem}.usage-profiler-range-actions{display:flex;gap:.28rem}.usage-profiler-source-filters{min-width:0;height:2.25rem}.usage-profiler-source-filters-viewport{display:flex;min-width:max-content;min-height:0;align-items:center;gap:.45rem;padding-bottom:.05rem}.usage-profiler-source-filter{max-width:16rem;flex:0 0 auto}.usage-profiler-source-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.usage-profiler-source-dot{width:.42rem;height:.42rem;flex:0 0 auto;border-radius:999px}.usage-profiler-chart,.usage-profiler-context,.usage-profiler-activity,.usage-profiler-detail,.usage-profiler-agent-list,.usage-profiler-event-list{display:grid;min-width:0;gap:.75rem;border-top:1px solid var(--border);padding:1rem 0}.usage-profiler-chart-head{justify-content:space-between;align-items:baseline}.usage-profiler-chart-head strong{font-size:.875rem;font-weight:600}.usage-profiler-selected-range{display:block;border-left:2px solid var(--pi-desk-plugin-primary,var(--primary));border-radius:.2rem;background:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 9%,transparent);padding:.25rem .4rem;color:var(--pi-desk-plugin-foreground,var(--foreground));font-size:.75rem;font-weight:500}.usage-profiler-chart-canvas{touch-action:pan-y}.usage-profiler-chart svg,.usage-profiler-context svg,.usage-profiler-activity svg{display:block;width:100%;height:auto;overflow:visible;touch-action:pan-y}.usage-profiler-grid,.usage-profiler-lane{stroke:var(--pi-desk-plugin-border,var(--border));stroke-width:1;opacity:.55;vector-effect:non-scaling-stroke}.usage-profiler-axis,.usage-profiler-lane-label{fill:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:12px}.usage-profiler-source-area{opacity:.13}.usage-profiler-total-area{fill:var(--pi-desk-plugin-muted,var(--muted));opacity:.7}.usage-profiler-source-line,.usage-profiler-context-line{fill:none;stroke-width:1.7;vector-effect:non-scaling-stroke}.usage-profiler-context-line[data-main="true"]{stroke-width:2.3}.usage-profiler-cursor{stroke:var(--pi-desk-plugin-foreground,var(--foreground));stroke-width:1;stroke-dasharray:3 3;opacity:.68;vector-effect:non-scaling-stroke}.usage-profiler-marker{stroke-width:1.25;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}.usage-profiler-marker[data-kind="context-ignore"]{stroke:var(--status-warning,var(--foreground))}.usage-profiler-marker[data-kind="compaction"]{stroke:#8b5cf6}.usage-profiler-run{opacity:.16}.usage-profiler-tool{opacity:.9}.usage-profiler-tool[data-running="true"]{stroke-dasharray:3 2;stroke:var(--pi-desk-plugin-foreground,var(--foreground));stroke-width:1}.usage-profiler-detail{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.usage-profiler-detail-selected{border:1px solid var(--ring);border-radius:.5rem;background:var(--muted);padding:.75rem}.usage-profiler-detail-head{justify-content:space-between;grid-column:1/-1}.usage-profiler-detail-head strong{font-size:.875rem;font-weight:600}.usage-profiler-detail-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.3rem}.usage-profiler-detail-stat{display:grid;gap:.02rem}.usage-profiler-detail-stat span{font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.usage-profiler-detail-stat strong{font-size:.875rem;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.usage-profiler-detail-sources,.usage-profiler-detail-activities{display:grid;gap:.26rem}.usage-profiler-detail-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:.35rem;align-items:baseline;border-top:1px solid color-mix(in srgb,var(--pi-desk-plugin-border,var(--border)) 60%,transparent);padding-top:.5rem;font-size:.875rem}.usage-profiler-detail-row span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.usage-profiler-activity-row{display:grid;gap:.05rem;border-top:1px solid color-mix(in srgb,var(--pi-desk-plugin-border,var(--border)) 60%,transparent);padding-top:.3rem}.usage-profiler-activity-head{justify-content:space-between;gap:.5rem;font-size:.75rem}.usage-profiler-activity-head strong{font-size:.875rem;font-weight:500}.usage-profiler-activity-head span{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.usage-profiler-agent-list{gap:0;padding:0}.usage-profiler-agent{display:grid;gap:.3rem;border-bottom:1px solid var(--pi-desk-plugin-border,var(--border));padding:.48rem .54rem}.usage-profiler-agent:last-child{border-bottom:0}.usage-profiler-agent-head{justify-content:space-between;align-items:flex-start}.usage-profiler-agent-name{display:flex;min-width:0;align-items:center;gap:.5rem;font-size:.875rem;font-weight:500}.usage-profiler-agent-name span:last-child{min-width:0;overflow-wrap:anywhere}.usage-profiler-agent-meta{display:flex;flex-wrap:wrap;gap:.5rem;font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.usage-profiler-agent-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.3rem}.usage-profiler-agent-metric{display:grid;gap:.02rem}.usage-profiler-agent-metric span{font-size:.75rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.usage-profiler-agent-metric strong{font-size:.875rem;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.usage-profiler-event-list{gap:0;padding:0}.usage-profiler-empty{padding:1.5rem 1rem;text-align:center;font-size:.875rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
@container (max-width:40rem){.usage-profiler-detail{grid-template-columns:minmax(0,1fr)}.usage-profiler-detail-head{grid-column:auto}.usage-profiler-agent-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.usage-profiler-controls{align-items:flex-start;flex-wrap:wrap}.usage-profiler-chart-head,.usage-profiler-detail-head{flex-wrap:wrap}}
`

function parseSnapshot(value: PluginJsonObject): UsageSessionAnalysisSnapshot {
  return JSON.parse(JSON.stringify(value)) as UsageSessionAnalysisSnapshot
}

function parseTimeline(value: PluginJsonObject): UsageSessionTimelineSnapshot {
  return JSON.parse(JSON.stringify(value)) as UsageSessionTimelineSnapshot
}

function parseActivities(value: PluginJsonObject): UsageSessionActivityPage {
  return JSON.parse(JSON.stringify(value)) as UsageSessionActivityPage
}

function promptTokens(totals: UsageTotals): number {
  return totals.input + totals.cacheRead + totals.cacheWrite
}

function totalTokens(totals: UsageTotals): number {
  return promptTokens(totals) + totals.output
}

function cacheRate(totals: UsageTotals): number | null {
  const input = promptTokens(totals)
  return input > 0 ? totals.cacheRead / input : null
}

function addTotals(target: UsageTotals, value: UsageTotals): void {
  target.input += value.input
  target.output += value.output
  target.cacheRead += value.cacheRead
  target.cacheWrite += value.cacheWrite
  target.cost += value.cost
}

function sourceTotals(sources: readonly UsageAnalysisSource[]): UsageTotals {
  const result = { ...EMPTY_TOTALS }
  for (const source of sources) addTotals(result, source.totals)
  return result
}

function formatCost(value: number): string {
  return value === 0 ? '$0' : `$${value.toFixed(value < 1 ? 4 : 2)}`
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

function formatDuration(startAt: number, endAt: number | null): string {
  const minutes = Math.max(0, Math.round(((endAt ?? Date.now()) - startAt) / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return hours < 24
    ? `${hours} 小时 ${minutes % 60} 分`
    : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

function metricLabel(metric: TimelineMetric): string {
  if (metric === 'tokens') return 'Token/分'
  if (metric === 'calls') return '调用/分'
  if (metric === 'cost') return '费用/分'
  return '命中率'
}

function activityLabel(activity: UsageActivity): string {
  if (activity.kind === 'model') return activity.detail ?? '模型调用'
  if (activity.kind === 'tool') return activity.label
  if (activity.kind === 'subagent-run') return '子代理运行'
  return activity.label
}

function selectedSources(
  snapshot: UsageSessionAnalysisSnapshot,
  keys: readonly string[]
): UsageAnalysisSource[] {
  return snapshot.sources.filter((source) => keys.includes(source.key))
}

function statusLabel(status: UsageActivity['status']): string | null {
  if (status === 'running') return '未记录结束'
  if (status === 'failed') return '失败'
  if (status === 'completed') return '完成'
  return null
}

export function SessionAnalysisPanel({
  target,
  host,
  signal
}: {
  target: BrowserComposerPanelTarget
  host: BrowserPluginHost
  signal: AbortSignal
}): React.JSX.Element {
  const timeZone = useUsageTimeZone(host)
  const [analysis, setAnalysis] = useState<UsageSessionAnalysisSnapshot | null>(null)
  const [timeline, setTimeline] = useState<UsageSessionTimelineSnapshot | null>(null)
  const [activities, setActivities] = useState<UsageSessionActivityPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [activityLoading, setActivityLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<AnalysisTab>('trend')
  const [metric, setMetric] = useState<TimelineMetric>('tokens')
  const [visibleSourceKeys, setVisibleSourceKeys] = useState<string[]>([])
  const [selectedBucketIndex, setSelectedBucketIndex] = useState<number | null>(null)
  const [range, setRange] = useState<{ startAt: number; endAt: number } | null>(null)
  const loadRequest = useRef(0)

  const input = useMemo(
    () => ({
      source: {
        workId: target.source.workId,
        sessionId: target.source.sessionId,
        branchId: target.source.branchId
      }
    }),
    [target.source]
  )

  const load = useCallback(async (): Promise<void> => {
    const request = ++loadRequest.current
    setLoading(true)
    setSelectedBucketIndex(null)
    setError(null)
    try {
      const timelineInput = range ? { ...input, ...range } : input
      const [nextAnalysis, nextTimeline] = await Promise.all([
        host.piDesk.invokeGlobal('session-analysis-get', input),
        host.piDesk.invokeGlobal('session-timeline-get', timelineInput)
      ])
      if (signal.aborted || request !== loadRequest.current) return
      const parsedAnalysis = parseSnapshot(nextAnalysis)
      const parsedTimeline = parseTimeline(nextTimeline)
      setAnalysis(parsedAnalysis)
      setTimeline(parsedTimeline)
      setActivities(null)
      setSelectedBucketIndex(null)
      setVisibleSourceKeys((current) =>
        current.filter((key) => parsedTimeline.sources.some((source) => source.key === key))
      )
    } catch (cause) {
      if (!signal.aborted && request === loadRequest.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!signal.aborted && request === loadRequest.current) setLoading(false)
    }
  }, [host, input, range, signal])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    const dispose = host.connection.subscribe(() => {
      if (host.connection.getSnapshot().status === 'ready') void load()
    })
    return () => {
      active = false
      loadRequest.current += 1
      void dispose()
    }
  }, [host, load, timeZone])

  const selectedBucket =
    timeline && selectedBucketIndex !== null
      ? (timeline.buckets[selectedBucketIndex] ?? null)
      : null
  const activityStartAt = selectedBucket?.startAt ?? timeline?.startAt ?? null
  const activityEndAt = selectedBucket?.endAt ?? timeline?.endAt ?? null

  useEffect(() => {
    if (activityStartAt === null || activityEndAt === null) return
    let active = true
    queueMicrotask(() => {
      if (!active || signal.aborted) return
      setActivityLoading(true)
      void host.piDesk
        .invokeGlobal('session-activity-get', {
          ...input,
          startAt: activityStartAt,
          endAt: activityEndAt,
          offset: 0,
          limit: 100
        })
        .then((result) => {
          if (active && !signal.aborted) setActivities(parseActivities(result))
        })
        .catch((cause) => {
          if (active && !signal.aborted)
            setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (active && !signal.aborted) setActivityLoading(false)
        })
    })
    return () => {
      active = false
    }
  }, [activityEndAt, activityStartAt, host, input, signal])

  const allVisible = timeline ? timeline.sources.map((source) => source.key) : []
  const effectiveVisibleSourceKeys = visibleSourceKeys.length > 0 ? visibleSourceKeys : allVisible
  const visibleAnalysisSources = analysis
    ? selectedSources(analysis, effectiveVisibleSourceKeys)
    : []
  const totals = analysis ? sourceTotals(analysis.sources) : EMPTY_TOTALS
  const zoom = (): void => {
    if (!timeline || !selectedBucket) return
    const startAt = Math.max(timeline.startAt, selectedBucket.startAt - timeline.bucketMs * 3)
    const endAt = Math.min(timeline.endAt, selectedBucket.endAt + timeline.bucketMs * 3)
    if (endAt - startAt > timeline.bucketMs) setRange({ startAt, endAt })
  }
  const toggleSource = (key: string): void => {
    setVisibleSourceKeys((current) => {
      const visible = current.length === 0 ? allVisible : current
      if (visible.includes(key)) {
        const next = visible.filter((item) => item !== key)
        return next.length === 0 ? [] : next
      }
      return [...visible, key]
    })
  }
  const trendDetail = (
    <TrendDetail
      bucket={selectedBucket}
      timeline={timeline!}
      sources={visibleAnalysisSources}
      activities={activities?.items ?? []}
      loading={activityLoading}
      timeZone={timeZone}
    />
  )

  return (
    <PluginSurface className="usage-session-analysis" data-usage-session-analysis="">
      <style>{SESSION_ANALYSIS_STYLES}</style>
      <div className="usage-profiler-toolbar">
        <div className="usage-profiler-tabs" aria-label="会话剖析视图">
          {(
            [
              ['trend', '趋势'],
              ['agents', '代理'],
              ['events', '事件']
            ] as const
          ).map(([value, label]) => (
            <PluginButton
              key={value}
              variant="ghost"
              size="sm"
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </PluginButton>
          ))}
        </div>
        <div className="usage-profiler-actions">
          <PluginButton variant="secondary" disabled={loading} onClick={() => void load()}>
            {loading ? '分析中…' : '刷新'}
          </PluginButton>
        </div>
      </div>
      <PluginScroll
        className="usage-profiler-body"
        viewportClassName="usage-profiler-body-viewport"
        aria-label="会话分析内容"
      >
        {error ? <PluginAlert tone="error">{error}</PluginAlert> : null}
        {analysis?.inherited ? (
          <PluginAlert tone="info">
            继承历史：{formatTokens(totalTokens(analysis.inherited))} Token、
            {formatCost(analysis.inherited.cost)}；未计入当前时间剖面。
          </PluginAlert>
        ) : null}
        {loading && !analysis ? (
          <PluginEmptyState>正在建立会话使用量、上下文和活动时间轴…</PluginEmptyState>
        ) : null}
        {!loading && !analysis ? (
          <PluginEmptyState>当前 Session 暂无可分析数据</PluginEmptyState>
        ) : null}
        {analysis && timeline ? (
          <>
            <div className="usage-profiler-summary">
              {[
                ['总 Token', formatTokens(totalTokens(totals))],
                ['费用', formatCost(totals.cost)],
                ['模型调用', String(timeline.totalCalls)],
                [
                  '缓存命中',
                  cacheRate(totals) === null ? '—' : `${(cacheRate(totals)! * 100).toFixed(1)}%`
                ],
                ['会话时长', formatDuration(timeline.startAt, timeline.endAt)]
              ].map(([label, value]) => (
                <span className="usage-profiler-kpi" key={label}>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </span>
              ))}
            </div>
            {tab === 'trend' ? (
              <>
                <div className="usage-profiler-controls">
                  <div className="usage-profiler-control-group" aria-label="趋势指标">
                    {(['tokens', 'calls', 'cost', 'cache'] as const).map((value) => (
                      <PluginButton
                        variant="ghost"
                        size="sm"
                        aria-pressed={metric === value}
                        data-active={metric === value}
                        key={value}
                        onClick={() => setMetric(value)}
                      >
                        {metricLabel(value)}
                      </PluginButton>
                    ))}
                  </div>
                  <div className="usage-profiler-range-actions">
                    {selectedBucket ? (
                      <PluginButton variant="ghost" size="sm" onClick={zoom}>
                        放大此段
                      </PluginButton>
                    ) : null}
                    {range ? (
                      <PluginButton variant="ghost" size="sm" onClick={() => setRange(null)}>
                        返回全会话
                      </PluginButton>
                    ) : null}
                  </div>
                </div>
                <PluginScroll
                  orientation="horizontal"
                  className="usage-profiler-source-filters"
                  viewportClassName="usage-profiler-source-filters-viewport"
                  aria-label="代理筛选"
                >
                  <PluginButton
                    variant="ghost"
                    size="sm"
                    className="usage-profiler-source-filter"
                    aria-pressed={visibleSourceKeys.length === 0}
                    data-active={visibleSourceKeys.length === 0}
                    onClick={() => setVisibleSourceKeys([])}
                  >
                    <span className="usage-profiler-source-dot" />
                    全部
                  </PluginButton>
                  {timeline.sources.map((source, index) => (
                    <PluginButton
                      variant="ghost"
                      size="sm"
                      className="usage-profiler-source-filter"
                      aria-pressed={effectiveVisibleSourceKeys.includes(source.key)}
                      data-active={effectiveVisibleSourceKeys.includes(source.key)}
                      title={source.title}
                      key={source.key}
                      onClick={() => toggleSource(source.key)}
                    >
                      <span
                        className="usage-profiler-source-dot"
                        style={{ background: usageTimelineSourceColor(source, index) }}
                      />
                      <span className="usage-profiler-source-name">
                        {source.kind === 'main' ? source.title : `代理 ${index} · ${source.title}`}
                      </span>
                    </PluginButton>
                  ))}
                </PluginScroll>
                <UsageTrendChart
                  snapshot={timeline}
                  timeZone={timeZone}
                  metric={metric}
                  visibleSourceKeys={effectiveVisibleSourceKeys}
                  selectedIndex={selectedBucketIndex}
                  onSelect={(index) => {
                    setActivities(null)
                    setActivityLoading(true)
                    setSelectedBucketIndex(index)
                  }}
                />
                {selectedBucket ? trendDetail : null}
                <ContextTimelineChart
                  snapshot={timeline}
                  visibleSourceKeys={effectiveVisibleSourceKeys}
                />
                <ActivityTimeline
                  snapshot={timeline}
                  visibleSourceKeys={effectiveVisibleSourceKeys}
                />
                {selectedBucket ? null : trendDetail}
              </>
            ) : null}
            {tab === 'agents' ? <AgentList sources={analysis.sources} timeline={timeline} /> : null}
            {tab === 'events' ? (
              <EventList
                items={activities?.items ?? []}
                sources={analysis.sources}
                loading={activityLoading}
                timeZone={timeZone}
              />
            ) : null}
          </>
        ) : null}
      </PluginScroll>
    </PluginSurface>
  )
}

function TrendDetail({
  bucket,
  timeline,
  sources,
  activities,
  loading,
  timeZone
}: {
  bucket: UsageTimelineBucket | null
  timeline: UsageSessionTimelineSnapshot
  sources: UsageAnalysisSource[]
  activities: UsageActivity[]
  loading: boolean
  timeZone: string
}): React.JSX.Element {
  const totals = bucket?.totals ?? sourceTotals(sources)
  const rangeStart = bucket?.startAt ?? timeline.startAt
  const rangeEnd = bucket?.endAt ?? timeline.endAt
  const bucketSources =
    bucket?.sources ??
    sources.map((source) => ({ sourceKey: source.key, totals: source.totals, calls: 0 }))
  const sourceMap = new Map(sources.map((source) => [source.key, source]))
  return (
    <section
      className={`usage-profiler-detail${bucket ? ' usage-profiler-detail-selected' : ''}`}
      aria-label="选中时间段详情"
      aria-live={bucket ? 'polite' : undefined}
      data-usage-selected={bucket ? 'true' : 'false'}
    >
      <div className="usage-profiler-detail-head">
        <strong>
          {formatTime(rangeStart, timeZone)} – {formatTime(rangeEnd, timeZone)}
        </strong>
        <span className="usage-profiler-muted">{bucket ? '选中时间段' : '全会话汇总'}</span>
      </div>
      <div className="usage-profiler-detail-stats">
        {[
          ['Token', formatTokens(totalTokens(totals))],
          ['调用', String(bucket?.calls ?? timeline.totalCalls)],
          [
            '命中率',
            cacheRate(totals) === null ? '—' : `${(cacheRate(totals)! * 100).toFixed(1)}%`
          ],
          ['费用', formatCost(totals.cost)],
          ['输入', formatTokens(promptTokens(totals))],
          ['输出', formatTokens(totals.output)]
        ].map(([label, value]) => (
          <span className="usage-profiler-detail-stat" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </span>
        ))}
      </div>
      <div className="usage-profiler-detail-sources">
        <strong className="usage-profiler-muted">来源</strong>
        {bucketSources
          .filter((item) => sources.some((source) => source.key === item.sourceKey))
          .map((item) => (
            <div className="usage-profiler-detail-row" key={item.sourceKey}>
              <span>
                {sourceMap.get(item.sourceKey)?.kind === 'main'
                  ? '主代理'
                  : (sourceMap.get(item.sourceKey)?.title ?? item.sourceKey)}
              </span>
              <strong>{formatTokens(totalTokens(item.totals))}</strong>
              <span>{formatCost(item.totals.cost)}</span>
            </div>
          ))}
      </div>
      <div className="usage-profiler-detail-activities">
        <strong className="usage-profiler-muted">主要活动</strong>
        {loading ? <span className="usage-profiler-muted">正在读取活动…</span> : null}
        {!loading && activities.length === 0 ? (
          <span className="usage-profiler-muted">该时段无可观测活动</span>
        ) : null}
        {activities.slice(0, 6).map((activity) => (
          <ActivityRow
            activity={activity}
            source={sourceMap.get(activity.sourceKey)}
            timeZone={timeZone}
            key={activity.id}
          />
        ))}
      </div>
    </section>
  )
}

function AgentList({
  sources,
  timeline
}: {
  sources: UsageAnalysisSource[]
  timeline: UsageSessionTimelineSnapshot
}): React.JSX.Element {
  const timelineSources = new Map(timeline.sources.map((source) => [source.key, source]))
  return (
    <section className="usage-profiler-agent-list" aria-label="代理使用量">
      {sources.map((source) => {
        const timelineSource = timelineSources.get(source.key)
        const duration =
          timelineSource?.runs.reduce(
            (total, run) => total + ((run.endAt ?? timeline.endAt) - run.startAt),
            0
          ) ?? 0
        return (
          <div className="usage-profiler-agent" key={source.key}>
            <div className="usage-profiler-agent-head">
              <div className="usage-profiler-agent-name">
                <span
                  className="usage-profiler-source-dot"
                  style={{
                    background: timelineSource
                      ? usageTimelineSourceColor(
                          timelineSource,
                          timeline.sources.indexOf(timelineSource)
                        )
                      : undefined
                  }}
                />
                <span>{source.kind === 'main' ? '主代理' : source.title}</span>
              </div>
              {source.kind === 'subagent' ? (
                <PluginBadge tone={source.status === 'failed' ? 'error' : 'neutral'}>
                  {source.status === 'running' ? '运行中' : source.status}
                </PluginBadge>
              ) : null}
            </div>
            <div className="usage-profiler-agent-meta">
              {source.kind === 'subagent' ? (
                <>
                  <span>{source.agentType}</span>
                  <span>{source.runCount} 次运行</span>
                </>
              ) : (
                <span>当前会话代理</span>
              )}
              <span>{formatDuration(source.startedAt, source.updatedAt)}</span>
            </div>
            <div className="usage-profiler-agent-metrics">
              {[
                ['Token', formatTokens(totalTokens(source.totals))],
                ['费用', formatCost(source.totals.cost)],
                ['调用', String(timelineSource?.calls ?? 0)],
                ['运行', formatDuration(0, duration)]
              ].map(([label, value]) => (
                <span className="usage-profiler-agent-metric" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </span>
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}

function EventList({
  items,
  sources,
  loading,
  timeZone
}: {
  items: UsageActivity[]
  sources: UsageAnalysisSource[]
  loading: boolean
  timeZone: string
}): React.JSX.Element {
  const sourceMap = new Map(sources.map((source) => [source.key, source]))
  if (loading) return <PluginEmptyState>正在读取活动…</PluginEmptyState>
  if (items.length === 0) return <PluginEmptyState>当前范围没有可观测活动</PluginEmptyState>
  return (
    <section className="usage-profiler-event-list" aria-label="会话活动列表">
      {items.map((activity) => (
        <ActivityRow
          activity={activity}
          source={sourceMap.get(activity.sourceKey)}
          timeZone={timeZone}
          key={activity.id}
        />
      ))}
    </section>
  )
}

function ActivityRow({
  activity,
  source,
  timeZone
}: {
  activity: UsageActivity
  source: UsageAnalysisSource | undefined
  timeZone: string
}): React.JSX.Element {
  const duration =
    activity.endAt === null ? null : formatDuration(activity.timestamp, activity.endAt)
  const detail = activity.kind === 'model' ? activity.label : activity.detail
  return (
    <div className="usage-profiler-activity-row">
      <div className="usage-profiler-activity-head">
        <strong>
          {formatTime(activity.timestamp, timeZone)} ·{' '}
          {source?.kind === 'main' ? '主代理' : (source?.title ?? activity.sourceKey)}
        </strong>
        <span>
          {activityLabel(activity)}
          {duration ? ` · ${duration}` : ''}
        </span>
      </div>
      {detail ? <span className="usage-profiler-muted">{detail}</span> : null}
      {activity.totals ? (
        <span className="usage-profiler-muted">
          {formatTokens(totalTokens(activity.totals))} Token · {formatCost(activity.totals.cost)}
        </span>
      ) : null}
      {statusLabel(activity.status) ? (
        <span className="usage-profiler-muted">{statusLabel(activity.status)}</span>
      ) : null}
    </div>
  )
}
