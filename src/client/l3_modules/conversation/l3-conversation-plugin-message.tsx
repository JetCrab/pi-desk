'use client'

import { AlertTriangleIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'
import type {
  BrowserMessageHandle,
  BrowserMessageHandleListener,
  BrowserMessageViewTarget,
  PluginDisposer,
  PluginJsonObject,
  PublicMessageSnapshot
} from '@jetcrab/pi-desk-sdk/browser'
import {
  useL4PluginHost,
  useL4PluginRegistry
} from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4ErrorDetails } from '@client/l4_foundation/ui/l4-error-details'
import type { L3ConversationDisplayMessage } from './l3-conversation-display'

const L3ConversationPresentationContext = createContext<{
  basic: boolean
  recover?: () => Promise<void>
}>({ basic: false })

export function L3ConversationPresentationProvider({
  basic,
  onRecover,
  children
}: {
  basic: boolean
  onRecover: () => Promise<void>
  children: ReactNode
}): React.JSX.Element {
  const value = useMemo(() => ({ basic, recover: onRecover }), [basic, onRecover])
  return (
    <L3ConversationPresentationContext.Provider value={value}>
      {children}
    </L3ConversationPresentationContext.Provider>
  )
}

export type L3ConversationPluginDetailLoader = (
  message: L3ConversationDisplayMessage
) => Promise<PluginJsonObject | null>

function publicSnapshot(message: L3ConversationDisplayMessage): PublicMessageSnapshot {
  return {
    location: message.snapshot.location,
    fixed: message.snapshot.fixed,
    summary: message.snapshot.summary,
    ...(message.snapshot.detail === undefined ? {} : { detail: message.snapshot.detail })
  }
}

class L3ConversationBrowserMessageHandle implements BrowserMessageHandle {
  private snapshot: PublicMessageSnapshot
  private loader: L3ConversationPluginDetailLoader
  private message: L3ConversationDisplayMessage
  private readonly listeners = new Set<BrowserMessageHandleListener>()
  private pending: Promise<PluginJsonObject | null> | null = null
  private detailLoaded: boolean
  private requestEpoch = 0
  private disposed = false
  private basic = false

  constructor(message: L3ConversationDisplayMessage, loader: L3ConversationPluginDetailLoader) {
    this.message = message
    this.snapshot = publicSnapshot(message)
    this.loader = loader
    this.detailLoaded = this.snapshot.detail !== undefined || !this.snapshot.fixed.hasDetail
  }

  getSnapshot(): PublicMessageSnapshot {
    return this.snapshot
  }

  subscribe(listener: BrowserMessageHandleListener): PluginDisposer {
    if (this.disposed) throw new Error('Message Handle has been disposed')
    this.listeners.add(listener)
    return (): void => {
      this.listeners.delete(listener)
    }
  }

  loadDetail(): Promise<PluginJsonObject | null> {
    if (this.detailLoaded) return Promise.resolve(this.snapshot.detail ?? null)
    if (!this.snapshot.fixed.hasDetail) return Promise.resolve(null)
    if (!('entryId' in this.snapshot.location)) {
      return Promise.reject(new Error('Temporary Message 不能读取 canonical Detail'))
    }
    if (this.pending) return this.pending

    const epoch = this.requestEpoch
    const request = this.loader(this.message)
      .then((detail) => {
        if (!this.disposed && epoch === this.requestEpoch) {
          this.detailLoaded = true
          this.snapshot = { ...this.snapshot, ...(detail === null ? {} : { detail }) }
          this.notify()
        }
        return detail
      })
      .finally(() => {
        if (this.pending === request) this.pending = null
      })
    this.pending = request
    return request
  }

