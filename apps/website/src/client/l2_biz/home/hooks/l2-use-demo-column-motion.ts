'use client'

import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useReducedMotion } from 'motion/react'

export function useDemoColumnMotion(
  containerRef: RefObject<HTMLDivElement | null>,
  layoutKey: string,
  enabled: boolean
): void {
  const reducedMotion = useReducedMotion()
  const previousPositions = useRef<{ width: number; leftById: Map<string, number> } | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || !enabled || reducedMotion) {
      previousPositions.current = null
      return
    }

    const columns = Array.from(
      container.querySelectorAll<HTMLElement>(':scope > [data-demo-column]')
    )
    // 与工作台一致：折叠切换只提交布局，只有窗格增删才移动剩余窗格。
    const topologyChanged =
      previousPositions.current !== null &&
      previousPositions.current.leftById.size !== columns.length
    const animations = new Map<HTMLElement, Animation>()
    const cancelAnimations = (): void => {
      for (const animation of animations.values()) animation.cancel()
      animations.clear()
    }
    const observer = new ResizeObserver(() => {
      const previous = previousPositions.current
      const width = container.clientWidth
      const leftById = new Map(
        columns.map((column) => [column.dataset.demoColumn!, column.offsetLeft])
      )
      const groupLeft = container.getBoundingClientRect().left
      const visibleLeftById = new Map(
        columns.map((column) => [
          column.dataset.demoColumn!,
          animations.has(column)
            ? column.getBoundingClientRect().left - groupLeft
            : previous?.leftById.get(column.dataset.demoColumn!)
        ])
      )
      cancelAnimations()
      previousPositions.current = { width, leftById }
      if (!topologyChanged || !previous || Math.abs(previous.width - width) > 1) return

      for (const column of columns) {
        const oldLeft = visibleLeftById.get(column.dataset.demoColumn!)
        const delta = oldLeft === undefined ? 0 : oldLeft - column.offsetLeft
        if (Math.abs(delta) < 1) continue
        const animation = column.animate(
          [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
          { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        )
        animations.set(column, animation)
        animation.onfinish = () => animations.delete(column)
      }
    })
    observer.observe(container)
    for (const column of columns) observer.observe(column)
    container.addEventListener('pointerdown', cancelAnimations, true)
    return () => {
      observer.disconnect()
      container.removeEventListener('pointerdown', cancelAnimations, true)
      cancelAnimations()
    }
  }, [containerRef, enabled, layoutKey, reducedMotion])
}
