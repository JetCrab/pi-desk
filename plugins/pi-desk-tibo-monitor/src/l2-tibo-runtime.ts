import type { PiDeskPluginFacade } from '@jetcrab/pi-desk-sdk/entry'
import type { HostRegion, HostSettings } from '@jetcrab/pi-desk-sdk/settings'
import { DEFAULT_REGION, LEGACY_ANALYSIS_REGION, sameRegion, tiboText } from './l4-tibo-locale.js'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import { fetchQuotedText, fetchRss, isTruncatedQuote, type FeedResult } from './l4-tibo-feed.js'
import { readStore, retainRecords, writeStore } from './l4-tibo-storage.js'
import {
  errorText,
  settingsSchema,
  type ModelSelection,
  type TiboAnalysis,
  type TiboPost,
  type TiboRecord,
  type TiboRuntimeStatus,
  type TiboSnapshot,
  type TiboStored
} from './l4-tibo-protocol.js'

type RuntimeHost = Pick<PiDeskPluginFacade, 'setState' | 'notifications'>
export interface TiboRuntimeOptions {
  path: string
  settings?: HostSettings
  fetchFeed?: (signal: AbortSignal) => Promise<FeedResult>
  fetchQuote?: (
    quote: NonNullable<TiboPost['quote']>,
    signal: AbortSignal
  ) => Promise<string | null>
  translate(
    post: TiboPost,
    model: ModelSelection,
    signal: AbortSignal,
    region: HostRegion
  ): Promise<TiboAnalysis>
}

export class TiboRuntime {
  private status: TiboRuntimeStatus = {
    polling: false,
    translating: false,
    lastCheckedAt: null,
    lastSuccessAt: null,
    sourceUrl: null,
    error: null
  }
  private region: HostRegion
  private settingsOff: (() => void | Promise<void>) | null = null
  private disposed = false
  private controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null
  private pollTask: Promise<void> | null = null
  private writeTail: Promise<void> = Promise.resolve()
  private settingsTail: Promise<void> = Promise.resolve()
  private analysisTail: Promise<void> = Promise.resolve()
  private readonly analyses = new Map<string, Promise<TiboRecord | null>>()
  // 仅当前进程新发现的帖子可通知；重启不恢复通知或历史重放队列。
  private readonly pendingNotifications = new Set<string>()

  private constructor(
    private readonly host: RuntimeHost,
    private readonly options: TiboRuntimeOptions,
    private data: TiboStored
  ) {
    this.region = options.settings?.getSnapshot().region ?? DEFAULT_REGION
  }

  static async create(host: RuntimeHost, options: TiboRuntimeOptions): Promise<TiboRuntime> {
    const runtime = new TiboRuntime(host, options, await readStore(options.path))
    await runtime.invalidateAnalysis(runtime.region)
    runtime.settingsOff = options.settings?.subscribe(() => runtime.regionChanged()) ?? null
    // 读取存储期间地区可能已更新；订阅建立后再次核对共享源。
    if (!sameRegion(runtime.region, options.settings?.getSnapshot().region ?? DEFAULT_REGION)) {
      runtime.regionChanged()
      await runtime.settingsTail
    }
    runtime.emit()
    runtime.schedule(0)
    return runtime
  }

  snapshot(): TiboSnapshot {
    const analysisCurrent = sameRegion(
      this.data.analysisRegion ?? LEGACY_ANALYSIS_REGION,
      this.options.settings?.getSnapshot().region ?? DEFAULT_REGION
    )
    return {
      settings: structuredClone(this.data.settings),
      status: { ...this.status },
      records: this.data.records.map(({ text, quote, analysis, ...post }) => ({
        ...post,
        preview: (analysisCurrent ? (analysis?.translation ?? text) : text).slice(0, 240),
        quotePreview: quote ? `${quote.author} · ${quote.text.slice(0, 120)}` : null,
        resetLevel: analysisCurrent ? (analysis?.reset.level ?? null) : null,
        translated: analysisCurrent && analysis !== null
      }))
    }
  }

  record(id: string): TiboRecord | null {
    const record = this.data.records.find((item) => item.id === id)
    if (!record) return null
    const region = this.options.settings?.getSnapshot().region ?? DEFAULT_REGION
    return structuredClone(
      sameRegion(this.data.analysisRegion ?? LEGACY_ANALYSIS_REGION, region)
        ? record
        : { ...record, analysis: null }
    )
  }

