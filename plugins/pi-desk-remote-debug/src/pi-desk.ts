import { definePiDeskPlugin, type PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/errors'
import type { ZodType } from 'zod'
import {
  remoteDebugRangesSchema,
  remoteDebugRegistrationDeleteSchema
} from './l4-remote-debug-contract.js'
import { RemoteDebugSettingsStore } from './l4-remote-debug-settings.js'
import { RemoteDebugRuntime } from './runtime.js'

function jsonObject(value: unknown): PluginJsonObject {
  return JSON.parse(JSON.stringify(value)) as PluginJsonObject
}

function emptyInput(input: PluginJsonObject): void {
  const key = Object.keys(input)[0]
  if (key) throw new PluginMethodError(400, `未知输入字段：${key}`)
}

function stringFields(input: PluginJsonObject, fields: readonly string[]): Record<string, string> {
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) throw new PluginMethodError(400, `未知输入字段：${key}`)
  }
  const result: Record<string, string> = {}
  for (const field of fields) {
    const value = input[field]
    if (typeof value !== 'string' || !value.trim()) {
      throw new PluginMethodError(400, `${field} 必须是非空字符串`)
    }
    result[field] = value
  }
  return result
}

function parseInput<T>(schema: ZodType<T>, input: PluginJsonObject): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new PluginMethodError(
      400,
      `输入无效：${result.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('；')}`
    )
  }
  return result.data
}

function methodError(error: unknown): PluginMethodError {
  if (error instanceof PluginMethodError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = /不存在|没有/.test(message) ? 404 : /正在运行|正在被/.test(message) ? 409 : 400
  return new PluginMethodError(code, message)
}

export default definePiDeskPlugin({
  name: 'remote-debug',
  setup(plugin) {
    const settingsStore = new RemoteDebugSettingsStore()
    const runtime = new RemoteDebugRuntime(plugin, { settingsStore })

    plugin.registerMethod('catalog-get', async (input) => {
      emptyInput(input)
      return jsonObject({ projects: await runtime.catalog() })
    })
    plugin.registerMethod('run-start', async (input, context) => {
      if (context.signal.aborted) throw new PluginMethodError(409, '启动请求已取消')
      const fields = stringFields(input, ['cwd', 'profile'])
      try {
        return jsonObject(await runtime.start(fields.cwd!, fields.profile!))
      } catch (error) {
        throw methodError(error)
      }
    })
    plugin.registerMethod('run-stop', async (input) => {
      const fields = stringFields(input, ['runId'])
      try {
        return jsonObject({ run: await runtime.stop(fields.runId!) })
      } catch (error) {
        throw methodError(error)
      }
    })

    plugin.registerMethod('settings-get', async (input) => {
      emptyInput(input)
      try {
        return jsonObject(await settingsStore.get())
      } catch (error) {
        throw methodError(error)
      }
    })
    plugin.registerMethod('settings-save', async (input) => {
      const ranges = parseInput(remoteDebugRangesSchema, input)
      try {
        const settings = await settingsStore.saveRanges(ranges)
        plugin.pushGlobal('settings-changed', {})
        return jsonObject(settings)
      } catch (error) {
        throw methodError(error)
      }
    })
    plugin.registerMethod('registration-delete', async (input) => {
      const registration = parseInput(remoteDebugRegistrationDeleteSchema, input)
      try {
        const settings = await settingsStore.removeRegistration(registration)
        plugin.pushGlobal('settings-changed', {})
        return jsonObject(settings)
      } catch (error) {
        throw methodError(error)
      }
    })

    plugin.registerBrowserEntry('./dist/browser/entry.js')
    return () => runtime.dispose()
  }
})
