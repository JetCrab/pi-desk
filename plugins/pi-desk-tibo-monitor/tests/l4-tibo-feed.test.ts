import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import { fetchQuotedText, fetchRss, parseRss } from '../src/l4-tibo-feed.js'

const VALID_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Tibo</title>
    <item>
      <guid>https://mirror.example/alice/status/101</guid>
      <title>标题 &amp; 说明</title>
      <link>https://mirror.example/alice/status/101</link>
      <content:encoded><![CDATA[<p>第一段 &amp; 实体</p><script>不要显示</script><div>第二段</div>]]></content:encoded>
      <pubDate>Wed, 01 Jan 2025 12:00:00 GMT</pubDate>
    </item>
    <item>
      <guid>https://x.com/alice/status/100</guid>
      <title>旧帖</title>
      <description><![CDATA[<p>正文</p><iframe>不要显示</iframe>]]></description>
      <pubDate>Tue, 31 Dec 2024 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`

function listen(
  handler: (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法获取测试HTTP端口'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/feed.xml`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()))
          })
      })
    })
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('等待测试HTTP状态超时')
}

test('RSS解析统一canonical链接、清洗HTML并按发布时间排序', () => {
  const posts = parseRss(VALID_RSS)

  assert.deepEqual(
    posts.map((post) => ({ id: post.id, link: post.link, title: post.title })),
    [
      { id: 'x:101', link: 'https://x.com/alice/status/101', title: '标题 & 说明' },
      { id: 'x:100', link: 'https://x.com/alice/status/100', title: '旧帖' }
    ]
  )
  assert.equal(posts[0]?.text, '第一段 & 实体\n\n第二段')
  assert.equal(posts[1]?.text, '正文')
})

test('RSS解析支持单条与空feed，并以guid或link取得帖子身份', () => {
  const single = parseRss(
    '<rss><channel><title>x</title><item><guid>https://x.com/bob/status/7</guid><title>t</title><description>正文</description><pubDate>2025-01-01T00:00:00Z</pubDate></item></channel></rss>'
  )
  const empty = parseRss('<rss><channel><title>x</title></channel></rss>')

  assert.equal(single[0]?.id, 'x:7')
  assert.equal(single[0]?.link, 'https://x.com/bob/status/7')
  assert.deepEqual(empty, [])
})

test('RSS解析拒绝坏XML、DTD和超过2MB的响应', () => {
  assert.throws(() => parseRss('<rss><channel></rss>'), /有效 RSS XML/)
  assert.throws(
    () =>
      parseRss('<!DOCTYPE rss [<!ENTITY x "bad">]><rss><channel><title>x</title></channel></rss>'),
    /DTD|实体/
  )
  assert.throws(() => parseRss('x'.repeat(2 * 1024 * 1024 + 1)), /超过 2MB/)
})

test('HTTP抓取按配置顺序fallback，并返回成功源地址', async (context) => {
  const requests: string[] = []
  const server = await listen((request, response) => {
    requests.push(request.url ?? '')
    if (requests.length === 1) {
      response.writeHead(503)
      response.end('temporary failure')
      return
    }
    response.writeHead(200, { 'content-type': 'application/rss+xml' })
    response.end(VALID_RSS)
  })
  context.after(() => server.close())

  const secondUrl = `${server.url}?fallback=1`
  const result = await fetchRss(new AbortController().signal, [server.url, secondUrl])

  assert.equal(result.sourceUrl, secondUrl)
  assert.equal(result.posts.length, 2)
  assert.deepEqual(requests, ['/feed.xml', '/feed.xml?fallback=1'])
})

test('HTTP抓取响应超过上限时拒绝且不尝试猜测内容', async (context) => {
  const server = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/rss+xml' })
    response.end('x'.repeat(2 * 1024 * 1024 + 1))
  })
  context.after(() => server.close())

  await assert.rejects(
    fetchRss(new AbortController().signal, [server.url]),
    /RSS 抓取失败.*超过 2MB/
  )
})

