import type { PluginPushMessage, PluginSource } from '@jetcrab/pi-desk-sdk/browser'
import type { DeliverableBatch, DeliverableItem } from './contract.js'

export interface DeliverablePushEvent {
  source: PluginSource
  delivery: DeliverableBatch
}

type DeliverablePushListener = (event: DeliverablePushEvent) => void

const listeners = new Set<DeliverablePushListener>()

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseItems(value: unknown): DeliverableItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null
  const items: DeliverableItem[] = []
  for (const raw of value) {
    const item = record(raw)
    if (!item || typeof item.path !== 'string' || typeof item.title !== 'string') return null
    const path = item.path.trim()
    const title = item.title.trim()
    if (!path || !title || title.length > 40) return null
    items.push({ path, title })
  }
  return items
}

export function parseDeliverableBatch(value: unknown): DeliverableBatch | null {
  const data = record(value)
  const items = parseItems(data?.items)
  return data && typeof data.entryId === 'string' && data.entryId && items
    ? { entryId: data.entryId, items }
    : null
}

export function publishDeliverablePush(message: PluginPushMessage): DeliverableBatch | null {
  if (message.event !== 'added' || message.target.scope !== 'session') return null
  const delivery = parseDeliverableBatch(message.data)
  if (!delivery) return null
  const event = { source: message.target.source, delivery }
  for (const listener of [...listeners]) listener(event)
  return delivery
}

export function subscribeDeliverablePush(listener: DeliverablePushListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetDeliverableBrowserRuntime(): void {
  listeners.clear()
}
