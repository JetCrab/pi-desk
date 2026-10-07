import { defineBrowserEntry } from '@jetcrab/pi-desk-sdk/browser'

export default defineBrowserEntry((plugin) => {
  plugin.registerContribution('application', 'usage-dashboard', {
    label: '用量',
    title: '模型用量',
    icon: { type: 'builtin', name: 'panel' },
    chrome: 'host',
    load: () => import('./browser.js').then((module) => module.default)
  })

  plugin.registerContribution('composer-panel', 'session-analysis', {
    label: '会话分析',
    icon: { type: 'builtin', name: 'database' },
    load: () => import('./browser-session-view.js').then((module) => module.default)
  })
})
