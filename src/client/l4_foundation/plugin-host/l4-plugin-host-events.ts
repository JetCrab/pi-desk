import type {
  BrowserHostEventMap,
  HostEvents,
  HostEventListener,
  PluginJsonObject
} from '@jetcrab/pi-desk-sdk/browser'
import { runL4PluginCallback } from './l4-plugin-host-lifecycle'

type StateName = Exclude<keyof BrowserHostEventMap, 'chat-submit-result'>

interface EventOwner {
  readonly active: boolean
  descriptor: { pluginName: string }
  subscriptionDisposers: Set<() => void>
}

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child)
    Object.freeze(value)
  }
  return value
}

function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || value === null) throw new Error('事件数据必须为 JSON')
  if (ancestors.has(value)) throw new Error('事件数据不能包含循环引用')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (
    array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    throw new Error('事件数据必须为普通 JSON 对象')
  }
  ancestors.add(value)
  if (array && Object.keys(value).length !== value.length)
    throw new Error('事件数据不能包含稀疏或扩展数组')
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('事件数据只能包含 JSON 字段')
    }
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('事件数据不能包含扩展数组字段')
    assertJson(descriptor.value, ancestors)
  }
  ancestors.delete(value)
}

function parseIdentifier(value: string): string {
  if (typeof value !== 'string') throw new Error('插件或事件名称必须为字符串')
  const name = value.trim()
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('插件或事件名称必须为 1-64 字符的小写 kebab-case')
  }
  return name
}

function cloneEventData(data: PluginJsonObject): PluginJsonObject {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('插件事件数据必须为 JSON Object')
  }
  assertJson(data)
  const json = JSON.stringify(data)
  if (new TextEncoder().encode(json).byteLength > 64 * 1024) {
    throw new Error('插件事件数据不能超过 64KB')
  }
  return freezeData(JSON.parse(json) as PluginJsonObject)
}

/** 每个 Browser Runtime 持有，路由仅随订阅存在，不记录事件历史。 */
export class L4PluginHostEvents {
  private readonly states = new Map<StateName, Set<() => void>>()
  private readonly actions = new Set<(data: BrowserHostEventMap['chat-submit-result']) => void>()
  private readonly plugins = new Map<string, Set<(data: PluginJsonObject) => void>>()

  constructor(
    private readonly readState: <K extends StateName>(
      name: K,
      pluginName: string
    ) => BrowserHostEventMap[K] | undefined,
    private readonly isDisposed: () => boolean
  ) {}

  createHost(owner: EventOwner): HostEvents<BrowserHostEventMap> {
    const pluginName = owner.descriptor.pluginName
    const assertActive = (): void => {
      if (!owner.active || this.isDisposed()) throw new Error('Browser Entry 已失效')
    }
    const subscribe = <T>(
      listeners: Set<T>,
      listener: T,
      releaseRoute: () => void = () => undefined
    ): (() => void) => {
      let active = true
      const off = (): void => {
        if (!active) return
        active = false
        listeners.delete(listener)
        owner.subscriptionDisposers.delete(off)
        if (listeners.size === 0) releaseRoute()
      }
      listeners.add(listener)
      owner.subscriptionDisposers.add(off)
      return off
    }
    return {
      on: <K extends keyof BrowserHostEventMap>(
        name: K,
        handler: HostEventListener<BrowserHostEventMap[K]>
      ): (() => void) => {
        assertActive()
        if (typeof handler !== 'function') throw new Error('事件监听器必须为函数')
        if (name === 'chat-submit-result') {
          const listener = (data: BrowserHostEventMap['chat-submit-result']): void => {
            if (!owner.active || this.isDisposed() || !this.actions.has(listener)) return
            runL4PluginCallback(
              () => handler(data as BrowserHostEventMap[K]),
              `event:browser:host:${name}`,
              pluginName
            )
          }
          return subscribe(this.actions, listener)
        }
        if (
          ![
            'workbench-context',
            'work-sessions',
            'connection',
            'settings',
            'theme',
            'plugin-state'
          ].includes(name)
        ) {
          throw new Error(`未知 Browser 宿主事件：${name}`)
        }
        const stateName = name as StateName
        const listeners = this.states.get(stateName) ?? new Set<() => void>()
        this.states.set(stateName, listeners)
        let initial = true
        let scheduled = false
        let serialized: string | undefined
        const deliver = (): void => {
          scheduled = false
          if (!owner.active || this.isDisposed() || !listeners.has(changed)) return
          const value = this.readState(stateName, pluginName)
          if (value === undefined) return
          const next = JSON.stringify(value)
          if (!initial && next === serialized) return
          initial = false
          serialized = next
          runL4PluginCallback(
            () => handler(freezeData(value) as BrowserHostEventMap[K]),
            `event:browser:host:${name}`,
            pluginName
          )
        }
        const changed = (): void => {
          if (!initial) {
            deliver()
          } else if (!scheduled) {
            scheduled = true
            queueMicrotask(deliver)
          }
        }
        const off = subscribe(listeners, changed, () => this.states.delete(stateName))
        changed()
        return off
      },
      onPlugin: (publisher, name, handler) => {
        assertActive()
        const key = `${parseIdentifier(publisher)}\u0000${parseIdentifier(name)}`
        if (typeof handler !== 'function') throw new Error('事件监听器必须为函数')
        const listeners = this.plugins.get(key) ?? new Set<(data: PluginJsonObject) => void>()
        this.plugins.set(key, listeners)
        const listener = (data: PluginJsonObject): void => {
          if (!owner.active || this.isDisposed() || !listeners.has(listener)) return
          runL4PluginCallback(
            () => handler(data),
            `event:browser:plugin:${publisher}/${name}`,
            pluginName
          )
        }
        return subscribe(listeners, listener, () => this.plugins.delete(key))
      },
      emit: (name, data) => {
        assertActive()
        const event = parseIdentifier(name)
        const snapshot = cloneEventData(data)
        for (const listener of [...(this.plugins.get(`${pluginName}\u0000${event}`) ?? [])])
          listener(snapshot)
      }
    }
  }

  publishState(name: StateName): void {
    for (const listener of [...(this.states.get(name) ?? [])]) listener()
  }

  publishChatSubmitResult(data: BrowserHostEventMap['chat-submit-result']): void {
    const snapshot = freezeData(structuredClone(data))
    for (const listener of [...this.actions]) listener(snapshot)
  }

  dispose(): void {
    this.states.clear()
    this.actions.clear()
    this.plugins.clear()
  }
}
