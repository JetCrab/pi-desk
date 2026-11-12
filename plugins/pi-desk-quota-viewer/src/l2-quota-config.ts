import type { PluginConfig } from '@jetcrab/pi-desk-sdk/entry'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import { z } from 'zod'
import { quotaAdapterRegistry } from './adapters/registry.js'
import type { QuotaAdapter } from './adapters/types.js'
import { QuotaDisplaySettingsSchema } from './l2-quota-display-schema.js'

const MAX_CONFIG_BYTES = 256 * 1024
export const MAX_SOURCES = 50
export const PLUGIN_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const storedSourceSchema = z
  .object({
    sourceId: z.string().uuid(),
    adapter: z.string().regex(PLUGIN_IDENTIFIER_PATTERN),
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    config: z.record(z.string(), z.string())
  })
  .strict()

export const storedConfigSchema = z
  .object({
    sources: z.array(storedSourceSchema).max(MAX_SOURCES),
    display: QuotaDisplaySettingsSchema.default(() => QuotaDisplaySettingsSchema.parse({}))
  })
  .strict()

export type StoredSource = z.infer<typeof storedSourceSchema>
export type StoredConfig = z.infer<typeof storedConfigSchema>

export function normalizeHiddenItems(keys: readonly string[]): string[] {
  return [...new Set(keys)]
}

function normalizeConfig(
  value: unknown,
  registry: ReadonlyMap<string, QuotaAdapter>
): StoredConfig {
  const parsed = storedConfigSchema.parse(value)
  const seen = new Set<string>()
  for (const source of parsed.sources) {
    if (seen.has(source.sourceId)) throw new Error(`额度来源 sourceId 重复：${source.sourceId}`)
    seen.add(source.sourceId)
    const adapter = registry.get(source.adapter)
    if (!adapter) throw new Error(`额度 Adapter 不存在：${source.adapter}`)
    source.config = adapter.validateConfig(source.config)
  }
  parsed.display.hiddenItemKeys = normalizeHiddenItems(parsed.display.hiddenItemKeys)
  return parsed
}

export async function readStoredConfig(
  config: PluginConfig,
  registry: ReadonlyMap<string, QuotaAdapter>
): Promise<StoredConfig> {
  const value = await config.get(['/sources/*/config/*'])
  return normalizeConfig(Object.keys(value).length ? value : { sources: [] }, registry)
}

export async function writeStoredConfig(
  config: PluginConfig,
  value: StoredConfig,
  registry: ReadonlyMap<string, QuotaAdapter> = quotaAdapterRegistry
): Promise<void> {
  const normalized = normalizeConfig(value, registry)
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_CONFIG_BYTES) {
    throw new PluginMethodError(400, `额度配置超过 ${Math.round(MAX_CONFIG_BYTES / 1024)}KB`)
  }
  const paths = normalized.sources.flatMap((source, index) => {
    const adapter = registry.get(source.adapter)!
    return adapter.descriptor.fields
      .filter((field) => field.kind === 'secret' && source.config[field.key])
      .map(
        (field) =>
          `/sources/${index}/config/${field.key.replaceAll('~', '~0').replaceAll('/', '~1')}`
      )
  })
  await config.set(normalized, paths)
}

/** 调用方 Runtime 串行编排同插件的读改写。 */
export async function updateStoredConfig(
  config: PluginConfig,
  update: (current: StoredConfig) => StoredConfig,
  registry: ReadonlyMap<string, QuotaAdapter> = quotaAdapterRegistry
): Promise<StoredConfig> {
  const next = normalizeConfig(update(await readStoredConfig(config, registry)), registry)
  await writeStoredConfig(config, next, registry)
  return next
}
