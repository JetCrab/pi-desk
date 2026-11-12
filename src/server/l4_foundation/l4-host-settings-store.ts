import 'server-only'

import { bindConfigStore, readConfigSection } from '@jetcrab/pi-desk-sdk/config'
import {
  HostSettingsSchema,
  type HostRegion,
  type HostSettingsSnapshot
} from '@jetcrab/pi-desk-sdk/settings'

function initialSettings(): HostSettingsSnapshot {
  const region = Intl.DateTimeFormat().resolvedOptions()
  return HostSettingsSchema.parse({
    region: {
      locale: region.locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
      timeZone: region.timeZone || 'UTC'
    }
  })
}

export class L4HostSettingsStore {
  private snapshot: HostSettingsSnapshot | null = null
  private readonly listeners = new Set<() => void>()
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly agentDir?: string,
    private readonly defaults: () => HostSettingsSnapshot = initialSettings
  ) {}

  getSnapshot(): HostSettingsSnapshot {
    if (!this.snapshot) {
      const value = readConfigSection('pi-desk', 'settings', this.agentDir)
      this.snapshot = HostSettingsSchema.parse(Object.keys(value).length ? value : this.defaults())
    }
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(region: Partial<HostRegion>): Promise<void> {
    const update = this.tail.then(async () => {
      const previous = this.getSnapshot()
      const next = HostSettingsSchema.parse({ region: { ...previous.region, ...region } })
      if (JSON.stringify(previous) === JSON.stringify(next)) return
      await this.save(next)
      this.snapshot = next
      console.info('[Pi Desk][Settings] 共享地区设置已保存', next.region)
      for (const listener of this.listeners) {
        try {
          listener()
        } catch (error) {
          console.error('[Pi Desk][Settings] 设置订阅回调失败', {
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }
    })
    this.tail = update.catch(() => undefined)
    return update
  }

  private async save(value: HostSettingsSnapshot): Promise<void> {
    await bindConfigStore('pi-desk', 'settings', { agentDir: this.agentDir }).set(value)
  }
}

export function getL4HostSettingsStore(): L4HostSettingsStore {
  return (globalThis.__piDeskHostSettingsStore ??= new L4HostSettingsStore())
}

declare global {
  var __piDeskHostSettingsStore: L4HostSettingsStore | undefined
}
