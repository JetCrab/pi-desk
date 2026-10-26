'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserContributionIcon, PluginSource } from '@jetcrab/pi-desk-sdk/browser'
import {
  useL4PluginHost,
  useL4PluginRegistry
} from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import { L4PluginIcon } from '@client/l4_foundation/plugin-host/l4-plugin-icon'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { cn } from '@client/l4_foundation/lib/l4-utils'

interface L2PluginSessionHeaderActionProps {
  pluginName: string
  contributionName: string
  presentation: 'inline' | 'overflow'
  source: PluginSource
  icon: BrowserContributionIcon
  label: string
  onSelected?: () => void
}

export function L2PluginSessionHeaderAction({
  pluginName,
  contributionName,
  presentation,
  source,
  icon,
  label,
  onSelected
}: L2PluginSessionHeaderActionProps): React.JSX.Element {
  const runtime = useL4PluginHost()
  useL4PluginRegistry()
  const entryState = runtime.getEntryState(pluginName)
  const toast = useL4AppToast()
  const { t } = useTranslation('workbench')
  const lifecycle = useRef<AbortController | null>(null)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)

  useLayoutEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    pendingRef.current = false
    queueMicrotask(() => {
      if (!controller.signal.aborted) setPending(false)
    })
    return () => {
      controller.abort()
      if (lifecycle.current === controller) lifecycle.current = null
    }
  }, [entryState, presentation, source])

  const select = async (): Promise<void> => {
    const controller = lifecycle.current
    if (!controller || controller.signal.aborted || pendingRef.current) return
    const active = (): boolean =>
      !controller.signal.aborted && runtime.getEntryState(pluginName) === entryState
    pendingRef.current = true
    setPending(true)
    try {
      await runtime.invokeSessionHeaderAction({
        pluginName,
        contributionName,
        presentation,
        source,
        signal: controller.signal
      })
      if (active()) onSelected?.()
    } catch (cause: unknown) {
      if (!active()) return
      const message = cause instanceof Error ? cause.message : t('operationFailed')
      console.error('[Pi Desk][PluginHost] 会话标题操作失败', {
        pluginName,
        contributionName,
        presentation,
        source,
        message
      })
      toast.error(message)
    } finally {
      if (active()) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      aria-busy={pending}
      disabled={pending}
      data-testid="plugin-session-header-action"
      data-plugin-name={pluginName}
      data-contribution-name={contributionName}
      data-presentation={presentation}
      className={cn(
        presentation === 'overflow' && 'w-full justify-start whitespace-normal text-left'
      )}
      onClick={() => void select()}
    >
      <L4PluginIcon icon={icon} className="size-4" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </Button>
  )
}
