import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  PluginButton,
  PluginStatusCapsule,
  PluginScroll,
  PluginSurface,
  usePluginHost
} from '@jetcrab/pi-desk-sdk/react/base'
import { countTodoItems, type TodoInput, type TodoItem } from './contract.js'
import type { TodoBrowserController, TodoBrowserState } from './browser-runtime.js'

const STYLES = `
.pi-desk-todo{min-width:0;padding-inline:.5rem}
.pi-desk-todo-dismiss{min-width:1.75rem;padding-inline:.25rem;color:inherit!important;background:transparent!important}
.pi-desk-todo-dismiss:hover{background:color-mix(in srgb,currentColor 12%,transparent)!important}
.pi-desk-todo-blocked{font-weight:500}
.pi-desk-todo-icon{display:inline-flex;flex:none;width:1rem;height:1rem;align-items:center;justify-content:center}
.pi-desk-todo-icon svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.pi-desk-todo-icon[data-status="0"]{opacity:.65}
.pi-desk-todo-panel{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column}
.pi-desk-todo-heading{display:flex;flex:none;flex-wrap:wrap;align-items:baseline;gap:.25rem .75rem;padding:.75rem 1rem .625rem;border-bottom:1px solid color-mix(in srgb,currentColor 18%,transparent)}
.pi-desk-todo-heading h3{flex:1 1 12rem;min-width:0;margin:0;font:inherit;font-weight:600;overflow-wrap:anywhere}
.pi-desk-todo-meta{display:flex;flex:none;gap:.75rem;opacity:.75;font-size:.75rem;font-variant-numeric:tabular-nums;white-space:nowrap}
.pi-desk-todo-scroll{min-height:0;flex:1}
.pi-desk-todo-scroll-content{padding:.375rem .5rem .5rem;overscroll-behavior:contain}
.pi-desk-todo-list{list-style:none;margin:0;padding:0}
.pi-desk-todo-leaf{position:relative;display:flex;align-items:flex-start;gap:.625rem;min-width:0;padding:.5rem}
.pi-desk-todo-leaf>.pi-desk-todo-icon{height:1.5em}
.pi-desk-todo-leaf-copy{flex:1;min-width:0}
.pi-desk-todo-title{display:block;overflow-wrap:anywhere}
.pi-desk-todo-leaf[data-status="1"] .pi-desk-todo-title{font-weight:600}
.pi-desk-todo-leaf[data-status="2"] .pi-desk-todo-title{opacity:.7}
.pi-desk-todo-note{margin:.125rem 0 0;font-size:.8125rem;overflow-wrap:anywhere;opacity:.75}
.pi-desk-todo-flag{margin-inline-end:.5em;font-weight:600}
.pi-desk-todo-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.pi-desk-todo-error{display:flex;align-items:center;gap:.5rem;justify-content:space-between;padding:.375rem .5rem;color:var(--pi-desk-plugin-destructive,var(--destructive));font-size:.8125rem;overflow-wrap:anywhere}
`

const LABELS = {
  'zh-CN': {
    statuses: ['待开始', '进行中', '已完成', '受阻'],
    completed: '全部完成',
    parallel: (count: number): string => `${count} 项并行进行中`,
    blocked: (count: number): string => `${count} 受阻`,
    tasks: '任务',
    done: '完成',
    dismiss: '隐藏整份任务进度',
    failure: '任务进度同步失败',
    retry: '重试'
  },
  en: {
    statuses: ['Not started', 'In progress', 'Completed', 'Needs attention'],
    completed: 'All completed',
    parallel: (count: number): string => `${count} tasks in progress`,
    blocked: (count: number): string => `${count} blocked`,
    tasks: 'Tasks',
    done: 'completed',
    dismiss: 'Hide the entire task progress',
    failure: 'Could not sync task progress',
    retry: 'Retry'
  }
}

type Labels = (typeof LABELS)['en']
function summary(todo: TodoInput, labels: Labels): string {
  const running = todo.items.filter((item) => item.status === 1)
  if (running.length > 1) return labels.parallel(running.length)
  if (running.length === 1) return running[0]!.title
  const blocked = todo.items.find((item) => item.status === 3)
  if (blocked) return blocked.title
  const pending = todo.items.find((item) => item.status === 0)
  return pending ? `${pending.title} · ${labels.statuses[0]}` : labels.completed
}

function StatusIcon({ status }: { status: 0 | 1 | 2 | 3 }): React.JSX.Element {
  return (
    <span className="pi-desk-todo-icon" data-status={status} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        {status === 3 ? (
          <path d="m12 3 10 18H2zM12 9v5m0 3v.1" />
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            {status === 2 ? <path d="m8 12 3 3 5-6" /> : null}
            {status === 1 ? (
              <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
            ) : null}
          </>
        )}
      </svg>
    </span>
  )
}

function Task({ item, labels }: { item: TodoItem; labels: Labels }): React.JSX.Element {
  const blocked = item.status === 3
  return (
    <li className="pi-desk-todo-leaf" data-todo-id={item.id} data-status={item.status}>
      <StatusIcon status={item.status} />
      <div className="pi-desk-todo-leaf-copy">
        <span className="pi-desk-todo-title">
          {item.title}
          {blocked ? null : (
            <span className="pi-desk-todo-sr"> {labels.statuses[item.status]}</span>
          )}
        </span>
        {blocked || item.note ? (
          <p className="pi-desk-todo-note">
            {blocked ? <span className="pi-desk-todo-flag">{labels.statuses[3]}</span> : null}
            {item.note}
          </p>
        ) : null}
      </div>
    </li>
  )
}

