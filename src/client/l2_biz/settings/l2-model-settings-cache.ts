'use client'

import {
  L2ProjectModelDefaultGetResponseSchema,
  type L2ProjectModelDefaultGetResponse
} from '@common/l2_biz/model-settings/l2-model-settings-contract'

const PROJECT_DEFAULT_CACHE_KEY = 'pi-desk:project-model-defaults'
const MAX_PROJECT_DEFAULT_CACHE_ITEMS = 64

let loaded = false
const cache = new Map<string, L2ProjectModelDefaultGetResponse>()

function cacheKey(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function load(): void {
  if (loaded || typeof window === 'undefined') return
  loaded = true

  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(PROJECT_DEFAULT_CACHE_KEY) ?? 'null'
    )
    if (!value || typeof value !== 'object' || Array.isArray(value)) return

    for (const [key, item] of Object.entries(value)) {
      const parsed = L2ProjectModelDefaultGetResponseSchema.safeParse(item)
      if (parsed.success) cache.set(key, parsed.data)
    }
    let trimmed = false
    while (cache.size > MAX_PROJECT_DEFAULT_CACHE_ITEMS) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
      trimmed = true
    }
    if (trimmed) persist()
  } catch {
    cache.clear()
  }
}

function persist(): void {
  try {
    window.localStorage.setItem(
      PROJECT_DEFAULT_CACHE_KEY,
      JSON.stringify(Object.fromEntries(cache))
    )
  } catch {
    // 缓存不可用时仍在当前页面使用最新响应。
  }
}

export function readL2ProjectModelDefaultCache(
  cwd: string
): L2ProjectModelDefaultGetResponse | null {
  load()
  return cache.get(cacheKey(cwd)) ?? null
}

export function saveL2ProjectModelDefaultCache(response: L2ProjectModelDefaultGetResponse): void {
  const parsed = L2ProjectModelDefaultGetResponseSchema.safeParse(response)
  if (!parsed.success) return
  load()
  const key = cacheKey(parsed.data.cwd)
  cache.delete(key)
  cache.set(key, parsed.data)
  while (cache.size > MAX_PROJECT_DEFAULT_CACHE_ITEMS) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  persist()
}
