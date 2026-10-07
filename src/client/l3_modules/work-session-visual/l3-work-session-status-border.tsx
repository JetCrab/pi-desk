'use client'

import { useLayoutEffect, useRef } from 'react'
import styles from './l3-work-session-visual-effects.module.css'

export type L3WorkSessionVisualState = 'running' | 'completed' | 'idle'

export function L3WorkSessionStatusBorder({
  state,
  powerSaving
}: {
  state: L3WorkSessionVisualState
  powerSaving: boolean
}): React.JSX.Element | null {
  const rectRef = useRef<SVGRectElement>(null)

  useLayoutEffect(() => {
    const rect = rectRef.current
    if (!rect || powerSaving || state === 'idle') return

    const length = state === 'completed' ? 30 : 14
    const animation = rect.animate(
      [{ strokeDashoffset: length }, { strokeDashoffset: length - 100 }],
      { duration: 6000, iterations: Infinity, easing: 'linear' }
    )
    let visible = true

    const sync = (): void => {
      if (document.hidden || !visible) {
        animation.pause()
      } else {
        // 共用 document.timeline 的零点；新挂载、状态变化和恢复可见都不从头计时。
        animation.play()
        animation.startTime = 0
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      sync()
    })
    observer.observe(rect)
    document.addEventListener('visibilitychange', sync)
    sync()

    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', sync)
      animation.cancel()
    }
  }, [powerSaving, state])

  if (powerSaving || state === 'idle') return null

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-testid="work-session-status-border"
      data-state={state}
      className={styles.statusBorder}
    >
      {/* pathLength 归一化周长；改变线长时向后延伸，前端始终落在统一进度上。 */}
      <rect ref={rectRef} x="1" y="1" pathLength="100" />
    </svg>
  )
}
