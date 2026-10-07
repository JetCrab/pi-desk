import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  defaultContextIgnoreSettings,
  parseContextIgnoreSettings,
  type ContextIgnoreSettings
} from './context-settings.js'

const MAX_CONFIG_BYTES = 128 * 1024

export function defaultContextIgnoreSettingsPath(): string {
  const agentDir = getAgentDir()
  const path = join(agentDir, 'pi-desk-ctx.json')
  const previous = join(agentDir, 'pi-super-ctx.json')
  if (!existsSync(path) && existsSync(previous)) copyFileSync(previous, path)
  return path
}

export async function readContextIgnoreSettings(
  path = defaultContextIgnoreSettingsPath()
): Promise<ContextIgnoreSettings> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile()) throw new Error('上下文忽略配置必须是普通文件')
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error(`上下文忽略配置不能超过 ${Math.round(MAX_CONFIG_BYTES / 1024)}KB`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultContextIgnoreSettings()
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `读取上下文忽略配置失败：${error instanceof Error ? error.message : String(error)}`
    )
  }
  return parseContextIgnoreSettings(value)
}

export async function writeContextIgnoreSettings(
  value: unknown,
  path = defaultContextIgnoreSettingsPath()
): Promise<ContextIgnoreSettings> {
  const settings = parseContextIgnoreSettings(value)
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  return settings
}
