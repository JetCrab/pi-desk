import 'server-only'

import { bindConfigStore, readConfigSection } from '@jetcrab/pi-desk-sdk/config'
import {
  CapabilityModesSchema as L3CapabilityModesSchema,
  type CapabilityModes as L3CapabilityModes
} from '@jetcrab/pi-desk-sdk/capabilities'

export class L4CapabilityModesStore {
  private modes: L3CapabilityModes | null = null
  private readonly listeners = new Set<() => void>()
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly agentDir?: string) {}

  read(): L3CapabilityModes {
    if (this.modes === null) {
      const saved = readConfigSection('pi-desk', 'capability-modes', this.agentDir)
      const raw: unknown = Object.keys(saved).length ? saved : { modes: {} }
      if (!raw || typeof raw !== 'object' || !('modes' in raw)) {
        throw new Error('能力模式配置缺少 modes')
      }
      this.modes = L3CapabilityModesSchema.parse(raw.modes)
    }
    return structuredClone(this.modes)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return (): void => {
      this.listeners.delete(listener)
    }
  }

  replace(input: L3CapabilityModes): Promise<void> {
    const next = L3CapabilityModesSchema.parse(input)
    const save = this.tail.then(async () => {
      await bindConfigStore('pi-desk', 'capability-modes', { agentDir: this.agentDir }).set({
        modes: next
      })
      this.modes = structuredClone(next)
      for (const listener of this.listeners) {
        try {
          listener()
        } catch (cause) {
          console.error('[Pi Desk][Capabilities] 模式配置监听器失败', {
            message: cause instanceof Error ? cause.message : String(cause)
          })
        }
      }
    })
    this.tail = save.catch(() => undefined)
    return save
  }
}

export function getL4CapabilityModesStore(): L4CapabilityModesStore {
  return (globalThis.__piDeskCapabilityModesStore ??= new L4CapabilityModesStore())
}

declare global {
  var __piDeskCapabilityModesStore: L4CapabilityModesStore | undefined
}
