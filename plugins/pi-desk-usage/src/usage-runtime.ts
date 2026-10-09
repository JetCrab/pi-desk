import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent'
import type {
  PiDeskWorkSessionCapability,
  PluginJsonObject,
  PluginSource
} from '@jetcrab/pi-desk-sdk/entry'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import type { HostSettings } from '@jetcrab/pi-desk-sdk/settings'
import { usageBucketRanges, usageBucketIndex, zonedHourStart } from './l4-usage-calendar.js'
import { z } from 'zod'
import type {
  UsageAnalysisCall,
  UsageAnalysisSource,
  UsageModelSnapshot,
  UsageReportSnapshot,
  UsageSeriesPoint,
  UsageSessionActivityPage,
  UsageSessionAnalysisSnapshot,
  UsageSessionPage,
  UsageTimelineRun,
  UsageSessionSnapshot,
  UsageStructureCounts,
  UsageTotals
} from './protocol.js'
import type {
  ParsedUsageEvent,
  ParsedUsageFile,
  ParsedToolActivity,
  ParsedUsageMarker,
  UsageFileDescriptor,
  UsageFileScanResult
} from './usage-scan.js'
import {
  addTotals,
  aggregateEventModels,
  emptyStructureCounts,
  emptyTotals,
  hasUsage,
  promptTokens,
  totalEvents
} from './l4-usage-aggregate.js'
import {
  descriptor,
  listSessionCandidates,
  listStandardSessionFiles,
  nestedParentSessionId,
  pathKey
} from './l4-usage-files.js'
import {
  createUsageActivities,
  createUsageTimeline,
  type UsageTimelineSourceInput
} from './usage-timeline.js'

const HOUR_MS = 60 * 60 * 1000
const HALF_HOUR_MS = HOUR_MS / 2
const DAY_MS = 24 * HOUR_MS
const MAX_RANGE_MS = 370 * DAY_MS
const INDEX_REUSE_MS = 30_000
const CACHE_IDLE_MS = 30 * 60 * 1000
const MAX_SESSION_PAGE = 50

const reportInputSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    endAt: z.number().int().positive(),
    force: z.boolean().optional()
  })
  .strict()
const sessionListInputSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    endAt: z.number().int().positive(),
    model: z.string().trim().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(100_000),
    limit: z.number().int().min(1).max(MAX_SESSION_PAGE)
  })
  .strict()
const pluginSourceSchema = z
  .object({
    workId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    branchId: z.string().trim().min(1)
  })
  .strict()
const sessionAnalysisInputSchema = z.object({ source: pluginSourceSchema }).strict()
const sessionTimelineInputSchema = z
  .object({
    source: pluginSourceSchema,
    startAt: z.number().int().nonnegative().optional(),
    endAt: z.number().int().positive().optional()
  })
  .strict()
const sessionActivityInputSchema = z
  .object({
    source: pluginSourceSchema,
    startAt: z.number().int().nonnegative(),
    endAt: z.number().int().positive(),
    offset: z.number().int().min(0).max(100_000),
    limit: z.number().int().min(1).max(200)
  })
  .strict()

interface CacheEntry {
  descriptor: UsageFileDescriptor
  file: ParsedUsageFile
  lastAccessedAt: number
}

interface ChildMetadata {
  taskId: string
  agentType: string | null
  title: string
  parentSessionId: string | null
}

interface IndexedFile {
  cache: CacheEntry
  source: 'main' | 'subagent'
  child: ChildMetadata | null
}

interface OwnedUsageEvent {
  indexed: IndexedFile
  event: ParsedUsageEvent
}

interface LoadedSessionSource {
  key: string
  kind: 'main' | 'subagent'
  taskId: string | null
  title: string
  agentType: string | null
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | null
  runCount: number
  launches: number[]
  startedAt: number
  updatedAt: number
  events: ParsedUsageEvent[]
  markers: ParsedUsageMarker[]
  tools: ParsedToolActivity[]
  counts: UsageStructureCounts
  error: string | null
}

interface LoadedSessionDetails {
  main: CacheEntry
  inheritedEvents: ParsedUsageEvent[]
  sources: LoadedSessionSource[]
}

interface Coverage {
  startAt: number
  endAt: number
  checkedAt: number
}

interface UsageWorkerMessage {
  results?: UsageFileScanResult[]
  error?: string
}

interface UsageRuntimeOptions {
  sessionsRoot?: string
  workSessions?: PiDeskWorkSessionCapability
  settings?: HostSettings
  scanFiles?: (
    files: readonly UsageFileDescriptor[],
    signal: AbortSignal
  ) => Promise<UsageFileScanResult[]>
  logger?: Pick<Console, 'info' | 'warn'>
}