  saveSettings(input: unknown): Promise<TiboSnapshot> {
    const parsed = settingsSchema.safeParse(input)
    if (!parsed.success)
      throw new PluginMethodError(400, parsed.error.issues[0]?.message ?? '设置无效')
    const settings = parsed.data
    const operation = this.settingsTail.then(async () => {
      this.assertActive()
      await this.pause()
      try {
        this.assertActive()
        await this.mutate((current) => ({
          ...current,
          settings,
          records: retainRecords(current.records, settings.retentionCount)
        }))
        this.prunePending()
        if (!settings.enabled) this.pendingNotifications.clear()
        this.status.error = null
      } finally {
        this.controller = new AbortController()
        this.emit()
        this.schedule(0)
      }
      return this.snapshot()
    })
    this.settingsTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  async translateRecord(id: string): Promise<TiboRecord | null> {
    await this.settingsTail
    this.assertActive()
    const existing = this.analyses.get(id)
    if (existing) return existing
    const signal = this.controller.signal
    const operation = this.analysisTail.then(async () => {
      signal.throwIfAborted()
      const record = this.record(id)
      if (!record || record.analysis) return record
      const model = this.data.settings.model
      if (!model)
        throw new PluginMethodError(
          400,
          tiboText(
            this.region,
            '请先在 Tibo 动态设置中选择翻译模型',
            'Choose a translation model in Tibo settings first'
          )
        )
      this.status.translating = true
      this.emit()
      try {
        const analysis = await this.options.translate(record, model, signal, this.region)
        signal.throwIfAborted()
        await this.mutate((current) => {
          signal.throwIfAborted()
          return {
            ...current,
            records: current.records.map((item) => (item.id === id ? { ...item, analysis } : item))
          }
        })
        signal.throwIfAborted()
        return this.record(id)
      } finally {
        this.status.translating = false
        this.emit()
      }
    })
    this.analyses.set(id, operation)
    this.analysisTail = operation.then(
      () => undefined,
      () => undefined
    )
    void operation
      .finally(() => {
        if (this.analyses.get(id) === operation) this.analyses.delete(id)
      })
      .catch(() => undefined)
    return operation
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.settingsOff?.()
    this.settingsOff = null
    await this.pause()
    await this.settingsTail
    this.pendingNotifications.clear()
  }

  private async invalidateAnalysis(region: HostRegion): Promise<void> {
    const previous = this.data.analysisRegion ?? LEGACY_ANALYSIS_REGION
    const changed = !sameRegion(previous, region)
    if (this.data.analysisRegion && !changed) return
    await this.mutate((current) => ({
      ...current,
      analysisRegion: region,
      records: changed
        ? current.records.map((record) => ({ ...record, analysis: null }))
        : current.records
    }))
  }

  private regionChanged(): void {
    if (this.disposed) return
    const region = this.options.settings?.getSnapshot().region ?? DEFAULT_REGION
    if (sameRegion(this.region, region)) return
    // 立即取消，避免排队等待期间旧地区结果提交或通知。
    this.controller.abort(new Error('Tibo 宿主地区设置已变化'))
    const operation = this.settingsTail.then(async () => {
      if (this.disposed) return
      await this.pause()
      if (this.disposed) return
      try {
        this.region = this.options.settings?.getSnapshot().region ?? DEFAULT_REGION
        await this.invalidateAnalysis(this.region)
        this.status.error = null
      } finally {
        this.controller = new AbortController()
        this.emit()
        this.schedule(0)
      }
    })
    this.settingsTail = operation.catch((error: unknown) => {
      console.warn('[Pi Desk][TiboMonitor] 地区缓存更新失败', { error: errorText(error) })
      this.status.error = errorText(error)
      this.emit()
    })
  }

  private assertActive(): void {
    if (this.disposed)
      throw new PluginMethodError(
        409,
        tiboText(this.region, 'Tibo 插件已关闭', 'Tibo plugin is closed')
      )
  }

  private emit(): void {
    if (!this.disposed) this.host.setState({ ...this.status })
  }

  private mutate(update: (current: TiboStored) => TiboStored): Promise<void> {
    const operation = this.writeTail.then(async () => {
      const next = update(this.data)
      await writeStore(this.options.path, next)
      this.data = next
    })
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  private schedule(delayMs: number): void {
    if (this.disposed || !this.data.settings.enabled || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.pollTask = this.poll().finally(() => {
        this.pollTask = null
      })
    }, delayMs)
    this.timer.unref?.()
  }

  private async pause(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.controller.abort(new Error('Tibo 监听设置已变化或插件已关闭'))
    await Promise.allSettled([this.pollTask, this.analysisTail, this.writeTail])
    // poll 的 finally 可能已经排入下一轮；设置切换时一并清理。
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private prunePending(): void {
    const ids = new Set(this.data.records.map((record) => record.id))
    for (const id of this.pendingNotifications)
      if (!ids.has(id)) this.pendingNotifications.delete(id)
  }

  private async completeQuotes(posts: TiboPost[], signal: AbortSignal): Promise<TiboPost[]> {
    const known = new Map(this.data.records.map((record) => [record.id, record]))
    // 最多补全本轮最新五条引用；失败沿用 RSS，不影响正文抓取和后续通知。
    return Promise.all(
      posts.map(async (post, index) => {
        const quote = post.quote
        const previous = known.get(post.id)?.quote
        if (
          !quote ||
          index >= 5 ||
          !isTruncatedQuote(quote.text) ||
          (previous && !isTruncatedQuote(previous.text))
        ) {
          return post
        }
        try {
          const fullText = await (this.options.fetchQuote ?? fetchQuotedText)(quote, signal)
          return fullText ? { ...post, quote: { ...quote, text: fullText } } : post
        } catch {
          signal.throwIfAborted()
          return post
        }
      })
    )
  }

  private async storePosts(posts: TiboPost[], signal: AbortSignal): Promise<string[]> {
    const newIds: string[] = []
    await this.mutate((current) => {
      signal.throwIfAborted()
      const byId = new Map(current.records.map((record) => [record.id, record]))
      const latest = current.records[0]?.publishedAt
      const incoming = posts.map((post): TiboRecord => {
        const existing = byId.get(post.id)
        if (existing) {
          // 旧版记录正文混入引用：补齐结构后清除旧译文，但不重新通知。
          if (
            post.quote &&
            (!existing.quote || post.quote.text.length > existing.quote.text.length)
          ) {
            return { ...post, analysis: null }
          }
          return existing
        }
        // 被淘汰的旧帖、置顶帖或备用源补出的历史不重新通知。
        if (latest !== undefined && post.publishedAt >= latest) newIds.push(post.id)
        return { ...post, analysis: null }
      })
      return {
        ...current,
        records: retainRecords([...incoming, ...current.records], current.settings.retentionCount)
      }
    })
    return newIds
  }

  private async poll(): Promise<void> {
    const signal = this.controller.signal
    const checkedAt = Date.now()
    let stage = '状态发布'
    this.status.polling = true
    this.status.lastCheckedAt = checkedAt
    console.info('[Pi Desk][TiboMonitor] 抓取开始', { checkedAt })
    this.emit()
    try {
      stage = 'RSS 抓取'
      const result = await (this.options.fetchFeed ?? fetchRss)(signal)
      signal.throwIfAborted()
      console.info('[Pi Desk][TiboMonitor] RSS 已返回', {
        checkedAt,
        elapsedMs: Date.now() - checkedAt,
        postCount: result.posts.length,
        sourceUrl: result.sourceUrl
      })
      let newIds: string[] = []
      if (result.posts.length) {
        stage = '引用补全'
        const posts = await this.completeQuotes(result.posts, signal)
        signal.throwIfAborted()
        console.info('[Pi Desk][TiboMonitor] 引用补全已结束，开始保存记录', {
          checkedAt,
          elapsedMs: Date.now() - checkedAt
        })
        stage = '记录保存'
        newIds = await this.storePosts(posts, signal)
      }
      stage = '结果整理'
      signal.throwIfAborted()
      for (const id of newIds.reverse()) this.pendingNotifications.add(id)
      this.prunePending()
      this.status.lastSuccessAt = Date.now()
      this.status.sourceUrl = result.sourceUrl
      this.status.error = null
      this.processNotifications(signal)
    } catch (error) {
      if (!signal.aborted) {
        this.status.error = errorText(error)
        console.warn('[Pi Desk][TiboMonitor] 抓取失败', {
          checkedAt,
          stage,
          elapsedMs: Date.now() - checkedAt,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          message: this.status.error
        })
      }
    } finally {
      this.status.polling = false
      console.info('[Pi Desk][TiboMonitor] 准备发布抓取状态', {
        checkedAt,
        stage,
        elapsedMs: Date.now() - checkedAt,
        aborted: signal.aborted,
        lastSuccessAt: this.status.lastSuccessAt,
        error: this.status.error
      })
      this.emit()
      if (!signal.aborted) this.schedule(this.data.settings.intervalSeconds * 1000)
      console.info('[Pi Desk][TiboMonitor] 抓取收尾完成', {
        checkedAt,
        nextCheckSeconds: signal.aborted ? null : this.data.settings.intervalSeconds
      })
    }
  }

  private processNotifications(signal: AbortSignal): void {
    for (const id of this.pendingNotifications) {
      if (this.analyses.has(id)) continue
      void this.translateRecord(id)
        .then((record) => {
          if (signal.aborted || !record?.analysis || !this.pendingNotifications.has(id)) return
          const level = record.analysis.reset.level
          this.host.notifications.publish({
            level: level === 'none' ? 'info' : 'warning',
            title:
              level === 'announced'
                ? tiboText(
                    this.region,
                    'Tibo：Codex 额度重置消息',
                    'Tibo: Codex quota reset announcement'
                  )
                : level === 'possible'
                  ? tiboText(
                      this.region,
                      'Tibo：可能重置 Codex 额度（推测）',
                      'Tibo: Possible Codex quota reset (inferred)'
                    )
                  : tiboText(this.region, 'Tibo 发布了新动态', 'New post from Tibo'),
            description: [
              record.analysis.translation,
              record.quote
                ? `${tiboText(this.region, '引用', 'Quote from')} ${record.quote.author}: ${record.analysis.quoteTranslation ?? record.quote.text}`
                : null
            ]
              .filter((part): part is string => part !== null)
              .join('\n')
              .slice(0, 280),
            event: { name: 'open-post', data: { id: record.id, link: record.link } }
          })
          this.pendingNotifications.delete(id)
        })
        .catch((error: unknown) => {
          if (!signal.aborted) {
            this.status.error = `${tiboText(this.region, '翻译或通知失败，下轮重试', 'Translation or notification failed; retrying next check')}: ${errorText(error)}`
            this.emit()
          }
        })
    }
  }
}
