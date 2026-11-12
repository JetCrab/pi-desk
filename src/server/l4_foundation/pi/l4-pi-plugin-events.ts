import type {
  HostEvents,
  HostEventListener,
  NodeHostEventMap,
  PluginJsonObject
} from '@jetcrab/pi-desk-sdk/entry'
import type { HostSettings } from '@jetcrab/pi-desk-sdk/settings'
import { parseL4PiPluginMethodName, parseL4PiPluginName } from './l4-pi-plugin-method-runtime-core'

interface EventOwner {
  pluginName: string
  ensureActive(): void
  isActive(): boolean
  subscriptions: Set<() => void | Promise<void>>
}

interface Subscription {
  owner: EventOwner
  active: boolean
  initialized: boolean
  pending: boolean
  off(): void
  deliver(data: unknown): void | Promise<void>
}

type WorkSessionSource = (
  listener: (sessions: NodeHostEventMap['work-sessions']) => void
) => () => void

type StateName = 'settings' | 'work-sessions'

function freezeEventData<T>(data: T): T {
  if (data !== null && typeof data === 'object') {
    for (const value of Object.values(data)) freezeEventData(value)
    Object.freeze(data)
  }
  return data
}

function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || value === null) throw new Error('事件数据必须是严格 JSON')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (
    array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    throw new Error('事件数据不接受类实例')
  }
  if (ancestors.has(value)) throw new Error('事件数据不能包含循环引用')
  ancestors.add(value)
  const keys = Reflect.ownKeys(value)
  if (array && keys.length !== value.length + 1) throw new Error('事件数据不接受稀疏数组或额外属性')
  for (const key of keys) {
    if (array && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('事件数据只能包含可枚举 JSON 属性')
    }
    if (array && !/^(0|[1-9]\d*)$/.test(key)) throw new Error('事件数组不能包含额外属性')
    validateJson(descriptor.value, ancestors)
  }
  ancestors.delete(value)
}

function parseEventData(value: PluginJsonObject): PluginJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('事件数据根值必须是JSON对象')
  }
  validateJson(value)
  const data = structuredClone(value)
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 64 * 1024) {
    throw new Error('插件事件数据超过64KB')
  }
  return freezeEventData(data)
}

export class L4PiPluginEvents {
  private readonly hostListeners = new Map<string, Set<Subscription>>()
  private readonly pluginListeners = new Map<string, Set<Subscription>>()
  private readonly states = new Map<StateName, unknown>()
  private readonly unsubscribeSettings: (() => void) | undefined
  private workSessionSource: { subscribe: WorkSessionSource } | null = null
  private workSessionConnection: { dispose?: () => void } | null = null

  constructor(settings?: HostSettings) {
    if (settings) {
      this.updateState('settings', settings.getSnapshot())
      this.unsubscribeSettings = settings.subscribe(() =>
        this.updateState('settings', settings.getSnapshot())
      )
    }
  }

  createHost(owner: EventOwner): HostEvents<NodeHostEventMap> {
    return {
      on: (name, handler) => {
        owner.ensureActive()
        if (!['settings', 'work-sessions', 'chat-input-accepted'].includes(name)) {
          throw new Error(`未知 Node 宿主事件：${name}`)
        }
        const subscription = this.subscribe(owner, this.hostListeners, name, handler)
        if (name !== 'chat-input-accepted') {
          this.scheduleInitial(subscription, name)
          if (name === 'work-sessions') this.connectWorkSessions()
        } else {
          subscription.initialized = true
        }
        return subscription.off
      },
      onPlugin: (pluginName, name, handler) => {
        owner.ensureActive()
        const publisher = parseL4PiPluginName(pluginName)
        const event = parseL4PiPluginMethodName(name)
        const subscription = this.subscribe(
          owner,
          this.pluginListeners,
          `${publisher}\u0000${event}`,
          handler
        )
        subscription.initialized = true
        return subscription.off
      },
      emit: (name, data) => {
        owner.ensureActive()
        const event = parseL4PiPluginMethodName(name)
        const parsed = parseEventData(data)
        this.publish(this.pluginListeners, `${owner.pluginName}\u0000${event}`, parsed)
      }
    }
  }

