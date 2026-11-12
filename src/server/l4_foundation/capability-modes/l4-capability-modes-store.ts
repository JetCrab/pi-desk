import 'server-only'

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getConfigPath } from '@jetcrab/pi-desk-sdk/config'
import { existsSync } from 'node:fs'
import {
  CapabilityModesSchema as L3CapabilityModesSchema,
  type CapabilityModes as L3CapabilityModes
} from '@jetcrab/pi-desk-sdk/capabilities'

export class L4CapabilityModesStore {
  private modes: L3CapabilityModes | null = null
  private readonly listeners = new Set<() => void>()
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly path = getConfigPath('pi-desk-capability-modes.json')) {}

  read(): L3CapabilityModes {
    if (this.modes === null) {
      const raw: unknown = existsSync(this.path)
        ? JSON.parse(readFileSync(this.path, 'utf8'))
        : { modes: {} }
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
    const save = this.tail.then(() => {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporaryPath, `${JSON.stringify({ modes: next }, null, 2)}\n`, 'utf8')
        renameSync(temporaryPath, this.path)
      } finally {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      }
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