test('RSS请求不响应取消时仍按时退出，并可继续使用同一个监听信号', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  let requestSignal: AbortSignal | null | undefined
  let release!: (response: Response) => void
  const delayed = new Promise<Response>((resolve) => {
    release = resolve
  })
  context.after(() => release(new Response(VALID_RSS)))
  let failure: unknown
  const pending = fetchRss(controller.signal, ['https://feed.example/rss'], async (_url, init) => {
    requestSignal = init?.signal
    return delayed
  }).catch((error: unknown) => {
    failure = error
  })

  context.mock.timers.tick(20_000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /请求超时/)
  await pending
  assert.equal(requestSignal?.aborted, true)
  assert.equal(controller.signal.aborted, false)

  const next = await fetchRss(
    controller.signal,
    ['https://feed.example/rss'],
    async () => new Response(VALID_RSS)
  )
  assert.equal(next.posts.length, 2)
})

for (const kind of ['rss', 'quote'] as const) {
  test(`${kind}正文停滞且取消清理不返回时仍超时退出并释放读取锁`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    const controller = new AbortController()
    let cancelled = false
    let releaseCancel!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('<partial>'))
      },
      cancel() {
        cancelled = true
        return cleanup
      }
    })
    context.after(releaseCancel)
    const fetchImpl: typeof fetch = async () => new Response(body)
    let failure: unknown
    const pending = (
      kind === 'rss'
        ? fetchRss(controller.signal, ['https://feed.example/rss'], fetchImpl)
        : fetchQuotedText(
            { author: '@alice', link: 'https://x.com/alice/status/1', text: 'quote…' },
            controller.signal,
            fetchImpl
          )
    ).catch((error: unknown) => {
      failure = error
    })
    await waitFor(() => body.locked)

    context.mock.timers.tick(kind === 'rss' ? 20_000 : 4_000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(failure instanceof Error)
    assert.match(failure.message, /请求超时/)
    await pending
    assert.equal(cancelled, true)
    assert.equal(body.locked, false)
    assert.equal(controller.signal.aborted, false)
  })
}

test('HTTP失败的响应清理不阻塞备用源', async (context) => {
  let cancelled = false
  let releaseCancel!: () => void
  const cleanup = new Promise<void>((resolve) => {
    releaseCancel = resolve
  })
  context.after(releaseCancel)
  const body = new ReadableStream({
    cancel() {
      cancelled = true
      return cleanup
    }
  })
  let requests = 0
  let completed = false
  const pending = fetchRss(
    new AbortController().signal,
    ['https://feed.example/primary', 'https://feed.example/backup'],
    async () => {
      requests += 1
      return requests === 1 ? new Response(body, { status: 503 }) : new Response(VALID_RSS)
    }
  ).then((result) => {
    completed = true
    return result
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(completed, true)
  assert.equal(cancelled, true)
  assert.equal((await pending).sourceUrl, 'https://feed.example/backup')
})

test('主动取消无需等待无响应请求或触发备用源', async (context) => {
  const controller = new AbortController()
  let release!: (response: Response) => void
  const delayed = new Promise<Response>((resolve) => {
    release = resolve
  })
  context.after(() => release(new Response(VALID_RSS)))
  let requests = 0
  let failure: unknown
  const pending = fetchRss(
    controller.signal,
    ['https://feed.example/primary', 'https://feed.example/backup'],
    async () => {
      requests += 1
      return delayed
    }
  ).catch((error: unknown) => {
    failure = error
  })
  const reason = new Error('监听已关闭')
  controller.abort(reason)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(failure, reason)
  await pending
  assert.equal(requests, 1)
})

test('HTTP抓取响应遵循AbortSignal并结束请求', async (context) => {
  let requested = false
  let responseTimer: NodeJS.Timeout | undefined
  const server = await listen((_request, response) => {
    requested = true
    responseTimer = setTimeout(() => response.end(VALID_RSS), 10_000)
  })
  context.after(() => {
    if (responseTimer) clearTimeout(responseTimer)
    return server.close()
  })

  const controller = new AbortController()
  const pending = fetchRss(controller.signal, [server.url])
  await waitFor(() => requested)
  controller.abort()

  await assert.rejects(
    pending,
    (error: unknown) => controller.signal.aborted && error instanceof Error
  )
})
