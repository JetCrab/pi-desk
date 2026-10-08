'use client'

import { useEffect, useReducer, useState, useSyncExternalStore, type RefObject } from 'react'
import { showcaseChapters } from '../l2-showcase-story'

export type PlaybackState = { chapter: number; step: number; elapsed: number }
export type PlaybackAction =
  | { type: 'chapter'; chapter: number }
  | { type: 'step'; step: number }
  | { type: 'tick'; delta: number }

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'chapter':
      return { chapter: action.chapter, step: 0, elapsed: 0 }
    case 'step':
      return { ...state, step: action.step, elapsed: 0 }
    case 'tick': {
      const steps = showcaseChapters[state.chapter].steps
      let step = state.step
      let elapsed = state.elapsed + action.delta
      while (elapsed >= steps[step].duration) {
        elapsed -= steps[step].duration
        step = (step + 1) % steps.length
      }
      return { ...state, step, elapsed }
    }
  }
}

function subscribeMotion(listener: () => void): () => void {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

function readMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function readVisibility(): boolean {
  return !document.hidden
}

function serverPreference(): boolean {
  return false
}

export function useShowcase(
  ref: RefObject<HTMLElement | null>,
  chapter: number,
  paused: boolean
): {
  chapter: number
  step: number
  elapsed: number
  progress: number
  stepProgress: number
  running: boolean
  replayKey: number
  seek: (step: number) => void
  selectStep: (step: number) => void
} {
  const reducedMotion = useSyncExternalStore(subscribeMotion, readMotion, serverPreference)
  const pageVisible = useSyncExternalStore(subscribeVisibility, readVisibility, serverPreference)
  const [visible, setVisible] = useState(false)
  const [state, dispatch] = useReducer(playbackReducer, { chapter, step: 0, elapsed: 0 })
  // 在提交新章节画面前同步播放位置，不能先显示上一章的阶段。
  if (state.chapter !== chapter) dispatch({ type: 'chapter', chapter })
  // 时间轴跳转需要重建演示状态，普通场景内操作不能触发重建。
  const [replayKey, restartScene] = useReducer((value: number): number => value + 1, 0)
  const running = visible && pageVisible && !reducedMotion && !paused
  const steps = showcaseChapters[state.chapter].steps
  const completed = steps.slice(0, state.step).reduce((sum, step) => sum + step.duration, 0)
  const duration = steps.reduce((sum, step) => sum + step.duration, 0)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.intersectionRatio >= 0.5),
      { threshold: [0, 0.5, 1] }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  useEffect(() => {
    if (!running) return
    let previous = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      dispatch({ type: 'tick', delta: now - previous })
      previous = now
    }, 40)
    return () => window.clearInterval(timer)
  }, [running])

  return {
    chapter: state.chapter,
    step: state.step,
    elapsed: state.elapsed,
    progress: (completed + state.elapsed) / duration,
    stepProgress: state.elapsed / steps[state.step].duration,
    running,
    replayKey,
    seek: (step) => {
      restartScene()
      dispatch({ type: 'step', step })
    },
    selectStep: (step) => dispatch({ type: 'step', step })
  }
}
