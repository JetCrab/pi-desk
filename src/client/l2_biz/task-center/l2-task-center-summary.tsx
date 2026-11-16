'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleStopIcon,
  LoaderCircleIcon,
  OctagonAlertIcon
} from 'lucide-react'
import { PluginStatusCapsule } from '@jetcrab/pi-desk-sdk/react/base'
import type { L2TaskSummary } from '@common/l2_biz/task-center/l2-task-center-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'

const STATUS_LABELS = {
  running: 'statusRunning',
  completed: 'statusCompleted',
  failed: 'statusFailed',
  stopped: 'statusStopped',
  interrupted: 'statusInterrupted'
} as const

const STATUS_COLORS = {
  running: 'text-muted-foreground',
  completed: 'text-status-success',
  failed: 'text-destructive',
  stopped: 'text-muted-foreground',
  interrupted: 'text-status-warning'
} as const

function StatusIcon({ task }: { task: L2TaskSummary }): React.JSX.Element {
  if (task.status === 'running')
    return <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
  if (task.status === 'completed') return <CheckIcon className="size-4 text-status-success" />
  if (task.status === 'stopped') return <CircleStopIcon className="size-4 text-muted-foreground" />
  return <OctagonAlertIcon className={`size-4 ${STATUS_COLORS[task.status]}`} />
}

export function L2TaskCenterSummary({
  tasks,
  onOpen
}: {
  tasks: readonly L2TaskSummary[]
  onOpen: (taskId?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('taskCenter')
  const [open, setOpen] = useState(false)
  const running = tasks.filter((task) => task.status === 'running')
  const highlighted = running[0] ?? null
  const [recent, setRecent] = useState<L2TaskSummary | null>(highlighted)
  if (highlighted && highlighted !== recent) setRecent(highlighted)
  const settled = recent ? tasks.find((task) => task.taskId === recent.taskId) : null
  const visible = highlighted !== null || Boolean(settled && recent)
  if ((!visible || running.length === 1) && open) setOpen(false)
  const displayTask = highlighted ?? settled ?? recent

  useEffect(() => {
    if (highlighted || !recent || open) return
    // 只对当前挂载中实际观察到的任务保留短暂终态，不重放历史完成提示。
    const timer = window.setTimeout(() => {
      setRecent(null)
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [highlighted, recent, open])

  const summary = highlighted
    ? running.length > 1
      ? t('runningCount', { count: running.length })
      : highlighted.title
    : displayTask
      ? `${t(STATUS_LABELS[displayTask.status])} · ${displayTask.title}`
      : t('title')
  const preview = running.length > 0 ? running.slice(0, 3) : displayTask ? [displayTask] : []
  const showTask = (taskId?: string): void => {
    setOpen(false)
    onOpen(taskId)
  }

  return (
    <PluginStatusCapsule
      visible={visible}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && running.length === 1 && highlighted) {
          showTask(highlighted.taskId)
          return
        }
        setOpen(nextOpen)
      }}
      summary={summary}
      icon={displayTask ? <StatusIcon task={displayTask} /> : null}
      meta={highlighted && running.length === 1 ? t('statusRunning') : undefined}
    >
      <div className="p-4" data-testid="task-capsule-preview">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t('title')}</h3>
            <span className="text-xs text-muted-foreground">
              {t('recordCount', { count: tasks.length })}
            </span>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => showTask()}>
            {t('open')}
            <ArrowUpRightIcon />
          </Button>
        </div>
        <div className="space-y-1">
          {preview.map((task) => (
            <button
              key={task.taskId}
              type="button"
              onClick={() => showTask(task.taskId)}
              className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-current/10 focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-inset"
            >
              <span className="mt-0.5">
                <StatusIcon task={task} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm">{task.title}</span>
                {task.activity && task.activity.trim() !== t(STATUS_LABELS[task.status]) ? (
                  <span className="mt-1 block break-words text-xs opacity-70">{task.activity}</span>
                ) : null}
              </span>
              <span className={`shrink-0 text-xs ${STATUS_COLORS[task.status]}`}>
                {t(STATUS_LABELS[task.status])}
              </span>
            </button>
          ))}
        </div>
      </div>
    </PluginStatusCapsule>
  )
}
