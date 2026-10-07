'use client'

import { useEffect } from 'react'
import type { L2PluginManagementSnapshot } from '@common/l2_biz/plugin/l2-plugin-management-contract'

export function useL2WorkbenchPluginHealth(
  ready: boolean,
  readHealth: () => Promise<L2PluginManagementSnapshot>,
  onSnapshot: (snapshot: L2PluginManagementSnapshot) => void,
  onError: (message: string) => void,
  subscribeChanges: (listener: () => void) => () => void
): void {
  useEffect(() => {
    if (!ready) return
    let active = true
    let reading = false
    let dirty = false
    const refresh = (): void => {
      if (!active) return
      dirty = true
      if (reading) return
      reading = true
      void (async (): Promise<void> => {
        try {
          while (active && dirty) {
            dirty = false
            const snapshot = await readHealth()
            if (active) onSnapshot(snapshot)
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          if (active) onError(message || '读取插件健康状态失败')
          console.warn('[Pi Desk][Workbench] 读取插件健康状态失败', { message })
        } finally {
          reading = false
        }
      })()
    }
    const unsubscribe = subscribeChanges(refresh)

    // 首屏只读取静态清单；能力盘点由用户主动发起。
    let cancel: () => void
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(refresh, { timeout: 3_000 })
      cancel = (): void => {
        window.cancelIdleCallback(handle)
      }
    } else {
      const handle = window.setTimeout(refresh, 1_500)
      cancel = (): void => {
        window.clearTimeout(handle)
      }
    }
    return () => {
      active = false
      unsubscribe()
      cancel()
    }
  }, [onError, onSnapshot, readHealth, ready, subscribeChanges])
}