  replace(
    message: L3ConversationDisplayMessage,
    loader: L3ConversationPluginDetailLoader,
    basic: boolean
  ): void {
    if (this.disposed) return
    const next = publicSnapshot(message)
    if (this.snapshot === next) return
    const projectionChanged =
      this.basic !== basic ||
      (this.snapshot.detail !== undefined && next.detail === undefined) ||
      this.snapshot.fixed.viewKey !== next.fixed.viewKey ||
      ('entryId' in this.snapshot.location &&
        'entryId' in next.location &&
        this.snapshot.location.entryId !== next.location.entryId)
    this.basic = basic
    this.message = message
    this.loader = loader
    this.snapshot = next
    if (projectionChanged) {
      this.requestEpoch += 1
      this.pending = null
      this.detailLoaded = next.detail !== undefined || !next.fixed.hasDetail
    } else if (next.detail !== undefined || !next.fixed.hasDetail) {
      this.detailLoaded = true
    }
    this.notify()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.requestEpoch += 1
    this.pending = null
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function MessageErrorView({
  message,
  pluginName,
  contributionName,
  phase,
  error,
  handle,
  onRetry
}: {
  message: L3ConversationDisplayMessage
  pluginName: string | null
  contributionName: string | null
  phase: string
  error: Error
  handle: BrowserMessageHandle
  onRetry?: () => void | Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const [detail, setDetail] = useState<PluginJsonObject | null | undefined>(
    handle.getSnapshot().detail
  )
  const [loading, setLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const presentation = useContext(L3ConversationPresentationContext)
  const [recovering, setRecovering] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const errorName = error.name
  const errorMessage = error.message
  const errorStack = error.stack

  useEffect(() => {
    console.error('[Pi Desk][MessageView] 消息视图无法展示', {
      messageId: message.identity,
      viewKey: message.viewKey,
      pluginName,
      contributionName,
      phase,
      errorName,
      message: errorMessage,
      stack: errorStack
    })
  }, [
    message.identity,
    message.viewKey,
    pluginName,
    contributionName,
    phase,
    errorName,
    errorMessage,
    errorStack
  ])

  return (
    <div
      role="alert"
      data-message-id={message.identity}
      className="rounded-lg border border-destructive/35 bg-muted/30 p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-destructive">{t('viewFailed')}</p>
          {message.viewKey === 'pi-desk/message-declaration-error' &&
          typeof message.snapshot.summary.text === 'string' &&
          message.snapshot.summary.text.length > 0 ? (
            <p className="mt-2 whitespace-pre-wrap break-words text-foreground">
              {message.snapshot.summary.text}
            </p>
          ) : null}
          <L4ErrorDetails error={error}>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {pluginName ?? 'Host'} · {contributionName ?? t('reservedView')} · {message.viewKey} ·{' '}
              {phase}
            </p>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {t('publicSnapshot')}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-background p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                {JSON.stringify(handle.getSnapshot(), null, 2)}
              </pre>
            </details>
            {!message.temporary && message.snapshot.fixed.hasDetail && detail === undefined ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => {
                  setLoading(true)
                  setDetailError(null)
                  void handle
                    .loadDetail()
                    .then(setDetail, (cause: unknown) => {
                      setDetailError(cause instanceof Error ? cause.message : t('detailFailed'))
                    })
                    .finally(() => setLoading(false))
                }}
              >
                {loading ? <LoaderCircleIcon className="animate-spin" /> : null}
                {t('loadDetail')}
              </Button>
            ) : null}
            {detailError ? (
              <p className="text-sm text-destructive [overflow-wrap:anywhere]">{detailError}</p>
            ) : null}
            {detail ? (
              <pre className="max-h-48 overflow-auto rounded-md bg-background p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                {JSON.stringify(detail, null, 2)}
              </pre>
            ) : null}
          </L4ErrorDetails>
          {presentation.recover ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 mr-2"
              disabled={recovering}
              onClick={() => {
                setRecovering(true)
                void presentation.recover!()
                  .catch((cause: unknown) =>
                    setDetailError(cause instanceof Error ? cause.message : String(cause))
                  )
                  .finally(() => setRecovering(false))
              }}
            >
              {recovering ? <LoaderCircleIcon className="animate-spin" /> : null}
              {t('useBasicPresentation')}
            </Button>
          ) : null}
          {onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={retrying}
              onClick={() => {
                setRetrying(true)
                setDetailError(null)
                void Promise.resolve()
                  .then(onRetry)
                  .catch((cause: unknown) =>
                    setDetailError(cause instanceof Error ? cause.message : String(cause))
                  )
                  .finally(() => setRetrying(false))
              }}
            >
              {retrying ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}
              {t('retry')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function L3ConversationMessageView({
  message,
  loadDetail,
  defaultView
}: {
  message: L3ConversationDisplayMessage
  loadDetail: L3ConversationPluginDetailLoader
  defaultView: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const runtime = useL4PluginHost()
  useL4PluginRegistry()
  const presentation = useContext(L3ConversationPresentationContext)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleLifecycleRef = useRef<object | null>(null)
  const activeMountRef = useRef<object | null>(null)
  const [mountState, setMountState] = useState<
    | { status: 'loading' }
    | { status: 'ready' }
    | { status: 'error'; error: Error; phase: string; generation: object | null }
  >({ status: 'loading' })
  const [handle] = useState(() => new L3ConversationBrowserMessageHandle(message, loadDetail))
  const [attempt, setAttempt] = useState(0)
  const resolution = runtime.getMessageViewResolution(message.viewKey)
  const entriesInitialized = runtime.areEntriesInitialized()
  const waitingForView = !resolution && runtime.isRefreshingEntries()
  const resolutionKey =
    resolution?.status === 'winner'
      ? `${message.viewKey}\u0000${resolution.pluginName}\u0000${resolution.descriptor.contributionName}\u0000${resolution.descriptor.priority}`
      : resolution?.status === 'conflict'
        ? `${message.viewKey}\u0000${resolution.candidates.map((candidate) => `${candidate.pluginName}:${candidate.descriptor.contributionName}`).join(',')}`
        : message.viewKey
  const winnerPluginName = resolution?.status === 'winner' ? resolution.pluginName : null
  const winnerContributionName =
    resolution?.status === 'winner' ? resolution.descriptor.contributionName : null
  const winnerEntry = winnerPluginName ? runtime.getEntryState(winnerPluginName) : null
  const winnerIdentity = winnerEntry?.status === 'ready' ? winnerEntry.runtime : winnerEntry?.status
  const builtinView =
    message.viewKey.startsWith('pi-desk/') &&
    message.viewKey !== 'pi-desk/message-declaration-error'
  const builtinFallback = builtinView && resolution === null
  const mountGeneration = useMemo(
    () => ({ attempt, basic: presentation.basic, resolutionKey, winnerIdentity }),
    [attempt, presentation.basic, resolutionKey, winnerIdentity]
  )
  const target = useMemo<BrowserMessageViewTarget>(
    () => ({
      kind: 'message-view',
      message: {
        getSnapshot: () => handle.getSnapshot(),
        subscribe: (listener) => {
          if (activeMountRef.current !== mountGeneration) return () => undefined
          return handle.subscribe(() => {
            if (
              activeMountRef.current !== mountGeneration ||
              !winnerPluginName ||
              runtime.getEntryState(winnerPluginName) !== winnerEntry
            )
              return
            try {
              listener()
            } catch (cause) {
              setMountState({
                status: 'error',
                error: cause instanceof Error ? cause : new Error(String(cause)),
                phase: 'update',
                generation: mountGeneration
              })
            }
          })
        },
        loadDetail: async () => {
          if (activeMountRef.current !== mountGeneration) throw new Error('Message View 已释放')
          const detail = await handle.loadDetail()
          if (activeMountRef.current !== mountGeneration) throw new Error('Message View 已释放')
          return detail
        }
      },
      reportError(error) {
        if (
          activeMountRef.current !== mountGeneration ||
          !winnerPluginName ||
          runtime.getEntryState(winnerPluginName) !== winnerEntry
        )
          return
        setMountState({
          status: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
          phase: 'report-error',
          generation: mountGeneration
        })
      }
    }),
    [handle, mountGeneration, runtime, winnerEntry, winnerPluginName]
  )

  useLayoutEffect(() => {
    activeMountRef.current = mountGeneration
    handle.replace(message, loadDetail, presentation.basic)
    return () => {
      if (activeMountRef.current === mountGeneration) activeMountRef.current = null
    }
  }, [handle, loadDetail, message, presentation.basic, mountGeneration])

  useEffect(() => {
    const token = {}
    handleLifecycleRef.current = token
    return () => {
      if (handleLifecycleRef.current === token) handleLifecycleRef.current = null
      queueMicrotask(() => {
        if (handleLifecycleRef.current === null) handle.dispose()
      })
    }
  }, [handle])

  useEffect(() => {
    if (presentation.basic) {
      queueMicrotask(() => setMountState({ status: 'loading' }))
      return
    }
    if (
      !entriesInitialized ||
      builtinFallback ||
      message.viewKey === 'pi-desk/message-declaration-error'
    ) {
      return
    }
    if (!winnerPluginName || !winnerContributionName || winnerEntry?.status !== 'ready') return
    const hostContainer = containerRef.current
    if (!hostContainer) return
    const controller = new AbortController()
    let active = true
    let mountContainer: HTMLDivElement | null = null
    queueMicrotask(() => {
      if (!active) return
      setMountState({ status: 'loading' })
    })
    const mountPromise = Promise.resolve().then(() => {
      if (!active) return null
      mountContainer = document.createElement('div')
      hostContainer.append(mountContainer)
      return runtime.mountContribution({
        pluginName: winnerPluginName,
        kind: 'message-view',
        contributionName: winnerContributionName,
        container: mountContainer,
        target,
        signal: controller.signal
      })
    })
    void mountPromise.then(
      (dispose) => {
        if (active && dispose && runtime.getEntryState(winnerPluginName) === winnerEntry) {
          setMountState((current) =>
            current.status === 'error' && current.generation === mountGeneration
              ? current
              : { status: 'ready' }
          )
        }
      },
      (cause: unknown) => {
        if (!active || runtime.getEntryState(winnerPluginName) !== winnerEntry) return
        setMountState({
          status: 'error',
          error: cause instanceof Error ? cause : new Error(String(cause)),
          phase: 'mount',
          generation: mountGeneration
        })
      }
    )
    return () => {
      active = false
      controller.abort()
      mountContainer?.remove()
      const cleanupPromise = mountPromise.then(
        async (dispose) => {
          await dispose?.()
        },
        () => undefined
      )
      void cleanupPromise
    }
  }, [
    attempt,
    builtinFallback,
    entriesInitialized,
    message.viewKey,
    mountGeneration,
    winnerPluginName,
    winnerContributionName,
    winnerEntry,
    runtime,
    target,
    presentation.basic
  ])

  if (presentation.basic) return <>{defaultView}</>
  if (message.viewKey === 'pi-desk/message-declaration-error') {
    return (
      <MessageErrorView
        message={message}
        pluginName="pi-desk"
        contributionName="message-declaration-error"
        phase="declaration"
        error={new Error(t('declarationFailed'))}
        handle={handle}
      />
    )
  }
  if (!entriesInitialized) {
    if (builtinView) return <>{defaultView}</>
    return <div className="min-h-12" aria-busy="true" />
  }
  if (resolution?.status === 'conflict') {
    return (
      <MessageErrorView
        message={message}
        pluginName={null}
        contributionName={null}
        phase="priority-conflict"
        error={new Error(t('viewConflict'))}
        handle={handle}
      />
    )
  }
  if (!resolution) {
    if (waitingForView) {
      return <div className="min-h-12" aria-busy="true" />
    }
    if (builtinView) return <>{defaultView}</>
    return (
      <MessageErrorView
        message={message}
        pluginName={null}
        contributionName={null}
        phase="missing-view"
        error={new Error(t('viewMissing', { viewKey: message.viewKey }))}
        handle={handle}
        onRetry={async () => {
          await runtime.refreshEntries()
          await Promise.all(
            runtime.getFailedEntries().map(({ pluginName }) => runtime.retryEntry(pluginName))
          )
        }}
      />
    )
  }
  if (mountState.status === 'error' && mountState.generation === mountGeneration) {
    return (
      <MessageErrorView
        message={message}
        pluginName={resolution.pluginName}
        contributionName={resolution.descriptor.contributionName}
        phase={mountState.phase}
        error={mountState.error}
        handle={handle}
        onRetry={() => {
          const state = runtime.getContributionLoadState(
            resolution.pluginName,
            'message-view',
            resolution.descriptor.contributionName
          )
          setMountState({ status: 'loading' })
          if (state.status !== 'failed') {
            setAttempt((value) => value + 1)
            return
          }
          void runtime
            .retryContribution(
              resolution.pluginName,
              'message-view',
              resolution.descriptor.contributionName
            )
            .then(
              () => setAttempt((value) => value + 1),
              (cause: unknown) => {
                setMountState({
                  status: 'error',
                  error: cause instanceof Error ? cause : new Error(String(cause)),
                  phase: 'load',
                  generation: mountGeneration
                })
              }
            )
        }}
      />
    )
  }

  return (
    <div
      className="relative min-h-12"
      data-message-id={message.identity}
      aria-busy={mountState.status === 'loading'}
    >
      <div
        ref={containerRef}
        data-pi-desk-plugin={resolution.pluginName}
        data-pi-desk-kind="message-view"
        data-pi-desk-contribution={resolution.descriptor.contributionName}
      />
    </div>
  )
}
