import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { DomUtils, Parser, parseDocument } from 'htmlparser2'
import { z } from 'zod'
import {
  MAX_POST_TEXT,
  PRIMARY_RSS_URL,
  errorText,
  postSchema,
  type TiboPost
} from './l4-tibo-protocol.js'

const MAX_FEED_BYTES = 2 * 1024 * 1024
const feedItemSchema = z
  .object({
    guid: z.unknown().optional(),
    title: z.unknown().optional(),
    description: z.unknown().optional(),
    'content:encoded': z.unknown().optional(),
    content: z.unknown().optional(),
    link: z.unknown().optional(),
    pubDate: z.unknown().optional()
  })
  .passthrough()

function scalar(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && '#text' in value) return scalar(value['#text'])
  return ''
}

function plainText(html: string, omitQuotes = false): string {
  const chunks: string[] = []
  let hiddenDepth = 0
  let quoteDepth = 0
  const hidden = new Set(['script', 'style', 'iframe'])
  const blocks = new Set(['p', 'div', 'li', 'blockquote', 'br'])
  const visible = (): boolean => hiddenDepth === 0 && (!omitQuotes || quoteDepth === 0)
  const parser = new Parser(
    {
      onopentag(name) {
        if (hidden.has(name)) hiddenDepth += 1
        if (name === 'blockquote') quoteDepth += 1
        if (visible() && blocks.has(name)) chunks.push('\n')
      },
      ontext(text) {
        if (visible()) chunks.push(text)
      },
      onclosetag(name) {
        if (hidden.has(name)) hiddenDepth = Math.max(0, hiddenDepth - 1)
        if (name === 'blockquote') quoteDepth = Math.max(0, quoteDepth - 1)
        if (visible() && blocks.has(name)) chunks.push('\n')
      }
    },
    { decodeEntities: true }
  )
  parser.end(html)
  return chunks
    .join('')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function originalLink(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('RSS 帖子链接无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RSS 帖子链接协议无效')
  const match = /^\/([a-zA-Z0-9_]+)\/status\/(\d+)(?:\/|$)/.exec(url.pathname)
  if (!match) throw new Error('RSS 条目缺少 X 帖子路径')
  // Nitter / RSSHub 可能改写域名，同一帖子统一成 X 原始身份。
  return `https://x.com/${match[1]}/status/${match[2]}`
}

function rssQuote(html: string): TiboPost['quote'] {
  const document = parseDocument(html)
  const block = DomUtils.findOne((node) => node.name === 'blockquote', document.children)
  if (!block) return undefined
  const anchor = DomUtils.findOne(
    (node) => node.name === 'a' && !!node.attribs.href,
    block.children
  )
  if (!anchor) return undefined
  try {
    const link = originalLink(anchor.attribs.href)
    const author = new URL(link).pathname.split('/')[1]
    const text = plainText(DomUtils.getOuterHTML(block))
    return text ? { author: `@${author}`, link, text } : undefined
  } catch {
    return undefined
  }
}

export function isTruncatedQuote(text: string): boolean {
  return /(?:…|\.\.\.)\s*$/.test(text)
}

export function parseRss(xml: string): TiboPost[] {
  if (Buffer.byteLength(xml) > MAX_FEED_BYTES) throw new Error('RSS 超过 2MB')
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('RSS 不允许 DTD 或自定义实体')
  if (XMLValidator.validate(xml) !== true) throw new Error('数据源未返回有效 RSS XML')
  const parsed: unknown = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false
  }).parse(xml)
  const channel = z
    .object({
      rss: z
        .object({
          channel: z
            .object({
              title: z.unknown(),
              item: z.unknown().optional()
            })
            .passthrough()
        })
        .passthrough()
    })
    .parse(parsed).rss.channel
  const items =
    channel.item === undefined ? [] : Array.isArray(channel.item) ? channel.item : [channel.item]
  const records = new Map<string, TiboPost>()
  for (const raw of items) {
    const item = feedItemSchema.parse(raw)
    const guid = scalar(item.guid)
    const link = originalLink(scalar(item.link) || guid)
    const html = scalar(item['content:encoded']) || scalar(item.content) || scalar(item.description)
    const quote = rssQuote(html)
    const text = plainText(html, !!quote) || plainText(scalar(item.title))
    const statusId = /\/status\/(\d+)$/.exec(link)![1]
    const post = postSchema.parse({
      id: `x:${statusId}`,
      title: (plainText(scalar(item.title)) || text).slice(0, 1000),
      text,
      link,
      ...(quote ? { quote } : {}),
      publishedAt: Date.parse(scalar(item.pubDate))
    })
    records.set(post.id, post)
  }
  return [...records.values()].sort((a, b) => b.publishedAt - a.publishedAt)
}

async function withRequestTimeout<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  parentSignal.throwIfAborted()
  const controller = new AbortController()
  const signal = AbortSignal.any([parentSignal, controller.signal])
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const timer = setTimeout(
    () => controller.abort(new Error(`请求超时（${timeoutMs / 1000} 秒）`)),
    timeoutMs
  )
  try {
    // 取消底层请求的同时结束等待，不能依赖 fetch 或流清理一定响应取消。
    return await Promise.race([request(signal), aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error('响应正文为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = (): void => {
    // 底层清理可能不返回；发起取消即可，不能再阻塞请求收尾。
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > MAX_FEED_BYTES) throw new Error('RSS 超过 2MB')
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function fetchQuotedText(
  quote: NonNullable<TiboPost['quote']>,
  signal: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<string | null> {
  const url = `https://x.noodl3.net${new URL(quote.link).pathname}`
  const html = await withRequestTimeout(signal, 4_000, async (requestSignal) => {
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'PiDesk-TiboMonitor/0.0.1' },
      signal: requestSignal
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      requestSignal.throwIfAborted()
      return null
    }
    return readLimited(response, requestSignal)
  })
  if (html === null) return null
  const document = parseDocument(html)
  const content = DomUtils.findOne(
    (node) => node.attribs.class?.split(/\s+/).includes('tweet-content') === true,
    document.children
  )
  if (!content) return null
  const fullText = plainText(DomUtils.getOuterHTML(content))
  const prefix = quote.text.replace(/(?:…|\.\.\.)\s*$/, '').slice(0, 60)
  return prefix &&
    fullText.startsWith(prefix) &&
    fullText.length > quote.text.length &&
    fullText.length <= MAX_POST_TEXT
    ? fullText
    : null
}

export interface FeedResult {
  posts: TiboPost[]
  sourceUrl: string
}

export async function fetchRss(
  signal: AbortSignal,
  urls: readonly string[] = [PRIMARY_RSS_URL],
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<FeedResult> {
  const failures: string[] = []
  for (const url of urls) {
    signal.throwIfAborted()
    try {
      const posts = await withRequestTimeout(signal, 20_000, async (requestSignal) => {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Accept: 'application/rss+xml, application/xml, text/xml;q=0.9',
            'User-Agent': 'PiDesk-TiboMonitor/0.0.1'
          },
          signal: requestSignal
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined)
          requestSignal.throwIfAborted()
          throw new Error(`HTTP ${response.status}`)
        }
        return parseRss(await readLimited(response, requestSignal))
      })
      signal.throwIfAborted()
      return { posts, sourceUrl: url }
    } catch (error) {
      signal.throwIfAborted()
      failures.push(`${url}：${errorText(error)}`)
    }
  }
  throw new Error(`RSS 抓取失败：${failures.join('；') || '未配置数据源'}`)
}
