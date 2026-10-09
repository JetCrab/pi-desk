import 'server-only'

import { createHash } from 'node:crypto'
import { readRegistryNpmConfig, registryAuth } from './l4-pi-plugin-registry-config'

export class L4PluginRegistryError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly reason: 'network' | 'missing' | 'invalid' | 'denied' = 'invalid'
  ) {
    super(message)
    this.name = 'L4PluginRegistryError'
  }
}

const cache = new Map<string, { body: Buffer; expires: number }>()
let cacheBytes = 0
const CACHE_BYTES = 24 * 1024 * 1024

export async function fetchRegistryBytes(
  url: URL,
  options: {
    limit: number
    signal?: AbortSignal
    timeout?: number
    cache?: boolean
    auth?: boolean
  }
): Promise<Buffer> {
  options.signal?.throwIfAborted()
  const config = options.auth === false ? {} : await readRegistryNpmConfig()
  const authorization = registryAuth(url, config)
  const key = `${url.href}:${options.limit}:${createHash('sha256')
    .update(authorization ?? '')
    .digest('hex')}`
  const entry = cache.get(key)
  if (options.cache !== false && entry && entry.expires > Date.now()) return entry.body
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeout ?? 10_000),
    ...(options.signal ? [options.signal] : [])
  ])
  let current = url
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const auth = registryAuth(current, config)
      const response = await fetch(current, {
        signal,
        redirect: 'manual',
        headers: auth ? { Authorization: auth } : {}
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || redirects === 3) throw new L4PluginRegistryError('插件源重定向无效')
        const next = new URL(location, current)
        if (
          !['http:', 'https:'].includes(next.protocol) ||
          next.username ||
          next.password ||
          (current.protocol === 'https:' && next.protocol !== 'https:')
        )
          throw new L4PluginRegistryError('插件源重定向不安全')
        current = next
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        const reason =
          response.status === 404
            ? 'missing'
            : [401, 403].includes(response.status)
              ? 'denied'
              : response.status >= 500
                ? 'network'
                : 'invalid'
        throw new L4PluginRegistryError(
          `插件源请求失败（HTTP ${response.status}）`,
          response.status,
          reason
        )
      }
      const length = Number(response.headers.get('content-length') ?? 0)
      if (length > options.limit) {
        await response.body?.cancel()
        throw new L4PluginRegistryError('插件源响应超过大小限制')
      }
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            if (size > options.limit) throw new L4PluginRegistryError('插件源响应超过大小限制')
            chunks.push(next.value)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
      }
      const body = Buffer.concat(chunks)
      if (options.cache !== false) {
        for (const [cachedKey, cachedEntry] of cache) {
          if (cachedEntry.expires <= Date.now() || cachedKey === key) {
            cache.delete(cachedKey)
            cacheBytes -= cachedEntry.body.length
          }
        }
        while (cache.size >= 96 || cacheBytes + body.length > CACHE_BYTES) {
          const oldest = cache.entries().next().value
          if (!oldest) break
          cache.delete(oldest[0])
          cacheBytes -= oldest[1].body.length
        }
        if (body.length <= CACHE_BYTES) {
          cache.set(key, { body, expires: Date.now() + 120_000 })
          cacheBytes += body.length
        }
      }
      return body
    }
    throw new L4PluginRegistryError('插件源重定向过多')
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    if (error instanceof L4PluginRegistryError) throw error
    throw new L4PluginRegistryError('插件源网络连接失败或超时', 502, 'network')
  }
}

export async function fetchRegistryJson(
  url: URL,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const body = await fetchRegistryBytes(url, { limit: 8 * 1024 * 1024, signal })
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new L4PluginRegistryError('插件源返回的元数据格式无效')
  }
}
