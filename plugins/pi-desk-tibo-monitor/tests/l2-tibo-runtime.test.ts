import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  PluginJsonObject,
  PluginNotificationPublishInput,
  PiDeskPluginFacade
} from '@jetcrab/pi-desk-sdk/entry'
import { TiboRuntime } from '../src/l2-tibo-runtime.js'
import { fetchRss } from '../src/l4-tibo-feed.js'
import type {
  ModelSelection,
  TiboAnalysis,
  TiboPost,
  TiboSettings
} from '../src/l4-tibo-protocol.js'

const MODEL: ModelSelection = { provider: 'fixture', modelId: 'translator' }
const SETTINGS: TiboSettings = {
  enabled: true,
  intervalSeconds: 30,
  retentionCount: 10,
  model: MODEL
}
const ANALYSIS: TiboAnalysis = {
  translation: '中文翻译',
  reset: { level: 'none', reason: '没有重置信号' },
  times: []
}

function post(id: string, publishedAt: number): TiboPost {
  return {
    id,
    title: `标题-${id}`,
    text: `正文-${id}`,
    link: `https://x.com/alice/status/${publishedAt}`,
    publishedAt
  }
}

function createHost(): {
  host: Pick<PiDeskPluginFacade, 'setState' | 'notifications'>
  states: PluginJsonObject[]
  notifications: PluginNotificationPublishInput[]
} {
  const states: PluginJsonObject[] = []
  const notifications: PluginNotificationPublishInput[] = []
  return {
    states,
    notifications,
    host: {
      setState(state) {
        if (state) states.push(state)
      },
      notifications: {
        publish(input) {
          notifications.push(input)
          return `notification-${notifications.length}`
        },
        update() {},
        delete() {}
      }
    }
  }
}

async function tempPath(): Promise<{ path: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tibo-runtime-'))
  return { path: join(root, 'state.json'), root }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('等待Tibo运行时状态超时')
}

function enable(runtime: TiboRuntime): Promise<unknown> {
  return runtime.saveSettings(SETTINGS)
}

test('首次成功抓取只建立基线，重复与备用源历史回填不通知', async (context) => {
  const { path, root } = await tempPath()
  const hostState = createHost()
  let posts = [post('old', 100)]
  let fetchCount = 0
  const translated: string[] = []
  const runtime = await TiboRuntime.create(hostState.host, {
    path,
    fetchFeed: async () => {
      fetchCount += 1
      return { posts, sourceUrl: 'fixture://feed' }
    },
    translate: async (item) => {
      translated.push(item.id)
      return ANALYSIS
    }
  })
  context.after(async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })

  await enable(runtime)
  await waitFor(() => fetchCount === 1 && runtime.snapshot().status.lastSuccessAt !== null)
  assert.deepEqual(translated, [])
  assert.equal(hostState.notifications.length, 0)
  const historical = runtime.record('old')
  assert.ok(historical)
  assert.equal(translated.length, 0)
  const translatedHistorical = await runtime.translateRecord('old')
  assert.equal(translatedHistorical?.analysis?.translation, ANALYSIS.translation)
  assert.deepEqual(translated, ['old'])

  posts = [post('new', 200), post('old', 100), post('backfill', 50)]
  await enable(runtime)
  await waitFor(() => hostState.notifications.length === 1)
  assert.deepEqual(translated, ['old', 'new'])
  const notification = hostState.notifications[0]
  assert.ok(notification)
  assert.equal(notification.level, 'info')
  assert.deepEqual(
    runtime.snapshot().records.map((item) => item.id),
    ['new', 'old', 'backfill']
  )

  await enable(runtime)
  await waitFor(() => fetchCount === 3)
  assert.equal(hostState.notifications.length, 1)
})

test('慢翻译不阻塞下一轮RSS抓取，且同一帖子不会重复排队', async (context) => {
  const { path, root } = await tempPath()
  const timers = context.mock.timers
  timers.enable({ apis: ['setTimeout'] })
  const hostState = createHost()
  let posts = [post('baseline', 100)]
  let fetchCount = 0
  let releaseTranslation!: () => void
  let translationStarted = false
  const translationDone = new Promise<void>((resolve) => {
    releaseTranslation = resolve
  })
  const runtime = await TiboRuntime.create(hostState.host, {
    path,
    fetchFeed: async () => {
      fetchCount += 1
      return { posts, sourceUrl: 'fixture://feed' }
    },
    translate: async (_item, _model, signal) => {
      translationStarted = true
      await Promise.race([
        translationDone,
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
      ])
      signal.throwIfAborted()
      return ANALYSIS
    }
  })
  context.after(async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })

  await enable(runtime)
  timers.tick(0)
  await waitFor(() => fetchCount === 1 && runtime.snapshot().status.lastSuccessAt !== null)
  posts = [post('new', 200), post('baseline', 100)]
  timers.tick(30_000)
  await waitFor(() => translationStarted && fetchCount === 2)

  timers.tick(30_000)
  await waitFor(() => fetchCount === 3)
  assert.equal(hostState.notifications.length, 0)

  releaseTranslation()
  await waitFor(() => hostState.notifications.length === 1)
  assert.equal(hostState.notifications[0]?.event?.name, 'open-post')
})

