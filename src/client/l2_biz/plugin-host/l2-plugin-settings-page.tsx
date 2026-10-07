'use client'

import { useEffect, useMemo } from 'react'
import type {
  BrowserBeforeLeaveHandler,
  BrowserSettingsPageTarget
} from '@jetcrab/pi-desk-sdk/browser'
import {
  useL4PluginHost,
  useL4PluginRegistry
} from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import type { L4PluginBrowserContributionDescriptor } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import { L2PluginContributionHost } from './l2-plugin-contribution-host'

interface L2PluginSettingsPageProps {
  pluginName: string
  descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'settings-page' }>
  onClose: () => void
  onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void
}

export function L2PluginSettingsPage({
  pluginName,
  descriptor,
  onClose,
  onBeforeLeaveChange
}: L2PluginSettingsPageProps): React.JSX.Element {
  const runtime = useL4PluginHost()
  useL4PluginRegistry()
  const entryState = runtime.getEntryState(pluginName)
  const entryIdentity = entryState.status === 'ready' ? entryState.runtime : entryState.status
  useEffect(
    () => () => {
      onBeforeLeaveChange(null)
    },
    [entryIdentity, onBeforeLeaveChange]
  )

  const target = useMemo<BrowserSettingsPageTarget>(
    () => ({
      kind: 'settings-page',
      close: () => {
        if (runtime.getEntryState(pluginName) === entryState) onClose()
      },
      setBeforeLeave: (handler) => {
        if (runtime.getEntryState(pluginName) === entryState) onBeforeLeaveChange(handler)
      }
    }),
    [entryState, onBeforeLeaveChange, onClose, pluginName, runtime]
  )

  return (
    <L2PluginContributionHost
      pluginName={pluginName}
      kind="settings-page"
      contributionName={descriptor.contributionName}
      target={target}
      className="pi-desk-chat-scrollbar h-full min-h-0 overflow-auto"
    />
  )
}
