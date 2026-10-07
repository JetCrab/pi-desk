import { createRoot } from 'react-dom/client'
import type { BrowserComposerPanelImplementation } from '@jetcrab/pi-desk-sdk/browser'
import { PluginErrorBoundary } from '@jetcrab/pi-desk-sdk/react/base'
import { SessionAnalysisPanel } from './browser-session.js'

const implementation: BrowserComposerPanelImplementation = {
  mount({ container, target, host, signal }) {
    const root = createRoot(container)
    root.render(
      <PluginErrorBoundary>
        <SessionAnalysisPanel target={target} host={host} signal={signal} />
      </PluginErrorBoundary>
    )
    return (): void => root.unmount()
  }
}

export default implementation
