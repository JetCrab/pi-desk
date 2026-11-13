import { realpath } from 'node:fs/promises'
import { getProjectConfigPath, type PluginConfig } from '@jetcrab/pi-desk-sdk/config'
import { z } from 'zod'
import {
  DEFAULT_REMOTE_DEBUG_RANGES,
  remoteDebugRangesSchema,
  type RemoteDebugRanges
} from './l4-remote-debug-contract.js'

const PROFILE_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u
const PORT_SCHEMA = z.number().int().min(1).max(65_535)
const PROFILE_SCHEMA = z.strictObject({
  command: z.string().min(1).max(8192),
  description: z.string().max(240).default(''),
  entryPort: PORT_SCHEMA,
  publicPort: PORT_SCHEMA,
  routes: z.record(z.string(), PORT_SCHEMA).default({})
})
const SECTION_SCHEMA = z.strictObject({
  ...remoteDebugRangesSchema.partial().shape,
  version: z.literal(1).optional(),
  profiles: z.record(z.string(), PROFILE_SCHEMA).optional()
})
const CONFIG_SCHEMA = SECTION_SCHEMA.required({ version: true, profiles: true })

export interface RemoteDebugRoute {
  path: string
  targetPort: number
}

export interface RemoteDebugProfile {
  description: string
  command: string
  entryPort: number
  publicPort: number
  routes: RemoteDebugRoute[]
}

export interface RemoteDebugConfig {
  version: 1
  profiles: Record<string, RemoteDebugProfile>
}

export function remoteDebugConfigPath(cwd: string): string {
  return getProjectConfigPath(cwd)
}

export async function readRemoteDebugConfig(
  cwd: string,
  config: PluginConfig
): Promise<RemoteDebugConfig | null> {
  const projectRoot = await realpath(cwd)
  const own = await config.get({ cwd: projectRoot, inherit: false })
  if (Object.keys(own).length === 0) return null
  return validateRemoteDebugConfig(
    await config.get({ cwd: projectRoot, defaults: DEFAULT_REMOTE_DEBUG_RANGES }),
    remoteDebugConfigPath(projectRoot)
  )
}

export function validateRemoteDebugRanges(value: unknown): RemoteDebugRanges {
  const section = SECTION_SCHEMA.parse(value)
  return remoteDebugRangesSchema.parse({
    localRange: section.localRange ?? DEFAULT_REMOTE_DEBUG_RANGES.localRange,
    publicRange: section.publicRange ?? DEFAULT_REMOTE_DEBUG_RANGES.publicRange
  })
}

export function validateRemoteDebugConfig(
  value: unknown,
  path = 'plugins.remote-debug'
): RemoteDebugConfig {
  const parsed = CONFIG_SCHEMA.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ')
    throw new Error(`${path}: ${detail}`)
  }

  const entries = Object.entries(parsed.data.profiles)
  if (entries.length === 0) {
    throw new Error(`${path}: profiles 至少需要一个调试配置`)
  }
  const profiles = Object.create(null) as Record<string, RemoteDebugProfile>
  for (const [rawName, rawProfile] of entries) {
    const name = rawName.trim()
    if (!PROFILE_NAME_PATTERN.test(name)) {
      throw new Error(`${path}: Profile 名称无效：${rawName}`)
    }
    if (Object.hasOwn(profiles, name)) {
      throw new Error(`${path}: Profile 名称规范化后重复：${name}`)
    }
    const command = rawProfile.command.trim()
    if (!command || command.includes('\0')) {
      throw new Error(`${path}: Profile ${name} 的 command 无效`)
    }

    const routes = Object.entries(rawProfile.routes)
      .map(([rawPath, targetPort]) => ({ path: normalizeRoutePath(rawPath), targetPort }))
      .sort((left, right) => right.path.length - left.path.length)
    const seenPaths = new Set<string>()
    for (const route of routes) {
      if (seenPaths.has(route.path)) {
        throw new Error(`${path}: Profile ${name} 的路由重复：${route.path}`)
      }
      seenPaths.add(route.path)
    }
    profiles[name] = {
      description: rawProfile.description.trim(),
      command,
      entryPort: rawProfile.entryPort,
      publicPort: rawProfile.publicPort,
      routes
    }
  }
  return { version: 1, profiles }
}

export async function writeRemoteDebugConfig(
  cwd: string,
  value: RemoteDebugConfig,
  config: PluginConfig
): Promise<void> {
  const projectRoot = await realpath(cwd)
  const own = await config.get({ cwd: projectRoot, inherit: false })
  const profiles = Object.fromEntries(
    Object.entries(value.profiles).map(([name, profile]) => [
      name,
      {
        ...profile,
        routes: Object.fromEntries(profile.routes.map((route) => [route.path, route.targetPort]))
      }
    ])
  )
  const next = { ...own, version: 1, profiles }
  validateRemoteDebugConfig({ version: 1, profiles }, remoteDebugConfigPath(projectRoot))
  await config.set(next, { cwd: projectRoot })
}

export function normalizeRoutePath(value: string): string {
  const path = value.trim()
  if (
    path.length < 2 ||
    path.length > 256 ||
    !path.startsWith('/') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('\\')
  ) {
    throw new Error(`路由路径无效：${value}`)
  }
  return path.endsWith('/') ? path.slice(0, -1) : path
}
