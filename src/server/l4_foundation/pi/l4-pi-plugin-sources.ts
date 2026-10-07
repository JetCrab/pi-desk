import 'server-only'

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'

export interface L4PiPluginSource {
  source: string
  kind: 'package' | 'extension'
  path: string | null
  nativePaths: string[]
  hasPiResources?: boolean
  piDeskRoot: string | null
  version: string | null
  description: string | null
  enabled: boolean
  error: string | null
}

export interface L4PiPluginSourceSnapshot {
  sources: L4PiPluginSource[]
  errors: string[]
}

export interface L4PiPluginSourceDiscoverySdk {
  DefaultPackageManager: typeof DefaultPackageManager
  SettingsManager: typeof SettingsManager
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

async function manifest(root: string): Promise<{
  version: string | null
  description: string | null
  hasNodeEntry: boolean
  hasNativeEntries?: boolean
  error: string | null
}> {
  try {
    if ((await stat(root)).isFile()) {
      return { version: null, description: null, hasNodeEntry: false, error: null }
    }
    const value: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('package.json 必须是对象')
    }
    const data = value as {
      version?: unknown
      description?: unknown
      pi?: { extensions?: unknown }
      piDesk?: { entry?: unknown; global?: unknown }
    }
    return {
      version: typeof data.version === 'string' ? data.version : null,
      description: typeof data.description === 'string' ? data.description.trim() || null : null,
      hasNodeEntry: data.piDesk?.entry !== undefined || data.piDesk?.global !== undefined,
      hasNativeEntries: Array.isArray(data.pi?.extensions) && data.pi.extensions.length > 0,
      error: null
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { version: null, description: null, hasNodeEntry: false, error: null }
    }
    return {
      version: null,
      description: null,
      hasNodeEntry: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function discoverL4PiPluginSources(
  cwd: string,
  agentDir: string,
  sdk: L4PiPluginSourceDiscoverySdk
): Promise<L4PiPluginSourceSnapshot> {
  const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  const manager = new sdk.DefaultPackageManager({ cwd, agentDir, settingsManager: settings })
  const errors = settings.drainErrors().map(({ error }) => error.message)
  const sources = new Map<string, L4PiPluginSource>()
  const packageRoots = new Map<string, string>()

  for (const configured of manager.listConfiguredPackages()) {
    if (configured.scope !== 'user') continue
    const path = configured.installedPath ? await canonical(configured.installedPath) : null
    const metadata = path ? await manifest(path) : null
    const existing = path ? packageRoots.get(pathKey(path)) : undefined
    if (path && !existing) packageRoots.set(pathKey(path), configured.source)
    sources.set(configured.source, {
      source: configured.source,
      kind: 'package',
      path,
      nativePaths: [],
      hasPiResources: true,
      piDeskRoot: path && metadata?.hasNodeEntry && !existing ? path : null,
      version: metadata?.version ?? null,
      description: metadata?.description ?? null,
      enabled: true,
      error: existing
        ? `此目录已由 ${existing} 声明，不能重复加载`
        : !path
          ? '插件包未安装或安装目录不存在'
          : (metadata?.error ?? null)
    })
  }

  const extensionDir = join(agentDir, 'extensions')
  const directoryRoots = new Set<string>()
  try {
    for (const entry of await readdir(extensionDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        try {
          const path = await canonical(join(extensionDir, entry.name))
          if ((await stat(path)).isDirectory()) directoryRoots.add(path)
        } catch (error) {
          errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  for (const configured of settings.getGlobalSettings().extensions ?? []) {
    if (/^[!+-]|[?*{}]/.test(configured)) continue
    const path = await canonical(
      configured.startsWith('~/')
        ? join(homedir(), configured.slice(2))
        : resolve(agentDir, configured)
    )
    try {
      if ((await stat(path)).isDirectory()) directoryRoots.add(path)
    } catch {
      // 缺失入口由官方资源发现或清单诊断处理，不安装或执行它。
    }
  }
  const roots = [...directoryRoots].sort((left, right) => right.length - left.length)

  try {
    // 显式 skip，列清单不能触发缺失包安装、扩展导入或 AgentSession。
    const resolved = await manager.resolve(async () => 'skip')
    for (const item of sources.values()) item.hasPiResources = false
    for (const resource of [
      ...resolved.extensions,
      ...resolved.skills,
      ...resolved.prompts,
      ...resolved.themes
    ]) {
      if (
        resource.enabled &&
        resource.metadata.scope === 'user' &&
        resource.metadata.origin === 'package'
      ) {
        const item = sources.get(resource.metadata.source)
        if (item) item.hasPiResources = true
      }
    }
    for (const resource of resolved.extensions) {
      if (resource.metadata.scope !== 'user') continue
      const path = await canonical(resource.path)
      if (resource.metadata.origin === 'package') {
        const item = sources.get(resource.metadata.source)
        if (item && resource.enabled && !item.nativePaths.includes(path))
          item.nativePaths.push(path)
        continue
      }
      const root = roots.find((candidate) => inside(candidate, path)) ?? path
      const packaged = [...packageRoots].find(([candidate]) => inside(candidate, pathKey(path)))
      if (packaged) {
        const item = sources.get(packaged[1])
        if (resource.enabled && item && !item.nativePaths.includes(path)) {
          item.nativePaths.push(path)
        }
        errors.push(`扩展入口 ${path} 与已配置包 ${packaged[1]} 重复，保留包来源`)
        continue
      }
      let item = sources.get(root)
      if (!item) {
        item = {
          source: root,
          kind: 'extension',
          path: root,
          nativePaths: [],
          piDeskRoot: null,
          version: null,
          description: null,
          enabled: false,
          error: null
        }
        sources.set(root, item)
      }
      if (resource.enabled) {
        item.enabled = true
        if (!item.nativePaths.includes(path)) item.nativePaths.push(path)
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  for (const root of roots) {
    if ([...packageRoots.keys()].some((path) => inside(path, pathKey(root)))) continue
    const metadata = await manifest(root)
    const existing = sources.get(root)
    if (!existing && !metadata.hasNodeEntry && !metadata.error) continue
    const hasNativeIndex = (
      await Promise.all(
        ['index.ts', 'index.js'].map((file) =>
          stat(join(root, file)).then(
            (entry) => entry.isFile(),
            () => false
          )
        )
      )
    ).some(Boolean)
    const item: L4PiPluginSource = existing ?? {
      source: root,
      kind: 'extension',
      path: root,
      nativePaths: [],
      piDeskRoot: null,
      version: null,
      description: null,
      enabled: !metadata.hasNativeEntries && !hasNativeIndex,
      error: null
    }
    item.version = metadata.version
    item.description = metadata.description
    item.error = metadata.error
    if (metadata.hasNodeEntry && item.enabled) item.piDeskRoot = root
    sources.set(root, item)
  }

  return {
    sources: [...sources.values()].sort((left, right) => left.source.localeCompare(right.source)),
    errors
  }
}

export async function l4PiPluginSourceRoot(source: L4PiPluginSource): Promise<string | null> {
  if (!source.path) return null
  try {
    return (await stat(source.path)).isFile() ? dirname(source.path) : source.path
  } catch {
    return null
  }
}
