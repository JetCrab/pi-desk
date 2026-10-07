'use client'

import { useEffect, type ReactNode } from 'react'
import { useL4CodePreferences } from './l4-code-preferences'

export function L4CodePreferencesProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const { wrapLines } = useL4CodePreferences()
  useEffect(() => {
    const root = document.documentElement
    root.dataset.piDeskCodeWrap = String(wrapLines)
    root.style.setProperty('--pi-desk-code-white-space', wrapLines ? 'pre-wrap' : 'pre')
    root.style.setProperty('--pi-desk-code-overflow-wrap', wrapLines ? 'anywhere' : 'normal')
  }, [wrapLines])
  return <>{children}</>
}
