'use client'

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserWidgetTarget, PluginSource } from '@jetcrab/pi-desk-sdk/browser'
import { useL4PluginRegistry } from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import { L2PluginContributionHost } from './l2-plugin-contribution-host'

interface L2PluginWidgetsProps {
  source: PluginSource
  placement: 'aboveEditor' | 'belowEditor'
}

export function L2PluginWidgets({
  source,
  placement
}: L2PluginWidgetsProps): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const registry = useL4PluginRegistry()
  const target = useMemo<BrowserWidgetTarget>(() => ({ kind: 'widget', source }), [source])
  const sourceKey = JSON.stringify([source.workId, source.sessionId, source.branchId])
  const widgets = registry.flatMap((entry) =>
    entry.contributions.flatMap((descriptor) =>
      descriptor.kind === 'widget' && descriptor.placement === placement
        ? [{ pluginName: entry.pluginName, descriptor }]
        : []
    )
  )
  if (widgets.length === 0) return null

  return (
    <div
      data-testid={`plugin-widgets-${placement}`}
      aria-label={t('composer')}
      className="min-w-0 w-full"
    >
      {widgets.map(({ pluginName, descriptor }) => (
        <L2PluginContributionHost
          key={`${pluginName}:${descriptor.contributionName}:${sourceKey}`}
          pluginName={pluginName}
          kind="widget"
          contributionName={descriptor.contributionName}
          target={target}
          targetKey={sourceKey}
          layout="inline"
        />
      ))}
    </div>
  )
}
