import 'server-only'

import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { l4PluginSourceIdentity } from '@common/l4_foundation/plugin/l4-plugin-package'
import { readL4PiPluginPreferences } from './l4-pi-plugin-preferences'

async function canonical(path: string): Promise<string> {
  const result = await realpath(path).catch(() => resolve(path))
  return process.platform === 'win32' ? result.toLowerCase() : result
}

function localPath(source: string, agentDir: string): string | null {
  if (/^(npm:|git:|https?:|ssh:|git@)/.test(source)) return null
  return source.startsWith('~/') ? join(homedir(), source.slice(2)) : resolve(agentDir, source)
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

/** 只按全局身份或全局安装的真实路径禁用，不按包名误禁项目独立副本。 */
export async function createL4PiPluginDisabledFilter(
  agentDir: string,
  manager: Pick<DefaultPackageManager, 'listConfiguredPackages'>,
  settings: Pick<SettingsManager, 'getGlobalSettings'>
): Promise<(source: string, path: string | null, globalPackage: boolean) => Promise<boolean>> {
  const disabled = new Set(readL4PiPluginPreferences(agentDir).disabled.map(l4PluginSourceIdentity))
  const roots = new Set<string>()
  for (const source of disabled) {
    const path = localPath(source, agentDir)
    if (path) roots.add(await canonical(path))
  }
  for (const item of manager.listConfiguredPackages()) {
    if (item.scope !== 'user' || !item.installedPath) continue
    const sourcePath = localPath(item.source, agentDir)
    const matchesPath = sourcePath && roots.has(await canonical(sourcePath))
    if (disabled.has(l4PluginSourceIdentity(item.source)) || matchesPath) {
      roots.add(await canonical(item.installedPath))
    }
  }
  if (roots.size > 0) {
    const extensionDir = join(agentDir, 'extensions')
    const entries = await readdir(extensionDir, { withFileTypes: true }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return []
      throw error
    })
    const candidates = [
      ...manager
        .listConfiguredPackages()
        .filter((item) => item.scope === 'user')
        .flatMap((item) => item.installedPath ?? []),
      ...entries
        .filter(
          (entry) =>
            !entry.name.startsWith('.') &&
            entry.name !== 'node_modules' &&
            (entry.isDirectory() || entry.isSymbolicLink())
        )
        .map((entry) => join(extensionDir, entry.name)),
      ...(settings.getGlobalSettings().extensions ?? [])
        .filter((entry) => !/^[!+-]|[?*{}]/.test(entry))
        .flatMap((entry) => localPath(entry, agentDir) ?? [])
    ]
    const directories: string[] = []
    for (const candidate of candidates) {
      if (
        await stat(candidate).then(
          (entry) => entry.isDirectory(),
          () => false
        )
      ) {
        directories.push(await canonical(candidate))
      }
    }
    directories.sort((left, right) => right.length - left.length)
    for (const root of [...roots]) {
      if (
        !(await stat(root).then(
          (entry) => entry.isFile(),
          () => false
        ))
      )
        continue
      // 原生发现把目录内入口归为一个源；禁用文件也不能经目录别名加载同源资源。
      const directory = directories.find((candidate) => inside(candidate, root))
      if (directory) roots.add(directory)
    }
  }
  const paths = new Map<string, Promise<string>>()
  return async (source, path, globalPackage): Promise<boolean> => {
    if (globalPackage && disabled.has(l4PluginSourceIdentity(source))) return true
    if (!path || path.startsWith('builtin:') || roots.size === 0) return false
    let pending = paths.get(path)
    if (!pending) {
      pending = canonical(path)
      paths.set(path, pending)
    }
    const resolved = await pending
    return [...roots].some((root) => inside(root, resolved))
  }
}
