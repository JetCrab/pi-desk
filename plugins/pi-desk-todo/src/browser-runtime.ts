import type {
  BrowserPluginHost,
  PluginPushMessage,
  PluginSource
} from '@jetcrab/pi-desk-sdk/browser'
import { parseTodoInput, type TodoSnapshot } from './contract.js'

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
  let todo = value.todo
  // Browser 热更新不重载 Native 会话，旧二级快照只在读取边界摊平。
  if (todo && typeof todo === 'object' && 'items' in todo && Array.isArray(todo.items)) {
    todo = {
      ...todo,
      items: todo.items.flatMap((item: unknown): unknown[] =>
        item && typeof item === 'object' && 'children' in item && Array.isArray(item.children)
          ? item.children
          : [item]
      )
    }
  }
  return { todo: todo === null ? null : parseTodoInput(todo), hidden: value.hidden }
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
    error: null
  }
  const listeners = new Set<() => void>()
  const waiters = new Set<() => void>()
  let disposed = false
  let pumping = false
  let dirty = false
  let pendingHide = false
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
        update({ loading: true, error: null })
        try {
          const snapshot = parseSnapshot(await host.piDesk.invokeSession(source, action, {}))
          if (disposed) return
          // 查询期间收到新通知或隐藏操作时，丢弃旧结果，只应用队列收敛后的快照。
          if (!ready || dirty || pendingHide) continue
          update({ snapshot })
        } catch (cause) {
          if (disposed) return
          if (!ready || (action === 'get' && (dirty || pendingHide))) continue
          // Browser 更新不会重载旧 Native 会话，缺少查询方法时不打扰聊天。
          if (action === 'get' && cause instanceof Error && 'code' in cause && cause.code === 404) {
            update({ snapshot: { todo: null, hidden: false }, error: null })
            continue
          }
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

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve()
    dirty = true
    return schedule()
  }

  const onPush: PushListener = (target): void => {
    if (ready && sameSource(source, target)) void refresh()
  }
  pushListeners.add(onPush)
  const unsubscribeConnection = host.connection.subscribe(() => {
    const nextReady = host.connection.getSnapshot().status === 'ready'
    if (ready === nextReady) return
    ready = nextReady
    dirty = true
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
      update({ hiding: true, error: null })
      return schedule()
    },
    dispose
  }
}
