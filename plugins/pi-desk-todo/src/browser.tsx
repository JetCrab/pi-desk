import { createRoot } from 'react-dom/client'
import type { BrowserWidgetImplementation } from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginButton,
  PluginErrorBoundary,
  PluginHostProvider,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'
import { createTodoBrowserController } from './browser-runtime.js'
import { TodoWidget } from './browser-view.js'

const widget: BrowserWidgetImplementation = {
  mount({ container, target, host, signal }) {
    if (signal.aborted) return
    const controller = createTodoBrowserController(host, target.source, signal)
    const root = createRoot(container)
    let disposed = false
    const english = host.settings.getSnapshot().region.locale === 'en'

    root.render(
      <PluginHostProvider host={host}>
        <PluginErrorBoundary
          onError={(error) => console.error('[todo] 任务进度界面加载失败', error)}
          fallback={(error, retry) => (
            <PluginSurface
              role="alert"
              style={{ display: 'grid', gap: '.375rem', padding: '.5rem' }}
            >
              <span>
                {english ? 'Could not display task progress' : '任务进度显示失败'}: {error.message}
              </span>
              <PluginButton size="sm" onClick={retry}>
                {english ? 'Retry' : '重试'}
              </PluginButton>
            </PluginSurface>
          )}
        >
          <TodoWidget controller={controller} />
        </PluginErrorBoundary>
      </PluginHostProvider>
    )

    function dispose(): void {
      if (disposed) return
      disposed = true
      signal.removeEventListener('abort', dispose)
      controller.dispose()
      root.unmount()
    }

    signal.addEventListener('abort', dispose, { once: true })
    if (signal.aborted) dispose()
    return dispose
  }
}

export default widget
