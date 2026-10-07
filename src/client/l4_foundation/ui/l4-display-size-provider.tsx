'use client'

import { useEffect, type ReactNode } from 'react'
import {
  L4_DEFAULT_DISPLAY_SIZE,
  L4_DISPLAY_SIZE_STORAGE_KEY,
  L4_LEGACY_CHAT_SIZE_STORAGE_KEY,
  resolveL4DisplaySize,
  type L4DisplaySize
} from '@common/l4_foundation/l4-display-size'

const DISPLAY_SIZE_CHANGE_EVENT = 'pi-desk:display-size-change'
let memorySize: L4DisplaySize | null = null

function applyDisplaySize(size: L4DisplaySize): void {
  document.documentElement.dataset.piDeskDisplaySize = size
}

export function readL4DisplaySize(): L4DisplaySize {
  if (memorySize !== null) return memorySize
  try {
    const saved = window.localStorage.getItem(L4_DISPLAY_SIZE_STORAGE_KEY)
    const legacy: unknown =
      saved === null
        ? JSON.parse(window.localStorage.getItem(L4_LEGACY_CHAT_SIZE_STORAGE_KEY) ?? 'null')
        : null
    memorySize = resolveL4DisplaySize(saved, legacy)
  } catch {
    memorySize = L4_DEFAULT_DISPLAY_SIZE
  }
  return memorySize
}

export function saveL4DisplaySize(size: L4DisplaySize): void {
  memorySize = size
  try {
    window.localStorage.setItem(L4_DISPLAY_SIZE_STORAGE_KEY, size)
  } catch {
    // 存储不可用时，当前页面仍使用选择的档位。
  }
  applyDisplaySize(size)
  window.dispatchEvent(new Event(DISPLAY_SIZE_CHANGE_EVENT))
}

export function subscribeL4DisplaySize(listener: () => void): () => void {
  const handleStorage = (event: StorageEvent): void => {
    if (
      event.key !== null &&
      event.key !== L4_DISPLAY_SIZE_STORAGE_KEY &&
      event.key !== L4_LEGACY_CHAT_SIZE_STORAGE_KEY
    ) {
      return
    }
    memorySize = null
    listener()
  }
  window.addEventListener(DISPLAY_SIZE_CHANGE_EVENT, listener)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(DISPLAY_SIZE_CHANGE_EVENT, listener)
    window.removeEventListener('storage', handleStorage)
  }
}

export function L4DisplaySizeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  useEffect(() => {
    const syncSize = (): void => applyDisplaySize(readL4DisplaySize())
    const unsubscribe = subscribeL4DisplaySize(syncSize)
    syncSize()
    return unsubscribe
  }, [])

  return <>{children}</>
}
