import 'server-only'

import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { L4PiResolvedBrowserEntry } from './l4-pi-plugin-owner-runtime'
import type { L4PiBrowserModuleSnapshot } from './l4-pi-plugin-browser-snapshot'

const RETIRED_RESOURCE_TTL_MS = 60_000
const MAX_RETIRED_GROUPS = 32
const MAX_RETIRED_BYTES = 64 * 1024 * 1024
const MAX_ACTIVE_BYTES = 128 * 1024 * 1024

interface L4PiPluginBrowserResourceRecord {
  pluginName: string
  resourceGroup: string
  resourceKey: string
  entryPath: string
  snapshot: L4PiBrowserModuleSnapshot
  retiredAt: number | null
}

export interface L4PiPluginBrowserResourceDescriptor {
  resourceGroup: string
  url: string
  entry: L4PiResolvedBrowserEntry
}

export interface L4PiPluginBrowserResource {
  stream: ReadableStream<Uint8Array>
  size: number
  etag: string
}

export class L4PiPluginBrowserResourceNotFoundError extends Error {
  constructor(resourceGroup: string, resourcePath: string) {
    super(`Plugin Browser resource was not found: ${resourceGroup}/${resourcePath}`)
    this.name = 'L4PiPluginBrowserResourceNotFoundError'
  }
}

function canonicalResourcePath(resourcePath: string): boolean {
  if (
    !resourcePath ||
    resourcePath.length > 4096 ||
    resourcePath.startsWith('/') ||
    resourcePath.includes('\\') ||
    resourcePath.includes('\0') ||
    !resourcePath.endsWith('.js')
  )
    return false
  return resourcePath
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export class L4PiPluginBrowserResourceRegistry {
  private readonly recordsByPlugin = new Map<string, L4PiPluginBrowserResourceRecord>()
  private readonly recordsByGroup = new Map<string, L4PiPluginBrowserResourceRecord>()
  private pruneTimer: ReturnType<typeof setTimeout> | null = null

  replace(
    entries: readonly L4PiResolvedBrowserEntry[]
  ): readonly L4PiPluginBrowserResourceDescriptor[] {
    const names = new Set(entries.map((entry) => entry.pluginName))
    if (names.size !== entries.length) throw new Error('Browser Entry 清单包含重复插件')
    if (entries.reduce((size, entry) => size + entry.snapshot.size, 0) > MAX_ACTIVE_BYTES) {
      throw new Error('Browser 活动资源超过容量上限')
    }
    for (const [name, record] of this.recordsByPlugin) {
      if (names.has(name)) continue
      this.recordsByPlugin.delete(name)
      this.retire(record)
    }
    const descriptors = entries.map((entry) => {
      const previous = this.recordsByPlugin.get(entry.pluginName)
      const record =
        previous?.resourceKey === entry.resourceKey && previous.entryPath === entry.entryPath
          ? previous
          : {
              pluginName: entry.pluginName,
              resourceGroup: randomBytes(24).toString('base64url'),
              resourceKey: entry.resourceKey,
              entryPath: entry.entryPath,
              snapshot: entry.snapshot,
              retiredAt: null
            }
      if (previous !== record) {
        if (previous) this.retire(previous)
        this.recordsByPlugin.set(entry.pluginName, record)
        this.recordsByGroup.set(record.resourceGroup, record)
      }
      return {
        resourceGroup: record.resourceGroup,
        url: `/api/plugins/browser-resources/${record.resourceGroup}/entry.js`,
        entry
      }
    })
    this.prune()
    return descriptors
  }

  async read(resourceGroup: string, resourcePath: string): Promise<L4PiPluginBrowserResource> {
    this.prune()
    const record = this.recordsByGroup.get(resourceGroup)
    const resource = canonicalResourcePath(resourcePath)
      ? record?.snapshot.modules.get(resourcePath)
      : undefined
    if (!resource) throw new L4PiPluginBrowserResourceNotFoundError(resourceGroup, resourcePath)
    // 不再按旧 URL 读取可变安装目录；stream 已取得的 Buffer 不受快照淘汰影响。
    return {
      stream: Readable.toWeb(Readable.from([resource.content])) as ReadableStream<Uint8Array>,
      size: resource.content.length,
      etag: resource.etag
    }
  }

  dispose(): void {
    if (this.pruneTimer) clearTimeout(this.pruneTimer)
    this.pruneTimer = null
    this.recordsByPlugin.clear()
    this.recordsByGroup.clear()
  }

  private retire(record: L4PiPluginBrowserResourceRecord): void {
    record.retiredAt ??= Date.now()
  }

  private prune(): void {
    if (this.pruneTimer) clearTimeout(this.pruneTimer)
    this.pruneTimer = null
    const now = Date.now()
    const retired = [...this.recordsByGroup.values()]
      .filter((record) => record.retiredAt !== null)
      .sort((left, right) => left.retiredAt! - right.retiredAt!)
    let bytes = retired.reduce((total, record) => total + record.snapshot.size, 0)
    let count = retired.length
    for (const record of retired) {
      if (
        now - record.retiredAt! >= RETIRED_RESOURCE_TTL_MS ||
        count > MAX_RETIRED_GROUPS ||
        bytes > MAX_RETIRED_BYTES
      ) {
        this.recordsByGroup.delete(record.resourceGroup)
        bytes -= record.snapshot.size
        count -= 1
      }
    }
    const oldest = retired.find((record) => this.recordsByGroup.has(record.resourceGroup))
    if (oldest) {
      this.pruneTimer = setTimeout(
        () => this.prune(),
        Math.max(1, oldest.retiredAt! + RETIRED_RESOURCE_TTL_MS - now)
      )
      this.pruneTimer.unref()
    }
  }
}

export function getL4PiPluginBrowserResourceRegistry(): L4PiPluginBrowserResourceRegistry {
  if (!globalThis.__piDeskPluginBrowserResourceRegistry) {
    globalThis.__piDeskPluginBrowserResourceRegistry = new L4PiPluginBrowserResourceRegistry()
  }
  return globalThis.__piDeskPluginBrowserResourceRegistry
}

export function disposeL4PiPluginBrowserResourceRegistry(): void {
  globalThis.__piDeskPluginBrowserResourceRegistry?.dispose()
  globalThis.__piDeskPluginBrowserResourceRegistry = undefined
}

declare global {
  var __piDeskPluginBrowserResourceRegistry: L4PiPluginBrowserResourceRegistry | undefined
}
