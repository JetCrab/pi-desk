'use client'

import { useEffect, type ReactNode } from 'react'
import {
  isL4Theme,
  L4_DEFAULT_THEME,
  L4_THEME_STORAGE_KEY,
  resolveL4Theme,
  type L4Theme
} from '@common/l4_foundation/theme/l4-theme'

const THEME_CHANGE_EVENT = 'pi-desk:theme-change'
let memoryTheme: L4Theme | null = null

function systemUsesDarkTheme(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyL4Theme(theme: L4Theme): void {
  const resolved = resolveL4Theme(theme, systemUsesDarkTheme())
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
}

export function readL4Theme(): L4Theme {
  if (memoryTheme !== null) return memoryTheme

  try {
    const saved = window.localStorage.getItem(L4_THEME_STORAGE_KEY)
    memoryTheme = isL4Theme(saved) ? saved : L4_DEFAULT_THEME
  } catch {
    memoryTheme = L4_DEFAULT_THEME
  }
  return memoryTheme
}

export function saveL4Theme(theme: L4Theme): void {
  memoryTheme = theme
  try {
    window.localStorage.setItem(L4_THEME_STORAGE_KEY, theme)
  } catch {
    // 存储不可用时仍在当前页面应用选择。
  }
  applyL4Theme(theme)
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
}

export function subscribeL4Theme(listener: () => void): () => void {
  const handleStorage = (event: StorageEvent): void => {
    if (event.key !== L4_THEME_STORAGE_KEY) return
    memoryTheme = isL4Theme(event.newValue) ? event.newValue : L4_DEFAULT_THEME
    listener()
  }

  window.addEventListener(THEME_CHANGE_EVENT, listener)
  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, listener)
    window.removeEventListener('storage', handleStorage)
  }
}

export function L4ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const syncTheme = (): void => applyL4Theme(readL4Theme())
    const unsubscribe = subscribeL4Theme(syncTheme)

    syncTheme()
    media.addEventListener('change', syncTheme)
    return () => {
      unsubscribe()
      media.removeEventListener('change', syncTheme)
    }
  }, [])

  return <>{children}</>
}
