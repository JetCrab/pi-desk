import 'server-only'

import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import type {
  L2PluginManagementInstallRequest,
  L2PluginManagementListRequest
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import {
  isL4PluginNewerVersion,
  L4PluginUpdateTagSchema,
  l4PluginNpmName,
  l4PluginSourceIdentity
} from '@common/l4_foundation/plugin/l4-plugin-package'
import { readL4PiPluginUpdateTag } from '@server/l4_foundation/pi/l4-pi-plugin-preferences'
import {
  readL4PluginInstallRegistry,
  resolveL4PluginInstall
} from '@server/l4_foundation/pi/l4-pi-plugin-registry'
import type { L4PiPluginSource } from '@server/l4_foundation/pi/l4-pi-plugin-sources'
import { runL4PiPackageRootExclusive } from '@server/l4_foundation/pi/l4-pi-package-root-gate'

const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000
const UPDATE_CACHE_MAX_ENTRIES = 128

export interface L2PluginUpdateStatus {
  updateTag: string | null
  updateAvailable: boolean | null
  availableVersion: string | null
  updateError: string | null
}

interface UpdateCacheEntry {
  identity: string
  expiresAt: number
  value: L2PluginUpdateStatus
}

export class L2PluginUpdates {
  private readonly cache = new Map<string, UpdateCacheEntry>()

  constructor(
    private readonly agentDir: string,
    private readonly cwd: string,
    private readonly signal: AbortSignal
  ) {}

  async resolveInstall(
    source: string,
    previousSource: string,
    options: Omit<L2PluginManagementInstallRequest, 'source'>,
    followTag: boolean
  ): Promise<{ source: string; registry?: string; updateTag: string | null }> {
    const name = l4PluginNpmName(source)
    const selector = name ? /^npm:(?:@[^/]+\/)?[^@]+@([^@]+)$/.exec(source)?.[1] : undefined
    const explicitTag =
      selector && !/^v?\d+\./.test(selector) && L4PluginUpdateTagSchema.safeParse(selector).success
        ? selector
        : null
    const updateTag = name
      ? followTag
        ? readL4PiPluginUpdateTag(previousSource, this.agentDir)
        : (options.tag ?? explicitTag ?? readL4PiPluginUpdateTag(previousSource, this.agentDir))
      : null
    const target =
      name && updateTag && (followTag || !selector) ? `npm:${name}@${updateTag}` : source
    const resolved = await resolveL4PluginInstall(target, {
      ...options,
      agentDir: this.agentDir,
      signal: this.signal,
      cache: followTag ? false : undefined
    })
    return { ...resolved, updateTag }
  }

  clear(source: string): void {
    const identity = l4PluginSourceIdentity(source)
    for (const [key, entry] of this.cache) {
      if (entry.identity === identity) this.cache.delete(key)
    }
  }

  async read(
    sources: readonly L4PiPluginSource[],
    input: L2PluginManagementListRequest
  ): Promise<ReadonlyMap<string, L2PluginUpdateStatus>> {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= Date.now()) this.cache.delete(key)
    }
    const selected = input.sources ? new Set(input.sources.map(l4PluginSourceIdentity)) : null
    const result = new Map<string, L2PluginUpdateStatus>()
    for (const source of sources) {
      if (source.kind !== 'package') continue
      const identity = l4PluginSourceIdentity(source.source)
      const name = l4PluginNpmName(source.source)
      const tag = name ? readL4PiPluginUpdateTag(source.source, this.agentDir) : null
      const empty: L2PluginUpdateStatus = {
        updateTag: tag,
        updateAvailable: null,
        availableVersion: null,
        updateError: null
      }
      result.set(source.source, empty)
      const check =
        input.checkUpdates === true &&
        (!selected || selected.has(identity)) &&
        (!input.tag || input.tag === tag)
      if (name) {
        if (!check && ![...this.cache.values()].some((entry) => entry.identity === identity))
          continue
        let key: string | null = null
        try {
          const policy = await readL4PluginInstallRegistry(name, { agentDir: this.agentDir })
          key = JSON.stringify([identity, tag, policy.registry, policy.fallback])
          let value = this.cache.get(key)?.value
          if (check) {
            if (!source.path || !source.version) throw new Error('无法读取插件已安装版本')
            const resolved = await resolveL4PluginInstall(`npm:${name}@${tag}`, {
              agentDir: this.agentDir,
              signal: this.signal,
              cache: false
            })
            const version = resolved.source.slice(resolved.source.lastIndexOf('@') + 1)
            value = { ...empty, availableVersion: version }
            this.store(key, identity, value)
          }
          if (value) {
            result.set(source.source, {
              ...value,
              updateAvailable:
                value.updateError || !source.version || !value.availableVersion
                  ? null
                  : isL4PluginNewerVersion(value.availableVersion, source.version)
            })
          }
        } catch (error) {
          const value = { ...empty, updateError: this.message(source.source, error) }
          result.set(source.source, value)
          if (key) this.store(key, identity, value)
        }
      } else if (/^(?:git:|https?:|git@)/.test(source.source)) {
        const key = JSON.stringify([identity, 'git'])
        const cached = this.cache.get(key)?.value
        if (cached) result.set(source.source, cached)
        if (!check) continue
        try {
          const settingsManager = SettingsManager.inMemory({ packages: [source.source] })
          const manager = new DefaultPackageManager({
            agentDir: this.agentDir,
            cwd: this.cwd,
            settingsManager
          })
          const updates = await runL4PiPackageRootExclusive(() =>
            manager.checkForAvailableUpdates()
          )
          const value: L2PluginUpdateStatus = {
            ...empty,
            updateAvailable: updates.some((item) => item.scope === 'user')
          }
          result.set(source.source, value)
          this.store(key, identity, value)
        } catch (error) {
          const value = { ...empty, updateError: this.message(source.source, error) }
          result.set(source.source, value)
          this.store(key, identity, value)
        }
      }
    }
    return result
  }

  private store(key: string, identity: string, value: L2PluginUpdateStatus): void {
    this.cache.delete(key)
    while (this.cache.size >= UPDATE_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.cache.set(key, { identity, expiresAt: Date.now() + UPDATE_CACHE_TTL_MS, value })
  }

  private message(source: string, error: unknown): string {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000)
    console.warn('[Pi Desk][PluginManagement] 检查插件更新失败', { source, message })
    this.clear(source)
    return message
  }
}