  updateState<K extends StateName>(name: K, value: NodeHostEventMap[K]): void {
    if (this.states.has(name) && JSON.stringify(this.states.get(name)) === JSON.stringify(value)) {
      return
    }
    const snapshot = freezeEventData(structuredClone(value))
    this.states.set(name, snapshot)
    for (const subscription of [...(this.hostListeners.get(name) ?? [])]) {
      if (subscription.initialized) this.deliver(subscription, snapshot, name)
      else this.scheduleInitial(subscription, name)
    }
  }

  bindWorkSessions(subscribe: WorkSessionSource): () => void {
    this.disconnectWorkSessions()
    const source = { subscribe }
    this.workSessionSource = source
    this.connectWorkSessions()
    return (): void => {
      if (this.workSessionSource !== source) return
      this.workSessionSource = null
      this.disconnectWorkSessions()
    }
  }

  releaseOwner(subscriptions: EventOwner['subscriptions']): void {
    for (const routes of [this.hostListeners, this.pluginListeners]) {
      for (const listeners of routes.values()) {
        for (const subscription of [...listeners]) {
          if (subscription.owner.subscriptions === subscriptions) subscription.off()
        }
      }
    }
  }

  private connectWorkSessions(): void {
    if (
      this.workSessionConnection ||
      !this.workSessionSource ||
      !this.hostListeners.has('work-sessions')
    )
      return
    const connection: { dispose?: () => void } = {}
    this.workSessionConnection = connection
    const dispose = this.workSessionSource.subscribe((sessions) => {
      if (this.workSessionConnection === connection) this.updateState('work-sessions', sessions)
    })
    if (this.workSessionConnection === connection) connection.dispose = dispose
    else dispose()
  }

  private disconnectWorkSessions(): void {
    const connection = this.workSessionConnection
    this.workSessionConnection = null
    this.states.delete('work-sessions')
    connection?.dispose?.()
  }

  inputAccepted(data: NodeHostEventMap['chat-input-accepted']): void {
    this.publish(this.hostListeners, 'chat-input-accepted', freezeEventData(structuredClone(data)))
  }

  dispose(): void {
    this.workSessionSource = null
    this.disconnectWorkSessions()
    this.unsubscribeSettings?.()
    this.hostListeners.clear()
    this.pluginListeners.clear()
    this.states.clear()
  }

  private scheduleInitial(subscription: Subscription, name: StateName): void {
    if (subscription.pending) return
    subscription.pending = true
    queueMicrotask(() => {
      subscription.pending = false
      if (subscription.initialized || !this.states.has(name)) return
      subscription.initialized = true
      this.deliver(subscription, this.states.get(name), name)
    })
  }

  private subscribe<T>(
    owner: EventOwner,
    routes: Map<string, Set<Subscription>>,
    name: string,
    handler: HostEventListener<T>
  ): Subscription {
    if (typeof handler !== 'function') throw new Error('事件监听器必须是函数')
    let listeners = routes.get(name)
    if (!listeners) {
      listeners = new Set()
      routes.set(name, listeners)
    }
    const subscription: Subscription = {
      owner,
      active: true,
      initialized: false,
      pending: false,
      deliver: (data) => handler(data as Readonly<T>),
      off: () => {
        if (!subscription.active) return
        subscription.active = false
        owner.subscriptions.delete(subscription.off)
        listeners.delete(subscription)
        if (listeners.size === 0) {
          routes.delete(name)
          if (routes === this.hostListeners && name === 'work-sessions')
            this.disconnectWorkSessions()
        }
      }
    }
    listeners.add(subscription)
    owner.subscriptions.add(subscription.off)
    return subscription
  }

  private publish(routes: Map<string, Set<Subscription>>, name: string, data: unknown): void {
    for (const subscription of [...(routes.get(name) ?? [])]) {
      this.deliver(subscription, data, name)
    }
  }

  private deliver(subscription: Subscription, data: unknown, event: string): void {
    if (!subscription.active || !subscription.owner.isActive()) return
    const log = (error: unknown): void => {
      console.warn('[Pi Desk][GlobalPluginRuntime] Node事件监听失败', {
        event: event.replace('\u0000', '/'),
        subscriber: subscription.owner.pluginName,
        message: error instanceof Error ? error.message : String(error)
      })
    }
    try {
      void Promise.resolve(subscription.deliver(data)).catch(log)
    } catch (error) {
      log(error)
    }
  }
}
