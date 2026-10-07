import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { BrowserPluginHost, PluginJsonObject } from '@jetcrab/pi-desk-sdk/browser'
import {
  PluginDialog,
  PluginErrorBoundary,
  PluginLoadingState,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'
import { tiboText } from './l4-tibo-locale.js'
import { useTiboPost, useTiboRegion } from './l2-browser-hooks.js'
import { notificationDataSchema } from './l4-tibo-protocol.js'
import { TiboPostView } from './views/l2-tibo-post-view.js'
import { TIBO_STYLES } from './l2-tibo-styles.js'

let mountId = 0

function PostDialog({
  host,
  id,
  link,
  signal,
  onClose,
  onReady
}: {
  host: BrowserPluginHost
  id: string
  link: string
  signal: AbortSignal
  onClose(): void
  onReady(): void
}): React.JSX.Element {
  const detail = useTiboPost(host, id, signal)
  const region = useTiboRegion(host)
  useEffect(onReady, [onReady])
  return (
    <PluginSurface>
      <style>{TIBO_STYLES}</style>
      <PluginDialog
        open
        title={tiboText(region, 'Tibo 动态', 'Tibo posts')}
        closeLabel={tiboText(region, '关闭弹窗', 'Close dialog')}
        size="lg"
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <TiboPostView {...detail} region={region} link={link} onRetry={detail.retry} />
      </PluginDialog>
    </PluginSurface>
  )
}

// 回调只等弹窗挂载；查询在弹窗内执行，因此慢请求期间也能关闭。
export async function openPostDialog(
  host: BrowserPluginHost,
  data: PluginJsonObject,
  lifetime: AbortSignal
): Promise<() => void> {
  const { id, link } = notificationDataSchema.parse(data)
  lifetime.throwIfAborted()
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const container = document.createElement('div')
  container.dataset.tiboNotification = ''
  document.body.append(container)
  const root = createRoot(container, { identifierPrefix: `tibo-notification-${++mountId}-` })
  const controller = new AbortController()
  return new Promise<() => void>((resolve, reject) => {
    let closed = false
    let mounted = false
    function dispose(): void {
      if (closed) return
      closed = true
      controller.abort()
      lifetime.removeEventListener('abort', dispose)
      root.unmount()
      container.remove()
      if (trigger?.isConnected) trigger.focus()
      if (!mounted)
        reject(
          new Error(
            tiboText(
              host.settings.getSnapshot().region,
              'Tibo 通知详情在挂载前已关闭',
              'Tibo notification details closed before mounting'
            )
          )
        )
    }
    lifetime.addEventListener('abort', dispose, { once: true })
    try {
      root.render(
        <PluginErrorBoundary
          fallback={(error, retry) => (
            <PluginLoadingState
              loading={false}
              error={error}
              onRetry={retry}
              retryLabel={tiboText(host.settings.getSnapshot().region, '重新加载', 'Reload')}
            >
              {null}
            </PluginLoadingState>
          )}
          onError={(error) => {
            reject(error)
            host.notify({
              level: 'error',
              title: tiboText(
                host.settings.getSnapshot().region,
                'Tibo 详情渲染失败',
                'Failed to render Tibo details'
              ),
              description: error.message
            })
            queueMicrotask(dispose)
          }}
        >
          <PostDialog
            host={host}
            id={id}
            link={link}
            signal={controller.signal}
            onReady={() => {
              if (closed || lifetime.aborted) {
                queueMicrotask(dispose)
                return
              }
              mounted = true
              resolve(dispose)
            }}
            onClose={() => queueMicrotask(dispose)}
          />
        </PluginErrorBoundary>
      )
    } catch (error) {
      reject(error)
      dispose()
    }
  })
}
