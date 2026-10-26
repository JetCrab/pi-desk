import type { ReactNode } from 'react'
import type { PluginSource } from '@jetcrab/pi-desk-sdk/browser'

export interface L2WorkbenchPluginWidgetSlots {
  renderPluginWidgets: (input: {
    source: PluginSource
    placement: 'aboveEditor' | 'belowEditor'
  }) => ReactNode
}

export interface L2WorkbenchPluginSessionSlots extends L2WorkbenchPluginWidgetSlots {
  renderPluginSessionHeader: (input: { source: PluginSource; title: ReactNode }) => ReactNode
}
