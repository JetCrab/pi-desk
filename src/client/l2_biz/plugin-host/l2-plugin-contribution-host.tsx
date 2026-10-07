'use client'

import { AlertTriangleIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  BrowserApplicationTarget,
  BrowserComposerPanelTarget,
  BrowserMessageViewTarget,
  BrowserSessionSidebarTabTarget,
  BrowserSettingsPageTarget,
  PluginDisposer
} from '@jetcrab/pi-desk-sdk/browser'
import {
  useL4PluginHost,
  useL4PluginRegistry
} from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4ErrorDetails } from '@client/l4_foundation/ui/l4-error-details'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import type { L4PluginContributionKind } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'

type L2PluginContributionLayout = 'fill' | 'intrinsic'

interface L2PluginContributionHostProps {
  pluginName: string
  kind: L4PluginContributionKind
  contributionName: string
  target:
    | BrowserApplicationTarget
    | BrowserComposerPanelTarget
    | BrowserSettingsPageTarget
    | BrowserMessageViewTarget
    | BrowserSessionSidebarTabTarget
  targetKey?: string
  className?: string
  layout?: L2PluginContributionLayout
}

type MountState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; error: Error }

export function L2PluginContributionHost({
  pluginName,
  kind,
  contributionName,
  target,
  targetKey,
  className,
  layout = 'fill'
}: L2PluginContributionHostProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const runtime = useL4PluginHost()
  useL4PluginRegistry()
  const entryState = runtime.getEntryState(pluginName)
  const entryIdentity = entryState.status === 'ready' ? entryState.runtime : entryState.status
  const entryError = entryState.status === 'failed' ? entryState.error : null
  const containerRef = useRef<HTMLDivElement | null>(null)
  const targetRef = useRef(target)
  const mountIdentity = targetKey ?? target
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<MountState>({ status: 'loading' })

  useEffect(() => {
    targetRef.current = target
  }, [target])

  useEffect(() => {
    const hostContainer = containerRef.current
    if (!hostContainer) return
    const controller = new AbortController()
    let active = true
    let mountContainer: HTMLDivElement | null = null
    if (entryState.status !== 'ready') {
      queueMicrotask(() => {
        if (!active) return
        setState(entryError ? { status: 'error', error: entryError } : { status: 'loading' })
      })
      return () => {
        active = false
        controller.abort()
      }
    }
    const mountPromise: Promise<PluginDisposer | null> = Promise.resolve().then(() => {
      if (!active) return null
      mountContainer = document.createElement('div')
      mountContainer.className =
        layout === 'intrinsic'
          ? 'inline-block min-h-0 min-w-0 align-top'
          : 'h-full min-h-0 w-full min-w-0'
      hostContainer.append(mountContainer)
      return runtime.mountContribution({
        pluginName,
        kind,
        contributionName,
        container: mountContainer,
        target: targetRef.current,
        signal: controller.signal
      })
    })

    queueMicrotask(() => {
      if (active) setState({ status: 'loading' })
    })
    void mountPromise.then(
      (nextDispose) => {
        if (!active || !nextDispose) return
        setState({ status: 'ready' })
      },
      (cause: unknown) => {
        if (!active) return
        setState({
          status: 'error',
          error: cause instanceof Error ? cause : new Error(String(cause))
        })
      }
    )

    return () => {
      active = false
      controller.abort()
      mountContainer?.remove()
      const cleanupPromise = mountPromise.then(
        async (nextDispose) => {
          if (!nextDispose) return
          try {
            await nextDispose()
          } catch (cause: unknown) {
            console.error('[Pi Desk][PluginHost] Contribution disposer 执行失败', {
              pluginName,
              kind,
              contributionName,
              errorName: cause instanceof Error ? cause.name : 'UnknownError',
              message: cause instanceof Error ? cause.message : String(cause)
            })
          }
        },
        () => undefined
      )
      void cleanupPromise
    }
  }, [
    attempt,
    contributionName,
    entryIdentity,
    entryState.status,
    entryError,
    kind,
    layout,
    mountIdentity,
    pluginName,
    runtime
  ])

  const retry = (): void => {
    if (entryState.status === 'failed') {
      setState({ status: 'loading' })
      void runtime.retryEntry(pluginName).catch((cause: unknown) => {
        if (runtime.getEntryState(pluginName).status !== 'failed') return
        setState({
          status: 'error',
          error: cause instanceof Error ? cause : new Error(String(cause))
        })
      })
      return
    }
    const loadState = runtime.getContributionLoadState(pluginName, kind, contributionName)
    if (loadState.status !== 'failed') {
      setAttempt((current) => current + 1)
      return
    }
    setState({ status: 'loading' })
    void runtime.retryContribution(pluginName, kind, contributionName).then(
      () => {
        if (runtime.getEntryState(pluginName) === entryState) setAttempt((current) => current + 1)
      },
      (cause: unknown) => {
        if (runtime.getEntryState(pluginName) !== entryState) return
        setState({
          status: 'error',
          error: cause instanceof Error ? cause : new Error(String(cause))
        })
      }
    )
  }

  const intrinsicFallbackClass =
    state.status === 'loading'
      ? 'h-[200px] w-[360px]'
      : state.status === 'error'
        ? 'w-[min(480px,calc(100dvw-3rem))]'
        : 'h-fit w-fit'

  return (
    <div
      className={cn(
        'pi-desk-chat-scrollbar relative min-h-0 min-w-0',
        layout === 'intrinsic'
          ? cn(
              'max-h-[calc(100dvh-7rem)] max-w-[calc(100dvw-3rem)] overflow-auto max-sm:max-h-[calc(100dvh-5rem)] max-sm:max-w-[calc(100dvw-2rem)]',
              intrinsicFallbackClass
            )
          : 'h-full w-full',
        className
      )}
    >
      <div
        ref={containerRef}
        data-pi-desk-plugin={pluginName}
        data-pi-desk-kind={kind}
        data-pi-desk-contribution={contributionName}
        className={cn(
          layout === 'intrinsic'
            ? 'inline-block min-h-0 min-w-0 align-top'
            : 'h-full min-h-0 w-full min-w-0',
          state.status === 'error' && 'hidden'
        )}
      />
      {state.status === 'loading' ? (
        <div className="absolute inset-0 flex items-center justify-center bg-popover p-6 text-sm text-muted-foreground">
          <LoaderCircleIcon className="mr-2 size-4 animate-spin" />
          {t('viewLoading')}
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div
          role="alert"
          className={cn(
            'flex items-center justify-center overflow-auto bg-background p-4',
            layout === 'fill' && 'absolute inset-0'
          )}
        >
          <div className="w-full max-w-xl rounded-lg border border-destructive/35 bg-muted p-4">
            <div className="flex items-start gap-3">
              <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-destructive">{t('viewFailed')}</p>
                <L4ErrorDetails error={state.error}>
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {pluginName} · {kind} · {contributionName}
                  </p>
                </L4ErrorDetails>
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={retry}>
                  <RefreshCwIcon />
                  {t('retry')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