function defaultSessionsRoot(): string {
  const configuredSessions = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
  if (configuredSessions) return configuredSessions
  const configuredAgent = process.env.PI_CODING_AGENT_DIR?.trim()
  const agentDir = configuredAgent || join(homedir(), '.pi', 'agent')
  return join(agentDir, 'sessions')
}

function jsonObject(value: unknown): PluginJsonObject {
  return JSON.parse(JSON.stringify(value)) as PluginJsonObject
}

function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return '输入格式无效'
  const path = issue.path.length > 0 ? `${issue.path.join('.')}：` : ''
  return `${path}${issue.message}`
}

function parseInput<T>(schema: z.ZodType<T>, input: PluginJsonObject): T {
  try {
    return schema.parse(input)
  } catch (error) {
    if (error instanceof z.ZodError) throw new PluginMethodError(400, zodMessage(error))
    throw error
  }
}

function validateRange(startAt: number, endAt: number): void {
  if (endAt <= startAt) throw new PluginMethodError(400, 'endAt 必须晚于 startAt')
  if (endAt - startAt > MAX_RANGE_MS) {
    throw new PluginMethodError(400, '单次用量查询不能超过 370 天')
  }
}

function signature(descriptor: UsageFileDescriptor): string {
  return `${descriptor.size}:${descriptor.modifiedAt}`
}

function overlaps(file: ParsedUsageFile, startAt: number, endAt: number): boolean {
  return file.createdAt < endAt && file.updatedAt >= startAt
}

function seriesBucketMs(startAt: number, endAt: number, timeZone: string): number {
  const duration = endAt - startAt
  if (duration === DAY_MS && zonedHourStart(endAt, timeZone) === endAt) {
    return HALF_HOUR_MS
  }
  if (duration <= 48 * HOUR_MS) return HOUR_MS
  if (duration <= 10 * DAY_MS) return 6 * HOUR_MS
  return DAY_MS
}

function fileTitle(file: ParsedUsageFile): string {
  return file.name ?? file.firstMessage ?? basename(file.cwd) ?? file.sessionId
}

function aggregateModels(
  events: readonly OwnedUsageEvent[],
  modelNames: ReadonlyMap<string, string>
): UsageModelSnapshot[] {
  return aggregateEventModels(
    events.map((item) => item.event),
    modelNames
  )
}

function cloneCounts(counts: UsageStructureCounts): UsageStructureCounts {
  return { ...counts }
}

export class UsageRuntime {
  private readonly sessionsRoot: string
  private readonly scanFiles: (
    files: readonly UsageFileDescriptor[],
    signal: AbortSignal
  ) => Promise<UsageFileScanResult[]>
  private readonly logger: Pick<Console, 'info' | 'warn'>
  private readonly workSessions: PiDeskWorkSessionCapability | null
  private readonly settings: HostSettings | null
  private readonly cache = new Map<string, CacheEntry>()
  private operation: Promise<void> = Promise.resolve()
  private coverage: Coverage | null = null
  private skippedFiles = 0
  private activeWorker: Worker | null = null
  private disposed = false

  constructor(options: UsageRuntimeOptions = {}) {
    this.sessionsRoot = resolve(options.sessionsRoot ?? defaultSessionsRoot())
    this.scanFiles = options.scanFiles ?? ((files, signal) => this.scanWithWorker(files, signal))
    this.logger = options.logger ?? console
    this.workSessions = options.workSessions ?? null
    this.settings = options.settings ?? null
  }

  async report(input: PluginJsonObject, signal: AbortSignal): Promise<PluginJsonObject> {
    const parsed = parseInput(reportInputSchema, input)
    validateRange(parsed.startAt, parsed.endAt)
    await this.ensureIndexed(parsed.startAt, parsed.endAt, parsed.force === true, signal)
    const events = this.ownedEvents(parsed.startAt, parsed.endAt)
    const modelNames = await this.readModelNames()
    const timeZone = this.settings?.getSnapshot().region.timeZone ?? 'UTC'
    const bucketMs = seriesBucketMs(parsed.startAt, parsed.endAt, timeZone)
    const snapshot: UsageReportSnapshot = {
      generatedAt: Date.now(),
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      bucketMs,
      totals: this.total(events),
      series: this.series(events, parsed.startAt, parsed.endAt, bucketMs, modelNames, timeZone),
      models: aggregateModels(events, modelNames),
      skippedFiles: this.skippedFiles
    }
    return jsonObject(snapshot)
  }

