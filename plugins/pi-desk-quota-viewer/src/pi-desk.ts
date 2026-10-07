import { definePiDeskPlugin, type PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import { QuotaViewerRuntime } from './runtime.js'

function jsonObject(value: unknown): PluginJsonObject {
  return JSON.parse(JSON.stringify(value)) as PluginJsonObject
}

function forceInput(input: PluginJsonObject): boolean {
  for (const key of Object.keys(input)) {
    if (key !== 'force') throw new PluginMethodError(400, `未知输入字段：${key}`)
  }
  if (input.force === undefined) return false
  if (typeof input.force !== 'boolean') {
    throw new PluginMethodError(400, 'force 必须是 boolean')
  }
  return input.force
}

function emptyInput(input: PluginJsonObject): void {
  const key = Object.keys(input)[0]
  if (key) throw new PluginMethodError(400, `未知输入字段：${key}`)
}

export default definePiDeskPlugin({
  name: 'quota-viewer',
  setup(plugin) {
    const runtime = new QuotaViewerRuntime(plugin)

    plugin.registerMethod('state-get', async (input) =>
      jsonObject(await runtime.query(forceInput(input)))
    )
    plugin.registerMethod('settings-get', async (input) => {
      emptyInput(input)
      return jsonObject(await runtime.settings())
    })
    plugin.registerMethod('settings-save', async (input) =>
      jsonObject(await runtime.saveSettings(input))
    )

    plugin.registerBrowserEntry('./dist/browser/entry.js')

    return () => runtime.dispose()
  }
})
