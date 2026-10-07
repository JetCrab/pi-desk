import { defineBrowserEntry } from '@jetcrab/pi-desk-sdk/browser'
import { createRemoteDebugBrowserEvents } from './l4-browser-events.js'

const loadApplication = () => import('./browser.js')

export default defineBrowserEntry((plugin) => {
  const events = createRemoteDebugBrowserEvents()
  const disposePush = plugin.onPush((message) => {
    if (message.target.scope === 'global' && message.event === 'settings-changed') events.changed()
  })
  plugin.registerContribution('application', 'remote-debug', {
    label: '远程调试',
    title: '远程调试',
    icon: { type: 'builtin', name: 'globe' },
    chrome: 'host',
    load: () => loadApplication().then((module) => module.createRemoteDebugApplication(events))
  })
  plugin.registerContribution('settings-page', 'remote-debug', {
    label: '远程调试',
    icon: { type: 'builtin', name: 'settings' },
    load: () =>
      import('./l2-browser-settings.js').then((module) => module.createRemoteDebugSettings(events))
  })
  return (): void => {
    disposePush()
    events.dispose()
  }
})
