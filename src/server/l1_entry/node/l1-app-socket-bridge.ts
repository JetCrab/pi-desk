import type { WebSocket } from 'ws'

export interface L1AppSocketRuntimeBridge {
  accept: (socket: WebSocket, clientId: string, cookieHeader?: string) => void
  closeAll: (code: number, reason: string) => Promise<void>
  terminateAll: () => void
  connectionCount: () => number
  disposePlugins: () => Promise<void>
  disposeWorkSessions: () => Promise<void>
  disposeTerminals: () => Promise<void>
}

declare global {
  var __piDeskAppSocketRuntimeBridge: L1AppSocketRuntimeBridge | undefined
}

export function registerL1AppSocketRuntime(runtime: L1AppSocketRuntimeBridge): void {
  const previous = globalThis.__piDeskAppSocketRuntimeBridge
  globalThis.__piDeskAppSocketRuntimeBridge = runtime
  if (previous && previous !== runtime) {
    void previous.closeAll(1012, '服务运行时已更新').catch((error: unknown) => {
      console.error('[Pi Desk][AppSocketBridge] 关闭旧运行时失败', {
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
      previous.terminateAll()
    })
  }
}

export function getL1AppSocketRuntimeBridge(): L1AppSocketRuntimeBridge | null {
  return globalThis.__piDeskAppSocketRuntimeBridge ?? null
}
