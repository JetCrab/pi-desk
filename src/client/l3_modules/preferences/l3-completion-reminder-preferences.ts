'use client'

export interface L3CompletionReminderPreferences {
  system: boolean
  sound: boolean
  attention: boolean
}

const STORAGE_KEY = 'pi-desk:completion-reminders'
export const L3_DEFAULT_COMPLETION_REMINDERS: Readonly<L3CompletionReminderPreferences> = {
  system: true,
  sound: true,
  attention: true
}

const listeners = new Set<() => void>()
let preferences: Readonly<L3CompletionReminderPreferences> = L3_DEFAULT_COMPLETION_REMINDERS
let initialized = false

export function readL3CompletionReminders(): Readonly<L3CompletionReminderPreferences> {
  if (initialized || typeof window === 'undefined') return preferences
  initialized = true
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof value === 'object' && value !== null) {
      const saved = value as Record<string, unknown>
      preferences = {
        system: typeof saved.system === 'boolean' ? saved.system : true,
        sound: typeof saved.sound === 'boolean' ? saved.sound : true,
        attention: typeof saved.attention === 'boolean' ? saved.attention : true
      }
    }
  } catch (cause) {
    console.warn('[Pi Desk][Reminders] 读取提醒偏好失败，使用默认设置', cause)
  }
  return preferences
}

export function saveL3CompletionReminders(changes: Partial<L3CompletionReminderPreferences>): void {
  preferences = { ...readL3CompletionReminders(), ...changes }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch (cause) {
    console.warn('[Pi Desk][Reminders] 保存提醒偏好失败，仅当前页面生效', cause)
  }
  for (const listener of listeners) listener()
}

export function subscribeL3CompletionReminders(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
