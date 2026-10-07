import 'server-only'

import { randomUUID } from 'node:crypto'
import {
  L3AppNotificationChangesSchema,
  L3AppNotificationSchema,
  L3PluginNotificationChangesSchema,
  L3PluginNotificationPublishInputSchema,
  type L3AppNotificationChanges,
  type L3AppNotificationEvent,
  type L3AppNotificationLevel,
  type L3PluginNotificationChanges,
  type L3PluginNotificationPublishInput
} from '@common/l3_modules/app-runtime/l3-app-runtime-contract'
import { L3PluginNameSchema } from '@common/l3_modules/plugin-host/l3-plugin-json-contract'
import { getL3AppRuntime, type L3AppRuntime } from './l3-app-runtime'

const L3_APP_NOTIFICATION_MAX_ITEMS = 100
const L3_PLUGIN_NOTIFICATION_EVENT_MAX_JSON_BYTES = 64 * 1024

type L3AppNotificationOwner = string | object

export interface L3AppNotificationPublishInput {
  level: L3AppNotificationLevel
  title: string
  description?: string
  event?: L3AppNotificationEvent | null
}

export interface L3AppNotificationPublisher {
  publish(input: L3AppNotificationPublishInput): string
  update(notificationId: string, changes: L3AppNotificationChanges): void
  delete(notificationId: string): void
  dispose(): void
}

export class L3AppNotificationNotFoundError extends Error {
  constructor(notificationId: string) {
    super(`Notification does not exist: ${notificationId}`)
    this.name = 'L3AppNotificationNotFoundError'
  }
}

export class L3AppNotificationOwnerError extends Error {
  constructor(notificationId: string) {
    super(`Notification is owned by another publisher: ${notificationId}`)
    this.name = 'L3AppNotificationOwnerError'
  }
}

