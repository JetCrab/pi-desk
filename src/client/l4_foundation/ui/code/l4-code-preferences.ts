'use client'

import { useSyncExternalStore } from 'react'
import { z } from 'zod'

const STORAGE_KEY = 'pi-super:code-preferences'
const LEGACY_STORAGE_KEY = 'pi-super:project-preview:global'
const PreferencesSchema = z.object({
  wrapLines: z.boolean().default(true),
  diffViewMode: z.enum(['side-by-side', 'inline']).default('side-by-side'),
  collapseUnchanged: z.boolean().default(true)
})
type CodePreferences = z.infer<typeof PreferencesSchema>
const DEFAULT_PREFERENCES = PreferencesSchema.parse({})
const listeners = new Set<() => void>()
let snapshot: CodePreferences | null = null

function persist(value: CodePreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch (cause) {
    console.warn('[Pi Desk][CodePreferences] 保存代码显示偏好失败', cause)
  }
}

function load(): CodePreferences {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved !== null) {
      const parsed = PreferencesSchema.safeParse(JSON.parse(saved))
      return parsed.success ? parsed.data : DEFAULT_PREFERENCES
    }
    // 旧项目预览的选择只迁入一次，不再由布局记录维护第二份偏好。
    const legacy = z
      .object({ wrapLines: z.boolean() })
      .safeParse(JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? 'null'))
    if (legacy.success) {
      const migrated = { ...DEFAULT_PREFERENCES, wrapLines: legacy.data.wrapLines }
      persist(migrated)
      return migrated
    }
  } catch {
    // 浏览器存储不可用或旧记录损坏时，仍可使用默认设置。
  }
  return DEFAULT_PREFERENCES
}

function equal(left: CodePreferences | null, right: CodePreferences): boolean {
  return (
    left?.wrapLines === right.wrapLines &&
    left.diffViewMode === right.diffViewMode &&
    left.collapseUnchanged === right.collapseUnchanged
  )
}

function publish(): void {
  for (const listener of listeners) listener()
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== STORAGE_KEY) return
  const next = load()
  if (equal(snapshot, next)) return
  snapshot = next
  publish()
}

export function readL4CodePreferences(): CodePreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES
  snapshot ??= load()
  return snapshot
}

export function saveL4CodePreferences(change: Partial<CodePreferences>): void {
  const next = PreferencesSchema.parse({ ...readL4CodePreferences(), ...change })
  if (equal(snapshot, next)) return
  snapshot = next
  if (typeof window !== 'undefined') persist(next)
  publish()
}

export function subscribeL4CodePreferences(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    snapshot = load()
    window.addEventListener('storage', onStorage)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined')
      window.removeEventListener('storage', onStorage)
  }
}

export function useL4CodePreferences(): CodePreferences {
  return useSyncExternalStore(
    subscribeL4CodePreferences,
    readL4CodePreferences,
    () => DEFAULT_PREFERENCES
  )
}
