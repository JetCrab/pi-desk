import { chmod, lstat, readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  getConfigPath,
  withConfigTransaction,
  writeConfigTextAtomic
} from '@jetcrab/pi-desk-sdk/config'
import {
  createSecretStore,
  isSecretReference,
  type SecretStore
} from '@jetcrab/pi-desk-sdk/secrets'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import { z } from 'zod'
import { quotaAdapterRegistry } from './adapters/registry.js'
import { errorMessage } from './adapters/resources.js'
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

type ConfigFile = {
  content: Buffer
  stored: StoredConfig
  value: StoredConfig
}

export function defaultQuotaViewerConfigPath(): string {
  return getConfigPath('pi-desk-quota-viewer.json')
}

export function normalizeHiddenItems(keys: readonly string[]): string[] {
  return [...new Set(keys)]
}

export async function readStoredConfig(
  path: string,
  registry: ReadonlyMap<string, QuotaAdapter>,
  secretStore?: SecretStore
): Promise<StoredConfig> {
  const store = secretStore ?? configSecretStore(path)
  return withConfigTransaction(path, async () => {
    const file = await readConfigFile(path, registry, store)
    return file?.value ?? { sources: [], display: QuotaDisplaySettingsSchema.parse({}) }
  })
}

function configSecretStore(path: string): SecretStore {
  const directory = dirname(path)
  return createSecretStore({
    agentDir: basename(directory) === 'config' ? dirname(directory) : directory
  })
}

async function readBytes(path: string): Promise<Buffer | null> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('额度配置必须是非符号链接普通文件')
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error(`额度配置超过 ${Math.round(MAX_CONFIG_BYTES / 1024)}KB`)
    }
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readConfigFile(
  path: string,
  registry: ReadonlyMap<string, QuotaAdapter>,
  store: SecretStore
): Promise<ConfigFile | null> {
  const content = await readBytes(path)
  if (content === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(content.toString('utf8'))
  } catch (error) {
    throw new Error(`读取额度配置失败：${errorMessage(error)}`)
  }
  const stored = storedConfigSchema.parse(raw)
  for (const source of stored.sources) {
    const adapter = registry.get(source.adapter)
    if (!adapter) throw new Error(`额度 Adapter 不存在：${source.adapter}`)
    for (const field of adapter.descriptor.fields) {
      const value = source.config[field.key]
      if (field.kind === 'secret' && value && !isSecretReference(value)) {
        throw new Error(`额度配置敏感字段必须为凭据引用或空值：${source.sourceId}/${field.key}`)
      }
    }
  }
  const value = await resolveConfig(stored, registry, store)
  return { content, stored, value }
}

async function resolveConfig(
  parsed: StoredConfig,
  registry: ReadonlyMap<string, QuotaAdapter>,
  store: SecretStore
): Promise<StoredConfig> {
  const seen = new Set<string>()
  const sources: StoredSource[] = []
  for (const source of parsed.sources) {
    if (seen.has(source.sourceId)) throw new Error(`额度来源 sourceId 重复：${source.sourceId}`)
    seen.add(source.sourceId)
    const adapter = registry.get(source.adapter)
    if (!adapter) throw new Error(`额度 Adapter 不存在：${source.adapter}`)
    const config = { ...source.config }
    for (const field of adapter.descriptor.fields) {
      if (field.kind !== 'secret') continue
      const value = config[field.key]
      if (isSecretReference(value)) {
        const secret = await store.get(value)
        if (secret === null) throw new Error(`额度凭据不存在：${source.sourceId}/${field.key}`)
        config[field.key] = secret
      }
    }
    sources.push({ ...source, config: adapter.validateConfig(config) })
  }
  return {
    sources,
    display: {
      ...parsed.display,
      hiddenItemKeys: normalizeHiddenItems(parsed.display.hiddenItemKeys)
    }
  }
}

