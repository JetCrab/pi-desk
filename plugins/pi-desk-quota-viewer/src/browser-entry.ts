import { defineBrowserEntry } from '@jetcrab/pi-desk-sdk/browser'
import {
  parseQuotaSnapshot,
  replaceQuotaSnapshot,
  resetQuotaBrowserRuntime
} from './browser-runtime.js'

const loadViews = () => import('./browser.js')

export default defineBrowserEntry((plugin) => {
  const english = plugin.host.locale?.getSnapshot().locale === 'en'
  const unregisterPush = plugin.onPush((message) => {
    if (message.event !== 'state') return
    replaceQuotaSnapshot(parseQuotaSnapshot(message.data))
  })

  plugin.registerContribution('application', 'quota-viewer', {
    label: english ? 'Quotas' : '额度',
    title: english ? 'Quota viewer' : '额度查看器',
    icon: { type: 'builtin', name: 'database' },
    chrome: 'host',
    load: () => loadViews().then((module) => module.quotaApplication)
  })

  plugin.registerContribution('settings-page', 'quota-sources', {
    label: english ? 'Quota settings' : '额度设置',
    icon: { type: 'builtin', name: 'settings' },
    load: () => loadViews().then((module) => module.quotaSettingsPage)
  })

  return () => {
    unregisterPush()
    resetQuotaBrowserRuntime()
  }
})
