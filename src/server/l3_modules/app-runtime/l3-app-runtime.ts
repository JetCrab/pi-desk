import 'server-only'

import {
  L3AppRuntimeSchema,
  type L3AppRuntime as L3AppRuntimeSnapshot,
  type L3AppRuntimeApplyRequest,
  type L3AppRuntimeEvent,
  type L3AppRuntimeModuleUpdate
} from '@common/l3_modules/app-runtime/l3-app-runtime-contract'
import { applyL3AppRuntimeEvent } from '@common/l3_modules/app-runtime/l3-app-runtime-state'
import { isL4PiDeskSafeMode } from '@server/l4_foundation/pi/l4-pi-desk-mode'
import {
  getL4HostSettingsStore,
  type L4HostSettingsStore
} from '@server/l4_foundation/l4-host-settings-store'

const EMPTY_APP_RUNTIME: L3AppRuntimeSnapshot = {
  mode: isL4PiDeskSafeMode() ? 'basic' : 'normal',
  notifications: [],
  plugins: {},
  capabilityModes: {},
  settings: { region: { locale: 'en', timeZone: 'UTC' } }
}

export class L3AppRuntimeTargetNotFoundError extends Error {
  constructor(target: string) {
    super(`App Runtime target does not exist: ${target}`)
    this.name = 'L3AppRuntimeTargetNotFoundError'
  }
}

export class L3AppRuntime {
  private runtime = L3AppRuntimeSchema.parse(EMPTY_APP_RUNTIME)
  private readonly listeners = new Set<(event: L3AppRuntimeEvent) => void>()
  private disposed = false
  private readonly unsubscribeSettings: (() => void) | null

  constructor(private readonly settingsStore?: L4HostSettingsStore) {
    if (settingsStore) {
      this.runtime = L3AppRuntimeSchema.parse({
        ...this.runtime,
        settings: settingsStore.getSnapshot()
      })
      this.unsubscribeSettings = settingsStore.subscribe(() => {
        this.applyInternal({ key: 'settings', update: settingsStore.getSnapshot() })
      })
    } else {
      this.unsubscribeSettings = null
    }
  }

  readSnapshot(): L3AppRuntimeSnapshot {
    return structuredClone(this.runtime)
  }

  subscribe(listener: (event: L3AppRuntimeEvent) => void): () => void {
    if (this.disposed) throw new Error('App Runtime has been disposed')
    this.listeners.add(listener)
    return (): void => {
      this.listeners.delete(listener)
    }
  }

  applyInternal(update: L3AppRuntimeModuleUpdate): void {
    if (this.disposed) throw new Error('App Runtime has been disposed')
    const event: L3AppRuntimeEvent = { type: 'update', ...update }
    this.runtime = applyL3AppRuntimeEvent(this.runtime, event)
    this.publish(event)
  }

  applyClient(request: L3AppRuntimeApplyRequest): void | Promise<void> {
    if (this.disposed) throw new Error('App Runtime has been disposed')
    if (request.key === 'settings') {
      if (!this.settingsStore) throw new Error('共享设置尚未就绪')
      return this.settingsStore.update(request.update.region)
    }
    if (
      !this.runtime.notifications.some(
        (notification) => notification.notificationId === request.update.notificationId
      )
    ) {
      throw new L3AppRuntimeTargetNotFoundError(request.update.notificationId)
    }
    this.applyInternal(request)
  }

  replace(runtime: L3AppRuntimeSnapshot): void {
    if (this.disposed) throw new Error('App Runtime has been disposed')
    const event: L3AppRuntimeEvent = {
      type: 'replace',
      runtime: L3AppRuntimeSchema.parse(runtime)
    }
    this.runtime = applyL3AppRuntimeEvent(this.runtime, event)
    this.publish(event)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeSettings?.()
    this.runtime = L3AppRuntimeSchema.parse(EMPTY_APP_RUNTIME)
    this.listeners.clear()
  }

  private publish(event: L3AppRuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(structuredClone(event))
  }
}

function appRuntime(): L3AppRuntime {
  if (!globalThis.__piDeskAppRuntime) {
    globalThis.__piDeskAppRuntime = new L3AppRuntime(getL4HostSettingsStore())
  }
  return globalThis.__piDeskAppRuntime
}

export function getL3AppRuntime(): L3AppRuntime {
  return appRuntime()
}

export function disposeL3AppRuntime(): void {
  const runtime = globalThis.__piDeskAppRuntime
  globalThis.__piDeskAppRuntime = undefined
  runtime?.dispose()
}

declare global {
  var __piDeskAppRuntime: L3AppRuntime | undefined
}
