import { defineBrowserEntry } from '@jetcrab/pi-desk-sdk/browser'
import { tiboText } from './l4-tibo-locale.js'

export default defineBrowserEntry((plugin) => {
  const region = plugin.host.settings.getSnapshot().region
  const lifetime = new AbortController()
  let closeDetail: (() => void) | undefined
  let opening = 0

  const unsubscribe = plugin.notifications.onEvent('open-post', async ({ data }) => {
    const request = ++opening
    const detail = await import('./l2-browser-dialog.js')
    lifetime.signal.throwIfAborted()
    if (request !== opening)
      throw new Error(
        tiboText(
          region,
          '已打开另一条 Tibo 通知，请重试',
          'Another Tibo notification was opened. Please retry.'
        )
      )
    closeDetail?.()
    closeDetail = undefined
    const close = await detail.openPostDialog(plugin.host, data, lifetime.signal)
    if (lifetime.signal.aborted || request !== opening) {
      close()
      throw new Error(tiboText(region, 'Tibo 通知详情已关闭', 'Tibo notification details closed'))
    }
    closeDetail = close
  })

  plugin.registerContribution('settings-page', 'tibo-monitor', {
    label: tiboText(region, 'Tibo 动态', 'Tibo posts'),
    icon: { type: 'builtin', name: 'settings' },
    load: () => import('./l2-browser-settings.js').then((module) => module.default)
  })

  return () => {
    unsubscribe()
    lifetime.abort()
    closeDetail?.()
    closeDetail = undefined
  }
})