async function assertConfigUnchanged(path: string, expected: Buffer | null): Promise<void> {
  const current = await readBytes(path)
  if (expected === null ? current !== null : !current?.equals(expected)) {
    throw new Error(`额度配置文件已变化：${path}`)
  }
}

export async function writeStoredConfig(
  path: string,
  value: StoredConfig,
  registry: ReadonlyMap<string, QuotaAdapter> = quotaAdapterRegistry,
  secretStore?: SecretStore
): Promise<void> {
  await updateStoredConfig(path, () => value, registry, secretStore)
}

export async function updateStoredConfig(
  path: string,
  update: (current: StoredConfig) => StoredConfig,
  registry: ReadonlyMap<string, QuotaAdapter> = quotaAdapterRegistry,
  secretStore?: SecretStore
): Promise<StoredConfig> {
  const store = secretStore ?? configSecretStore(path)
  return withConfigTransaction(path, async () => {
    const previous = await readConfigFile(path, registry, store)
    const value = update(
      previous?.value ?? { sources: [], display: QuotaDisplaySettingsSchema.parse({}) }
    )
    const normalized = await resolveConfig(value, registry, store)
    await publishConfig(path, value, previous, registry, store)
    const verified = await readConfigFile(path, registry, store)
    if (!verified || !isDeepStrictEqual(verified.value, normalized))
      throw new Error('额度配置写入验证失败')
    await assertConfigUnchanged(path, verified.content)
    return verified.value
  })
}

async function publishConfig(
  path: string,
  value: StoredConfig,
  previous: ConfigFile | null,
  registry: ReadonlyMap<string, QuotaAdapter>,
  store: SecretStore
): Promise<void> {
  const stored = structuredClone(value)
  const created: string[] = []
  let publicationAttempted = false
  try {
    for (const source of stored.sources) {
      const adapter = registry.get(source.adapter)
      if (!adapter) throw new Error(`额度 Adapter 不存在：${source.adapter}`)
      const old = previous?.stored.sources.find(
        (item) => item.sourceId === source.sourceId && item.adapter === source.adapter
      )
      for (const field of adapter.descriptor.fields) {
        if (field.kind !== 'secret' || !source.config[field.key]) continue
        const current = source.config[field.key]
        if (isSecretReference(current)) {
          if ((await store.get(current)) === null)
            throw new Error(`额度凭据不存在：${source.sourceId}/${field.key}`)
          continue
        }
        const reference = old?.config[field.key]
        if (reference && isSecretReference(reference)) {
          const previousValue = await store.get(reference)
          if (previousValue === null)
            throw new Error(`额度凭据不存在：${source.sourceId}/${field.key}`)
          if (previousValue === current) {
            source.config[field.key] = reference
            continue
          }
        }
        const next = await store.put(current)
        created.push(next)
        if ((await store.get(next)) !== current) throw new Error('额度凭据写入验证失败')
        source.config[field.key] = next
      }
    }
    const content = `${JSON.stringify(stored, null, 2)}\n`
    if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
      throw new PluginMethodError(400, `额度配置超过 ${Math.round(MAX_CONFIG_BYTES / 1024)}KB`)
    }
    await assertConfigUnchanged(path, previous?.content ?? null)
    const privateMode =
      process.platform !== 'win32' && previous ? (await lstat(path)).mode & 0o600 : 0o600
    publicationAttempted = true
    await writeConfigTextAtomic(path, content)
    if (privateMode && privateMode !== 0o600) await chmod(path, privateMode)
  } catch (error) {
    // 发布尝试后的错误不能证明未提交；已发布引用也可能被其他配置共享。
    if (!publicationAttempted) {
      const cleanup = await Promise.allSettled(created.map((reference) => store.delete(reference)))
      if (cleanup.some((result) => result.status === 'rejected')) {
        console.warn('[quota-viewer] 未提交凭据清理失败，配置未覆盖')
      }
    }
    throw error
  }
}
