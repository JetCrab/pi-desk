'use client'

import { useState, type Dispatch, type SetStateAction } from 'react'

// 分镜只在阶段变化时应用；普通查看和关闭操作不改变播放位置或业务事实。
export function useDemoState<S>(
  step: number,
  initial: (step: number) => S,
  advance: (state: S, step: number) => S
): [S, Dispatch<SetStateAction<S>>] {
  const [frame, setFrame] = useState(() => ({ step, value: initial(step) }))
  let current = frame
  if (frame.step !== step) {
    current = { step, value: step === 0 ? initial(0) : advance(frame.value, step) }
    setFrame(current)
  }
  const update: Dispatch<SetStateAction<S>> = (value) => {
    setFrame((previous) => ({
      ...previous,
      value: typeof value === 'function' ? (value as (previous: S) => S)(previous.value) : value
    }))
  }
  return [current.value, update]
}
