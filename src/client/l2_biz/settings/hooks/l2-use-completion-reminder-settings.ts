'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  L3_DEFAULT_COMPLETION_REMINDERS,
  readL3CompletionReminders,
  saveL3CompletionReminders,
  subscribeL3CompletionReminders,
  type L3CompletionReminderPreferences
} from '@client/l3_modules/preferences/l3-completion-reminder-preferences'
import {
  clearL4ClientReminder,
  getL4NotificationPermission,
  prepareL4ReminderSound,
  readL4ReminderPlatform,
  sendL4ClientReminder,
  subscribeL4ReminderPlatform,
  type L4NotificationPermission,
  type L4ReminderPlatform
} from '@client/l4_foundation/l4-client-reminders'

interface L2CompletionReminderSettings {
  preferences: Readonly<L3CompletionReminderPreferences>
  platform: L4ReminderPlatform
  permission: L4NotificationPermission | null
  busy: boolean
  error: unknown
  authorize: () => void
  setSystem: (enabled: boolean) => void
  setSound: (enabled: boolean) => void
  setAttention: (enabled: boolean) => void
  test: (title: string, body: string) => void
}

export function useL2CompletionReminderSettings(): L2CompletionReminderSettings {
  const preferences = useSyncExternalStore(
    subscribeL3CompletionReminders,
    readL3CompletionReminders,
    () => L3_DEFAULT_COMPLETION_REMINDERS
  )
  const platform = useSyncExternalStore(
    subscribeL4ReminderPlatform,
    readL4ReminderPlatform,
    (): L4ReminderPlatform => 'web'
  )
  const [permission, setPermission] = useState<L4NotificationPermission | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    const refresh = (): void => {
      void getL4NotificationPermission().then(
        (value) => {
          if (active) setPermission(value)
        },
        (cause: unknown) => {
          console.warn('[Pi Desk][Reminders] 查询通知权限失败', cause)
          if (active) setError(cause)
        }
      )
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
    }
  }, [platform])

  const run = useCallback((action: () => Promise<unknown>): void => {
    setError(null)
    setBusy(true)
    void action()
      .catch((cause: unknown) => {
        console.warn('[Pi Desk][Reminders] 提醒设置操作失败', cause)
        if (mounted.current) setError(cause)
      })
      .finally(() => {
        if (mounted.current) setBusy(false)
      })
  }, [])

  const authorize = useCallback((): void => {
    run(async () => {
      const value = await getL4NotificationPermission(true)
      if (mounted.current) setPermission(value)
    })
  }, [run])

  return {
    preferences,
    platform,
    permission,
    busy,
    error,
    authorize,
    setSystem(enabled: boolean): void {
      saveL3CompletionReminders({ system: enabled })
      if (enabled && permission === 'default') authorize()
    },
    setSound(enabled: boolean): void {
      saveL3CompletionReminders({ sound: enabled })
      if (enabled) run(prepareL4ReminderSound)
    },
    setAttention(enabled: boolean): void {
      saveL3CompletionReminders({ attention: enabled })
      if (!enabled) run(clearL4ClientReminder)
    },
    test(title: string, body: string): void {
      run(async () => {
        if (preferences.sound) await prepareL4ReminderSound()
        await sendL4ClientReminder({ title, body, ...preferences })
      })
    }
  }
}