test('RSS超时后保留记录并自动进行下一轮，迟到响应不覆盖结果', async (context) => {
  const { path, root } = await tempPath()
  const timers = context.mock.timers
  timers.enable({ apis: ['setTimeout'] })
  const hostState = createHost()
  let fetchCount = 0
  let release!: (response: Response) => void
  const delayed = new Promise<Response>((resolve) => {
    release = resolve
  })
  const rss = (id: number): string =>
    `<rss><channel><title>Tibo</title><item><link>https://x.com/alice/status/${id}</link><title>动态</title><pubDate>2025-01-01T00:00:00Z</pubDate></item></channel></rss>`
  const runtime = await TiboRuntime.create(hostState.host, {
    path,
    fetchFeed: (signal) =>
      fetchRss(signal, ['https://feed.example/rss'], async () => {
        fetchCount += 1
        return fetchCount === 2 ? delayed : new Response(rss(fetchCount))
      }),
    translate: async () => ANALYSIS
  })
  context.after(async () => {
    release(new Response(rss(2)))
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })

  await enable(runtime)
  timers.tick(0)
  await waitFor(() => runtime.snapshot().status.lastSuccessAt !== null)
  const baseline = runtime.snapshot()

  timers.tick(30_000)
  await waitFor(() => fetchCount === 2)
  timers.tick(20_000)
  await waitFor(() => !runtime.snapshot().status.polling)
  const failed = runtime.snapshot()
  assert.match(failed.status.error ?? '', /请求超时/)
  assert.equal(failed.status.lastSuccessAt, baseline.status.lastSuccessAt)
  assert.deepEqual(failed.records, baseline.records)

  timers.tick(30_000)
  await waitFor(() => fetchCount === 3 && !runtime.snapshot().status.polling)
  assert.equal(runtime.snapshot().status.error, null)
  assert.ok(runtime.record('x:3'))

  release(new Response(rss(2)))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(runtime.record('x:2'), null)
  assert.equal(runtime.snapshot().status.error, null)
})

test('新帖翻译失败后保留待通知状态，并在下一轮成功重试', async (context) => {
  const { path, root } = await tempPath()
  const timers = context.mock.timers
  timers.enable({ apis: ['setTimeout'] })
  const hostState = createHost()
  let posts = [post('baseline', 100)]
  let fetchCount = 0
  let translateCount = 0
  const runtime = await TiboRuntime.create(hostState.host, {
    path,
    fetchFeed: async () => {
      fetchCount += 1
      return { posts, sourceUrl: 'fixture://feed' }
    },
    translate: async () => {
      translateCount += 1
      if (translateCount === 1) throw new Error('模型暂时失败')
      return ANALYSIS
    }
  })
  context.after(async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })

  await enable(runtime)
  timers.tick(0)
  await waitFor(() => fetchCount === 1 && runtime.snapshot().status.lastSuccessAt !== null)
  posts = [post('new', 200), post('baseline', 100)]
  timers.tick(30_000)
  await waitFor(() => translateCount === 1 && runtime.snapshot().status.error !== null)
  assert.equal(hostState.notifications.length, 0)

  timers.tick(30_000)
  await waitFor(() => hostState.notifications.length === 1)
  assert.equal(translateCount, 2)
  assert.equal(runtime.snapshot().status.error, null)
})

test('释放运行时会取消翻译，重启后不重放通知', async (context) => {
  const { path, root } = await tempPath()
  const timers = context.mock.timers
  timers.enable({ apis: ['setTimeout'] })
  const firstHost = createHost()
  let posts = [post('baseline', 100)]
  let fetchCount = 0
  let translationStarted = false
  const runtime = await TiboRuntime.create(firstHost.host, {
    path,
    fetchFeed: async () => {
      fetchCount += 1
      return { posts, sourceUrl: 'fixture://feed' }
    },
    translate: async (_item, _model, signal) => {
      translationStarted = true
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
      signal.throwIfAborted()
      return ANALYSIS
    }
  })
  let restarted: TiboRuntime | null = null
  context.after(async () => {
    await runtime.dispose()
    await restarted?.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await enable(runtime)
  timers.tick(0)
  await waitFor(() => fetchCount === 1 && runtime.snapshot().status.lastSuccessAt !== null)
  posts = [post('new', 200), post('baseline', 100)]
  timers.tick(30_000)
  await waitFor(() => translationStarted)
  await runtime.dispose()
  assert.deepEqual(firstHost.notifications, [])

  const secondHost = createHost()
  let restartedFetches = 0
  const restartedRuntime = await TiboRuntime.create(secondHost.host, {
    path,
    fetchFeed: async () => {
      restartedFetches += 1
      return { posts, sourceUrl: 'fixture://feed' }
    },
    translate: async () => {
      throw new Error('重启不应自动翻译历史记录')
    }
  })
  restarted = restartedRuntime
  timers.tick(0)
  await waitFor(() => restartedFetches === 1)
  assert.deepEqual(secondHost.notifications, [])
  await restartedRuntime.dispose()
})
