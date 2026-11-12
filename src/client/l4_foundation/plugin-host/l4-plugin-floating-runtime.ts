'use client'

import type {
  BrowserFloatingHandle,
  BrowserFloatingHost,
  BrowserFloatingOpenInput,
  BrowserPluginHost,
  PluginDisposer
} from '@jetcrab/pi-desk-sdk/browser'
import { disposeL4PluginResource, runL4PluginCallback } from './l4-plugin-host-lifecycle'

interface FloatingOwner {
  descriptor: { pluginName: string }
  active: boolean
  mounts: Set<PluginDisposer>
}

interface FloatingInstance {
  handle: BrowserFloatingHandle
  start(layer: HTMLElement): void
}

export class L4PluginFloatingRuntime {
  private layer: HTMLElement | null = null
  private readonly instances = new Set<FloatingInstance>()

  bindContainer(layer: HTMLElement): () => void {
    if (this.layer) throw new Error('悬浮挂载层已经绑定')
    this.layer = layer
    for (const instance of this.instances) instance.start(layer)
    return () => {
      if (this.layer !== layer) return
      this.layer = null
      for (const instance of [...this.instances]) instance.handle.close()
    }
  }

  createHost(owner: FloatingOwner, getHost: () => BrowserPluginHost): BrowserFloatingHost {
    const byId = new Map<string, FloatingInstance>()
    const pluginName = owner.descriptor.pluginName
    return {
      open: (input: BrowserFloatingOpenInput): BrowserFloatingHandle => {
        if (!owner.active) throw new Error('Browser Entry 已失效')
        const id = input?.id
        if (typeof id !== 'string' || !id.trim()) throw new Error('悬浮组件需要非空 ID')
        if (typeof input.load !== 'function') throw new Error('悬浮组件缺少 load 回调')
        const existing = byId.get(id)
        if (existing) return existing.handle

        const load = input.load
        const controller = new AbortController()
        let container: HTMLElement | null = null
        let mounting: Promise<PluginDisposer | void> | null = null
        let disposal: Promise<void> | null = null
        const dispose = (): Promise<void> => {
          if (disposal) return disposal
          // 先记录清理任务，abort 回调即使重入 close 也不能撤销同 ID 的新实例。
          disposal = disposeL4PluginResource(pluginName, `floating:${id}`, async () => {
            const cleanup = await mounting?.catch(() => undefined)
            await cleanup?.()
          })
          byId.delete(id)
          this.instances.delete(instance)
          owner.mounts.delete(dispose)
          controller.abort()
          container?.remove()
          container = null
          return disposal
        }
        const handle: BrowserFloatingHandle = Object.freeze({
          close: (): void => {
            void dispose()
          }
        })
        const instance: FloatingInstance = {
          handle,
          start: (layer): void => {
            if (mounting || controller.signal.aborted) return
            const element = layer.ownerDocument.createElement('div')
            element.dataset.piDeskPlugin = pluginName
            element.dataset.piDeskFloating = id
            // 容器不产生整屏命中区域，插件内容继承可交互状态并自行定位。
            element.style.display = 'contents'
            element.style.pointerEvents = 'auto'
            container = element
            layer.append(element)
            mounting = Promise.resolve().then(async () => {
              if (controller.signal.aborted) return
              const implementation = await load()
              if (controller.signal.aborted) return
              if (!implementation || typeof implementation.mount !== 'function') {
                throw new Error('悬浮组件 load 必须返回包含 mount 的实现')
              }
              const cleanup = await implementation.mount({
                container: element,
                target: handle,
                host: getHost(),
                signal: controller.signal
              })
              if (cleanup !== undefined && typeof cleanup !== 'function') {
                throw new Error('悬浮组件 mount 必须返回 void 或 disposer')
              }
              return cleanup
            })
            void mounting.catch((cause: unknown) => {
              if (controller.signal.aborted) return
              const message = cause instanceof Error ? cause.message : String(cause)
              console.error('[Pi Desk][PluginHost] 悬浮组件打开失败', { pluginName, id, message })
              void dispose()
              runL4PluginCallback(
                () =>
                  getHost().notify({
                    level: 'error',
                    title: '悬浮组件打开失败',
                    description: message
                  }),
                'floating-error',
                pluginName
              )
            })
          }
        }
        byId.set(id, instance)
        this.instances.add(instance)
        owner.mounts.add(dispose)
        if (this.layer) instance.start(this.layer)
        return handle
      }
    }
  }
}
