import type {
  BrowserPluginHost,
  PluginPushMessage,
  PluginSource
} from '@jetcrab/pi-desk-sdk/browser'
import { parseTodoInput, type TodoInput, type TodoLeaf, type TodoSnapshot } from './contract.js'

type PushListener = (source: PluginSource) => void
const pushListeners = new Set<PushListener>()

export function publishTodoPush(message: PluginPushMessage): void {
  if (
    message.pluginName !== 'todo' ||
    message.event !== 'changed' ||
    message.target.scope !== 'session'
  ) {
    return
  }
  for (const listener of pushListeners) listener(message.target.source)
}

export function resetTodoBrowserRuntime(): void {
  pushListeners.clear()
}

export interface TodoBrowserState {
  snapshot: TodoSnapshot
  loading: boolean
  hiding: boolean
  error: { action: 'get' | 'hide'; message: string } | null
  change: { path: string; status: TodoLeaf['status'] | null; note?: string } | null
}

export interface TodoBrowserController {
  getSnapshot(): TodoBrowserState
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  hide(): Promise<void>
  dispose(): void
}

function parseSnapshot(value: unknown): TodoSnapshot {
  if (!value || typeof value !== 'object' || !('hidden' in value) || !('todo' in value)) {
    throw new Error('Todo 会话快照格式不正确')
  }
  if (typeof value.hidden !== 'boolean') throw new Error('Todo hidden 必须是布尔值')
  return { todo: value.todo === null ? null : parseTodoInput(value.todo), hidden: value.hidden }
}

function describeChange(
  previous: TodoInput | null,
  current: TodoInput
): NonNullable<TodoBrowserState['change']> {
  const locate = (todo: TodoInput): Array<{ leaf: TodoLeaf; path: string }> =>
    todo.items.flatMap((item) =>
      'children' in item
        ? item.children.map((leaf) => ({ leaf, path: `${item.title} › ${leaf.title}` }))
        : [{ leaf: item, path: item.title }]
    )
  const before = new Map(previous ? locate(previous).map(({ leaf }) => [leaf.id, leaf]) : [])
  const changes = locate(current).filter(
    ({ leaf }) => JSON.stringify(before.get(leaf.id)) !== JSON.stringify(leaf)
  )
  if (!previous || changes.length !== 1) return { path: current.title, status: null }
  const { leaf, path } = changes[0]!
  return { path, status: leaf.status, ...(leaf.note ? { note: leaf.note } : {}) }
}

function sameSource(left: PluginSource, right: PluginSource): boolean {
  return (
    left.workId === right.workId &&
    left.sessionId === right.sessionId &&
    left.branchId === right.branchId
  )
}

export function createTodoBrowserController(
  host: Pick<BrowserPluginHost, 'piDesk' | 'connection'>,
  source: PluginSource,
  signal?: AbortSignal
): TodoBrowserController {
  let state: TodoBrowserState = {
    snapshot: { todo: null, hidden: false },
    loading: false,
    hiding: false,
    error: null,
    change: null
  }
  const listeners = new Set<() => void>()
  const waiters = new Set<() => void>()
  let disposed = false
  let pumping = false
  let dirty = false
  let pendingHide = false
  let pendingChanged = false
  let baselineRequested = true
  let ready = host.connection.getSnapshot().status === 'ready'

  function update(patch: Partial<TodoBrowserState>): void {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  function settle(): void {
    for (const resolve of waiters) resolve()
    waiters.clear()
  }

  async function drain(): Promise<void> {
    try {
      while (!disposed && ready && (dirty || pendingHide)) {
        const action = pendingHide ? 'hide' : 'get'
        pendingHide = false
        dirty = false
        const notify = pendingChanged && !baselineRequested && action === 'get'
        pendingChanged = false
        baselineRequested = false
        update({ loading: true, error: null })
        try {
          const snapshot = parseSnapshot(await host.piDesk.invokeSession(source, action, {}))
          if (disposed) return
          // 查询期间收到新通知或隐藏操作时，丢弃旧结果，只应用队列收敛后的快照。
          if (!ready || dirty || pendingHide) {
            if (!baselineRequested) pendingChanged ||= notify
            continue
          }
          const previous = state.snapshot
          update({
            snapshot,
            change:
              notify && snapshot.todo && !snapshot.hidden
                ? describeChange(previous.todo, snapshot.todo)
                : action === 'hide'
                  ? null
                  : state.change
          })
        } catch (cause) {
          if (disposed) return
          if (!ready || (action === 'get' && (dirty || pendingHide))) continue
          console.error(`[todo] ${action === 'hide' ? '隐藏' : '查询'}进度失败`, cause)
          update({
            error: { action, message: cause instanceof Error ? cause.message : String(cause) }
          })
        } finally {
          if (!disposed && action === 'hide') update({ hiding: pendingHide })
        }
      }
    } finally {
      pumping = false
      if (!disposed) update({ loading: false })
      settle()
    }
  }

  function schedule(): Promise<void> {
    if (disposed) return Promise.resolve()
    const completion = new Promise<void>((resolve) => waiters.add(resolve))
    if (!pumping) {
      pumping = true
      void drain()
    }
    return completion
  }

  function refresh(changed = false): Promise<void> {
    if (disposed) return Promise.resolve()
    dirty = true
    if (changed) pendingChanged = true
    else {
      baselineRequested = true
      pendingChanged = false
      update({ change: null })
    }
    return schedule()
  }

  const onPush: PushListener = (target): void => {
    if (ready && sameSource(source, target)) void refresh(true)
  }
  pushListeners.add(onPush)
  const unsubscribeConnection = host.connection.subscribe(() => {
    const nextReady = host.connection.getSnapshot().status === 'ready'
    if (ready === nextReady) return
    ready = nextReady
    baselineRequested = true
    pendingChanged = false
    dirty = true
    update({ change: null })
    if (ready) void refresh()
  })

  function dispose(): void {
    if (disposed) return
    disposed = true
    pushListeners.delete(onPush)
    void unsubscribeConnection()
    signal?.removeEventListener('abort', dispose)
    listeners.clear()
    settle()
  }

  signal?.addEventListener('abort', dispose, { once: true })
  if (signal?.aborted) dispose()
  else void refresh()

  return {
    getSnapshot: (): TodoBrowserState => state,
    subscribe(listener): () => void {
      if (disposed) return (): void => undefined
      listeners.add(listener)
      return (): void => {
        listeners.delete(listener)
      }
    },
    refresh: (): Promise<void> => refresh(),
    hide(): Promise<void> {
      if (disposed || state.hiding) return Promise.resolve()
      pendingHide = true
      update({ hiding: true, error: null, change: null })
      return schedule()
    },
    dispose
  }
}
