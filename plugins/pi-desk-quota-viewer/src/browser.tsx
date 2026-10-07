import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BrowserApplicationImplementation,
  BrowserSettingsPageImplementation
} from '@jetcrab/pi-desk-sdk/browser'
import { PluginErrorBoundary } from '@jetcrab/pi-desk-sdk/react/base'
import { QuotaApplication } from './views/l2-quota-application.js'
import { QuotaSettingsPage } from './views/l2-quota-settings.js'

function renderReact(
  container: HTMLElement,
  children: ReactNode,
  onError: (error: Error) => void
): () => void {
  const root = createRoot(container)
  root.render(<PluginErrorBoundary onError={onError}>{children}</PluginErrorBoundary>)
  return (): void => root.unmount()
}

export const quotaApplication: BrowserApplicationImplementation = {
  mount({ container, host, signal }) {
    return renderReact(container, <QuotaApplication host={host} signal={signal} />, (error) => {
      host.notify({ level: 'error', title: '额度页面渲染失败', description: error.message })
    })
  }
}

export const quotaSettingsPage: BrowserSettingsPageImplementation = {
  mount({ container, target, host, signal }) {
    return renderReact(
      container,
      <QuotaSettingsPage target={target} host={host} signal={signal} />,
      (error) => {
        host.notify({ level: 'error', title: '额度设置渲染失败', description: error.message })
      }
    )
  }
}
