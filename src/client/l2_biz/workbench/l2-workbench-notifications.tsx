'use client'

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  ChevronUpIcon,
  InfoIcon,
  XIcon
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L3AppNotification,
  L3AppNotificationLevel
} from '@common/l3_modules/app-runtime/l3-app-runtime-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import motion from './l2-workbench-notifications.module.css'

const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 180
const EXIT_DURATION_MS = 240
const MAX_VISIBLE_HISTORY_CARDS = 5

interface L2WorkbenchNotificationsProps {
  mobile: boolean
  notifications: readonly L3AppNotification[]
  onConsume: (notification: L3AppNotification) => Promise<void>
  onDismiss: (notificationId: string) => Promise<void>
}

const LEVEL_STYLES: Record<L3AppNotificationLevel, { icon: string; label: string }> = {
  info: {
    icon: 'bg-muted text-muted-foreground',
    label: 'noticeInfo'
  },
  success: {
    icon: 'bg-status-success/10 text-status-success',
    label: 'noticeSuccess'
  },
  warning: {
    icon: 'bg-status-warning/10 text-status-warning',
    label: 'noticeWarning'
  },
  error: {
    icon: 'bg-destructive/10 text-destructive',
    label: 'noticeError'
  }
}

function NotificationLevelIcon({ level }: { level: L3AppNotificationLevel }): React.JSX.Element {
  const className = 'size-3.5'
  switch (level) {
    case 'success':
      return <CheckCircle2Icon className={className} />
    case 'warning':
      return <AlertTriangleIcon className={className} />
    case 'error':
      return <CircleAlertIcon className={className} />
    case 'info':
      return <InfoIcon className={className} />
  }
}

