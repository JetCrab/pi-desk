import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import {
  L4PluginDownloadSourceSchema,
  L4PluginRegistrySchema,
  l4PluginSourceIdentity,
  type L4PluginDownloadSource
} from '@common/l4_foundation/plugin/l4-plugin-package'

export const L4_PLUGIN_OFFICIAL_REGISTRY = 'https://registry.npmjs.org'
export const L4_PLUGIN_DOMESTIC_REGISTRY = 'https://mirrors.cloud.tencent.com/npm'
const PreferencesSchema = z
  .object({
    downloadSource: L4PluginDownloadSourceSchema.default({ mode: 'auto' }),
    disabled: z.array(z.string()).max(2000).default([]),
    registries: z.record(z.string(), L4PluginRegistrySchema).default({})
  })
  .strict()
type Preferences = z.infer<typeof PreferencesSchema>

export function readL4PiPluginPreferences(agentDir = getAgentDir()): Preferences {
  const path = join(agentDir, 'pi-desk-plugins.json')
  return existsSync(path)
    ? PreferencesSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    : PreferencesSchema.parse({})
}

function updatePreferences(agentDir: string, update: (current: Preferences) => Preferences): void {
  const path = join(agentDir, 'pi-desk-plugins.json')
  const next = PreferencesSchema.parse(update(readL4PiPluginPreferences(agentDir)))
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function setL4PiPluginDownloadSource(
  downloadSource: L4PluginDownloadSource,
  agentDir = getAgentDir()
): void {
  updatePreferences(agentDir, (current) => ({ ...current, downloadSource }))
}

export function setL4PiPluginEnabled(
  source: string,
  enabled: boolean,
  agentDir = getAgentDir()
): void {
  const identity = l4PluginSourceIdentity(source)
  updatePreferences(agentDir, (current) => ({
    ...current,
    disabled: [
      ...current.disabled.filter((item) => item !== identity),
      ...(enabled ? [] : [identity])
    ]
  }))
}

export function setL4PiPluginRegistry(
  source: string,
  registry: string | null,
  agentDir = getAgentDir()
): void {
  const identity = l4PluginSourceIdentity(source)
  updatePreferences(agentDir, (current) => {
    const registries = { ...current.registries }
    if (
      registry &&
      ![L4_PLUGIN_OFFICIAL_REGISTRY, L4_PLUGIN_DOMESTIC_REGISTRY].includes(
        registry.replace(/\/+$/, '')
      )
    )
      registries[identity] = registry
    else delete registries[identity]
    return { ...current, registries }
  })
}

export function removeL4PiPluginPreference(source: string, agentDir = getAgentDir()): void {
  const identity = l4PluginSourceIdentity(source)
  updatePreferences(agentDir, (current) => {
    const registries = { ...current.registries }
    delete registries[identity]
    return {
      ...current,
      registries,
      disabled: current.disabled.filter((item) => item !== identity)
    }
  })
}
