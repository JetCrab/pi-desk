import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode
} from 'react'
import type {
  BrowserConnectionHost,
  BrowserConnectionSnapshot,
  BrowserMessageHandle,
  BrowserPluginFacade,
  BrowserWorkSessionHost,
  PluginJsonObject,
  PluginPushMessage,
  PluginWorkSession,
  PublicMessageSnapshot
} from './browser.js'

export type {
  BrowserConnectionHost,
  BrowserConnectionSnapshot,
  BrowserMessageHandle,
  BrowserNotificationInput,
  BrowserNotificationLevel,
  BrowserPluginFacade,
  BrowserWorkSessionHost,
  PluginPushMessage,
  PluginWorkSession,
  PublicMessageSnapshot
} from './browser.js'
export * from './react-ui.tsx'
export * from './react-log.tsx'

function useExternalSnapshot<T>(owner: {
  getSnapshot(): T
  subscribe(listener: () => void): () => void | Promise<void>
}): T {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      const dispose = owner.subscribe(listener)
      return (): void => {
        void dispose()
      }
    },
    [owner]
  )
  const getSnapshot = useCallback((): T => owner.getSnapshot(), [owner])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function usePluginConnection(connection: BrowserConnectionHost): BrowserConnectionSnapshot {
  return useExternalSnapshot(connection)
}

export function usePluginWorkSessions(
  workSessions: BrowserWorkSessionHost
): readonly PluginWorkSession[] {
  return useExternalSnapshot(workSessions)
}

export function usePluginPush(
  plugin: Pick<BrowserPluginFacade, 'onPush'>,
  listener: (message: PluginPushMessage) => void
): void {
  useEffect(() => {
    const dispose = plugin.onPush(listener)
    return (): void => {
      void dispose()
    }
  }, [listener, plugin])
}

export function useMessageHandle(handle: BrowserMessageHandle): PublicMessageSnapshot {
  return useExternalSnapshot(handle)
}

export interface MessageDetailState {
  detail: PluginJsonObject | null | undefined
  loading: boolean
  error: Error | null
  load(): Promise<PluginJsonObject | null>
}

export function useMessageDetail(
  handle: BrowserMessageHandle,
  autoLoad = false
): MessageDetailState {
  const snapshot = useMessageHandle(handle)
  const requestEpoch = useRef(0)
  const [requestState, setRequestState] = useState<{
    handle: BrowserMessageHandle
    loading: boolean
    loaded: boolean
    error: Error | null
  }>({ handle, loading: false, loaded: false, error: null })
  const currentState =
    requestState.handle === handle
      ? requestState
      : { handle, loading: false, loaded: false, error: null }

  const load = useCallback(async (): Promise<PluginJsonObject | null> => {
    const epoch = requestEpoch.current + 1
    requestEpoch.current = epoch
    setRequestState({ handle, loading: true, loaded: false, error: null })
    try {
      const detail = await handle.loadDetail()
      if (requestEpoch.current === epoch) {
        setRequestState({ handle, loading: false, loaded: true, error: null })
      }
      return detail
    } catch (cause) {
      const nextError = cause instanceof Error ? cause : new Error(String(cause))
      if (requestEpoch.current === epoch) {
        setRequestState({ handle, loading: false, loaded: false, error: nextError })
      }
      throw nextError
    }
  }, [handle])

  useEffect(() => {
    if (
      !autoLoad ||
      currentState.loading ||
      currentState.loaded ||
      currentState.error ||
      snapshot.detail !== undefined ||
      !snapshot.fixed.hasDetail ||
      !('entryId' in snapshot.location)
    ) {
      return
    }
    let active = true
    queueMicrotask(() => {
      if (active) void load().catch(() => undefined)
    })
    return (): void => {
      active = false
    }
  }, [
    autoLoad,
    currentState.error,
    currentState.loaded,
    currentState.loading,
    load,
    snapshot.detail,
    snapshot.fixed.hasDetail,
    snapshot.location
  ])

  return {
    detail: snapshot.detail,
    loading: currentState.loading,
    error: currentState.error,
    load
  }
}

export interface PluginErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode | ((error: Error, retry: () => void) => ReactNode)
  onError?(error: Error, info: ErrorInfo): void
  resetKey?: unknown
}

interface PluginErrorBoundaryState {
  error: Error | null
}

export class PluginErrorBoundary extends Component<
  PluginErrorBoundaryProps,
  PluginErrorBoundaryState
> {
  state: PluginErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PluginErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
  }

  componentDidUpdate(previousProps: PluginErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  private readonly retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (typeof this.props.fallback === 'function') {
      return this.props.fallback(error, this.retry)
    }
    if (this.props.fallback !== undefined) return this.props.fallback
    return (
      <div role="alert" data-pi-desk-plugin-error="true">
        <p>插件界面加载失败</p>
        <pre>{error.message}</pre>
        <button type="button" onClick={this.retry}>
          重试
        </button>
      </div>
    )
  }
}
