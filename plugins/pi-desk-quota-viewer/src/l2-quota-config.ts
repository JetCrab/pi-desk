import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PluginMethodError } from '@jetcrab/pi-desk-sdk/session'
import { z } from 'zod'
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
    display: QuotaDisplaySettingsSchema.default(() => QuotaDisplaySettingsSchema.parse({})),
    hiddenResourceKeys: z.array(z.string()).optional()
  })
  .strict()
  .transform(({ hiddenResourceKeys: _legacy, ...config }) => config)

export type StoredSource = z.infer<typeof storedSourceSchema>
export type StoredConfig = z.infer<typeof storedConfigSchema>

export function defaultQuotaViewerConfigPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
  const agentDir = configured || join(homedir(), '.pi', 'agent')
  const path = join(agentDir, 'pi-desk-quota-viewer.json')
  const previous = join(agentDir, 'pi-super-quota-viewer.json')
  if (!existsSync(path) && existsSync(previous)) copyFileSync(previous, path)
  return path
}

export function normalizeHiddenItems(
  keys: readonly string[],
  registry: ReadonlyMap<string, QuotaAdapter>
): string[] {
  return [...new Set(keys)].filter((key) => registry.has(key.slice(0, key.indexOf(':'))))
}

export async function readStoredConfig(
  path: string,
  registry: ReadonlyMap<string, QuotaAdapter>
): Promise<StoredConfig> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('额度配置必须是非符号链接普通文件')
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error(`额度配置超过 ${Math.round(MAX_CONFIG_BYTES / 1024)}KB`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sources: [], display: QuotaDisplaySettingsSchema.parse({}) }
    }
    throw error
  }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`读取额度配置失败：${errorMessage(error)}`)
  }
  const parsed = storedConfigSchema.parse(raw)
  const seen = new Set<string>()
  const sources = parsed.sources.map((source) => {
    if (seen.has(source.sourceId)) throw new Error(`额度来源 sourceId 重复：${source.sourceId}`)
    seen.add(source.sourceId)
    const adapter = registry.get(source.adapter)
    if (!adapter) throw new Error(`额度 Adapter 不存在：${source.adapter}`)
    return {
      ...source,
      config: adapter.validateConfig(source.config)
    }
  })
  return {
    sources,
    display: {
      ...parsed.display,
      hiddenItemKeys: normalizeHiddenItems(parsed.display.hiddenItemKeys, registry)
    }
  }
}

export async function writeStoredConfig(path: string, value: StoredConfig): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
    throw new PluginMethodError(400, `额度配置超过 ${Math.round(MAX_CONFIG_BYTES / 1024)}KB`)
  }
  await mkdir(dirname(path), { recursive: true })
  let fileMode = 0o600
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new PluginMethodError(409, '额度配置必须是非符号链接普通文件')
    }
    const existingPrivateMode = metadata.mode & 0o600
    if (existingPrivateMode !== 0) fileMode = existingPrivateMode
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: fileMode })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