function NotificationCard({
  notification,
  latest,
  mobile,
  moreCount,
  expanded = false,
  historyId,
  busy,
  onConsume,
  onDismiss,
  onToggleMore,
  showDismiss
}: {
  notification: L3AppNotification
  latest: boolean
  mobile: boolean
  moreCount: number
  expanded?: boolean
  historyId?: string
  busy: boolean
  onConsume: () => void
  onDismiss: () => void
  onToggleMore: () => void
  showDismiss: boolean
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const style = LEVEL_STYLES[notification.level]
  const canConsume = notification.event !== null

  return (
    <div
      data-testid={`app-notification-${notification.notificationId}`}
      data-latest={latest ? 'true' : undefined}
      title={[notification.title, notification.description].filter(Boolean).join('\n')}
      className="group flex h-14 min-w-0 items-stretch overflow-hidden rounded-lg hover:bg-foreground/[0.03]"
    >
      <button
        type="button"
        disabled={!canConsume || busy}
        onClick={onConsume}
        aria-label={
          canConsume
            ? t('actionableNotice', { level: t(style.label), title: notification.title })
            : t('noticeLabel', { level: t(style.label), title: notification.title })
        }
        className="grid min-w-0 flex-1 grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-2 px-2 text-left outline-none transition-colors enabled:cursor-pointer enabled:hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
      >
        <span
          key={`icon:${notification.notificationId}`}
          className={cn(
            'grid size-7 place-items-center rounded-lg',
            style.icon,
            latest && motion.incoming
          )}
        >
          <NotificationLevelIcon level={notification.level} />
        </span>
        <span
          key={notification.notificationId}
          className={cn('min-w-0', latest && motion.incoming)}
        >
          <span className="block truncate text-sm font-medium leading-5">{notification.title}</span>
          {notification.description ? (
            <span className="block truncate text-xs leading-5 text-muted-foreground">
              {notification.description}
            </span>
          ) : null}
        </span>
      </button>
      {latest && moreCount > 0 ? (
        <button
          data-testid="app-notification-more"
          type="button"
          disabled={busy}
          onClick={onToggleMore}
          aria-label={
            expanded ? t('close', { ns: 'common' }) : t('olderNotices', { count: moreCount })
          }
          aria-expanded={expanded}
          aria-controls={historyId}
          className="mr-1 flex h-7 min-w-9 shrink-0 items-center justify-center gap-0.5 self-center rounded-md px-1 text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
        >
          <span>+{moreCount}</span>
          <ChevronUpIcon
            className={cn(
              'size-3 transition-transform duration-200 motion-reduce:transition-none',
              expanded && 'rotate-180'
            )}
          />
        </button>
      ) : null}
      {showDismiss ? (
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          aria-label={t('deleteNotice', { title: notification.title })}
          title={t('dismissNotice')}
          className={cn(
            'mr-1 grid size-7 shrink-0 place-items-center self-center rounded-md text-muted-foreground outline-none transition-[background-color,color,opacity] hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50',
            !mobile && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export function L2WorkbenchNotifications({
  mobile,
  notifications,
  onConsume,
  onDismiss
}: L2WorkbenchNotificationsProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const historyId = useId()
  const slotRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const historyRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [busyNotificationId, setBusyNotificationId] = useState<string | null>(null)

  const visible = notifications.length > 0
  const [displayedNotifications, setDisplayedNotifications] = useState(notifications)
  if (visible && displayedNotifications !== notifications) setDisplayedNotifications(notifications)
  const latest = displayedNotifications.at(-1) ?? null
  const history = displayedNotifications.slice(0, -1)
  const canExpand = visible && history.length > 0
  if (!canExpand && expanded) setExpanded(false)
  const visibleExpanded = expanded && canExpand
  const expandedHeight = 6 + Math.min(history.length, MAX_VISIBLE_HISTORY_CARDS) * 3.5

  const clearOpenTimer = useCallback((): void => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current)
    openTimerRef.current = null
  }, [])
  const clearCloseTimer = useCallback((): void => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])
  const open = useCallback((): void => {
    clearOpenTimer()
    clearCloseTimer()
    if (canExpand) setExpanded(true)
  }, [canExpand, clearCloseTimer, clearOpenTimer])
  const close = useCallback((): void => {
    clearOpenTimer()
    clearCloseTimer()
    pinnedRef.current = false
    setExpanded(false)
  }, [clearCloseTimer, clearOpenTimer])
  const scheduleOpen = useCallback((): void => {
    if (mobile || !canExpand) return
    clearCloseTimer()
    clearOpenTimer()
    openTimerRef.current = setTimeout(open, OPEN_DELAY_MS)
  }, [canExpand, clearCloseTimer, clearOpenTimer, mobile, open])
  const scheduleClose = useCallback((): void => {
    if (pinnedRef.current) return
    clearOpenTimer()
    clearCloseTimer()
    closeTimerRef.current = setTimeout(close, CLOSE_DELAY_MS)
  }, [clearCloseTimer, clearOpenTimer, close])

  useLayoutEffect(() => {
    if (!visible && panelRef.current?.contains(document.activeElement)) slotRef.current?.focus()
  }, [visible])

  useEffect(() => {
    if (!canExpand) {
      pinnedRef.current = false
      clearOpenTimer()
      clearCloseTimer()
    }
    if (visible || displayedNotifications.length === 0) return
    // 只保留退场所需的展示快照；新通知到来时取消清理，不重放旧内容。
    const timer = setTimeout(() => setDisplayedNotifications([]), EXIT_DURATION_MS)
    return () => clearTimeout(timer)
  }, [canExpand, clearCloseTimer, clearOpenTimer, displayedNotifications.length, visible])

  useEffect(() => {
    if (!visibleExpanded) return
    const historyElement = historyRef.current
    if (historyElement) historyElement.scrollTop = historyElement.scrollHeight
  }, [history.length, visibleExpanded])

  useEffect(() => {
    if (!visibleExpanded) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!panelRef.current?.contains(event.target as Node)) close()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (panelRef.current?.contains(document.activeElement)) {
        panelRef.current
          .querySelector<HTMLButtonElement>('[data-testid="app-notification-more"]')
          ?.focus()
      }
      close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, visibleExpanded])

  useEffect(
    () => () => {
      clearOpenTimer()
      clearCloseTimer()
    },
    [clearCloseTimer, clearOpenTimer]
  )

  const consume = useCallback(
    async (notification: L3AppNotification): Promise<void> => {
      if (!notification.event || busyNotificationId) return
      setBusyNotificationId(notification.notificationId)
      close()
      try {
        await onConsume(notification)
      } finally {
        setBusyNotificationId(null)
      }
    },
    [busyNotificationId, close, onConsume]
  )
  const dismiss = useCallback(
    async (notificationId: string): Promise<void> => {
      if (busyNotificationId) return
      setBusyNotificationId(notificationId)
      try {
        await onDismiss(notificationId)
      } finally {
        setBusyNotificationId(null)
      }
    },
    [busyNotificationId, onDismiss]
  )
  const handlePointerEnter = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse') scheduleOpen()
  }
  const handlePointerLeave = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && !event.currentTarget.contains(document.activeElement))
      scheduleClose()
  }
  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose()
  }

  return (
    <div
      ref={slotRef}
      tabIndex={-1}
      data-testid="app-notification-slot"
      data-visible={visible ? 'true' : 'false'}
      className={motion.slot}
    >
      <div
        ref={panelRef}
        data-testid="app-notification-panel"
        data-expanded={visibleExpanded ? 'true' : 'false'}
        inert={!visible}
        aria-hidden={!visible}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onFocus={() => {
          if (!mobile) open()
        }}
        onBlur={handleBlur}
        className={motion.panel}
        style={{ height: `calc(${visibleExpanded ? expandedHeight : 3.5}rem + 2px)` }}
      >
        <div className={motion.surface}>
          <div
            id={historyId}
            className={motion.history}
            inert={!visibleExpanded}
            aria-hidden={!visibleExpanded}
          >
            <div className={motion.heading}>
              {t('notificationsTitle')}
              <span className="font-normal tabular-nums text-muted-foreground">
                {displayedNotifications.length}
              </span>
            </div>
            <div ref={historyRef} className={cn('pi-desk-chat-scrollbar', motion.historyList)}>
              {history.map((notification) => (
                <NotificationCard
                  key={notification.notificationId}
                  notification={notification}
                  latest={false}
                  mobile={mobile}
                  moreCount={0}
                  busy={busyNotificationId !== null}
                  onConsume={() => void consume(notification)}
                  onDismiss={() => void dismiss(notification.notificationId)}
                  onToggleMore={() => undefined}
                  showDismiss
                />
              ))}
            </div>
          </div>
          <div className={motion.latest}>
            {latest ? (
              <NotificationCard
                notification={latest}
                latest
                mobile={mobile}
                moreCount={history.length}
                expanded={visibleExpanded}
                historyId={historyId}
                busy={busyNotificationId !== null}
                onConsume={() => void consume(latest)}
                onDismiss={() => void dismiss(latest.notificationId)}
                onToggleMore={() => {
                  if (pinnedRef.current) close()
                  else {
                    pinnedRef.current = true
                    open()
                  }
                }}
                showDismiss={!mobile || history.length === 0 || visibleExpanded}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
