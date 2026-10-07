'use client'

import { useLayoutEffect, useRef, type RefObject } from 'react'
import { useReducedMotion } from 'motion/react'
import { useL4PowerSaving } from '@client/l4_foundation/ui/l4-power-saving'

interface ColumnPositions {
  width: number
  leftById: Map<string, number>
}

export function useL2WorkSessionColumnMotion(
  containerRef: RefObject<HTMLDivElement | null>,
  layoutKey: string,
  enabled: boolean
): void {
  const reducedMotion = useReducedMotion()
  const powerSaving = useL4PowerSaving()
  const previousPositions = useRef<ColumnPositions | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || !enabled || reducedMotion || powerSaving) {
      previousPositions.current = null
      return
    }

    const panels = Array.from(container.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.hasAttribute('data-panel')
    )
    // 同样的位置变化也可能来自切换折叠窗口；只有窗口增删才播放位移动画。
    const topologyChanged =
      previousPositions.current !== null &&
      previousPositions.current.leftById.size !== panels.length
    const animations = new Map<HTMLElement, Animation>()
    const cancelAnimations = (): void => {
      for (const animation of animations.values()) animation.cancel()
      animations.clear()
    }
    const observer = new ResizeObserver(() => {
      const previous = previousPositions.current
      const width = container.clientWidth
      const leftById = new Map(panels.map((panel) => [panel.id, panel.offsetLeft]))
      const groupLeft = container.getBoundingClientRect().left
      const visibleLeftById = new Map(
        panels.map((panel) => [
          panel.id,
          animations.has(panel)
            ? panel.getBoundingClientRect().left - groupLeft
            : previous?.leftById.get(panel.id)
        ])
      )
      const resizing =
        container.matches(':has([data-separator="active"])') ||
        container.parentElement
          ?.closest('.pi-desk-workbench-resize-group')
          ?.matches(':has([data-separator="active"])')
      cancelAnimations()
      previousPositions.current = { width, leftById }
      if (!topologyChanged || !previous || Math.abs(previous.width - width) > 1 || resizing) {
        return
      }

      // 尺寸由面板库一次提交；只移动窗口位置，不缩放正文或逐帧重排聊天。
      for (const panel of panels) {
        const oldLeft = visibleLeftById.get(panel.id)
        const delta = oldLeft === undefined ? 0 : oldLeft - panel.offsetLeft
        if (Math.abs(delta) < 1) continue
        const animation = panel.animate(
          [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
          { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        )
        animations.set(panel, animation)
        animation.onfinish = () => animations.delete(panel)
      }
    })
    observer.observe(container)
    for (const panel of panels) observer.observe(panel)
    container.addEventListener('pointerdown', cancelAnimations, true)
    return () => {
      observer.disconnect()
      container.removeEventListener('pointerdown', cancelAnimations, true)
      cancelAnimations()
    }
  }, [containerRef, enabled, layoutKey, powerSaving, reducedMotion])
}
