import 'server-only'

import { readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { l4PluginSourceIdentity } from '@common/l4_foundation/plugin/l4-plugin-package'
import { getL4FileSystemKey, isL4PathInsideRoot } from '@server/l4_foundation/file/l4-file-path'
import { readL4PiPluginPreferences, removeL4PiPluginPreference } from './l4-pi-plugin-preferences'

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

async function canonical(path: string): Promise<string> {
  try {
    return getL4FileSystemKey(await realpath(path))
  } catch (error) {
    if (!isMissing(error)) throw error
    return getL4FileSystemKey(resolve(path))
  }
}

export async function removeL4PiLocalExtension(input: {
  source: string
  agentDir: string
  cwd: string
}): Promise<void> {
  const { source, agentDir, cwd } = input
  try {
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
    const initialErrors = settings.drainErrors()
    if (initialErrors.length) {
      throw new Error(
        `读取扩展配置失败：${initialErrors.map(({ error }) => error.message).join('；')}`
      )
    }

    const target = await canonical(source)
    const metadata = await stat(source).catch((error: unknown) => {
      if (!isMissing(error)) throw error
      return null
    })
    const configured = settings.getGlobalSettings().extensions ?? []
    const retained: string[] = []
    for (const reference of configured) {
      // 规则可能同时加载其他来源，留给卸载后的真实发现校验处理。
      if (/^[!+-]|[*?{}[\]()]/.test(reference)) {
        retained.push(reference)
        continue
      }
      const path = await canonical(
        reference.startsWith('~/')
          ? join(homedir(), reference.slice(2))
          : resolve(agentDir, reference)
      )
      if (
        path !== target &&
        !((metadata === null || metadata.isDirectory()) && isL4PathInsideRoot(target, path))
      ) {
        retained.push(reference)
      }
    }

    const extensionDir = join(agentDir, 'extensions')
    const entries = await readdir(extensionDir, { withFileTypes: true }).catch((error: unknown) => {
      if (!isMissing(error)) throw error
      return []
    })
    const removals: Array<{ path: string; recursive: boolean }> = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(extensionDir, entry.name)
      if ((await canonical(path)) === target) {
        removals.push({ path, recursive: !entry.isSymbolicLink() && entry.isDirectory() })
      }
    }
    for (const entry of removals) {
      // 使用原始入口路径；链接只删入口，不能用规范目标执行递归删除。
      await rm(entry.path, { recursive: entry.recursive, force: true })
    }

    const removedReferences = configured.length - retained.length
    if (removedReferences) {
      settings.setExtensionPaths(retained)
      await settings.flush()
      const errors = settings.drainErrors()
      if (errors.length) {
        throw new Error(`保存扩展配置失败：${errors.map(({ error }) => error.message).join('；')}`)
      }
    }

    const preferences = readL4PiPluginPreferences(agentDir)
    const identity = l4PluginSourceIdentity(source)
    const hasPreference =
      preferences.disabled.includes(identity) ||
      identity in preferences.registries ||
      identity in preferences.updateTags
    if (hasPreference) await removeL4PiPluginPreference(source, agentDir)

    if (removals.length || removedReferences || hasPreference) {
      console.info('[Pi Desk][LocalExtension] 已移除本地扩展入口与加载声明', {
        source,
        entries: removals.length,
        references: removedReferences
      })
    }
  } catch (error) {
    throw new Error(`移除本地扩展失败：${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    })
  }
}
