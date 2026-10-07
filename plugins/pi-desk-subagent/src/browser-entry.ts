import { defineBrowserEntry } from '@jetcrab/pi-desk-sdk/browser'

const loadViews = () => import('./browser.js')

export default defineBrowserEntry((plugin) => {
  plugin.registerContribution('settings-page', 'subagent', {
    label: '子代理',
    icon: { type: 'builtin', name: 'bot' },
    load: () => import('./browser-settings.js').then((module) => module.default)
  })

  plugin.registerContribution('message-view', 'start', {
    viewKey: 'subagent/start',
    priority: 100,
    load: () => loadViews().then((module) => module.startMessageView)
  })

  plugin.registerContribution('message-view', 'list', {
    viewKey: 'subagent/list',
    priority: 100,
    load: () => loadViews().then((module) => module.listMessageView)
  })

  plugin.registerContribution('message-view', 'control', {
    viewKey: 'subagent/control',
    priority: 100,
    load: () => loadViews().then((module) => module.controlMessageView)
  })

  plugin.registerContribution('message-view', 'return', {
    viewKey: 'subagent/return',
    priority: 100,
    load: () => loadViews().then((module) => module.returnMessageView)
  })
})
