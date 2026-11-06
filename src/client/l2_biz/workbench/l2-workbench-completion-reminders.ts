import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import { readL3CompletionReminders } from '@client/l3_modules/preferences/l3-completion-reminder-preferences'
import {
  clearL4ClientReminder,
  disposeL4ClientReminders,
  prepareL4ReminderSound,
  sendL4ClientReminder
} from '@client/l4_foundation/l4-client-reminders'

export function findL2CompletedWorkSessions(
  previous: readonly L2WorkSessionListItem[],
  next: readonly L2WorkSessionListItem[]
): L2WorkSessionListItem[] {
  const before = new Map(previous.map((session) => [session.workId, session]))
  return next.filter((session) => {
    if (session.status !== 'completed') return false
    const old = before.get(session.workId)
    return (
      old?.sessionId === session.sessionId &&
      old.branchId === session.branchId &&
      (old.status === 'main_running' || old.status === 'background_running')
    )
  })
}

export function remindL2CompletedWorkSessions(
  previous: readonly L2WorkSessionListItem[],
  next: readonly L2WorkSessionListItem[],
  title: string
): void {
  if (document.visibilityState === 'visible' && document.hasFocus()) return
  const preferences = readL3CompletionReminders()
  for (const session of findL2CompletedWorkSessions(previous, next)) {
    void sendL4ClientReminder({
      title,
      body: session.sessionTitle ?? session.projectName,
      ...preferences
    }).catch((cause: unknown) => {
      console.warn('[Pi Desk][Reminders] 会话完成提醒失败', {
        workId: session.workId,
        cause
      })
    })
  }
}

export function startL2CompletionReminders(): () => void {
  const onFocus = (): void => {
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return
    void clearL4ClientReminder().catch((cause: unknown) => {
      console.warn('[Pi Desk][Reminders] 清除桌面提醒失败', cause)
    })
  }
  const onInteraction = (): void => {
    if (!readL3CompletionReminders().sound) return
    void prepareL4ReminderSound().catch((cause: unknown) => {
      console.warn('[Pi Desk][Reminders] 初始化提示音失败', cause)
    })
  }
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onFocus)
  document.addEventListener('pointerdown', onInteraction)
  document.addEventListener('keydown', onInteraction)
  return () => {
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onFocus)
    document.removeEventListener('pointerdown', onInteraction)
    document.removeEventListener('keydown', onInteraction)
    disposeL4ClientReminders()
  }
}
