'use client'

import { useEffect, useState, type RefObject } from 'react'

export function useDemoViewport(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const container = ref.current?.closest<HTMLElement>('#showcase')
    if (!container) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(container)
    return () => observer.disconnect()
  }, [ref])
  return width
}
