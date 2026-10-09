'use client'

import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import {
  CopyIcon,
  EllipsisIcon,
  FolderTreeIcon,
  FolderSearchIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  Repeat2Icon,
  SettingsIcon,
  TerminalIcon,
  Trash2Icon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { BrowserContributionIcon } from '@jetcrab/pi-desk-sdk/browser'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L3AppNotification } from '@common/l3_modules/app-runtime/l3-app-runtime-contract'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { L4PluginIcon } from '@client/l4_foundation/plugin-host/l4-plugin-icon'
import { L4ScrollArea } from '@client/l4_foundation/ui/l4-scroll-area'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { buttonVariants } from '@client/l4_foundation/ui/shadcn/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@client/l4_foundation/ui/shadcn/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@client/l4_foundation/ui/shadcn/dropdown-menu'
import {
  getL3WorkSessionIdentityPresentation,
  getL3WorkSessionSurfacePresentation
} from '@client/l3_modules/work-session-visual/l3-work-session-visual-view'
import { calculateL2SidebarShortcutLayout } from './l2-work-session-sidebar-layout'
import { L2WorkbenchNotifications } from './l2-workbench-notifications'
import {
  getL2WorkSessionVisualSortableIds,
  L2_WORK_SESSION_PIN_BOUNDARY_ID,
  moveL2WorkSessionVisual,
  type L2WorkSessionArrangement
} from './l2-work-session-sidebar-order'
import { formatL2WorkSessionUpdatedAt } from './l2-work-session-sidebar-display'
import styles from './l2-work-session-sidebar.module.css'

export type L2WorkSessionSidebarMode = 'sessions' | 'files' | `plugin:${string}:${string}`

export interface L2SidebarPluginApplication {
  pluginName: string
  contributionName: string
  label: string
  icon?: BrowserContributionIcon
}

export interface L2SidebarPluginSessionTab {
  pluginName: string
  contributionName: string
  label: string
  icon?: BrowserContributionIcon
}

export function getL2PluginSessionSidebarMode(
  pluginName: string,
  contributionName: string
): L2WorkSessionSidebarMode {
  return `plugin:${pluginName}:${contributionName}`
}

interface L2WorkSessionSidebarProps {
  mode: L2WorkSessionSidebarMode
  mobile: boolean
  fileBrowser: ReactNode
  pluginTabContent: ReactNode
  pluginSessionTabs: readonly L2SidebarPluginSessionTab[]
  fileRefreshLoading: boolean
  canBrowseFiles: boolean
  workSessions: readonly L2WorkSessionListItem[]
  focusedWorkId: string | null
  pinnedCount: number
  ordering: boolean
  deletingWorkId: string | null
  canReplace: boolean
  disabled: boolean
  pluginApplications: readonly L2SidebarPluginApplication[]
  settingsAttention: 'error' | 'notice' | null
  notifications: readonly L3AppNotification[]
  onConsumeNotification: (notification: L3AppNotification) => Promise<void>
  onDismissNotification: (notificationId: string) => Promise<void>
  onModeChange: (mode: L2WorkSessionSidebarMode) => void
  onRefreshFiles: () => void
  onPreviewProject: () => void
  onOpenTerminal: () => void
  onCreate: () => void
  onReplace: () => void
  onSettings: () => void
  onOpenPluginApplication: (application: L2SidebarPluginApplication) => void
  onSelect: (workId: string) => void
  onTogglePin: (workId: string) => void
  onDelete: (workId: string) => void
  onArrangementChange: (arrangement: L2WorkSessionArrangement, movedWorkId: string) => void
}

const WORK_SESSION_DRAG_DOT_POINTS = [
  [5, 3],
  [11, 3],
  [5, 8],
  [11, 8],
  [5, 13],
  [11, 13]
] as const
const WORK_SESSION_TOUCH_DRAG_DELAY_MS = 250
const WORK_SESSION_TOUCH_DRAG_TOLERANCE_PX = 8
const SIDEBAR_SHORTCUT_SIZE_PX = 56
const SIDEBAR_SHORTCUT_INITIAL_COLUMNS = 3
const SIDEBAR_SHORTCUT_DESKTOP_MAX_ROWS = 3
const SIDEBAR_SHORTCUT_MOBILE_MAX_ROWS = 2
const SIDEBAR_SHORTCUT_CLASS = cn(
  buttonVariants({ variant: 'ghost' }),
  styles.sidebarAction,
  'relative h-[3.25rem] max-w-24 min-w-0 flex-1 flex-col gap-1 whitespace-normal px-1 text-xs font-normal text-muted-foreground'
)
const SIDEBAR_HEADER_MODE_BUTTON_CLASS = buttonVariants({ variant: 'ghost', size: 'icon' })
const SIDEBAR_HEADER_ACTION_BUTTON_CLASS = cn(
  buttonVariants({ variant: 'ghost', size: 'icon' }),
  styles.sidebarAction,
  'text-muted-foreground'
)

