'use client'

import type {
  BrowserConnectionHost,
  BrowserPluginLogHandle,
  BrowserPluginLogHost,
  BrowserPluginLogSnapshot
} from '@jetcrab/pi-desk-sdk/browser'
import { runL4PluginCallback } from './l4-plugin-host-lifecycle'

export interface L4PluginLogContentSnapshot {
  text: string
  truncated: boolean
}

export type L4PluginLogEvent =
  | { type: 'text_append'; text: string }
  | { type: 'snapshot'; snapshot: L4PluginLogContentSnapshot }
  | { type: 'unavailable' }

export interface L4PluginLogChannel {
  watch(path: string): Promise<L4PluginLogContentSnapshot>
  unwatch(path: string): Promise<void>
  subscribe(listener: (message: { path: string; event: L4PluginLogEvent }) => void): () => void
}

interface L4PluginLogRecord {
  path: string
  references: number
  observed: boolean
  blockedByError: boolean
  refreshRequested: boolean
  syncRequested: boolean
  syncPromise: Promise<void> | null
  snapshot: BrowserPluginLogSnapshot
  listeners: Set<() => void>
}

const EMPTY_LOG_SNAPSHOT: BrowserPluginLogSnapshot = {
  text: '',
  truncated: false,
  loading: true,
  error: null
}

function notifyRecord(record: L4PluginLogRecord): void {
  for (const listener of [...record.listeners]) {
    runL4PluginCallback(listener, `log:${record.path}`)
  }
}

function replaceSnapshot(record: L4PluginLogRecord, snapshot: BrowserPluginLogSnapshot): void {
  if (
    snapshot.text === record.snapshot.text &&
    snapshot.truncated === record.snapshot.truncated &&
    snapshot.loading === record.snapshot.loading &&
    snapshot.error === record.snapshot.error
  ) {
    return
  }
  record.snapshot = snapshot
  notifyRecord(record)
}

export class L4PluginLogHostRuntime implements BrowserPluginLogHost {
  private readonly records = new Map<string, L4PluginLogRecord>()
  private readonly unsubscribeEvents: () => void
  private readonly unsubscribeConnection: () => void
  private connectionEpoch = 0
  private disposed = false

  constructor(
    private readonly channel: L4PluginLogChannel,
    private readonly connection: BrowserConnectionHost
  ) {
    this.unsubscribeEvents = channel.subscribe((message) => this.handleEvent(message))
    this.unsubscribeConnection = connection.subscribe(() => this.handleConnectionChange())
  }

  open(pathInput: string): BrowserPluginLogHandle {
    if (this.disposed) throw new Error('Plugin log host has been disposed')
    const path = pathInput.trim()
    if (!path) throw new Error('日志路径不能为空')

    let record = this.records.get(path)
    if (!record) {
      record = {
        path,
        references: 0,
        observed: false,
        blockedByError: false,
        refreshRequested: false,
        syncRequested: false,
        syncPromise: null,
        snapshot: { ...EMPTY_LOG_SNAPSHOT },
        listeners: new Set()
      }
      this.records.set(path, record)
    }
    record.references += 1
    this.requestSync(record)

    let active = true
    return {
      getSnapshot: () => record!.snapshot,
      subscribe: (listener) => {
        if (!active) throw new Error('Plugin log handle has been disposed')
        record!.listeners.add(listener)
        return (): void => {
          record!.listeners.delete(listener)
        }
      },
      retry: () => {
        if (!active || this.disposed) return
        record!.blockedByError = false
        record!.refreshRequested = true
        replaceSnapshot(record!, { ...record!.snapshot, loading: true, error: null })
        this.requestSync(record!)
      },
      dispose: () => {
        if (!active) return
        active = false
        record!.references -= 1
        this.requestSync(record!)
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeEvents()
    this.unsubscribeConnection()
    for (const record of this.records.values()) {
      if (record.observed && this.connection.getSnapshot().status === 'ready') {
        void this.channel.unwatch(record.path).catch(() => undefined)
      }
      record.listeners.clear()
    }
    this.records.clear()
  }

  private handleConnectionChange(): void {
    if (this.disposed) return
    this.connectionEpoch += 1
    const ready = this.connection.getSnapshot().status === 'ready'
    for (const record of this.records.values()) {
      record.observed = false
      record.blockedByError = false
      record.refreshRequested = ready
      if (record.references > 0) {
        replaceSnapshot(record, {
          ...record.snapshot,
          loading: true,
          error: ready ? null : record.snapshot.error
        })
      }
      this.requestSync(record)
    }
  }

  private handleEvent(message: { path: string; event: L4PluginLogEvent }): void {
    if (this.disposed) return
    const record = this.records.get(message.path)
    if (!record || record.references === 0) return

    if (message.event.type === 'text_append') {
      replaceSnapshot(record, {
        ...record.snapshot,
        text: record.snapshot.text + message.event.text,
        loading: false,
        error: null
      })
      return
    }
    if (message.event.type === 'snapshot') {
      replaceSnapshot(record, {
        ...message.event.snapshot,
        loading: false,
        error: null
      })
      return
    }

    record.observed = false
    record.blockedByError = true
    replaceSnapshot(record, {
      ...record.snapshot,
      loading: false,
      error: '日志暂不可用'
    })
  }

  private requestSync(record: L4PluginLogRecord): void {
    if (this.disposed) return
    record.syncRequested = true
    if (record.syncPromise) return
    record.syncPromise = (async () => {
      while (record.syncRequested && !this.disposed) {
        record.syncRequested = false
        await this.reconcileRecord(record)
      }
    })().finally(() => {
      record.syncPromise = null
      if (record.syncRequested && !this.disposed) this.requestSync(record)
    })
  }

  private async reconcileRecord(record: L4PluginLogRecord): Promise<void> {
    if (this.records.get(record.path) !== record) return
    const ready = this.connection.getSnapshot().status === 'ready'
    const shouldObserve = record.references > 0 && ready && !record.blockedByError

    if (!shouldObserve) {
      if (record.observed && ready) {
        const epoch = this.connectionEpoch
        try {
          await this.channel.unwatch(record.path)
        } catch {
          // 连接关闭时服务端会自动释放旧观察。
        }
        if (epoch === this.connectionEpoch) record.observed = false
      } else {
        record.observed = false
      }
      if (record.references === 0 && !record.observed) this.records.delete(record.path)
      return
    }

    if (record.observed && !record.refreshRequested) return
    record.refreshRequested = false
    replaceSnapshot(record, { ...record.snapshot, loading: true, error: null })
    const epoch = this.connectionEpoch
    try {
      const snapshot = await this.channel.watch(record.path)
      if (
        this.disposed ||
        epoch !== this.connectionEpoch ||
        this.records.get(record.path) !== record
      ) {
        return
      }
      record.observed = true
      record.blockedByError = false
      replaceSnapshot(record, { ...snapshot, loading: false, error: null })
    } catch (error) {
      if (epoch !== this.connectionEpoch || this.connection.getSnapshot().status !== 'ready') {
        record.syncRequested = true
        return
      }
      record.observed = false
      record.blockedByError = true
      replaceSnapshot(record, {
        ...record.snapshot,
        loading: false,
        error: error instanceof Error && error.message ? error.message : '读取日志失败'
      })
    } finally {
      if (record.references === 0 || record.syncRequested) record.syncRequested = true
    }
  }
}