  async sessions(input: PluginJsonObject, signal: AbortSignal): Promise<PluginJsonObject> {
    const parsed = parseInput(sessionListInputSchema, input)
    validateRange(parsed.startAt, parsed.endAt)
    await this.ensureIndexed(parsed.startAt, parsed.endAt, false, signal)
    const events = this.ownedEvents(parsed.startAt, parsed.endAt).filter(
      (item) => !parsed.model || item.event.modelKey === parsed.model
    )
    const modelNames = await this.readModelNames()
    const sessions = this.sessionSnapshots(events, modelNames).sort(
      (left, right) =>
        promptTokens(right.totals) - promptTokens(left.totals) || right.updatedAt - left.updatedAt
    )
    const page: UsageSessionPage = {
      total: sessions.length,
      offset: parsed.offset,
      limit: parsed.limit,
      items: sessions.slice(parsed.offset, parsed.offset + parsed.limit)
    }
    return jsonObject(page)
  }

  async sessionAnalysis(input: PluginJsonObject, signal: AbortSignal): Promise<PluginJsonObject> {
    const parsed = parseInput(sessionAnalysisInputSchema, input)
    const workSession = await this.requireWorkSession(parsed.source)
    const snapshot = await this.runExclusive(async () => {
      if (this.disposed) throw new PluginMethodError(409, '用量 Runtime 已关闭')
      if (signal.aborted) throw new PluginMethodError(409, '会话分析已取消')
      const details = await this.loadSessionDetails(workSession, signal)
      const modelNames = await this.readModelNames()
      const sources: UsageAnalysisSource[] = details.sources.map((source) =>
        source.kind === 'main'
          ? {
              key: 'main',
              kind: 'main',
              title: source.title,
              startedAt: source.startedAt,
              updatedAt: source.updatedAt,
              totals: totalEvents(source.events),
              models: aggregateEventModels(source.events, modelNames),
              counts: cloneCounts(source.counts),
              error: source.error
            }
          : {
              key: source.key,
              kind: 'subagent',
              taskId: source.taskId!,
              title: source.title,
              agentType: source.agentType ?? 'subagent',
              status: source.status ?? 'running',
              runCount: source.runCount,
              startedAt: source.startedAt,
              updatedAt: source.updatedAt,
              totals: totalEvents(source.events),
              models: aggregateEventModels(source.events, modelNames),
              counts: cloneCounts(source.counts),
              error: source.error
            }
      )
      const calls = details.sources
        .flatMap((source) =>
          source.events.map((event) => this.analysisCall(event, source.key, modelNames))
        )
        .sort((left, right) => right.timestamp - left.timestamp)
        .slice(0, 30)
      const inheritedTotals = totalEvents(details.inheritedEvents)
      const analysis: UsageSessionAnalysisSnapshot = {
        generatedAt: Date.now(),
        session: {
          sessionId: details.main.file.sessionId,
          title: details.sources[0]!.title,
          cwd: details.main.file.cwd,
          startedAt: details.main.file.createdAt,
          updatedAt: Math.max(...details.sources.map((source) => source.updatedAt))
        },
        inherited: hasUsage(inheritedTotals) ? inheritedTotals : null,
        sources,
        recentCalls: calls
      }
      return analysis
    })
    await this.requireWorkSession(parsed.source)
    return jsonObject(snapshot)
  }

  async sessionTimeline(input: PluginJsonObject, signal: AbortSignal): Promise<PluginJsonObject> {
    const parsed = parseInput(sessionTimelineInputSchema, input)
    if ((parsed.startAt === undefined) !== (parsed.endAt === undefined)) {
      throw new PluginMethodError(400, 'startAt 和 endAt 必须同时提供')
    }
    if (parsed.startAt !== undefined && parsed.endAt !== undefined) {
      validateRange(parsed.startAt, parsed.endAt)
    }
    const workSession = await this.requireWorkSession(parsed.source)
    const snapshot = await this.runExclusive(async () => {
      if (this.disposed) throw new PluginMethodError(409, '用量 Runtime 已关闭')
      if (signal.aborted) throw new PluginMethodError(409, '会话时间轴已取消')
      const details = await this.loadSessionDetails(workSession, signal)
      return createUsageTimeline(
        this.timelineInputs(details),
        parsed.startAt,
        parsed.endAt,
        this.settings?.getSnapshot().region.timeZone ?? 'UTC'
      )
    })
    await this.requireWorkSession(parsed.source)
    return jsonObject(snapshot)
  }

