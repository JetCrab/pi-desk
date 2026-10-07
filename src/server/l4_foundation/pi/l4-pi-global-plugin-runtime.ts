import 'server-only'

import { getL4HostSettingsStore } from '@server/l4_foundation/l4-host-settings-store'

import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import { L4PiPluginOwnerRuntime, type L4PiPluginPackageSource } from './l4-pi-plugin-owner-runtime'
import { isL4PiDeskSafeMode } from './l4-pi-desk-mode'
import { discoverL4PiPluginSources, type L4PiPluginSourceSnapshot } from './l4-pi-plugin-sources'
import { L4PiPluginSourceChanges, type L4PiPluginSourceChange } from './l4-pi-plugin-source-changes'
import { clearL4PiPluginCodeCache } from './l4-pi-plugin-module-loader'

export * from './l4-pi-plugin-owner-runtime'

function nodeEntries(snapshot: L4PiPluginSourceSnapshot): L4PiPluginPackageSource[] {
  return snapshot.sources.flatMap((item) =>
    item.enabled && !item.error && item.piDeskRoot
      ? [{ source: item.source, installedPath: item.piDeskRoot }]
      : []
  )
}

export class L4PiGlobalPluginRuntime extends L4PiPluginOwnerRuntime {
  private readonly sourceChanges: L4PiPluginSourceChanges
  private readonly discover: () => Promise<L4PiPluginSourceSnapshot>

  constructor(cwd = process.cwd(), agentDir = getAgentDir()) {
    const changes = new L4PiPluginSourceChanges()
    const discover = async (): Promise<L4PiPluginSourceSnapshot> =>
      isL4PiDeskSafeMode()
        ? { sources: [], errors: [] }
        : discoverL4PiPluginSources(cwd, agentDir, { DefaultPackageManager, SettingsManager })
    super(async () => {
      const snapshot = await discover()
      for (const message of snapshot.errors)
        console.warn('[Pi Desk][GlobalPluginRuntime] 插件来源发现诊断', { message })
      await changes.initialize(snapshot)
      return nodeEntries(snapshot)
    }, getL4HostSettingsStore())
    this.sourceChanges = changes
    this.discover = discover
  }

  async scanSourceChanges(sources?: readonly string[]): Promise<L4PiPluginSourceChange[]> {
    await this.initialize()
    return this.sourceChanges.scan(await this.discover(), sources)
  }

  async applySourceChange(change: L4PiPluginSourceChange): Promise<void> {
    const [latest] = await this.scanSourceChanges([change.source])
    if (
      !latest ||
      latest.fingerprint !== change.fingerprint ||
      (latest.current?.enabled && latest.current.error)
    ) {
      throw new Error(latest?.current?.error ?? '插件源码在预检后发生变化，请重新加载')
    }
    if (change.previous?.piDeskRoot || change.current?.piDeskRoot) {
      await this.replaceSource(
        change.source,
        change.current?.enabled ? change.current.piDeskRoot : null
      )
    } else {
      clearL4PiPluginCodeCache()
    }
    this.sourceChanges.commit(change)
  }
}

export function getL4PiGlobalPluginRuntime(): L4PiGlobalPluginRuntime {
  if (!globalThis.__piDeskGlobalPluginRuntime)
    globalThis.__piDeskGlobalPluginRuntime = new L4PiGlobalPluginRuntime()
  return globalThis.__piDeskGlobalPluginRuntime
}

export async function disposeL4PiGlobalPluginRuntime(): Promise<void> {
  const runtime = globalThis.__piDeskGlobalPluginRuntime
  globalThis.__piDeskGlobalPluginRuntime = undefined
  await runtime?.dispose()
}

declare global {
  var __piDeskGlobalPluginRuntime: L4PiGlobalPluginRuntime | undefined
}
