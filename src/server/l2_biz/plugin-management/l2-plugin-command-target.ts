import 'server-only'

import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { L2PluginManagementItem } from '@common/l2_biz/plugin/l2-plugin-management-contract'

export function readL2PluginNpmName(source: string): string | null {
  return /^npm:((?:@[^/]+\/)?[^@]+)(?:@.+)?$/.exec(source)?.[1] ?? null
}

export function readL2PluginCommandName(item: L2PluginManagementItem, agentDir: string): string {
  return (
    readL2PluginNpmName(item.source) ??
    item.pluginName ??
    basename(resolve(agentDir, item.source)).replace(/\.(?:ts|js)$/, '')
  )
}

export function findL2PluginCommandTarget(
  items: readonly L2PluginManagementItem[],
  name: string,
  agentDir: string
): L2PluginManagementItem | null {
  const matches = items.filter(
    (item) =>
      readL2PluginCommandName(item, agentDir) === name ||
      item.pluginName === name ||
      (!readL2PluginNpmName(item.source) && basename(resolve(agentDir, item.source)) === name)
  )
  // npm 预检失败的队列占位没有安装版本，不能遮挡当前已配置来源。
  const candidates = matches.filter(
    (item) =>
      !(
        readL2PluginNpmName(item.source) &&
        item.version === null &&
        item.error === null &&
        item.operation?.phase === 'failed'
      )
  )
  if (candidates.length > 1) throw new Error(`插件名字对应多个来源，请先检查插件清单：${name}`)
  return candidates[0] ?? (matches.length === 1 ? matches[0] : null)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}

export async function resolveL2LocalPluginCommandTarget(
  name: string,
  agentDir: string,
  existing: L2PluginManagementItem | null
): Promise<string | null> {
  if (name.startsWith('@')) return null
  const root = join(agentDir, 'extensions')
  const candidates = [
    join(root, name),
    ...(/\.(?:ts|js)$/.test(name) ? [] : [join(root, `${name}.ts`), join(root, `${name}.js`)])
  ]
  if (existing && !/^[a-z][a-z0-9+.-]*:/i.test(existing.source)) {
    candidates.push(resolve(agentDir, existing.source))
  } else if (existing && isAbsolute(existing.source)) {
    candidates.push(existing.source)
  }
  const matches = [
    ...new Set(
      (
        await Promise.all(
          candidates.map(async (path) => ((await exists(path)) ? realpath(path) : null))
        )
      ).filter((path): path is string => path !== null)
    )
  ]
  if (matches.length > 1) throw new Error(`固定扩展目录中存在多个同名入口：${name}`)
  const path = matches[0]
  if (!path) return null
  const fromRoot = relative(await realpath(root), path)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('本地插件必须位于 Pi AgentDir 的 extensions 目录内')
  }
  return path
}
