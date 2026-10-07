import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Document, isMap, parseDocument } from 'yaml'
import { z } from 'zod'

export const REMOTE_DEBUG_CONFIG_DIRECTORY = '.pi'
export const REMOTE_DEBUG_CONFIG_FILE = 'remote_debug.yaml'

const MAX_CONFIG_BYTES = 128 * 1024
const PROFILE_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u
const PORT_SCHEMA = z.number().int().min(1).max(65_535)
const PROFILE_SCHEMA = z.strictObject({
  command: z.string().min(1).max(8192),
  description: z.string().max(240).default(''),
  entryPort: PORT_SCHEMA,
  publicPort: PORT_SCHEMA,
  routes: z.record(z.string(), PORT_SCHEMA).default({})
})
const CONFIG_SCHEMA = z.strictObject({
  version: z.literal(1),
  profiles: z.record(z.string(), PROFILE_SCHEMA)
})

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
  return join(cwd, REMOTE_DEBUG_CONFIG_DIRECTORY, REMOTE_DEBUG_CONFIG_FILE)
}

export async function readRemoteDebugConfig(cwd: string): Promise<RemoteDebugConfig | null> {
  const projectRoot = await realpath(cwd)
  await ensureConfigDirectory(projectRoot)
  const path = remoteDebugConfigPath(projectRoot)
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!metadata) return null
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${path} 必须是非符号链接普通文件`)
  }
  if (metadata.size > MAX_CONFIG_BYTES) {
    throw new Error(`${path} 超过 ${MAX_CONFIG_BYTES} 字节上限`)
  }

  const canonicalPath = await realpath(path)
  ensureWithinRoot(projectRoot, canonicalPath)
  const document = parseDocument(await readFile(canonicalPath, 'utf8'), { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`${canonicalPath}: ${document.errors.map((error) => error.message).join('; ')}`)
  }
  return validateRemoteDebugConfig(document.toJS(), canonicalPath)
}

export function validateRemoteDebugConfig(
  value: unknown,
  path: string = REMOTE_DEBUG_CONFIG_FILE
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
  config: RemoteDebugConfig
): Promise<void> {
  const projectRoot = await realpath(cwd)
  // 读取现有文件沿用同一校验与符号链接边界，避免覆盖损坏配置。
  const existing = await readRemoteDebugConfig(projectRoot)
  const path = remoteDebugConfigPath(projectRoot)
  const document = existing
    ? parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true })
    : new Document({ version: 1, profiles: {} })
  document.set('version', 1)
  const profilesNode = document.get('profiles', true)
  if (isMap(profilesNode)) {
    for (const pair of [...profilesNode.items]) {
      const name = String(pair.key)
      if (!Object.hasOwn(config.profiles, name)) document.deleteIn(['profiles', name])
    }
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    const prefix = ['profiles', name]
    document.setIn([...prefix, 'description'], profile.description)
    document.setIn([...prefix, 'command'], profile.command)
    document.setIn([...prefix, 'entryPort'], profile.entryPort)
    document.setIn([...prefix, 'publicPort'], profile.publicPort)
    const routesNode = document.getIn([...prefix, 'routes'], true)
    const paths = new Set(profile.routes.map((route) => route.path))
    if (isMap(routesNode)) {
      for (const pair of [...routesNode.items]) {
        const routePath = String(pair.key)
        if (!paths.has(routePath)) document.deleteIn([...prefix, 'routes', routePath])
      }
    } else {
      document.setIn([...prefix, 'routes'], document.createNode({}))
    }
    for (const route of profile.routes) {
      document.setIn([...prefix, 'routes', route.path], route.targetPort)
    }
  }
  validateRemoteDebugConfig(document.toJS(), path)
  const content = document.toString()
  if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) {
    throw new Error(`${path} 超过 ${MAX_CONFIG_BYTES} 字节上限`)
  }
  await mkdir(join(projectRoot, REMOTE_DEBUG_CONFIG_DIRECTORY), { recursive: true })
  await ensureConfigDirectory(projectRoot)
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function ensureConfigDirectory(root: string): Promise<void> {
  const path = join(root, REMOTE_DEBUG_CONFIG_DIRECTORY)
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!metadata) return
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${path} 必须是非符号链接目录`)
  }
  ensureWithinRoot(root, await realpath(path))
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

function ensureWithinRoot(root: string, target: string): void {
  const path = relative(root, target)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`配置文件越出项目目录：${target}`)
  }
}
