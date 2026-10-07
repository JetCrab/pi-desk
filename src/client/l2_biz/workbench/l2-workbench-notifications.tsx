'use client'

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  EllipsisIcon,
  InfoIcon,
  XIcon
} from 'lucide-react'
import {
  useCallback,
  useEffect,
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

const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 180
const COLLAPSED_HEIGHT_PX = 64
const HISTORY_CARD_HEIGHT_PX = 60
const MAX_VISIBLE_HISTORY_CARDS = 5

interface L2WorkbenchNotificationsProps {
  mobile: boolean
  notifications: readonly L3AppNotification[]
  onConsume: (notification: L3AppNotification) => Promise<void>
  onDismiss: (notificationId: string) => Promise<void>
}

const LEVEL_STYLES: Record<L3AppNotificationLevel, { icon: string; label: string }> = {
  info: {
    icon: 'text-muted-foreground',
    label: 'noticeInfo'
  },
  success: {
    icon: 'text-status-success',
    label: 'noticeSuccess'
  },
  warning: {
    icon: 'text-status-warning',
    label: 'noticeWarning'
  },
  error: {
    icon: 'text-destructive',
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
      className={cn(
        'group flex min-w-0 items-stretch overflow-hidden rounded-lg bg-foreground/[0.04]',
        latest ? 'h-14' : 'min-h-14'
      )}
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
        className="grid min-w-0 flex-1 grid-cols-[1.6rem_minmax(0,1fr)_auto] items-center gap-1.5 px-2 text-left outline-none transition-colors enabled:cursor-pointer enabled:hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
      >
        <span className={cn('grid size-6 place-items-center rounded-md', style.icon)}>
          <NotificationLevelIcon level={notification.level} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium leading-5 text-foreground">
            {notification.title}
          </span>
          {notification.description ? (
            <span className="block truncate text-xs leading-5 text-muted-foreground">
              {notification.description}
            </span>
          ) : null}
        </span>
        {!mobile && latest && moreCount > 0 ? (
          <span className="px-1 text-xs tabular-nums text-muted-foreground">+{moreCount}</span>
        ) : null}
      </button>
      {mobile && latest && moreCount > 0 ? (
        <button
          data-testid="app-notification-more"
          type="button"
          disabled={busy}
          onClick={onToggleMore}
          aria-label={t('olderNotices', { count: moreCount })}
          className="mr-1 grid size-7 shrink-0 place-items-center self-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
        >
          <EllipsisIcon className="size-4" />
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
}: L2WorkbenchNotificationsProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const historyRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [busyNotificationId, setBusyNotificationId] = useState<string | null>(null)

  const latest = notifications.at(-1) ?? null
  const history = notifications.slice(0, -1)
  const canExpand = history.length > 0
  const visibleExpanded = expanded && canExpand
  const expandedHeight =
    COLLAPSED_HEIGHT_PX +
    Math.min(history.length, MAX_VISIBLE_HISTORY_CARDS) * HISTORY_CARD_HEIGHT_PX +
    8

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
    setExpanded(false)
  }, [clearCloseTimer, clearOpenTimer])
  const scheduleOpen = useCallback((): void => {
    if (mobile || !canExpand) return
    clearCloseTimer()
    clearOpenTimer()
    openTimerRef.current = setTimeout(open, OPEN_DELAY_MS)
  }, [canExpand, clearCloseTimer, clearOpenTimer, mobile, open])
  const scheduleClose = useCallback((): void => {
    if (mobile) return
    clearOpenTimer()
    clearCloseTimer()
    closeTimerRef.current = setTimeout(close, CLOSE_DELAY_MS)
  }, [clearCloseTimer, clearOpenTimer, close, mobile])

  useEffect(() => {
    if (!visibleExpanded) return
    const historyElement = historyRef.current
    if (historyElement) historyElement.scrollTop = historyElement.scrollHeight
  }, [history.length, visibleExpanded])

  useEffect(() => {
    if (!mobile || !visibleExpanded) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!panelRef.current?.contains(event.target as Node)) close()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, mobile, visibleExpanded])

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
      setExpanded(false)
      try {
        await onConsume(notification)
      } finally {
        setBusyNotificationId(null)
      }
    },
    [busyNotificationId, onConsume]
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
    if (event.pointerType === 'mouse') scheduleClose()
  }
  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose()
  }

  if (!latest) return null

  return (
    <div data-testid="app-notification-slot" className="relative z-20 h-16 shrink-0">
      <div
        ref={panelRef}
        data-testid="app-notification-panel"
        data-expanded={visibleExpanded ? 'true' : 'false'}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onFocus={() => {
          if (!mobile) open()
        }}
        onBlur={handleBlur}
        className={cn(
          'absolute inset-x-0 bottom-0 flex max-h-[calc(100dvh-8rem)] flex-col overflow-hidden bg-sidebar text-sidebar-foreground transition-[height,box-shadow] duration-150 ease-out motion-reduce:transition-none',
          visibleExpanded && 'shadow-lg duration-200'
        )}
        style={{ height: visibleExpanded ? expandedHeight : COLLAPSED_HEIGHT_PX }}
      >
        <div
          ref={historyRef}
          className={cn(
            'pi-desk-chat-scrollbar absolute inset-x-0 bottom-16 top-0 space-y-1 overflow-y-auto px-2 pt-2',
            !visibleExpanded && 'invisible'
          )}
        >
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
        <div className="absolute inset-x-0 bottom-0 h-16 px-2 py-1">
          <NotificationCard
            notification={latest}
            latest
            mobile={mobile}
            moreCount={history.length}
            busy={busyNotificationId !== null}
            onConsume={() => void consume(latest)}
            onDismiss={() => void dismiss(latest.notificationId)}
            onToggleMore={() => setExpanded((current) => !current)}
            showDismiss={!mobile || history.length === 0 || visibleExpanded}
          />
        </div>
      </div>
    </div>
  )
}
