import type { BrowserEntryFactory } from '@jetcrab/pi-desk-sdk/browser'
import { publishTodoPush, resetTodoBrowserRuntime } from './browser-runtime.js'

const entry: BrowserEntryFactory = (plugin) => {
  const unsubscribePush = plugin.onPush(publishTodoPush)
  plugin.registerWidget('progress', {
    placement: 'aboveEditor',
    load: () => import('./browser.js').then((module) => module.default)
  })

  return (): void => {
    void unsubscribePush()
    resetTodoBrowserRuntime()
  }
}

export default entry
