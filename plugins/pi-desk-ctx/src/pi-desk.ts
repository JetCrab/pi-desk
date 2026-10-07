import { definePiDeskPlugin, type PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import { parseContextIgnoreSettings } from './context-settings.js'
import { readContextIgnoreSettings, writeContextIgnoreSettings } from './context-settings-store.js'

function jsonObject(value: unknown): PluginJsonObject {
  return JSON.parse(JSON.stringify(value)) as PluginJsonObject
}

function emptyInput(input: PluginJsonObject): void {
  const key = Object.keys(input)[0]
  if (key) throw new PluginMethodError(400, `未知输入字段：${key}`)
}

export default definePiDeskPlugin({
  name: 'context-ignore',
  setup(plugin) {
    plugin.registerMethod('settings-get', async (input) => {
      emptyInput(input)
      return jsonObject(await readContextIgnoreSettings())
    })
    plugin.registerMethod('settings-save', async (input) => {
      let settings
      try {
        settings = parseContextIgnoreSettings(input)
      } catch (error) {
        throw new PluginMethodError(
          400,
          error instanceof Error ? error.message : '上下文忽略配置无效'
        )
      }
      return jsonObject(await writeContextIgnoreSettings(settings))
    })
    plugin.registerBrowserEntry('./dist/browser/entry.js')
  }
})
