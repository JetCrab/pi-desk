import { defineBrowserEntry } from '@jetcrab/pi-desk-sdk/browser'
import { publishWorkspaceChanged, resetWorkspaceBrowserRuntime } from './browser-runtime.js'

export default defineBrowserEntry((plugin) => {
  const unregisterPush = plugin.onPush((message) => {
    const event = publishWorkspaceChanged(message)
    if (!event?.summary) return
    plugin.notify({
      level: 'success',
      title: '隔离工作区已更新',
      description: event.summary
    })
  })

  plugin.registerContribution('session-sidebar-tab', 'workspace', {
    label: '隔离工作区',
    icon: { type: 'builtin', name: 'folder' },
    load: () => import('./browser.js').then((module) => module.default)
  })

  return () => {
    unregisterPush()
    resetWorkspaceBrowserRuntime()
  }
})