  async sessionActivities(input: PluginJsonObject, signal: AbortSignal): Promise<PluginJsonObject> {
    const parsed = parseInput(sessionActivityInputSchema, input)
    validateRange(parsed.startAt, parsed.endAt)
    const workSession = await this.requireWorkSession(parsed.source)
    const snapshot = await this.runExclusive(async () => {
      if (this.disposed) throw new PluginMethodError(409, '会话活动查询已关闭')
      if (signal.aborted) throw new PluginMethodError(409, '会话活动查询已取消')
      const details = await this.loadSessionDetails(workSession, signal)
      const modelNames = await this.readModelNames()
      const activities = createUsageActivities(
        this.timelineInputs(details),
        parsed.startAt,
        parsed.endAt
      )
        .map((activity) =>
          activity.kind === 'model'
            ? { ...activity, label: modelNames.get(activity.label) || activity.label }
            : activity
        )
        .sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id))
      const page: UsageSessionActivityPage = {
        startAt: parsed.startAt,
        endAt: parsed.endAt,
        total: activities.length,
        offset: parsed.offset,
        limit: parsed.limit,
        items: activities.slice(parsed.offset, parsed.offset + parsed.limit)
      }
      return page
    })
    await this.requireWorkSession(parsed.source)
    return jsonObject(snapshot)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const worker = this.activeWorker
    this.activeWorker = null
    if (worker) await worker.terminate()
    await this.operation.catch(() => undefined)
    this.cache.clear()
    this.coverage = null
  }

  private async readModelNames(): Promise<ReadonlyMap<string, string>> {
    const agentDir = getAgentDir()
    const models = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json')
    })
    return new Map(
      models
        .getModels()
        .map((model) => [
          `${model.provider}/${model.id}`,
          `${model.provider}/${model.name || model.id}`
        ])
    )
  }

  private total(events: readonly OwnedUsageEvent[]): UsageTotals {
    const totals = emptyTotals()
    for (const item of events) addTotals(totals, item.event.totals)
    return totals
  }

  private series(
    events: readonly OwnedUsageEvent[],
    startAt: number,
    endAt: number,
    bucketMs: number,
    modelNames: ReadonlyMap<string, string>,
    timeZone: string
  ): UsageSeriesPoint[] {
    const buckets = usageBucketRanges(startAt, endAt, bucketMs, timeZone).map((range) => ({
      ...range,
      items: [] as OwnedUsageEvent[]
    }))
    for (const item of events) {
      buckets[usageBucketIndex(buckets, item.event.timestamp)]!.items.push(item)
    }
    return buckets.map((bucket) => ({
      startAt: bucket.startAt,
      endAt: bucket.endAt,
      totals: this.total(bucket.items),
      models: aggregateModels(bucket.items, modelNames)
    }))
  }

  private sessionSnapshots(
    events: readonly OwnedUsageEvent[],
    modelNames: ReadonlyMap<string, string>
  ): UsageSessionSnapshot[] {
    interface SessionGroup {
      sessionId: string
      main: IndexedFile | null
      mainItems: OwnedUsageEvent[]
      children: Map<string, OwnedUsageEvent[]>
    }

    const indexedFiles = this.indexedFiles()
    const mainsBySessionId = new Map(
      indexedFiles
        .filter((indexed) => indexed.source === 'main')
        .map((indexed) => [indexed.cache.file.sessionId, indexed])
    )
    const groups = new Map<string, SessionGroup>()
    for (const item of events) {
      const file = item.indexed.cache.file
      const parentFromPath = file.parentSessionPath
        ? this.cache.get(pathKey(file.parentSessionPath))?.file.sessionId
        : null
      const sessionId =
        item.indexed.source === 'main'
          ? file.sessionId
          : (item.indexed.child?.parentSessionId ?? parentFromPath ?? file.sessionId)
      let group = groups.get(sessionId)
      if (!group) {
        group = {
          sessionId,
          main: mainsBySessionId.get(sessionId) ?? null,
          mainItems: [],
          children: new Map()
        }
        groups.set(sessionId, group)
      }
      if (item.indexed.source === 'main') {
        group.main = item.indexed
        group.mainItems.push(item)
      } else {
        const taskId = item.indexed.child?.taskId ?? file.sessionId
        const childItems = group.children.get(taskId) ?? []
        childItems.push(item)
        group.children.set(taskId, childItems)
      }
    }

    return [...groups.values()].map((group) => {
      const childItems = [...group.children.values()]
      const allItems = [...group.mainItems, ...childItems.flat()]
      const fallback = allItems[0]!.indexed.cache.file
      const mainFile = group.main?.cache.file ?? null
      const subagents = childItems
        .map((items) => {
          const indexed = items[0]!.indexed
          const file = indexed.cache.file
          return {
            sessionId: file.sessionId,
            taskId: indexed.child?.taskId ?? file.sessionId,
            title: indexed.child?.title ?? fileTitle(file),
            agentType: indexed.child?.agentType ?? null,
            startedAt: Math.min(file.createdAt, ...items.map((item) => item.event.timestamp)),
            updatedAt: Math.max(...items.map((item) => item.event.timestamp)),
            totals: this.total(items),
            models: aggregateModels(items, modelNames)
          }
        })
        .sort(
          (left, right) =>
            promptTokens(right.totals) - promptTokens(left.totals) ||
            right.updatedAt - left.updatedAt
        )
      return {
        sessionId: group.sessionId,
        cwd: mainFile?.cwd ?? fallback.cwd,
        title: mainFile ? fileTitle(mainFile) : fileTitle(fallback),
        startedAt: Math.min(
          mainFile?.createdAt ?? Number.POSITIVE_INFINITY,
          ...allItems.map((item) => item.indexed.cache.file.createdAt)
        ),
        updatedAt: Math.max(...allItems.map((item) => item.event.timestamp)),
        totals: this.total(allItems),
        mainTotals: this.total(group.mainItems),
        models: aggregateModels(allItems, modelNames),
        subagents
      }
    })
  }

  private async loadSessionDetails(
    workSession: { source: PluginSource; cwd: string },
    signal: AbortSignal
  ): Promise<LoadedSessionDetails> {
    const main = await this.loadSessionById(workSession.source.sessionId, workSession.cwd, signal)

    const parent = main.file.parentSessionPath
      ? await this.loadExactFile(main.file.parentSessionPath, false, signal)
      : null
    const inheritedEventIds = new Set(parent?.file.events.map((event) => event.identity) ?? [])
    const inheritedMarkerIds = new Set(parent?.file.markers.map((marker) => marker.identity) ?? [])
    const inheritedLaunchIds = new Set(
      parent?.file.childSessions.map((child) => child.identity) ?? []
    )
    const inheritedToolIds = new Set(parent?.file.tools.map((tool) => tool.identity) ?? [])
    const inheritedEvents = main.file.events.filter((event) =>
      inheritedEventIds.has(event.identity)
    )
    const mainEvents = main.file.events.filter((event) => !inheritedEventIds.has(event.identity))
    const mainMarkers = main.file.markers.filter(
      (marker) => !inheritedMarkerIds.has(marker.identity)
    )
    const mainTools = main.file.tools.filter((tool) => !inheritedToolIds.has(tool.identity))
    const mainTitle = fileTitle(main.file)
    const sources: LoadedSessionSource[] = [
      {
        key: 'main',
        kind: 'main',
        taskId: null,
        title: mainTitle,
        agentType: null,
        status: null,
        runCount: 1,
        launches: [main.file.createdAt],
        startedAt: main.file.createdAt,
        updatedAt: Math.max(
          main.file.createdAt,
          ...mainEvents.map((event) => event.timestamp),
          ...mainMarkers.map((marker) => marker.timestamp)
        ),
        events: mainEvents,
        markers: mainMarkers,
        tools: mainTools,
        counts: cloneCounts(main.file.counts),
        error: null
      }
    ]

    const launchesByTask = new Map<string, typeof main.file.childSessions>()
    for (const launch of main.file.childSessions) {
      if (inheritedLaunchIds.has(launch.identity)) continue
      const launches = launchesByTask.get(launch.taskId) ?? []
      launches.push(launch)
      launchesByTask.set(launch.taskId, launches)
    }

    const childFiles = new Map<string, UsageFileDescriptor>()
    for (const launches of launchesByTask.values()) {
      launches.sort((left, right) => left.startedAt - right.startedAt)
      const latestLaunch = launches.at(-1)!
      const key = pathKey(latestLaunch.sessionFile)
      if (childFiles.has(key)) continue
      const file = await descriptor(latestLaunch.sessionFile, true)
      if (file) childFiles.set(key, file)
    }
    await this.loadChanged([...childFiles.values()], signal)

    for (const [taskId, orderedLaunches] of launchesByTask) {
      const latestLaunch = orderedLaunches.at(-1)!
      const latestTerminal = main.file.childTerminals
        .filter((terminal) => terminal.taskId === taskId)
        .sort((left, right) => left.timestamp - right.timestamp)
        .at(-1)
      const status =
        latestTerminal && latestTerminal.timestamp >= latestLaunch.startedAt
          ? latestTerminal.status
          : 'running'
      const childKey = pathKey(latestLaunch.sessionFile)
      const child = childFiles.has(childKey) ? this.cache.get(childKey) : null
      if (!child) {
        sources.push({
          key: taskId,
          kind: 'subagent',
          taskId,
          title: latestLaunch.title,
          agentType: latestLaunch.agentType,
          status,
          runCount: orderedLaunches.length,
          launches: orderedLaunches.map((launch) => launch.startedAt),
          startedAt: orderedLaunches[0]!.startedAt,
          updatedAt: latestTerminal?.endedAt ?? latestLaunch.startedAt,
          events: [],
          markers: [],
          tools: [],
          counts: emptyStructureCounts(),
          error: '子代理 Session 文件不存在或无法读取'
        })
        continue
      }
      const cutoff = parent ? orderedLaunches[0]!.startedAt : 0
      const childEvents = child.file.events.filter((event) => event.timestamp >= cutoff)
      const childMarkers = child.file.markers.filter((marker) => marker.timestamp >= cutoff)
      const childTools = child.file.tools.filter((tool) => tool.timestamp >= cutoff)
      sources.push({
        key: taskId,
        kind: 'subagent',
        taskId,
        title: latestLaunch.title,
        agentType: latestLaunch.agentType,
        status,
        runCount: orderedLaunches.length,
        launches: orderedLaunches.map((launch) => launch.startedAt),
        startedAt: orderedLaunches[0]!.startedAt,
        updatedAt: Math.max(
          orderedLaunches[0]!.startedAt,
          latestTerminal?.endedAt ?? 0,
          ...childEvents.map((event) => event.timestamp),
          ...childMarkers.map((marker) => marker.timestamp)
        ),
        events: childEvents,
        markers: childMarkers,
        tools: childTools,
        counts: cloneCounts(child.file.counts),
        error: null
      })
    }

    return { main, inheritedEvents, sources }
  }

  private async requireWorkSession(
    source: PluginSource
  ): Promise<{ source: PluginSource; cwd: string }> {
    if (!this.workSessions) throw new Error('用量 Runtime 缺少 WorkSession 能力')
    const workSessions = await this.workSessions.listWorkSessions()
    const workSession = workSessions.find(
      (item) =>
        item.source.workId === source.workId &&
        item.source.sessionId === source.sessionId &&
        item.source.branchId === source.branchId
    )
    if (!workSession) throw new PluginMethodError(409, '工作会话来源已变化')
    return { source: workSession.source, cwd: workSession.cwd }
  }

  private async loadSessionById(
    sessionId: string,
    cwd: string,
    signal: AbortSignal
  ): Promise<CacheEntry> {
    const cwdKey = pathKey(cwd)
    const matches = (entry: CacheEntry | undefined): entry is CacheEntry =>
      entry !== undefined &&
      !entry.descriptor.nestedSubagent &&
      entry.file.sessionId === sessionId &&
      pathKey(entry.file.cwd) === cwdKey
    const cached = [...this.cache.values()].find(matches)
    if (cached) {
      const key = pathKey(cached.file.path)
      const current = await descriptor(cached.file.path, false)
      if (!current || signature(current) !== signature(cached.descriptor)) {
        this.cache.delete(key)
      }
      if (current) await this.loadChanged([current], signal)
      const refreshed = this.cache.get(key)
      if (matches(refreshed)) return refreshed
    }

    const candidates = await listSessionCandidates(this.sessionsRoot, cwd, sessionId)
    for (const candidate of candidates) {
      const key = pathKey(candidate.path)
      const previous = this.cache.get(key)
      if (previous && signature(previous.descriptor) !== signature(candidate)) {
        this.cache.delete(key)
      }
    }
    await this.loadChanged(candidates, signal)
    const loaded = candidates.map((file) => this.cache.get(pathKey(file.path)))
    const found = loaded.find(matches)
    if (!found && loaded.some((entry) => entry?.file.sessionId === sessionId)) {
      throw new PluginMethodError(409, '工作会话目录与 Pi Session 不一致')
    }
    if (!found) throw new PluginMethodError(404, 'Pi Session 文件不存在')
    return found
  }

  private async loadExactFile(
    path: string,
    nestedSubagent: boolean,
    signal: AbortSignal
  ): Promise<CacheEntry | null> {
    const current = await descriptor(path, nestedSubagent)
    if (!current) return null
    await this.loadChanged([current], signal)
    return this.cache.get(pathKey(current.path)) ?? null
  }

  private timelineInputs(details: LoadedSessionDetails): UsageTimelineSourceInput[] {
    return details.sources.map((source) => {
      const runs: UsageTimelineRun[] =
        source.kind === 'main'
          ? [{ startAt: source.startedAt, endAt: source.updatedAt }]
          : source.launches.map((startAt, index) => ({
              startAt,
              endAt:
                source.launches[index + 1] ??
                (source.status === 'running' ? null : source.updatedAt)
            }))
      return {
        key: source.key,
        kind: source.kind,
        title: source.title,
        agentType: source.agentType,
        updatedAt: source.updatedAt,
        runs,
        events: source.events,
        markers: source.markers,
        tools: source.tools
      }
    })
  }

  private analysisCall(
    event: ParsedUsageEvent,
    sourceKey: string,
    modelNames: ReadonlyMap<string, string>
  ): UsageAnalysisCall {
    return {
      timestamp: event.timestamp,
      sourceKey,
      kind: event.kind,
      modelKey: event.modelKey,
      requestedModel:
        event.requestedModelKey && event.requestedModelKey !== event.modelKey
          ? modelNames.get(event.requestedModelKey) || event.requestedModelKey
          : null,
      actualModel: modelNames.get(event.modelKey) || event.label,
      totals: { ...event.totals }
    }
  }

  private async ensureIndexed(
    startAt: number,
    endAt: number,
    force: boolean,
    signal: AbortSignal
  ): Promise<void> {
    if (!force && this.isCovered(startAt, endAt)) return
    await this.runExclusive(async () => {
      if (this.disposed) throw new PluginMethodError(409, '用量 Runtime 已关闭')
      if (signal.aborted) throw new PluginMethodError(409, '用量查询已取消')
      if (!force && this.isCovered(startAt, endAt)) return
      await this.refreshIndex(startAt, endAt, signal)
    })
  }

  private isCovered(startAt: number, endAt: number): boolean {
    return (
      this.coverage !== null &&
      startAt >= this.coverage.startAt &&
      endAt <= this.coverage.endAt &&
      Date.now() - this.coverage.checkedAt < INDEX_REUSE_MS
    )
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async refreshIndex(startAt: number, endAt: number, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now()
    const standardFiles = await listStandardSessionFiles(this.sessionsRoot)
    const standardByKey = new Map(standardFiles.map((file) => [pathKey(file.path), file]))
    const candidateByKey = new Map(
      standardFiles
        .filter((file) => this.shouldLoad(file, startAt, endAt))
        .map((file) => [pathKey(file.path), file])
    )
    for (const file of candidateByKey.values()) {
      if (!file.nestedSubagent) continue
      const parentSessionId = nestedParentSessionId(file.path)
      if (!parentSessionId) continue
      const suffix = `_${parentSessionId}.jsonl`.toLowerCase()
      const parent = standardFiles.find(
        (candidate) =>
          !candidate.nestedSubagent && basename(candidate.path).toLowerCase().endsWith(suffix)
      )
      if (parent) candidateByKey.set(pathKey(parent.path), parent)
    }
    const candidates = [...candidateByKey.values()]
    let skipped = await this.loadChanged(candidates, signal)

    const childMetadata = this.childMetadata()
    const legacyDescriptors: UsageFileDescriptor[] = []
    for (const [key, child] of childMetadata) {
      if (standardByKey.has(key)) continue
      const file = await descriptor(child.sessionFile, true)
      if (file && this.shouldLoad(file, startAt, endAt)) legacyDescriptors.push(file)
    }
    skipped += await this.loadChanged(legacyDescriptors, signal)

    const activeStandardKeys = new Set(standardByKey.keys())
    for (const [key, entry] of this.cache) {
      if (this.isWithinSessionsRoot(entry.file.path) && !activeStandardKeys.has(key)) {
        this.cache.delete(key)
      }
    }
    this.pruneCache(Date.now())
    this.skippedFiles = skipped
    this.coverage = { startAt, endAt, checkedAt: Date.now() }
    this.logger.info(
      `[pi-desk-usage] stage=indexed elapsedMs=${Date.now() - startedAt} files=${candidates.length + legacyDescriptors.length} cached=${this.cache.size} skipped=${skipped}`
    )
  }

  private shouldLoad(file: UsageFileDescriptor, startAt: number, endAt: number): boolean {
    const cached = this.cache.get(pathKey(file.path))
    if (cached && signature(cached.descriptor) === signature(file)) {
      return overlaps(cached.file, startAt, endAt)
    }
    return file.modifiedAt >= startAt
  }

  private async loadChanged(
    files: readonly UsageFileDescriptor[],
    signal: AbortSignal
  ): Promise<number> {
    const changed = files.filter((file) => {
      const cached = this.cache.get(pathKey(file.path))
      return !cached || signature(cached.descriptor) !== signature(file)
    })
    if (changed.length === 0) {
      const now = Date.now()
      for (const file of files) {
        const cached = this.cache.get(pathKey(file.path))
        if (cached) cached.lastAccessedAt = now
      }
      return 0
    }

    const startedAt = Date.now()
    const results = await this.scanFiles(changed, signal)
    let skipped = 0
    const now = Date.now()
    for (const result of results) {
      const key = pathKey(result.descriptor.path)
      if (!result.file) {
        skipped += 1
        this.logger.warn('[pi-desk-usage] Session 文件解析失败', {
          path: result.descriptor.path,
          error: result.error
        })
        continue
      }
      if (result.file.parseErrors > 0) skipped += 1
      this.cache.set(key, {
        descriptor: result.descriptor,
        file: result.file,
        lastAccessedAt: now
      })
    }
    this.logger.info('[pi-desk-usage] 文件批量解析完成', {
      files: changed.length,
      skipped,
      elapsedMs: Date.now() - startedAt
    })
    return skipped
  }

  private childMetadata(): Map<string, ChildMetadata & { sessionFile: string }> {
    const result = new Map<string, ChildMetadata & { sessionFile: string }>()
    const mains = [...this.cache.values()].sort(
      (left, right) => left.file.createdAt - right.file.createdAt
    )
    for (const cache of mains) {
      if (cache.descriptor.nestedSubagent) continue
      for (const child of cache.file.childSessions) {
        const key = pathKey(child.sessionFile)
        if (result.has(key)) continue
        result.set(key, {
          taskId: child.taskId,
          agentType: child.agentType,
          title: child.title,
          parentSessionId: child.parentSessionId,
          sessionFile: child.sessionFile
        })
      }
    }
    return result
  }

  private indexedFiles(): IndexedFile[] {
    const children = this.childMetadata()
    return [...this.cache.values()].map((cache) => {
      const referencedChild = children.get(pathKey(cache.file.path)) ?? null
      const inferredParentSessionId = cache.descriptor.nestedSubagent
        ? nestedParentSessionId(cache.file.path)
        : null
      const child =
        referencedChild ??
        (inferredParentSessionId
          ? {
              taskId: cache.file.sessionId,
              agentType: null,
              title: fileTitle(cache.file),
              parentSessionId: inferredParentSessionId
            }
          : null)
      const source = cache.descriptor.nestedSubagent || child ? 'subagent' : 'main'
      return { cache, source, child }
    })
  }

  private ownedEvents(startAt: number, endAt: number): OwnedUsageEvent[] {
    const files = this.indexedFiles().sort(
      (left, right) =>
        left.cache.file.createdAt - right.cache.file.createdAt ||
        left.cache.file.path.localeCompare(right.cache.file.path)
    )
    const seen = new Set<string>()
    const events: OwnedUsageEvent[] = []
    const accessedAt = Date.now()
    for (const indexed of files) {
      let accessed = false
      for (const event of indexed.cache.file.events) {
        if (event.timestamp < startAt || event.timestamp >= endAt || seen.has(event.identity)) {
          continue
        }
        seen.add(event.identity)
        events.push({ indexed, event })
        accessed = true
      }
      if (accessed) indexed.cache.lastAccessedAt = accessedAt
    }
    return events
  }

  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (now - entry.lastAccessedAt > CACHE_IDLE_MS) this.cache.delete(key)
    }
  }

  private isWithinSessionsRoot(path: string): boolean {
    const value = relative(this.sessionsRoot, path)
    return value === '' || (!value.startsWith(`..${sep}`) && value !== '..')
  }

  private scanWithWorker(
    files: readonly UsageFileDescriptor[],
    signal: AbortSignal
  ): Promise<UsageFileScanResult[]> {
    if (files.length === 0) return Promise.resolve([])
    return new Promise<UsageFileScanResult[]>((resolvePromise, rejectPromise) => {
      const worker = new Worker(new URL('./usage-worker.js', import.meta.url), {
        workerData: { files }
      })
      this.activeWorker = worker
      let settled = false

      const finish = (): void => {
        if (this.activeWorker === worker) this.activeWorker = null
        signal.removeEventListener('abort', abort)
      }
      const resolveOnce = (results: UsageFileScanResult[]): void => {
        if (settled) return
        settled = true
        finish()
        resolvePromise(results)
      }
      const rejectOnce = (error: unknown): void => {
        if (settled) return
        settled = true
        finish()
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      }
      const abort = (): void => {
        void worker.terminate()
        rejectOnce(new PluginMethodError(409, '用量查询已取消'))
      }

      signal.addEventListener('abort', abort, { once: true })
      worker.once('message', (message: UsageWorkerMessage) => {
        if (message.error) rejectOnce(new Error(message.error))
        else resolveOnce(message.results ?? [])
      })
      worker.once('error', rejectOnce)
      worker.once('exit', (code) => {
        if (!settled) rejectOnce(new Error(`用量 Worker 未返回结果即退出：${code}`))
      })
      if (signal.aborted) abort()
    })
  }
}
