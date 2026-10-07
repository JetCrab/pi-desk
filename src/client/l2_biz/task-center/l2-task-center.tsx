'use client'

import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CircleStopIcon,
  CopyIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  RotateCcwIcon,
  XCircleIcon,
  XIcon
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type L2TaskDetailBody,
  type L2TaskInfoItem,
  type L2TaskStatus,
  type L2TaskSummary
} from '@common/l2_biz/task-center/l2-task-center-contract'
import type { L3WorkSessionSource } from '@common/l3_modules/work-session/l3-work-session-source-contract'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import {
  Conversation,
  ConversationContent
} from '@client/l4_foundation/ui/ai-elements/conversation'
import { PromptInputButton } from '@client/l4_foundation/ui/ai-elements/prompt-input'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  L4AppDialogContent,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { DropdownMenuItem } from '@client/l4_foundation/ui/shadcn/dropdown-menu'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import {
  buildL3ConversationTurns,
  formatL3ConversationTimestamp
} from '@client/l3_modules/conversation/l3-conversation-display'
import { L3ConversationNavigation } from '@client/l3_modules/conversation/l3-conversation-navigation'
import { L3ConversationProgressiveWindow } from '@client/l3_modules/conversation/l3-conversation-progressive-window'
import {
  L3ConversationStickToBottomBridge,
  L3ConversationTurnView
} from '@client/l3_modules/conversation/l3-conversation-messages'
import { L3ConversationTailSpacerObserver } from '@client/l3_modules/conversation/l3-conversation-viewport'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { useL4WindowReveal } from '@client/l4_foundation/ui/l4-window-reveal'
import type { L2TaskCenterRuntime } from './l2-task-center-runtime'

interface L2TaskCenterProps {
  source: L3WorkSessionSource
  cwd: string
  tasks: readonly L2TaskSummary[]
  runtime: L2TaskCenterRuntime
  variant: 'summary' | 'footer' | 'menu'
}

const STATUS_LABELS: Record<L2TaskStatus, string> = {
  running: 'statusRunning',
  completed: 'statusCompleted',
  failed: 'statusFailed',
  stopped: 'statusStopped',
  interrupted: 'statusInterrupted'
}

function sameSource(left: L3WorkSessionSource | null, right: L3WorkSessionSource): boolean {
  return (
    left !== null &&
    left.workId === right.workId &&
    left.sessionId === right.sessionId &&
    left.branchId === right.branchId
  )
}

function taskTime(
  task: L2TaskSummary,
  format: (unit: 'seconds' | 'minutes' | 'hours', count: number) => string
): string {
  const end = task.endedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000))
  if (seconds < 60) return format('seconds', seconds)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return format('minutes', minutes)
  const hours = Math.floor(minutes / 60)
  return `${format('hours', hours)}${minutes % 60 ? ` ${format('minutes', minutes % 60)}` : ''}`
}

function taskIdentity(task: L2TaskSummary): string {
  return [task.taskKind, task.taskType]
    .filter((value): value is string => Boolean(value))
    .join(' / ')
}

function taskStatusIcon(status: L2TaskStatus): React.JSX.Element {
  switch (status) {
    case 'running':
      return <LoaderCircleIcon className="size-4 animate-spin text-foreground" />
    case 'completed':
      return <CheckCircle2Icon className="size-4 text-status-success" />
    case 'failed':
      return <XCircleIcon className="size-4 text-destructive" />
    case 'interrupted':
      return <OctagonAlertIcon className="size-4 text-status-warning" />
    case 'stopped':
      return <CircleStopIcon className="size-4 text-muted-foreground" />
  }
}

function taskStatusBadgeClass(status: L2TaskStatus): string {
  switch (status) {
    case 'running':
      return 'bg-muted text-foreground'
    case 'completed':
      return 'bg-muted text-status-success'
    case 'failed':
      return 'bg-muted text-destructive'
    case 'interrupted':
      return 'bg-muted text-status-warning'
    case 'stopped':
      return 'bg-muted text-muted-foreground'
  }
}

