import { definePiDeskPlugin } from '@jetcrab/pi-desk-sdk/entry'

export default definePiDeskPlugin({
  name: 'deliverables',
  setup(plugin) {
    plugin.registerBrowserEntry('./dist/browser/entry.js')
  }
})
