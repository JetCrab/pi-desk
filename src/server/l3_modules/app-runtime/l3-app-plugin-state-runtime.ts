import 'server-only'

import type { PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import {
  L3PluginJsonObjectSchema,
  L3PluginNameSchema
} from '@common/l3_modules/plugin-host/l3-plugin-json-contract'
import { getL3AppRuntime, type L3AppRuntime } from './l3-app-runtime'

const L3_APP_PLUGIN_STATE_MAX_JSON_BYTES = 64 * 1024

export class L3AppPluginStateRuntime {
  private disposed = false

  constructor(private readonly runtime: L3AppRuntime = getL3AppRuntime()) {}

  setState(pluginNameInput: string, stateInput: PluginJsonObject | null): void {
    this.ensureActive()
    const pluginName = L3PluginNameSchema.parse(pluginNameInput)
    const state = stateInput === null ? null : L3PluginJsonObjectSchema.parse(stateInput)
    if (
      state !== null &&
      Buffer.byteLength(JSON.stringify(state), 'utf8') > L3_APP_PLUGIN_STATE_MAX_JSON_BYTES
    ) {
      throw new Error('Plugin global state exceeds 64KB')
    }
    const current = this.runtime.readSnapshot().plugins[pluginName]

    if (state === null) {
      if (current === undefined) return
    } else if (current !== undefined && JSON.stringify(current) === JSON.stringify(state)) {
      return
    }

    this.runtime.applyInternal({
      key: 'plugins',
      update: {
        pluginName,
        state: state === null ? null : structuredClone(state)
      }
    })
  }

  releasePlugin(pluginName: string): void {
    if (this.disposed) return
    this.setState(pluginName, null)
  }

  dispose(): void {
    this.disposed = true
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('App Plugin State Runtime has been disposed')
  }
}

function pluginStateRuntime(): L3AppPluginStateRuntime {
  if (!globalThis.__piDeskAppPluginStateRuntime) {
    globalThis.__piDeskAppPluginStateRuntime = new L3AppPluginStateRuntime()
  }
  return globalThis.__piDeskAppPluginStateRuntime
}

export function getL3AppPluginStateRuntime(): L3AppPluginStateRuntime {
  return pluginStateRuntime()
}

export function disposeL3AppPluginStateRuntime(): void {
  const runtime = globalThis.__piDeskAppPluginStateRuntime
  globalThis.__piDeskAppPluginStateRuntime = undefined
  runtime?.dispose()
}

declare global {
  var __piDeskAppPluginStateRuntime: L3AppPluginStateRuntime | undefined
}
