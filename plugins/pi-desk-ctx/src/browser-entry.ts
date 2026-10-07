import { defineBrowserEntry } from '@jetcrab/pi-desk-sdk/browser'

const loadSettingsPage = () => import('./browser.js')

export default defineBrowserEntry((plugin) => {
  plugin.registerContribution('settings-page', 'context-ignore', {
    label: '上下文忽略',
    icon: { type: 'builtin', name: 'bot' },
    load: () => loadSettingsPage().then((module) => module.contextIgnoreSettingsPage)
  })
})
