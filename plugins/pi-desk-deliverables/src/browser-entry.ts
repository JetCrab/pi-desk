import { defineBrowserEntry } from '@jetcrab/pi-desk-sdk/browser'
import { publishDeliverablePush, resetDeliverableBrowserRuntime } from './browser-runtime.js'

export default defineBrowserEntry((plugin) => {
  const unregisterPush = plugin.onPush((message) => {
    const delivery = publishDeliverablePush(message)
    if (!delivery) return
    plugin.notify({
      level: 'success',
      title:
        delivery.items.length === 1
          ? delivery.items[0]!.title
          : `新增 ${delivery.items.length} 个交付物`,
      description:
        delivery.items.length === 1
          ? delivery.items[0]!.path
          : delivery.items.map((item) => item.title).join('、')
    })
  })

  plugin.registerContribution('session-sidebar-tab', 'deliverables', {
    label: '交付物',
    icon: { type: 'builtin', name: 'file' },
    load: () => import('./browser.js').then((module) => module.default)
  })

  return () => {
    unregisterPush()
    resetDeliverableBrowserRuntime()
  }
})
