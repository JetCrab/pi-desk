import type { PiDeskPluginDefinition } from '@jetcrab/pi-desk-sdk/entry'

const definition: PiDeskPluginDefinition = {
  name: 'local-application',
  setup(plugin) {
    plugin.registerMethod('status-get', async () => ({ message: '插件服务已连接' }))
    plugin.registerBrowserEntry('./browser/entry.js')
  }
}

export default definition
