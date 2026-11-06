import { defineBrowserEntry } from '@jetcrab/pi-desk-sdk/browser'
import {
  publishWorkspaceChanged,
  resetWorkspaceBrowserRuntime,
  subscribeWorkspaceSubmissions
} from './browser-runtime.js'

export default defineBrowserEntry((plugin) => {
  const unregisterPush = plugin.onPush((message) => {
    const event = publishWorkspaceChanged(message)
    if (!event?.summary) return
    plugin.notify({
      level: event.level ?? 'success',
      title: event.level === 'error' ? '工作区命令失败' : '隔离工作区已更新',
      description: event.summary
    })
  })

  const unsubscribeSubmissions = subscribeWorkspaceSubmissions((failure) => {
    if (!failure) return
    plugin.notify({
      level: 'error',
      title: '工作区命令提交未确认',
      description: failure.error ?? undefined
    })
  })

  plugin.registerContribution('session-sidebar-tab', 'workspace', {
    label: '隔离工作区',
    icon: { type: 'builtin', name: 'folder' },
    load: () => import('./browser.js').then((module) => module.default)
  })

  return () => {
    unregisterPush()
    unsubscribeSubmissions()
    resetWorkspaceBrowserRuntime()
  }
})
