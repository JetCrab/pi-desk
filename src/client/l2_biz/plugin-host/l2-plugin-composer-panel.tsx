'use client'

import { useMemo } from 'react'
import type { BrowserComposerPanelTarget, PluginSource } from '@jetcrab/pi-desk-sdk/browser'
import { L4PluginIcon } from '@client/l4_foundation/plugin-host/l4-plugin-icon'
import type { L4PluginBrowserContributionDescriptor } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import {
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogHeader,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { L2PluginContributionHost } from './l2-plugin-contribution-host'

interface L2PluginComposerPanelProps {
  pluginName: string
  descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'composer-panel' }>
  source: PluginSource
  onClose: () => void
}

export function L2PluginComposerPanel({
  pluginName,
  descriptor,
  source,
  onClose
}: L2PluginComposerPanelProps): React.JSX.Element {
  const target = useMemo<BrowserComposerPanelTarget>(
    () => ({ kind: 'composer-panel', source, close: onClose }),
    [onClose, source]
  )

  return (
    <L4AppDialogRoot open onOpenChange={(open) => !open && onClose()}>
      <L4AppDialogContent
        finalFocus={false}
        className="h-[min(720px,calc(100dvh-2rem))] max-w-4xl max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
      >
        <L4AppDialogHeader className="border-b px-4 py-3 pr-12">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
              <L4PluginIcon icon={descriptor.icon} className="size-5" />
            </span>
            <div className="min-w-0">
              <L4AppDialogTitle className="truncate">{descriptor.label}</L4AppDialogTitle>
              <L4AppDialogDescription className="sr-only">{pluginName}</L4AppDialogDescription>
            </div>
          </div>
        </L4AppDialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <L2PluginContributionHost
            pluginName={pluginName}
            kind="composer-panel"
            contributionName={descriptor.contributionName}
            target={target}
            className="pi-desk-chat-scrollbar h-full min-h-0 overflow-auto"
          />
        </div>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
