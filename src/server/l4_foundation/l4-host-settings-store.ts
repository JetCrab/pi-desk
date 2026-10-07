import 'server-only'

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
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
    private readonly path = join(getAgentDir(), 'pi-desk-settings.json'),
    private readonly defaults: () => HostSettingsSnapshot = initialSettings
  ) {}

  getSnapshot(): HostSettingsSnapshot {
    if (!this.snapshot) {
      if (existsSync(this.path)) {
        this.snapshot = HostSettingsSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      } else {
        const initial = HostSettingsSchema.parse(this.defaults())
        this.save(initial)
        this.snapshot = initial
      }
    }
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(region: Partial<HostRegion>): Promise<void> {
    const update = this.tail.then(() => {
      const previous = this.getSnapshot()
      const next = HostSettingsSchema.parse({ region: { ...previous.region, ...region } })
      if (JSON.stringify(previous) === JSON.stringify(next)) return
      this.save(next)
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

  private save(value: HostSettingsSnapshot): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.path)
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
}

export function getL4HostSettingsStore(): L4HostSettingsStore {
  return (globalThis.__piDeskHostSettingsStore ??= new L4HostSettingsStore())
}

declare global {
  var __piDeskHostSettingsStore: L4HostSettingsStore | undefined
}
