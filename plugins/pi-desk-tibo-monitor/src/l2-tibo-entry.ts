import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { definePiDeskPlugin, type PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import { z } from 'zod'
import { TiboModels } from './l4-tibo-model.js'
import { TiboRuntime } from './l2-tibo-runtime.js'
import { tiboText } from './l4-tibo-locale.js'
import {
  emptyInputSchema,
  errorText,
  recordInputSchema,
  settingsSchema
} from './l4-tibo-protocol.js'

function input<T extends z.ZodType>(schema: T, value: PluginJsonObject): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new PluginMethodError(400, parsed.error.issues[0]?.message ?? '输入无效')
  return parsed.data
}

export default definePiDeskPlugin({
  name: 'tibo-monitor',
  async setup(plugin) {
    const models = new TiboModels()
    const path = join(getAgentDir(), 'pi-desk-tibo-monitor.json')
    const previous = join(getAgentDir(), 'pi-super-tibo-monitor.json')
    if (!existsSync(path) && existsSync(previous)) copyFileSync(previous, path)
    const runtime = await TiboRuntime.create(plugin, {
      path,
      settings: plugin.host.settings,
      translate: (post, model, signal, region) => models.translate(post, model, signal, region)
    })
    plugin.registerMethod('state-get', async (value) => {
      input(emptyInputSchema, value)
      const snapshot = runtime.snapshot()
      console.info('[Pi Desk][TiboMonitor] 状态查询完成', {
        queriedAt: Date.now(),
        polling: snapshot.status.polling,
        lastCheckedAt: snapshot.status.lastCheckedAt,
        lastSuccessAt: snapshot.status.lastSuccessAt,
        error: snapshot.status.error
      })
      return { ...snapshot }
    })
    plugin.registerMethod('settings-save', async (value) => {
      const settings = input(settingsSchema, value)
      if (settings.enabled && settings.model) {
        const available = await models.list()
        if (
          !available.some(
            (model) =>
              model.provider === settings.model?.provider &&
              model.modelId === settings.model.modelId
          )
        ) {
          throw new PluginMethodError(
            400,
            tiboText(
              plugin.host.settings.getSnapshot().region,
              '所选翻译模型当前不可用，请检查模型配置与认证',
              'The selected translation model is unavailable. Check model configuration and authentication.'
            )
          )
        }
      }
      return { ...(await runtime.saveSettings(settings)) }
    })
    plugin.registerMethod('models-list', async (value) => {
      input(emptyInputSchema, value)
      return { models: await models.list() }
    })
    plugin.registerMethod('record-get', async (value) => ({
      record: runtime.record(input(recordInputSchema, value).id)
    }))
    plugin.registerMethod('record-translate', async (value) => {
      const { id } = input(recordInputSchema, value)
      try {
        return { record: await runtime.translateRecord(id) }
      } catch (error) {
        if (error instanceof PluginMethodError) throw error
        throw new PluginMethodError(
          409,
          `${tiboText(plugin.host.settings.getSnapshot().region, '当前无法完成翻译', 'Translation is currently unavailable')}: ${errorText(error)}`
        )
      }
    })
    plugin.registerBrowserEntry('./dist/browser/entry.js')
    return { dispose: () => runtime.dispose() }
  }
})
