import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent
} from 'react'
import {
  PluginButton,
  PluginPopover,
  PluginScroll,
  PluginSurface,
  usePluginHost
} from '@jetcrab/pi-desk-sdk/react/base'
import { countTodoItems, type TodoInput, type TodoItem } from './contract.js'
import type { TodoBrowserController, TodoBrowserState } from './browser-runtime.js'

const STYLES = `
.pi-desk-todo{min-width:0;position:relative;padding-inline:.5rem}
.pi-desk-todo-row{display:flex;min-width:0;align-items:center;gap:.125rem;padding:.125rem .375rem;border-radius:.5rem;background:var(--pi-desk-plugin-muted,var(--muted));transition:background-color 150ms ease-out}
.pi-desk-todo-row:hover,.pi-desk-todo-row:focus-within,.pi-desk-todo-row:has([aria-expanded="true"]){background:var(--accent)}
.pi-desk-todo-summary{flex:1;min-width:0;justify-content:flex-start;gap:.375rem;padding-inline:.25rem;text-align:left;color:inherit}
.pi-desk-todo .pi-desk-todo-row .pi-desk-todo-summary{background:transparent}
.pi-desk-todo-summary-copy{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400}
.pi-desk-todo-count,.pi-desk-todo-blocked{flex:none;font-size:.75rem;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap}
.pi-desk-todo-count{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.pi-desk-todo-blocked{color:var(--status-warning,var(--foreground))}
.pi-desk-todo-dismiss{flex:none;min-width:1.75rem;padding-inline:.25rem}
.pi-desk-todo-segments{display:flex;height:.1875rem;gap:.1875rem;margin:.125rem .375rem .25rem;overflow:hidden;border-radius:.125rem}
.pi-desk-todo-segment{flex:1;min-width:0;background:var(--pi-desk-plugin-border,var(--border));border-radius:.125rem}
.pi-desk-todo-segment[data-status="1"]{background:var(--foreground)}
.pi-desk-todo-segment[data-status="2"]{background:var(--muted-foreground)}
.pi-desk-todo-segment[data-status="3"]{background:var(--status-warning,var(--foreground))}
.pi-desk-todo-icon{display:inline-flex;flex:none;width:1rem;height:1rem;align-items:center;justify-content:center}
.pi-desk-todo-icon svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.pi-desk-todo-icon[data-status="0"]{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.pi-desk-todo-icon[data-status="2"]{color:var(--status-success,var(--foreground))}
.pi-desk-todo-icon[data-status="3"]{color:var(--status-warning,var(--foreground))}
.pi-desk-todo-popup{width:min(26rem,max(17rem,var(--anchor-width)));overflow:hidden}
.pi-desk-todo-panel{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column}
.pi-desk-todo-heading{padding:.75rem .375rem .5rem;overflow-wrap:anywhere}
.pi-desk-todo-heading h3{margin:0;font:inherit;font-weight:600}
.pi-desk-todo-meta{display:flex;flex-wrap:wrap;gap:.25rem .75rem;margin-top:.375rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.75rem}
.pi-desk-todo-scroll{min-height:0;flex:1}
.pi-desk-todo-scroll-content{padding:0 .5rem .5rem;overscroll-behavior:contain}
.pi-desk-todo-list{list-style:none;margin:0;padding:0}
.pi-desk-todo-title{min-width:0;flex:1;overflow-wrap:anywhere}
.pi-desk-todo-leaf{display:flex;align-items:flex-start;gap:.5rem;min-width:0;padding:.5rem;border-radius:.375rem}
.pi-desk-todo-leaf>.pi-desk-todo-icon{margin-top:.125rem}
.pi-desk-todo-leaf[data-status="1"]{background:var(--pi-desk-plugin-muted,var(--muted))}
.pi-desk-todo-leaf[data-status="2"] .pi-desk-todo-title{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.pi-desk-todo-leaf[data-status="3"]{background:color-mix(in srgb,var(--status-warning,var(--foreground)) 8%,transparent)}
.pi-desk-todo-leaf-copy{flex:1;min-width:0}
.pi-desk-todo-leaf-top{display:flex;align-items:baseline;justify-content:space-between;gap:.25rem .5rem;flex-wrap:wrap}
.pi-desk-todo-status{flex:none;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.75rem}
.pi-desk-todo-note{margin:.25rem 0 0;font-size:.8125rem;overflow-wrap:anywhere;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.pi-desk-todo-leaf[data-status="3"] .pi-desk-todo-note,.pi-desk-todo-leaf[data-status="3"] .pi-desk-todo-status{color:var(--status-warning,var(--foreground))}
.pi-desk-todo-error{display:flex;align-items:center;gap:.5rem;justify-content:space-between;padding:.375rem .5rem;color:var(--pi-desk-plugin-destructive,var(--destructive));font-size:.8125rem;overflow-wrap:anywhere}
@media(prefers-reduced-motion:reduce){.pi-desk-todo-row{transition:none}}
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
    details: '查看任务进度，点击保持展开',
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
    details: 'View task progress; click to keep open',
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
          <>
            <path d="m12 3 10 18H2zM12 9v5m0 3v.1" />
          </>
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
  return (
    <li className="pi-desk-todo-leaf" data-todo-id={item.id} data-status={item.status}>
      <StatusIcon status={item.status} />
      <div className="pi-desk-todo-leaf-copy">
        <div className="pi-desk-todo-leaf-top">
          <span className="pi-desk-todo-title">{item.title}</span>
          <span className="pi-desk-todo-status">{labels.statuses[item.status]}</span>
        </div>
        {item.note ? <p className="pi-desk-todo-note">{item.note}</p> : null}
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
  todo: TodoInput
  state: TodoBrowserState
  controller: TodoBrowserController
  labels: Labels
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const widgetRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const ignoreReturnFocus = useRef(false)
  const open = hovered || focused || pinned
  const counts = countTodoItems(todo.items)
  const blocked = todo.items.filter((item) => item.status === 3).length
  const current = todo.items.some((item) => item.status === 1)
    ? 1
    : blocked
      ? 3
      : counts.completed === counts.total
        ? 2
        : 0
  const label = summary(todo, labels)

  useEffect(
    () => (): void => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current)
    },
    []
  )

  function enter(): void {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    setHovered(true)
  }

  function leave(): void {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setHovered(false), 160)
  }

  function close(): void {
    ignoreReturnFocus.current = Boolean(panelRef.current?.contains(document.activeElement))
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    setPinned(false)
    setHovered(false)
    setFocused(false)
  }

  function onFocus(event: FocusEvent<HTMLDivElement>): void {
    if (ignoreReturnFocus.current) {
      ignoreReturnFocus.current = false
      return
    }
    if (event.target.matches(':focus-visible')) {
      setFocused(true)
    }
  }

  function onBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget
    if (
      next instanceof Node &&
      (widgetRef.current?.contains(next) || panelRef.current?.contains(next))
    )
      return
    setFocused(false)
  }

  return (
    <div
      ref={widgetRef}
      className="pi-desk-todo"
      data-testid="todo-widget"
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
    >
      <div className="pi-desk-todo-row" data-testid="todo-summary-row">
        <PluginPopover
          open={open}
          side="top"
          align="start"
          className="pi-desk-todo-popup"
          onOpenChange={(nextOpen, details) => {
            if (details.reason === 'trigger-press') {
              if (pinned) close()
              else setPinned(true)
            } else if (!nextOpen) close()
          }}
          trigger={
            <PluginButton
              variant="ghost"
              size="sm"
              className="pi-desk-todo-summary"
              data-testid="todo-summary"
              aria-label={`${label} · ${counts.completed}/${counts.total} ${labels.tasks} ${labels.done}${blocked ? ` · ${labels.blocked(blocked)}` : ''} · ${labels.details}`}
              aria-pressed={pinned}
              title={label}
              onPointerEnter={(event) => {
                if (event.pointerType !== 'touch') enter()
              }}
              onPointerLeave={leave}
            >
              <StatusIcon status={current} />
              <span className="pi-desk-todo-summary-copy">{label}</span>
              {blocked ? (
                <span className="pi-desk-todo-blocked">{labels.blocked(blocked)}</span>
              ) : null}
              <span className="pi-desk-todo-count">
                {counts.completed}/{counts.total}
              </span>
            </PluginButton>
          }
        >
          <div
            ref={panelRef}
            className="pi-desk-todo-panel"
            data-testid="todo-popover"
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') enter()
            }}
            onPointerLeave={leave}
          >
            <PluginScroll
              className="pi-desk-todo-scroll"
              viewportClassName="pi-desk-todo-scroll-content"
              aria-label={todo.title}
            >
              <header className="pi-desk-todo-heading">
                <h3>{todo.title}</h3>
                <div className="pi-desk-todo-meta">
                  <span>
                    {labels.tasks} {counts.completed}/{counts.total} {labels.done}
                  </span>
                  {blocked ? (
                    <span className="pi-desk-todo-blocked">{labels.blocked(blocked)}</span>
                  ) : null}
                </div>
              </header>
              <ul className="pi-desk-todo-list">
                {todo.items.map((item) => (
                  <Task key={item.id} item={item} labels={labels} />
                ))}
              </ul>
            </PluginScroll>
          </div>
        </PluginPopover>
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
      </div>
      <div className="pi-desk-todo-segments" aria-hidden="true">
        {todo.items.map((item) => (
          <span key={item.id} className="pi-desk-todo-segment" data-status={item.status} />
        ))}
      </div>
    </div>
  )
}

export function TodoWidget({
  controller
}: {
  controller: TodoBrowserController
}): React.JSX.Element | null {
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
  const todo = state.snapshot.todo
  const visible = todo && !state.snapshot.hidden && todo.items.length > 0
  if (!visible && !state.error) return null

  return (
    <PluginSurface>
      <style href="pi-desk-todo" precedence="plugin-todo">
        {STYLES}
      </style>
      {visible ? (
        <TodoProgress todo={todo} state={state} controller={controller} labels={labels} />
      ) : null}
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
