import { definePiDeskPlugin } from '@jetcrab/pi-desk-sdk/entry'

export default definePiDeskPlugin({
  name: 'todo',
  setup(plugin): void {
    plugin.registerBrowserEntry('./dist/browser/entry.js')
  }
})
