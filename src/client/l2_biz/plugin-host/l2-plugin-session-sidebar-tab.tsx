'use client'

import type {
  BrowserFilePreviewOptions,
  BrowserSessionSidebarTabTarget,
  PluginSource
} from '@jetcrab/pi-desk-sdk/browser'
import type { L4PluginBrowserContributionDescriptor } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import { L2PluginContributionHost } from './l2-plugin-contribution-host'

interface L2PluginSessionSidebarTabProps {
  pluginName: string
  descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'session-sidebar-tab' }>
  source: PluginSource
  cwd: string
  onPreviewFile: (path: string, options?: BrowserFilePreviewOptions) => void
  onRevealFile: (path: string) => Promise<void>
}

export function L2PluginSessionSidebarTab({
  pluginName,
  descriptor,
  source,
  cwd,
  onPreviewFile,
  onRevealFile
}: L2PluginSessionSidebarTabProps): React.JSX.Element {
  const target: BrowserSessionSidebarTabTarget = {
    kind: 'session-sidebar-tab',
    source,
    cwd,
    files: { preview: onPreviewFile, reveal: onRevealFile }
  }
  const targetKey = `${source.workId}\u0000${source.sessionId}\u0000${source.branchId}\u0000${cwd}`

  return (
    <L2PluginContributionHost
      pluginName={pluginName}
      kind="session-sidebar-tab"
      contributionName={descriptor.contributionName}
      target={target}
      targetKey={targetKey}
      layout="fill"
    />
  )
}