type L2SidebarHeaderItemAppearance = 'mode' | 'action'

interface L2SidebarHeaderItem {
  key: string
  label: string
  icon: ReactNode
  disabled?: boolean
  busy?: boolean
  pressed?: boolean
  testId?: string
  onSelect: () => void
}

function sidebarHeaderButtonClass(
  appearance: L2SidebarHeaderItemAppearance,
  pressed: boolean,
  busy: boolean
): string {
  if (appearance === 'mode') {
    return cn(
      SIDEBAR_HEADER_MODE_BUTTON_CLASS,
      pressed
        ? 'bg-accent text-accent-foreground'
        : cn(styles.sidebarAction, 'text-muted-foreground')
    )
  }

  return cn(
    SIDEBAR_HEADER_ACTION_BUTTON_CLASS,
    pressed && 'bg-muted text-foreground',
    busy ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed'
  )
}

function SidebarHeaderGroup({
  items,
  appearance,
  label,
  className
}: {
  items: readonly L2SidebarHeaderItem[]
  appearance: L2SidebarHeaderItemAppearance
  label: string
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <div
      className={cn('flex min-w-0 items-center gap-0', className)}
      role="group"
      aria-label={label}
    >
      {items.map((item) => (
        <button
          key={item.key}
          data-testid={item.testId}
          type="button"
          disabled={item.disabled}
          aria-pressed={item.pressed}
          aria-label={
            appearance === 'mode' ? t('showSidebarMode', { name: item.label }) : item.label
          }
          title={item.label}
          onClick={item.onSelect}
          className={sidebarHeaderButtonClass(
            appearance,
            item.pressed === true,
            item.busy === true
          )}
        >
          <span
            className={cn(
              'flex shrink-0',
              appearance === 'mode' ? '[&_svg]:size-5' : '[&_svg]:size-4'
            )}
          >
            {item.icon}
          </span>
        </button>
      ))}
    </div>
  )
}

function SidebarHeader({
  modeItems,
  actionItems
}: {
  modeItems: readonly L2SidebarHeaderItem[]
  actionItems: readonly L2SidebarHeaderItem[]
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-2 px-2">
      <SidebarHeaderGroup
        items={modeItems}
        appearance="mode"
        label={t('sidebarContents')}
        className="max-w-full overflow-x-auto rounded-lg p-0.5 dark:bg-muted"
      />
      {actionItems.length > 0 ? (
        <SidebarHeaderGroup
          items={actionItems}
          appearance="action"
          label={t('sidebarActions')}
          className="ml-auto shrink-0"
        />
      ) : null}
    </header>
  )
}

function WorkSessionDragIcon(): React.JSX.Element {
  return (
    <svg className="block size-full" viewBox="0 0 16 16" aria-hidden="true">
      {WORK_SESSION_DRAG_DOT_POINTS.map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.15" fill="currentColor" />
      ))}
    </svg>
  )
}

function workSessionStatusLabel(workSession: L2WorkSessionListItem): string {
  switch (workSession.status) {
    case 'main_running':
      return 'mainRunning'
    case 'background_running':
      return 'backgroundRunning'
    case 'completed':
      return 'completedUnread'
    case 'idle':
      return 'idle'
  }
}

