'use client'

import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { calculateL2WorkSessionExpandedColumnCount } from '../l2-work-session-column-layout'

interface L2WorkSessionColumnCapacity {
  containerRef: RefObject<HTMLDivElement | null>
  expandedCount: number
}

export function useL2WorkSessionColumnCapacity(totalCount: number): L2WorkSessionColumnCapacity {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const initialExpandedCount = totalCount > 0 ? 1 : 0
  const expandedCountRef = useRef(initialExpandedCount)
  const [expandedCount, setExpandedCount] = useState(initialExpandedCount)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateCapacity = (width: number): void => {
      const next = calculateL2WorkSessionExpandedColumnCount(width, totalCount)
      if (expandedCountRef.current === next) return
      expandedCountRef.current = next
      setExpandedCount(next)
    }

    updateCapacity(container.clientWidth)
    const observer = new ResizeObserver((entries) => {
      updateCapacity(entries[0]?.contentRect.width ?? container.clientWidth)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [totalCount])

  return { containerRef, expandedCount }
}
