'use client'

export type L3NewWorkSessionBehavior = 'none' | 'activate' | 'pin'

const NEW_WORK_SESSION_BEHAVIOR_STORAGE_KEY = 'pi-super:new-work-session-behavior'
const DEFAULT_NEW_WORK_SESSION_BEHAVIOR: L3NewWorkSessionBehavior = 'activate'

const listeners = new Set<() => void>()
let behavior: L3NewWorkSessionBehavior = DEFAULT_NEW_WORK_SESSION_BEHAVIOR
let initialized = false

function parseNewWorkSessionBehavior(value: string | null): L3NewWorkSessionBehavior {
  if (value === 'none' || value === 'activate' || value === 'pin') return value
  return DEFAULT_NEW_WORK_SESSION_BEHAVIOR
}

function initialize(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  try {
    behavior = parseNewWorkSessionBehavior(
      window.localStorage.getItem(NEW_WORK_SESSION_BEHAVIOR_STORAGE_KEY)
    )
  } catch {
    behavior = DEFAULT_NEW_WORK_SESSION_BEHAVIOR
  }
}

export function readL3NewWorkSessionBehavior(): L3NewWorkSessionBehavior {
  initialize()
  return behavior
}

export function saveL3NewWorkSessionBehavior(nextBehavior: L3NewWorkSessionBehavior): void {
  initialize()
  if (behavior === nextBehavior) return
  behavior = nextBehavior
  try {
    window.localStorage.setItem(NEW_WORK_SESSION_BEHAVIOR_STORAGE_KEY, nextBehavior)
  } catch {
    // 存储不可用时仍在当前页面应用设置。
  }
  for (const listener of [...listeners]) listener()
}

export function subscribeL3NewWorkSessionBehavior(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
