export type { PluginConfig } from './config-api.js'
export {
  bindConfigStore,
  getUnifiedConfigPath,
  readConfigSection,
  type ConfigStoreOptions
} from './config-store.ts'

import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { dirname, join, resolve } from 'node:path'
import {
  ensureStorageDirectory,
  readStorageFile,
  withStorageLock,
  writeStorageFile
} from './config-storage.ts'

export function getConfigDirectory(agentDir?: string): string {
  return join(agentDir ?? getAgentDir(), 'config')
}

export function getConfigPath(filename: string, agentDir?: string): string {
  if (!filename || filename === '.' || filename === '..' || /[/\\:\x00-\x1f]/u.test(filename)) {
    throw new Error('配置文件名必须是单个文件名')
  }
  return join(getConfigDirectory(agentDir), filename)
}

/** 串行保护同一目标的完整读改写；操作内不能嵌套获取同一目标锁。 */
export async function withConfigTransaction<T>(
  targetPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const target = resolve(targetPath)
  ensureStorageDirectory(dirname(target))
  return withStorageLock(target, async () => {
    readStorageFile(target)
    return operation()
  })
}

/** 原子发布 UTF-8 配置；读改写应置于 withConfigTransaction 内，本方法不重复加锁。 */
export function writeConfigTextAtomic(path: string, content: string): void {
  const target = resolve(path)
  ensureStorageDirectory(dirname(target))
  writeStorageFile(target, Buffer.from(content, 'utf8'), readStorageFile(target))
}
