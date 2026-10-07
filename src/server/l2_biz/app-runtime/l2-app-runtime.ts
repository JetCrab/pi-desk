import 'server-only'

import { l3CapabilityModeNames } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import { getL4CapabilityModesStore } from '@server/l4_foundation/capability-modes/l4-capability-modes-store'

import type {
  L3AppNotificationChanges,
  L3AppNotificationLevel
} from '@common/l3_modules/app-runtime/l3-app-runtime-contract'
import type { L4PiPluginAppRuntimeSink } from '@server/l4_foundation/pi/l4-pi-plugin-owner-runtime'
import {
  disposeL3AppNotificationRuntime,
  getL3AppNotificationRuntime
} from '@server/l3_modules/app-runtime/l3-app-notification-runtime'
import {
  disposeL3AppPluginStateRuntime,
  getL3AppPluginStateRuntime
} from '@server/l3_modules/app-runtime/l3-app-plugin-state-runtime'
import {
  disposeL3AppRuntime,
  getL3AppRuntime,
  L3AppRuntimeTargetNotFoundError,
  type L3AppRuntime
} from '@server/l3_modules/app-runtime/l3-app-runtime'

export { L3AppRuntimeTargetNotFoundError as L2AppRuntimeTargetNotFoundError }

export type L2AppRuntime = L3AppRuntime

export interface L2AppNotificationPublisher {
  publish(input: { level: L3AppNotificationLevel; title: string; description?: string }): string
  update(notificationId: string, changes: L3AppNotificationChanges): void
  delete(notificationId: string): void
  dispose(): void
}

export function getL2AppRuntime(): L2AppRuntime {
  const runtime = getL3AppRuntime()
  if (globalThis.__piDeskModeNamesBinding?.runtime !== runtime) {
    globalThis.__piDeskModeNamesBinding?.dispose()
    const store = getL4CapabilityModesStore()
    const update = (): void => {
      runtime.applyInternal({ key: 'capabilityModes', update: l3CapabilityModeNames(store.read()) })
    }
    update()
    globalThis.__piDeskModeNamesBinding = { runtime, dispose: store.subscribe(update) }
  }
  return runtime
}

export function createL2AppNotificationPublisher(): L2AppNotificationPublisher {
  const publisher = getL3AppNotificationRuntime().createPublisher()
  return {
    publish: (input) => publisher.publish({ ...input, event: null }),
    update: (notificationId, changes) => publisher.update(notificationId, changes),
    delete: (notificationId) => publisher.delete(notificationId),
    dispose: () => publisher.dispose()
  }
}

export function createL2PluginAppRuntimeSink(): L4PiPluginAppRuntimeSink {
  const notifications = getL3AppNotificationRuntime()
  const plugins = getL3AppPluginStateRuntime()
  return {
    setState: (pluginName, state) => plugins.setState(pluginName, state),
    publishNotification: (pluginName, input) => notifications.publishPlugin(pluginName, input),
    updateNotification: (pluginName, notificationId, changes) =>
      notifications.updatePlugin(pluginName, notificationId, changes),
    deleteNotification: (pluginName, notificationId) =>
      notifications.deletePlugin(pluginName, notificationId),
    releasePlugin: (pluginName) => {
      notifications.releasePlugin(pluginName)
      plugins.releasePlugin(pluginName)
    }
  }
}

export function disposeL2AppRuntime(): void {
  globalThis.__piDeskModeNamesBinding?.dispose()
  globalThis.__piDeskModeNamesBinding = undefined
  disposeL3AppNotificationRuntime()
  disposeL3AppPluginStateRuntime()
  disposeL3AppRuntime()
}

declare global {
  var __piDeskModeNamesBinding: { runtime: L3AppRuntime; dispose: () => void } | undefined
}
