export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export interface UsageModelSnapshot {
  key: string
  provider: string | null
  model: string | null
  label: string
  calls: number
  totals: UsageTotals
}

export interface UsageSeriesPoint {
  startAt: number
  endAt: number
  totals: UsageTotals
  models: UsageModelSnapshot[]
}

export interface UsageReportSnapshot {
  generatedAt: number
  startAt: number
  endAt: number
  bucketMs: number
  totals: UsageTotals
  series: UsageSeriesPoint[]
  models: UsageModelSnapshot[]
  skippedFiles: number
}

export interface UsageSubagentSessionSnapshot {
  sessionId: string
  taskId: string
  title: string
  agentType: string | null
  startedAt: number
  updatedAt: number
  totals: UsageTotals
  models: UsageModelSnapshot[]
}

export interface UsageSessionSnapshot {
  sessionId: string
  cwd: string
  title: string
  startedAt: number
  updatedAt: number
  totals: UsageTotals
  mainTotals: UsageTotals
  models: UsageModelSnapshot[]
  subagents: UsageSubagentSessionSnapshot[]
}

export interface UsageSessionPage {
  total: number
  offset: number
  limit: number
  items: UsageSessionSnapshot[]
}

export interface UsageStructureCounts {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  compactions: number
  branchSummaries: number
}

export type UsageAnalysisCallKind =
  'assistant' | 'tool-result' | 'compaction' | 'branch-summary' | 'cache-warm' | 'usage'

export interface UsageAnalysisCall {
  timestamp: number
  sourceKey: string
  kind: UsageAnalysisCallKind
  modelKey: string
  requestedModel: string | null
  actualModel: string
  totals: UsageTotals
}

interface UsageAnalysisSourceBase {
  key: string
  kind: 'main' | 'subagent'
  title: string
  startedAt: number
  updatedAt: number
  totals: UsageTotals
  models: UsageModelSnapshot[]
  counts: UsageStructureCounts
  error: string | null
}

export interface UsageMainAnalysisSource extends UsageAnalysisSourceBase {
  key: 'main'
  kind: 'main'
}

export interface UsageSubagentAnalysisSource extends UsageAnalysisSourceBase {
  kind: 'subagent'
  taskId: string
  agentType: string
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  runCount: number
}

export type UsageAnalysisSource = UsageMainAnalysisSource | UsageSubagentAnalysisSource

export interface UsageSessionAnalysisSnapshot {
  generatedAt: number
  session: {
    sessionId: string
    title: string
    cwd: string
    startedAt: number
    updatedAt: number
  }
  inherited: UsageTotals | null
  sources: UsageAnalysisSource[]
  recentCalls: UsageAnalysisCall[]
}

export interface UsageTimelinePoint {
  at: number
  prompt: number
  cacheRead: number
}

export interface UsageTimelineRun {
  startAt: number
  endAt: number | null
}

export interface UsageTimelineSourceSnapshot {
  key: string
  kind: 'main' | 'subagent'
  title: string
  agentType: string | null
  calls: number
  segments: UsageTimelinePoint[][]
  runs: UsageTimelineRun[]
}

export interface UsageTimelineBucketSource {
  sourceKey: string
  totals: UsageTotals
  calls: number
}

export interface UsageTimelineBucket {
  startAt: number
  endAt: number
  totals: UsageTotals
  calls: number
  sources: UsageTimelineBucketSource[]
}

export type UsageActivityKind = 'model' | 'tool' | 'subagent-run' | 'context-ignore' | 'compaction'

export interface UsageActivity {
  id: string
  timestamp: number
  endAt: number | null
  sourceKey: string
  kind: UsageActivityKind
  label: string
  detail: string | null
  status: 'completed' | 'failed' | 'running' | null
  totals: UsageTotals | null
}

export type UsageTimelineMarkerKind = 'context-ignore' | 'compaction'
export type UsageTimelineIgnoreMode = 'user-turns' | 'internal-turns' | 'combined'

export interface UsageTimelineMarker {
  x: number
  sourceKey: string
  kind: UsageTimelineMarkerKind
  timestamp: number
  mode: UsageTimelineIgnoreMode | null
  beforePrompt: number | null
  projectedPrompt: number | null
  afterPrompt: number | null
  tokensBefore: number | null
}

export interface UsageSessionTimelineSnapshot {
  generatedAt: number
  startAt: number
  endAt: number
  bucketMs: number
  totalCalls: number
  displayedPoints: number
  sampled: boolean
  buckets: UsageTimelineBucket[]
  sources: UsageTimelineSourceSnapshot[]
  markers: UsageTimelineMarker[]
  activities: UsageActivity[]
}

export interface UsageSessionActivityPage {
  startAt: number
  endAt: number
  total: number
  offset: number
  limit: number
  items: UsageActivity[]
}
