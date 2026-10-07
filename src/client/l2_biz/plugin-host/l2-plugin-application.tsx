'use client'

import { XIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  BrowserApplicationContext,
  BrowserApplicationTarget
} from '@jetcrab/pi-desk-sdk/browser'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4PluginIcon } from '@client/l4_foundation/plugin-host/l4-plugin-icon'
import {
  useL4PluginHost,
  useL4PluginRegistry
} from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import type { L4PluginBrowserContributionDescriptor } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import {
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogHeader,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { L2PluginContributionHost } from './l2-plugin-contribution-host'

interface L2PluginApplicationProps {
  pluginName: string
  descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'application' }>
  workSessions: readonly L2WorkSessionListItem[]
  preferredWorkId: string | null
  onClose: () => void
}

export function L2PluginApplication({
  pluginName,
  descriptor,
  workSessions,
  preferredWorkId,
  onClose
}: L2PluginApplicationProps): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const runtime = useL4PluginHost()
  useL4PluginRegistry()
  const entryState = runtime.getEntryState(pluginName)
  const [initialContext] = useState<BrowserApplicationContext | null>(() => {
    const workSession = workSessions.find((item) => item.workId === preferredWorkId)
    if (!workSession) return null
    return {
      source: {
        workId: workSession.workId,
        sessionId: workSession.sessionId,
        branchId: workSession.branchId
      },
      cwd: workSession.cwd
    }
  })
  const target = useMemo<BrowserApplicationTarget>(
    () => ({
      kind: 'application',
      initialContext,
      close: () => {
        if (runtime.getEntryState(pluginName) === entryState) onClose()
      }
    }),
    [entryState, initialContext, onClose, pluginName, runtime]
  )
  const hostChrome = descriptor.chrome === 'host'

  return (
    <L4AppDialogRoot
      open
      onOpenChange={(open, eventDetails) => {
        if (!open && eventDetails.reason !== 'focus-out') onClose()
      }}
    >
      <L4AppDialogContent
        finalFocus={false}
        showCloseButton={false}
        className={cn(
          'w-fit max-w-[calc(100dvw-2rem)] max-h-[calc(100dvh-2rem)]',
          !hostChrome && 'rounded-none border-0 bg-transparent shadow-none ring-0'
        )}
      >
        {hostChrome ? (
          <L4AppDialogHeader className="border-b px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                <L4PluginIcon icon={descriptor.icon} className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <L4AppDialogTitle className="break-words">{descriptor.title}</L4AppDialogTitle>
                <L4AppDialogDescription className="sr-only">{pluginName}</L4AppDialogDescription>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('closeNamedApplication', { name: descriptor.title })}
                title={t('closeApplication')}
                onClick={onClose}
                className="text-muted-foreground"
              >
                <XIcon className="size-4" />
              </Button>
            </div>
          </L4AppDialogHeader>
        ) : (
          <>
            <L4AppDialogTitle className="sr-only">{descriptor.title}</L4AppDialogTitle>
            <L4AppDialogDescription className="sr-only">{pluginName}</L4AppDialogDescription>
          </>
        )}
        <div className="min-h-0 min-w-0 max-w-full overflow-hidden">
          <L2PluginContributionHost
            pluginName={pluginName}
            kind="application"
            contributionName={descriptor.contributionName}
            target={target}
            layout="intrinsic"
          />
        </div>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
