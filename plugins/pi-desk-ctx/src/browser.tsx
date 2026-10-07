import { createRoot } from 'react-dom/client'
import type { BrowserSettingsPageImplementation } from '@jetcrab/pi-desk-sdk/browser'
import { PluginErrorBoundary } from '@jetcrab/pi-desk-sdk/react/base'
import { ContextIgnoreSettingsPage } from './l2-context-settings-view.js'

export const contextIgnoreSettingsPage: BrowserSettingsPageImplementation = {
  mount({ container, target, host, signal }) {
    const root = createRoot(container)
    root.render(
      <PluginErrorBoundary
        onError={(error) =>
          host.notify({
            level: 'error',
            title: '上下文忽略设置渲染失败',
            description: error.message
          })
        }
      >
        <ContextIgnoreSettingsPage target={target} host={host} signal={signal} />
      </PluginErrorBoundary>
    )
    return (): void => root.unmount()
  }
}
