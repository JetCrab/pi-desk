import 'server-only'

import {
  L2McpServersSchema,
  type L2McpSettings,
  type L2McpSettingsReplaceRequest
} from '@common/l2_biz/pi-settings/l2-pi-settings-contract'
import {
  L4PiSettingsStore,
  checkL4McpServer
} from '@server/l4_foundation/pi-settings/l4-pi-settings'

let store: L4PiSettingsStore | undefined

function settingsStore(): L4PiSettingsStore {
  store ??= new L4PiSettingsStore()
  return store
}

export async function getL2McpSettings(cwd: string | null): Promise<L2McpSettings> {
  const snapshot = await settingsStore().readMcp(cwd)
  const representableServers = (servers: L2McpSettings['local']): L2McpSettings['local'] =>
    Object.fromEntries(
      Object.entries(servers).filter(([name, config]) => {
        if (L2McpServersSchema.safeParse({ [name]: config }).success) return true
        if (!snapshot.diagnostics.some((diagnostic) => diagnostic.name === name)) {
          snapshot.diagnostics.push({ name, message: '服务名称长度必须为 1 至 128 个字符' })
        }
        return false
      })
    )
  return {
    ...snapshot,
    local: representableServers(snapshot.local),
    inherited: representableServers(snapshot.inherited)
  }
}

export async function replaceL2McpSettings(
  input: L2McpSettingsReplaceRequest
): Promise<Record<string, never>> {
  return settingsStore().replaceMcp(input)
}

export async function deleteL2McpSettings(input: {
  cwd: string | null
  name: string
}): Promise<Record<string, never>> {
  return settingsStore().deleteMcp(input)
}

export async function checkL2McpServer(
  input: { cwd: string | null; name: string },
  signal?: AbortSignal
): Promise<{ output: string }> {
  return checkL4McpServer(input, signal)
}
