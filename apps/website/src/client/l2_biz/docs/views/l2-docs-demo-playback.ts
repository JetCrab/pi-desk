'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'

function subscribeMotion(listener: () => void): () => void {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useDocsDemoPlayback(steps: readonly { duration: number }[]): {
  root: RefObject<HTMLElement | null>
  step: number
  playing: boolean
  running: boolean
  selectStep: (next: number) => void
  togglePlaying: () => void
} {
  const [step, setStep] = useState(0)
  const [requested, setRequested] = useState<boolean | null>(null)
  const reducedMotion = useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => true)
  const playing = requested ?? !reducedMotion
  const [visible, setVisible] = useState(false)
  const root = useRef<HTMLElement>(null)
  const running = playing && visible

  useEffect(() => {
    const element = root.current
    if (!element) return
    let inView = false
    const syncVisibility = (): void => setVisible(inView && !document.hidden)
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry.intersectionRatio >= 0.35
        syncVisibility()
      },
      { threshold: [0, 0.35] }
    )
    observer.observe(element)
    document.addEventListener('visibilitychange', syncVisibility)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', syncVisibility)
    }
  }, [])

  useEffect(() => {
    if (!running) return
    const timer = window.setTimeout(() => setStep((step + 1) % steps.length), steps[step].duration)
    return () => window.clearTimeout(timer)
  }, [running, step, steps])

  function selectStep(next: number): void {
    setRequested(false)
    setStep(next)
  }

  function togglePlaying(): void {
    setRequested(!playing)
  }

  return { root, step, playing, running, selectStep, togglePlaying }
}