export class L3AppNotificationRuntime {
  private readonly ownersByNotificationId = new Map<string, L3AppNotificationOwner>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly runtime: L3AppRuntime = getL3AppRuntime()) {
    this.unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'replace') {
        const activeIds = new Set(
          event.runtime.notifications.map((notification) => notification.notificationId)
        )
        for (const notificationId of this.ownersByNotificationId.keys()) {
          if (!activeIds.has(notificationId)) this.ownersByNotificationId.delete(notificationId)
        }
        return
      }
      if (event.key === 'notifications' && event.update.type === 'delete') {
        this.ownersByNotificationId.delete(event.update.notificationId)
      }
    })
  }

  createPublisher(): L3AppNotificationPublisher {
    this.ensureActive()
    const owner = {}
    let active = true
    return {
      publish: (input) => {
        if (!active) throw new Error('App Notification Publisher has been disposed')
        return this.publish(owner, input)
      },
      update: (notificationId, changes) => {
        if (!active) throw new Error('App Notification Publisher has been disposed')
        this.update(owner, notificationId, changes)
      },
      delete: (notificationId) => {
        if (!active) throw new Error('App Notification Publisher has been disposed')
        this.delete(owner, notificationId)
      },
      dispose: () => {
        if (!active) return
        active = false
        this.releaseOwner(owner)
      }
    }
  }

  publishPlugin(pluginNameInput: string, input: L3PluginNotificationPublishInput): string {
    this.ensureActive()
    const pluginName = L3PluginNameSchema.parse(pluginNameInput)
    const normalized = L3PluginNotificationPublishInputSchema.parse(input)
    return this.publish(pluginName, {
      level: normalized.level,
      title: normalized.title,
      ...(normalized.description === undefined ? {} : { description: normalized.description }),
      event: normalized.event
        ? {
            type: 'plugin',
            pluginName,
            name: normalized.event.name,
            data: normalized.event.data
          }
        : null
    })
  }

  updatePlugin(
    pluginNameInput: string,
    notificationId: string,
    changes: L3PluginNotificationChanges
  ): void {
    this.ensureActive()
    this.update(
      L3PluginNameSchema.parse(pluginNameInput),
      notificationId,
      L3PluginNotificationChangesSchema.parse(changes)
    )
  }

  deletePlugin(pluginNameInput: string, notificationId: string): void {
    this.ensureActive()
    this.delete(L3PluginNameSchema.parse(pluginNameInput), notificationId)
  }

  releasePlugin(pluginNameInput: string): void {
    if (this.disposed) return
    this.releaseOwner(L3PluginNameSchema.parse(pluginNameInput))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.ownersByNotificationId.clear()
  }

  private publish(owner: L3AppNotificationOwner, input: L3AppNotificationPublishInput): string {
    this.ensureActive()
    if (
      input.event?.type === 'plugin' &&
      Buffer.byteLength(JSON.stringify(input.event.data), 'utf8') >
        L3_PLUGIN_NOTIFICATION_EVENT_MAX_JSON_BYTES
    ) {
      throw new Error('Plugin notification event data exceeds 64KB')
    }

    const current = this.runtime.readSnapshot().notifications
    const oldest = current.length >= L3_APP_NOTIFICATION_MAX_ITEMS ? current[0] : undefined
    if (oldest) {
      this.runtime.applyInternal({
        key: 'notifications',
        update: { type: 'delete', notificationId: oldest.notificationId }
      })
    }

    const notification = L3AppNotificationSchema.parse({
      notificationId: randomUUID(),
      level: input.level,
      title: input.title,
      description: input.description ?? null,
      createdAt: Date.now(),
      event: input.event ?? null
    })
    this.ownersByNotificationId.set(notification.notificationId, owner)
    try {
      this.runtime.applyInternal({
        key: 'notifications',
        update: { type: 'add', notification }
      })
    } catch (error) {
      this.ownersByNotificationId.delete(notification.notificationId)
      throw error
    }
    return notification.notificationId
  }

  private update(
    owner: L3AppNotificationOwner,
    notificationId: string,
    changes: L3AppNotificationChanges
  ): void {
    this.ensureActive()
    this.assertOwner(owner, notificationId)
    this.runtime.applyInternal({
      key: 'notifications',
      update: {
        type: 'update',
        notificationId,
        changes: L3AppNotificationChangesSchema.parse(changes)
      }
    })
  }

  private delete(owner: L3AppNotificationOwner, notificationId: string): void {
    this.ensureActive()
    this.assertOwner(owner, notificationId)
    this.runtime.applyInternal({
      key: 'notifications',
      update: { type: 'delete', notificationId }
    })
  }

  private releaseOwner(owner: L3AppNotificationOwner): void {
    const activeIds = new Set(
      this.runtime.readSnapshot().notifications.map((notification) => notification.notificationId)
    )
    const notificationIds = [...this.ownersByNotificationId.entries()]
      .filter(([, currentOwner]) => currentOwner === owner)
      .map(([notificationId]) => notificationId)
    for (const notificationId of notificationIds) {
      if (!activeIds.has(notificationId)) {
        this.ownersByNotificationId.delete(notificationId)
        continue
      }
      this.runtime.applyInternal({
        key: 'notifications',
        update: { type: 'delete', notificationId }
      })
    }
  }

  private assertOwner(owner: L3AppNotificationOwner, notificationId: string): void {
    const currentOwner = this.ownersByNotificationId.get(notificationId)
    if (!currentOwner) throw new L3AppNotificationNotFoundError(notificationId)
    if (currentOwner !== owner) throw new L3AppNotificationOwnerError(notificationId)
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('App Notification Runtime has been disposed')
  }
}

function notificationRuntime(): L3AppNotificationRuntime {
  if (!globalThis.__piDeskAppNotificationRuntime) {
    globalThis.__piDeskAppNotificationRuntime = new L3AppNotificationRuntime()
  }
  return globalThis.__piDeskAppNotificationRuntime
}

export function getL3AppNotificationRuntime(): L3AppNotificationRuntime {
  return notificationRuntime()
}

export function disposeL3AppNotificationRuntime(): void {
  const runtime = globalThis.__piDeskAppNotificationRuntime
  globalThis.__piDeskAppNotificationRuntime = undefined
  runtime?.dispose()
}

declare global {
  var __piDeskAppNotificationRuntime: L3AppNotificationRuntime | undefined
}