const SortableWorkSessionRow = memo(function SortableWorkSessionRow({
  workSession,
  mobile,
  selected,
  pinned,
  deleting,
  disabled,
  ordering,
  now,
  onSelect,
  onTogglePin,
  onDelete
}: {
  workSession: L2WorkSessionListItem
  mobile: boolean
  selected: boolean
  pinned: boolean
  deleting: boolean
  disabled: boolean
  ordering: boolean
  now: number | null
  onSelect: (workId: string) => void
  onTogglePin: (workId: string) => void
  onDelete: (workId: string) => void
}): React.JSX.Element {
  const actionsDisabled = disabled || ordering
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: workSession.workId, disabled: actionsDisabled })
  const toast = useL4AppToast()
  const { t } = useTranslation('workbench')
  const { locale, timeZone } = useL4Region()
  const statusLabel = t(workSessionStatusLabel(workSession))
  const sessionTitle = workSession.sessionTitle ?? t('newSession')
  const messageSummary = `${workSession.messageCounts.user}/${workSession.messageCounts.total}`
  const updatedAt = formatL2WorkSessionUpdatedAt(
    workSession.lastMessageUpdatedAt,
    now,
    locale,
    timeZone
  )
  const running =
    workSession.status === 'main_running' || workSession.status === 'background_running'
  const surface = getL3WorkSessionSurfacePresentation(workSession.cwd)
  const identity = getL3WorkSessionIdentityPresentation(workSession.cwd)
  const transformStyle = transform
    ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
    : undefined
  const select = useCallback(() => onSelect(workSession.workId), [onSelect, workSession.workId])
  const togglePin = useCallback(
    () => onTogglePin(workSession.workId),
    [onTogglePin, workSession.workId]
  )
  const deleteSession = useCallback(
    () => onDelete(workSession.workId),
    [onDelete, workSession.workId]
  )
  const copyProjectPath = useCallback((): void => {
    void copyL4BrowserText(workSession.cwd).then((copied) => {
      if (copied) {
        toast.success(t('copiedProjectPath'))
        return
      }
      toast.error(t('copyProjectPathFailed'))
    })
  }, [toast, workSession.cwd, t])

  const row = (
    <div
      ref={setNodeRef}
      data-testid={`work-session-row-${workSession.workId}`}
      data-dragging={isDragging ? 'true' : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={select}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          select()
        }
      }}
      className={cn(
        surface.className,
        styles.sessionRow,
        !mobile && styles.desktopRow,
        'grid min-h-15 min-w-0 cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)] items-center rounded-lg border border-transparent px-1 py-0.5 outline-none transition-[background-color,opacity] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        selected ? 'text-accent-foreground' : 'hover:text-foreground',
        workSession.status === 'completed' && 'border-[var(--pi-desk-project-color)]',
        isDragging && 'cursor-grabbing opacity-30'
      )}
      style={{ ...surface.style, transform: transformStyle, transition }}
    >
      {running ? (
        <svg
          aria-hidden="true"
          focusable="false"
          data-testid="work-session-running-border"
          className={styles.runningBorder}
        >
          <rect x="0.5" y="0.5" />
        </svg>
      ) : null}
      <button
        ref={setActivatorNodeRef}
        data-testid={`work-session-drag-${workSession.workId}`}
        type="button"
        {...attributes}
        {...listeners}
        onTouchStart={(event) => {
          listeners?.onTouchStart?.(event)
          event.stopPropagation()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={(event) => event.stopPropagation()}
        disabled={actionsDisabled}
        aria-label={t('dragSession', { name: sessionTitle })}
        title={`${statusLabel} · ${t('dragOrder')}`}
        className={cn(
          identity.className,
          'flex size-7 touch-none cursor-grab items-center justify-center outline-none transition-[color,filter] hover:brightness-125 active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none',
          disabled && 'opacity-50'
        )}
      >
        <span className="size-4">
          <WorkSessionDragIcon />
        </span>
      </button>
      <div className="min-w-0 py-0.5">
        <span className="sr-only">{statusLabel}</span>
        <div className="flex min-w-0 items-center justify-between gap-1">
          <p
            className={cn(identity.className, 'truncate text-xs font-medium')}
            title={workSession.projectName}
          >
            {workSession.projectName}
          </p>
          <span
            className={cn(
              styles.rowMetadata,
              'flex shrink-0 items-center gap-1 whitespace-nowrap text-xs leading-4 text-muted-foreground'
            )}
            title={t('sessionMessages', { count: messageSummary, time: updatedAt.title })}
          >
            <span>{messageSummary}</span>
            <span aria-hidden="true">·</span>
            <span
              className={cn(
                'transition-colors',
                updatedAt.tone === 'fresh' && 'dark:text-sidebar-primary'
              )}
            >
              {updatedAt.compact}
            </span>
          </span>
        </div>
        <div className="relative flex min-h-7 min-w-0 items-center">
          <p
            className={cn(
              styles.rowTitle,
              'min-w-0 flex-1 truncate pr-1 text-sm',
              selected ? 'font-semibold' : 'font-medium'
            )}
            title={sessionTitle}
          >
            {sessionTitle}
          </p>
          <div className={cn(styles.rowActions, 'flex shrink-0 items-center')}>
            <button
              data-testid={`work-session-pin-${workSession.workId}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                togglePin()
              }}
              disabled={actionsDisabled}
              aria-label={t(pinned ? 'unpinSession' : 'pinSession', { name: sessionTitle })}
              title={t(pinned ? 'unpin' : 'pin')}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
                'text-muted-foreground',
                pinned && identity.className
              )}
            >
              {pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
            </button>
            <button
              data-testid={`work-session-delete-${workSession.workId}`}
              type="button"
              disabled={actionsDisabled || deleting}
              onClick={(event) => {
                event.stopPropagation()
                deleteSession()
              }}
              aria-label={t('deleteSession', { name: sessionTitle })}
              title={t('deleteSessionTitle')}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
                'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
              )}
            >
              <Trash2Icon className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent>
        <ContextMenuItem
          data-testid={`work-session-copy-project-path-${workSession.workId}`}
          onClick={copyProjectPath}
        >
          <CopyIcon />
          {t('copyProjectPath')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

function WorkSessionGroupBoundary({ id, label }: { id: string; label: string }): React.JSX.Element {
  const { setNodeRef, transform, transition } = useSortable({
    id,
    disabled: { draggable: true }
  })
  const transformStyle = transform
    ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX ?? 1}) scaleY(${transform.scaleY ?? 1})`
    : undefined

  return (
    <div
      ref={setNodeRef}
      data-testid={id}
      aria-hidden="true"
      className="pointer-events-none flex h-5 items-center gap-2 px-1 text-xs text-muted-foreground"
      style={{ transform: transformStyle, transition }}
    >
      <span className="h-px flex-1 bg-border/75" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-border/75" />
    </div>
  )
}

function L2WorkSessionSidebarComponent({
  mode,
  mobile,
  fileBrowser,
  pluginTabContent,
  pluginSessionTabs,
  fileRefreshLoading,
  canBrowseFiles,
  workSessions,
  focusedWorkId,
  pinnedCount,
  ordering,
  deletingWorkId,
  canReplace,
  disabled,
  pluginApplications,
  settingsAttention,
  notifications,
  onConsumeNotification,
  onDismissNotification,
  onModeChange,
  onRefreshFiles,
  onPreviewProject,
  onOpenTerminal,
  onCreate,
  onReplace,
  onSettings,
  onOpenPluginApplication,
  onSelect,
  onTogglePin,
  onDelete,
  onArrangementChange
}: L2WorkSessionSidebarProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const [now, setNow] = useState<number | null>(null)
  const shortcutContainerRef = useRef<HTMLDivElement | null>(null)
  const shortcutColumnCountRef = useRef(SIDEBAR_SHORTCUT_INITIAL_COLUMNS)
  const [shortcutColumnCount, setShortcutColumnCount] = useState(SIDEBAR_SHORTCUT_INITIAL_COLUMNS)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: WORK_SESSION_TOUCH_DRAG_DELAY_MS,
        tolerance: WORK_SESSION_TOUCH_DRAG_TOLERANCE_PX
      }
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  useEffect(() => {
    const updateNow = (): void => setNow(Date.now())
    updateNow()
    const interval = window.setInterval(updateNow, 60_000)
    return () => window.clearInterval(interval)
  }, [])

  const modeItems: L2SidebarHeaderItem[] = [
    {
      key: 'sessions',
      label: t('sidebarSessions'),
      icon: <MessageSquareTextIcon />,
      pressed: mode === 'sessions',
      testId: 'sidebar-mode-sessions',
      onSelect: () => onModeChange('sessions')
    },
    {
      key: 'files',
      label: t('sidebarFiles'),
      icon: <FolderTreeIcon />,
      pressed: mode === 'files',
      testId: 'sidebar-mode-files',
      onSelect: () => onModeChange('files')
    },
    ...pluginSessionTabs.map((tab): L2SidebarHeaderItem => {
      const tabMode = getL2PluginSessionSidebarMode(tab.pluginName, tab.contributionName)
      return {
        key: `${tab.pluginName}:${tab.contributionName}`,
        label: tab.label,
        icon: <L4PluginIcon icon={tab.icon} />,
        disabled: !canBrowseFiles,
        pressed: mode === tabMode,
        onSelect: () => onModeChange(tabMode)
      }
    })
  ]
  const actionItems: L2SidebarHeaderItem[] =
    mode === 'sessions'
      ? [
          {
            key: 'replace',
            label: t('sidebarReplaceSession'),
            disabled: disabled || !canReplace,
            busy: disabled,
            testId: 'sidebar-replace-work-session',
            icon: <Repeat2Icon />,
            onSelect: onReplace
          },
          {
            key: 'create',
            label: t('createSession'),
            disabled,
            busy: disabled,
            testId: 'sidebar-create-work-session',
            icon: <PlusIcon />,
            onSelect: onCreate
          }
        ]
      : mode === 'files'
        ? [
            {
              key: 'new-terminal',
              label: t('newTerminal'),
              disabled,
              icon: <TerminalIcon />,
              testId: 'project-files-terminal-open',
              onSelect: onOpenTerminal
            },
            {
              key: 'preview-project',
              label: t('projectPreview'),
              disabled: !canBrowseFiles,
              icon: <FolderSearchIcon />,
              testId: 'project-preview-open',
              onSelect: onPreviewProject
            },
            {
              key: 'refresh-files',
              label: t('refreshFiles'),
              disabled: !canBrowseFiles || fileRefreshLoading,
              icon: fileRefreshLoading ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <RefreshCwIcon />
              ),
              busy: fileRefreshLoading,
              testId: 'project-files-refresh',
              onSelect: onRefreshFiles
            }
          ]
        : []

  useLayoutEffect(() => {
    const container = shortcutContainerRef.current
    if (!container) return

    const updateColumnCount = (width: number): void => {
      const next = Math.max(1, Math.floor(width / SIDEBAR_SHORTCUT_SIZE_PX))
      // 拖拽侧栏时只在跨过固定入口宽度后更新，避免逐像素重渲染。
      if (shortcutColumnCountRef.current === next) return
      shortcutColumnCountRef.current = next
      setShortcutColumnCount(next)
    }

    updateColumnCount(container.clientWidth)
    const observer = new ResizeObserver(([entry]) => {
      updateColumnCount(entry?.contentRect.width ?? container.clientWidth)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const workIds = useMemo(
    () => workSessions.map((workSession) => workSession.workId),
    [workSessions]
  )
  const sortableIds = useMemo(
    () => getL2WorkSessionVisualSortableIds(workIds, pinnedCount),
    [pinnedCount, workIds]
  )
  const workSessionById = useMemo(
    () => new Map(workSessions.map((workSession) => [workSession.workId, workSession])),
    [workSessions]
  )
  const pinnedWorkIdSet = useMemo(
    () => new Set(workIds.slice(0, pinnedCount)),
    [pinnedCount, workIds]
  )
  const { visiblePluginApplications, overflowPluginApplications, shortcutRowItemCounts } =
    useMemo(() => {
      const maxRows = mobile ? SIDEBAR_SHORTCUT_MOBILE_MAX_ROWS : SIDEBAR_SHORTCUT_DESKTOP_MAX_ROWS
      const layout = calculateL2SidebarShortcutLayout(
        pluginApplications.length,
        shortcutColumnCount,
        maxRows
      )

      return {
        visiblePluginApplications: pluginApplications.slice(0, layout.visibleApplicationCount),
        overflowPluginApplications: pluginApplications.slice(layout.visibleApplicationCount),
        shortcutRowItemCounts: layout.rowItemCounts
      }
    }, [mobile, pluginApplications, shortcutColumnCount])

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      if (ordering || !event.over || event.active.id === event.over.id) return

      const activeId = String(event.active.id)
      const arrangement = moveL2WorkSessionVisual(
        workIds,
        pinnedCount,
        activeId,
        String(event.over.id)
      )
      if (arrangement) onArrangementChange(arrangement, activeId)
    },
    [onArrangementChange, ordering, pinnedCount, workIds]
  )

  const rows = sortableIds.map((id) => {
    if (id === L2_WORK_SESSION_PIN_BOUNDARY_ID) {
      return <WorkSessionGroupBoundary key={id} id={id} label={t('pinnedBelow')} />
    }
    const workSession = workSessionById.get(id)
    if (!workSession) return null

    return (
      <SortableWorkSessionRow
        key={workSession.workId}
        workSession={workSession}
        mobile={mobile}
        selected={workSession.workId === focusedWorkId}
        pinned={pinnedWorkIdSet.has(workSession.workId)}
        deleting={deletingWorkId === workSession.workId}
        disabled={disabled}
        ordering={ordering}
        now={now}
        onSelect={onSelect}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
    )
  })
  const shortcutItems: React.JSX.Element[] = [
    <button
      key="settings"
      type="button"
      title={t('settings')}
      aria-label={t(settingsAttention === 'error' ? 'settingsWarning' : 'settings')}
      onClick={onSettings}
      className={SIDEBAR_SHORTCUT_CLASS}
    >
      <SettingsIcon className="size-5 shrink-0" />
      <span className="w-full truncate text-center">{t('settings')}</span>
      {settingsAttention ? (
        <span
          aria-hidden="true"
          className={cn(
            'absolute right-1.5 top-1.5 size-2 rounded-full ring-2 ring-sidebar',
            settingsAttention === 'error' ? 'bg-destructive' : 'bg-primary'
          )}
        />
      ) : null}
    </button>,
    ...visiblePluginApplications.map((application) => (
      <button
        key={`${application.pluginName}:${application.contributionName}`}
        type="button"
        disabled={disabled}
        title={application.label}
        onClick={() => onOpenPluginApplication(application)}
        className={SIDEBAR_SHORTCUT_CLASS}
      >
        <L4PluginIcon icon={application.icon} className="size-5 shrink-0" />
        <span className="w-full line-clamp-2 break-words text-center leading-4">
          {application.label}
        </span>
      </button>
    ))
  ]
  if (overflowPluginApplications.length > 0) {
    shortcutItems.push(
      <DropdownMenu key="more">
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              disabled={disabled}
              title={t('more')}
              aria-label={t('moreShortcuts')}
              className={SIDEBAR_SHORTCUT_CLASS}
            />
          }
        >
          <EllipsisIcon className="size-5 shrink-0" />
          <span className="w-full truncate text-center">{t('more')}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-56">
          {overflowPluginApplications.map((application) => (
            <DropdownMenuItem
              key={`${application.pluginName}:${application.contributionName}`}
              disabled={disabled}
              onClick={() => onOpenPluginApplication(application)}
              className="py-2"
            >
              <L4PluginIcon icon={application.icon} className="size-4" />
              <span className="min-w-0 truncate">{application.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const shortcutRows = shortcutRowItemCounts.map((itemCount, rowIndex) => {
    const rowStart = shortcutRowItemCounts
      .slice(0, rowIndex)
      .reduce((total, previousItemCount) => total + previousItemCount, 0)
    return (
      <div key={`shortcut-row:${rowStart}`} className="flex justify-evenly">
        {shortcutItems.slice(rowStart, rowStart + itemCount)}
      </div>
    )
  })

  return (
    <aside className="flex h-full w-full min-w-0 flex-col bg-sidebar text-sidebar-foreground">
      <SidebarHeader modeItems={modeItems} actionItems={actionItems} />
      <L4ScrollArea
        data-testid="work-session-list"
        className={cn('min-h-0 flex-1', mode !== 'sessions' && 'hidden')}
        viewportClassName="p-2 data-[has-overflow-y]:pr-4"
      >
        {workSessions.length === 0 ? (
          <p className="px-2 py-5 text-center text-sm leading-6 text-muted-foreground">
            {t('noSessions')}
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1">{rows}</div>
            </SortableContext>
          </DndContext>
        )}
      </L4ScrollArea>
      <div className={cn('min-h-0 flex-1 overflow-hidden', mode !== 'files' && 'hidden')}>
        {fileBrowser ?? (
          <div className="flex h-full items-center justify-center p-5 text-center text-sm text-muted-foreground">
            {t('selectSessionFirst')}
          </div>
        )}
      </div>
      {mode.startsWith('plugin:') ? (
        <div className="min-h-0 flex-1 overflow-hidden">{pluginTabContent}</div>
      ) : null}
      <L2WorkbenchNotifications
        mobile={mobile}
        notifications={notifications}
        onConsume={onConsumeNotification}
        onDismiss={onDismissNotification}
      />
      <footer
        data-testid="sidebar-shortcuts"
        className="shrink-0 px-2 py-1.5"
        aria-label={t('shortcuts')}
      >
        <div ref={shortcutContainerRef} className="flex flex-col gap-1">
          {shortcutRows}
        </div>
      </footer>
    </aside>
  )
}

export const L2WorkSessionSidebar = memo(L2WorkSessionSidebarComponent)

L2WorkSessionSidebar.displayName = 'L2WorkSessionSidebar'