function preferredTask(tasks: readonly L2TaskSummary[]): L2TaskSummary | null {
  return tasks.find((task) => task.status === 'running') ?? tasks[0] ?? null
}

function TaskInfoStrip({ info }: { info: readonly L2TaskInfoItem[] }): React.JSX.Element | null {
  const { t } = useTranslation('taskCenter')
  const toast = useL4AppToast()
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  if (info.length === 0) return null

  const copyInfo = (item: L2TaskInfoItem, key: string): void => {
    void copyL4BrowserText(item.value).then((copied) => {
      if (copied) {
        setCopiedKey(key)
        return
      }
      toast.error(t('copyFailed', { name: item.label }))
    })
  }

  return (
    <div
      data-task-info-scroll=""
      className="max-h-32 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
    >
      <dl className="flex flex-wrap gap-2">
        {info.map((item, index) => {
          const copyKey = `${item.label}:${index}:${item.value}`
          const copied = copiedKey === copyKey
          return (
            <div
              key={`${item.label}:${index}`}
              role="button"
              tabIndex={0}
              aria-label={t(copied ? 'copied' : 'copy', { name: item.label })}
              title={copied ? t('copiedShort') : t('clickToCopy', { name: item.label })}
              className={cn(
                'flex min-h-8 min-w-0 max-w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                copied && 'bg-muted'
              )}
              onClick={() => copyInfo(item, copyKey)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                copyInfo(item, copyKey)
              }}
            >
              <dt className="shrink-0 pt-0.5 font-medium text-muted-foreground">{item.label}</dt>
              <dd className="min-w-0 flex-1 break-words text-foreground">{item.value}</dd>
              <span className="shrink-0 pt-0.5 text-muted-foreground" aria-hidden="true">
                {copied ? (
                  <CheckIcon className="size-3.5 text-status-success" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </span>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

function TaskConversation({
  snapshot,
  running,
  runtime,
  cwd
}: {
  snapshot: Extract<NonNullable<L2TaskDetailBody>, { kind: 'conversation' }>
  running: boolean
  runtime: L2TaskCenterRuntime
  cwd: string
}): React.JSX.Element {
  const { t } = useTranslation('taskCenter')
  const turns = useMemo(() => buildL3ConversationTurns(snapshot, running), [running, snapshot])
  const latestUserTurn = turns.findLast((turn) => turn.user !== null) ?? null
  return (
    <Conversation
      className="h-full min-h-0"
      initial="instant"
      resize="instant"
      aria-label={t('conversationDetails')}
    >
      <L3ConversationProgressiveWindow
        turns={turns}
        focusTurnIdentity={latestUserTurn?.identity ?? null}
        initialAnchor={null}
      >
        {(turnWindow) => (
          <>
            <L3ConversationTailSpacerObserver />
            <L3ConversationStickToBottomBridge>
              <ConversationContent
                scrollClassName="pi-desk-chat-scrollbar"
                className="mx-auto min-h-full w-full max-w-3xl gap-6 px-4 pt-3 pb-6 sm:px-6"
              >
                {turns.length > 0 ? (
                  turnWindow.visibleTurns.map((turn, index) => {
                    const turnIndex = turnWindow.startIndex + index
                    return (
                      <L3ConversationTurnView
                        key={turn.identity}
                        turn={turn}
                        cwd={cwd}
                        logicalTail={turnWindow.containsTail && turnIndex === turns.length - 1}
                        onLoadDetail={runtime.loadMessageDetail}
                        onAcquireImage={runtime.acquireImage}
                      />
                    )
                  })
                ) : (
                  <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
                    {t('noMessages')}
                  </div>
                )}
                <div className="h-4 shrink-0" aria-hidden="true" />
              </ConversationContent>
            </L3ConversationStickToBottomBridge>
            <L3ConversationNavigation turns={turns} window={turnWindow} />
          </>
        )}
      </L3ConversationProgressiveWindow>
    </Conversation>
  )
}

function TaskDetail({
  task,
  runtime,
  cwd
}: {
  task: L2TaskSummary | null
  runtime: L2TaskCenterRuntime
  cwd: string
}): React.JSX.Element {
  const { t } = useTranslation('taskCenter')
  const state = useSyncExternalStore(runtime.subscribe, runtime.getState, runtime.getState)
  const detail = task ? state.details[task.taskId] : undefined
  const [confirmingInterrupt, setConfirmingInterrupt] = useState(false)
  const [interruptPending, setInterruptPending] = useState(false)
  const [interruptError, setInterruptError] = useState<string | null>(null)

  const interrupt = async (): Promise<void> => {
    if (!confirmingInterrupt) {
      setConfirmingInterrupt(true)
      return
    }
    setInterruptPending(true)
    setInterruptError(null)
    try {
      await runtime.interruptSelected()
      setConfirmingInterrupt(false)
    } catch (error) {
      setInterruptError(error instanceof Error ? error.message : t('interruptFailed'))
    } finally {
      setInterruptPending(false)
    }
  }

  if (!task) {
    return (
      <div className="grid h-full min-h-0 place-items-center px-6 text-center text-sm text-muted-foreground">
        {t('selectTask')}
      </div>
    )
  }

  const identity = taskIdentity(task)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 py-3 lg:pr-16">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5 shrink-0">{taskStatusIcon(task.status)}</span>
              <h3 className="min-w-0 break-words text-sm font-semibold">
                {identity ? `${identity} · ${task.title}` : task.title}
              </h3>
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span
                className={cn(
                  'rounded-md px-1.5 py-0.5 font-medium',
                  taskStatusBadgeClass(task.status)
                )}
              >
                {t(STATUS_LABELS[task.status])}
              </span>
              <span className="text-muted-foreground">
                {taskTime(task, (unit, count) => t(unit, { count }))}
              </span>
              {task.activity ? (
                <>
                  <span aria-hidden="true" className="text-muted-foreground/60">
                    ·
                  </span>
                  <span className="min-w-0 break-words text-muted-foreground">{task.activity}</span>
                </>
              ) : null}
            </div>
          </div>
          {detail?.canInterrupt ? (
            <Button
              className="shrink-0"
              type="button"
              size="sm"
              variant={confirmingInterrupt ? 'destructive' : 'outline'}
              disabled={interruptPending}
              onClick={() => void interrupt()}
            >
              {interruptPending ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <CircleStopIcon />
              )}
              {confirmingInterrupt ? t('confirmInterrupt') : t('interrupt')}
            </Button>
          ) : null}
        </div>
      </header>

      {interruptError ? (
        <p role="alert" className="shrink-0 border-b bg-muted px-4 py-2 text-sm text-destructive">
          {interruptError}
        </p>
      ) : null}
      {task.info.length > 0 ? (
        <div className="shrink-0 border-b px-4 py-2">
          <TaskInfoStrip info={task.info} />
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {detail?.body?.kind === 'conversation' ? (
          <TaskConversation
            snapshot={detail.body}
            running={task.status === 'running'}
            runtime={runtime}
            cwd={cwd}
          />
        ) : detail?.body?.kind === 'text' ? (
          <div className="h-full overflow-auto p-4 sm:p-5">
            <pre className={cn('whitespace-pre-wrap break-words font-mono text-sm leading-[1.6]')}>
              {detail.body.text || t('waitingOutput')}
            </pre>
          </div>
        ) : detail ? (
          <div className="h-full overflow-auto p-4 sm:p-5">
            <div className="grid min-h-48 place-items-center px-2 text-center text-sm text-muted-foreground">
              {t('noDetails')}
            </div>
          </div>
        ) : (
          <div className="h-full overflow-auto p-4 sm:p-5">
            <div className="grid min-h-48 place-items-center px-2 text-center text-sm text-muted-foreground">
              {state.error ? (
                <div className="space-y-3">
                  <p className="text-destructive">{state.error}</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => runtime.selectTask(task.taskId)}
                  >
                    <RotateCcwIcon />
                    {t('retry')}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <LoaderCircleIcon className="size-4 animate-spin" />
                  {t('loadingDetail')}
                </div>
              )}
            </div>
          </div>
        )}
        {state.refreshing ? (
          <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-md border bg-popover px-2 py-1 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3 animate-spin" />
            {t('refreshing')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TaskCenterPanel({
  source,
  tasks,
  runtime,
  cwd
}: {
  source: L3WorkSessionSource
  tasks: readonly L2TaskSummary[]
  runtime: L2TaskCenterRuntime
  cwd: string
}): React.JSX.Element | null {
  const { t } = useTranslation('taskCenter')
  const { locale, timeZone } = useL4Region()
  const getPanelSnapshot = useCallback(() => {
    const state = runtime.getState()
    return JSON.stringify([
      state.open,
      state.source?.workId ?? null,
      state.source?.sessionId ?? null,
      state.source?.branchId ?? null,
      state.selectedTaskId
    ])
  }, [runtime])
  useSyncExternalStore(runtime.subscribe, getPanelSnapshot, getPanelSnapshot)
  const state = runtime.getState()
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const desktopCloseButtonRef = useRef<HTMLButtonElement>(null)
  const [mobileDetail, setMobileDetail] = useState(false)
  const selectedTask = tasks.find((task) => task.taskId === state.selectedTaskId) ?? null

  useEffect(() => {
    if (!state.open || !sameSource(state.source, source)) return
    runtime.reconcileTasks(source, tasks)
  }, [runtime, source, state.open, state.source, tasks])

  const showMobileDetail = mobileDetail && state.selectedTaskId !== null
  const panelOpen = state.open && sameSource(state.source, source)
  const listRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  useL4WindowReveal(listRef, panelOpen && !showMobileDetail ? 'task-list' : null)
  useL4WindowReveal(
    detailRef,
    panelOpen ? `${state.selectedTaskId ?? 'no-task'}:${showMobileDetail}` : null
  )

  if (!state.open || !sameSource(state.source, source) || typeof document === 'undefined') {
    return null
  }

  const select = (taskId: string): void => {
    runtime.selectTask(taskId)
    setMobileDetail(true)
  }

  return (
    <L4AppDialogRoot
      open
      onOpenChange={(open) => {
        if (!open) runtime.close()
      }}
    >
      <L4AppDialogContent
        aria-label={t('title')}
        initialFocus={() =>
          desktopCloseButtonRef.current?.getClientRects().length
            ? desktopCloseButtonRef.current
            : closeButtonRef.current
        }
        showCloseButton={false}
        className="h-[calc(100dvh-2rem)] max-w-[70rem] flex-row bg-background data-open:animate-none max-lg:h-dvh max-lg:max-h-dvh max-lg:w-dvw max-lg:max-w-none max-lg:rounded-none max-lg:border-0"
      >
        <div
          ref={listRef}
          className={cn(
            'flex min-w-0 flex-1 flex-col border-r bg-sidebar lg:max-w-80',
            showMobileDetail && 'hidden lg:flex'
          )}
        >
          <header className="flex min-h-14 items-center gap-3 border-b px-4 py-3">
            <ListTodoIcon className="size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <L4AppDialogTitle>{t('title')}</L4AppDialogTitle>
              <p className="text-xs text-muted-foreground">
                {t('recordCount', { count: tasks.length })}
              </p>
            </div>
            <Button
              ref={showMobileDetail ? undefined : closeButtonRef}
              className="lg:hidden"
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('close')}
              onClick={() => runtime.close()}
            >
              <XIcon />
            </Button>
          </header>
          <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
            {tasks.length > 0 ? (
              <div className="space-y-1">
                {tasks.map((task) => {
                  const identity = taskIdentity(task)
                  const duration = taskTime(task, (unit, count) => t(unit, { count }))
                  const startTime = formatL3ConversationTimestamp(
                    task.startedAt,
                    undefined,
                    locale,
                    timeZone
                  )
                  return (
                    <button
                      key={task.taskId}
                      type="button"
                      aria-current={task.taskId === state.selectedTaskId ? 'true' : undefined}
                      onClick={() => select(task.taskId)}
                      className={cn(
                        'grid min-h-14 w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg px-3 py-3 text-left outline-none transition-colors hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        task.taskId === state.selectedTaskId &&
                          'bg-accent text-accent-foreground hover:bg-accent'
                      )}
                    >
                      <span className="mt-0.5 shrink-0">{taskStatusIcon(task.status)}</span>
                      <span className="min-w-0">
                        <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
                          <span className="truncate text-sm font-medium">{task.title}</span>
                          <span
                            className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                            aria-label={t('runningTime', { duration, time: startTime.full })}
                          >
                            {duration}
                            <span className="mx-1 text-muted-foreground/50" aria-hidden="true">
                              ·
                            </span>
                            <time dateTime={new Date(task.startedAt).toISOString()}>
                              {startTime.compact}
                            </time>
                          </span>
                        </span>
                        {identity ? (
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            {identity}
                          </span>
                        ) : null}
                      </span>
                      <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground lg:hidden" />
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
                {t('noTasks')}
              </div>
            )}
          </div>
        </div>

        <div
          ref={detailRef}
          className={cn('min-w-0 flex-1', !showMobileDetail && 'hidden lg:block')}
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-h-12 items-center gap-2 border-b bg-muted/10 px-3 lg:hidden">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('back')}
                onClick={() => setMobileDetail(false)}
              >
                <ArrowLeftIcon />
              </Button>
              <span className="min-w-0 flex-1 truncate text-center text-xs text-muted-foreground">
                {selectedTask?.title ?? t('detail')}
              </span>
              <Button
                ref={showMobileDetail ? closeButtonRef : undefined}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('close')}
                onClick={() => runtime.close()}
              >
                <XIcon />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <TaskDetail
                key={selectedTask?.taskId ?? 'no-task'}
                task={selectedTask}
                runtime={runtime}
                cwd={cwd}
              />
            </div>
          </div>
        </div>
        <Button
          ref={desktopCloseButtonRef}
          className="absolute right-4 top-3 z-10 hidden lg:inline-flex"
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('close')}
          onClick={() => runtime.close()}
        >
          <XIcon />
        </Button>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}

export function L2TaskCenter({
  source,
  cwd,
  tasks,
  runtime,
  variant
}: L2TaskCenterProps): React.JSX.Element {
  const { t } = useTranslation('taskCenter')
  const running = tasks.filter((task) => task.status === 'running')
  const highlighted = running[0]
  const open = (): void => {
    runtime.open(source, preferredTask(tasks)?.taskId ?? null)
  }

  if (variant === 'footer') {
    return tasks.length > 0 ? (
      <PromptInputButton tooltip={t('title')} aria-label={t('open')} onClick={open}>
        <ListTodoIcon className="size-4" />
      </PromptInputButton>
    ) : (
      <></>
    )
  }

  if (variant === 'menu') {
    return (
      <DropdownMenuItem onClick={open}>
        <ListTodoIcon className="size-4" />
        {t('title')}
      </DropdownMenuItem>
    )
  }

  return (
    <>
      {highlighted ? (
        <button
          type="button"
          className="mb-2 flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md border bg-muted px-2.5 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={open}
          aria-label={`${t('open')}, ${t('runningCount', { count: running.length })}`}
        >
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-foreground" />
          <span className="shrink-0 font-medium text-foreground">
            {t('runningCount', { count: running.length })}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {highlighted.title}
            {highlighted.activity ? ` · ${highlighted.activity}` : ''}
          </span>
          <ChevronRightIcon className="size-3.5 shrink-0" />
        </button>
      ) : null}

      <TaskCenterPanel source={source} tasks={tasks} runtime={runtime} cwd={cwd} />
    </>
  )
}