function TodoProgress({
  todo,
  state,
  controller,
  labels
}: {
  todo: TodoInput | null
  state: TodoBrowserState
  controller: TodoBrowserController
  labels: Labels
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const ignoreReturnFocus = useRef(false)
  const visible = Boolean(todo && !state.snapshot.hidden && todo.items.length > 0)
  const counts = todo ? countTodoItems(todo.items) : { completed: 0, total: 0 }
  const blocked = todo?.items.filter((item) => item.status === 3).length ?? 0
  const current = todo?.items.some((item) => item.status === 1)
    ? 1
    : blocked
      ? 3
      : counts.completed === counts.total
        ? 2
        : 0
  const label = todo ? summary(todo, labels) : labels.tasks
  const triggerProps = {
    'data-testid': 'todo-summary',
    'aria-label': `${label} · ${counts.completed}/${counts.total} ${labels.tasks} ${labels.done}${blocked ? ` · ${labels.blocked(blocked)}` : ''}`
  }

  useEffect(() => {
    if (visible) return
    let active = true
    queueMicrotask(() => {
      if (active) {
        setOpen(false)
        setPinned(false)
      }
    })
    return () => {
      active = false
    }
  }, [visible])

  return (
    <div
      className="pi-desk-todo"
      data-testid={visible ? 'todo-widget' : undefined}
      onFocusCapture={(event) => {
        if (ignoreReturnFocus.current) {
          ignoreReturnFocus.current = false
          return
        }
        if (event.target.matches('[data-slot="status-capsule-trigger"]:focus-visible'))
          setOpen(true)
      }}
    >
      <PluginStatusCapsule
        visible={visible}
        open={open}
        openOnHover
        onOpenChange={(nextOpen, details) => {
          if (details.reason === 'trigger-press' || details.reason === 'close-press') {
            if (!pinned) {
              details.cancel()
              setPinned(true)
              setOpen(true)
              return
            }
          } else if (pinned && details.reason === 'trigger-hover' && !nextOpen) {
            details.cancel()
            return
          }
          if (!nextOpen) {
            ignoreReturnFocus.current =
              details.reason === 'escape-key' || details.reason === 'close-press'
            setPinned(false)
          }
          setOpen(nextOpen)
        }}
        summary={label}
        triggerProps={triggerProps}
        icon={<StatusIcon status={current} />}
        meta={
          <>
            {blocked ? `${labels.blocked(blocked)} · ` : ''}
            {counts.completed}/{counts.total}
          </>
        }
        actions={
          <PluginButton
            variant="ghost"
            size="sm"
            className="pi-desk-todo-dismiss"
            data-testid="todo-dismiss"
            aria-label={labels.dismiss}
            title={labels.dismiss}
            disabled={state.hiding}
            onClick={() => void controller.hide()}
          >
            <span className="pi-desk-todo-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="m6 6 12 12M6 18 18 6" />
              </svg>
            </span>
          </PluginButton>
        }
      >
        {todo ? (
          <div className="pi-desk-todo-panel" data-testid="todo-popover">
            <header className="pi-desk-todo-heading">
              <h3>{todo.title}</h3>
              <div className="pi-desk-todo-meta">
                {blocked ? (
                  <span className="pi-desk-todo-blocked">{labels.blocked(blocked)}</span>
                ) : null}
                <span>
                  {counts.completed}/{counts.total} {labels.done}
                </span>
              </div>
            </header>
            <PluginScroll
              className="pi-desk-todo-scroll"
              viewportClassName="pi-desk-todo-scroll-content"
              aria-label={todo.title}
            >
              <ul className="pi-desk-todo-list">
                {todo.items.map((item) => (
                  <Task key={item.id} item={item} labels={labels} />
                ))}
              </ul>
            </PluginScroll>
          </div>
        ) : null}
      </PluginStatusCapsule>
    </div>
  )
}

export function TodoWidget({
  controller
}: {
  controller: TodoBrowserController
}): React.JSX.Element {
  const host = usePluginHost()
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  )
  const subscribeSettings = useCallback(
    (listener: () => void): (() => void) => {
      const dispose = host.settings.subscribe(listener)
      return (): void => {
        void dispose()
      }
    },
    [host.settings]
  )
  const settings = useSyncExternalStore(
    subscribeSettings,
    () => host.settings.getSnapshot(),
    () => host.settings.getSnapshot()
  )
  const labels = LABELS[settings.region.locale]

  return (
    <PluginSurface>
      <style href="pi-desk-todo" precedence="plugin-todo">
        {STYLES}
      </style>
      <TodoProgress
        todo={state.snapshot.todo}
        state={state}
        controller={controller}
        labels={labels}
      />
      {state.error ? (
        <div role="alert" className="pi-desk-todo-error">
          <span>
            {labels.failure}: {state.error.message}
          </span>
          <PluginButton
            size="sm"
            disabled={state.loading || state.hiding}
            onClick={() =>
              void (state.error?.action === 'hide' ? controller.hide() : controller.refresh())
            }
          >
            {labels.retry}
          </PluginButton>
        </div>
      ) : null}
    </PluginSurface>
  )
}
