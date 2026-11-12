import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import { readRuns } from './l4-browser-runs.js'

type TunnelHandle = ReturnType<NonNullable<BrowserPluginHost['tunnels']>['open']>
export type RemoteDebugTunnelSnapshot = ReturnType<TunnelHandle['getSnapshot']>

export interface RemoteDebugBrowserTunnels {
  getSnapshot(): ReadonlyMap<string, RemoteDebugTunnelSnapshot>
  subscribe(listener: () => void): () => void
  sync(): void
  dispose(): Promise<void>
}

export function createRemoteDebugBrowserTunnels(
  host: BrowserPluginHost
): RemoteDebugBrowserTunnels {
  const connections = new Map<
    string,
    { handle: TunnelHandle | null; unsubscribe: () => void; context: string }
  >()
  const listeners = new Set<() => void>()
  const closing = new Set<Promise<void>>()
  let snapshots = new Map<string, RemoteDebugTunnelSnapshot>()
  let disposed = false

  function changed(): void {
    for (const listener of listeners) listener()
  }

  function log(message: string): void {
    console.info(`[${new Date().toISOString()}] [pi-desk-remote-debug] ${message}`)
  }

  function close(handle: TunnelHandle | null, context: string, reason: string): void {
    if (!handle) return
    log(`关闭本地映射 reason=${reason} ${context}`)
    const pending = Promise.resolve()
      .then(async () => {
        await handle.close()
        log(`本地映射已关闭 ${context}`)
      })
      .catch((error: unknown) => {
        console.warn(
          `[${new Date().toISOString()}] [pi-desk-remote-debug] 关闭本地映射失败 ${context} reason=${reason}：`,
          error
        )
      })
      .finally(() => closing.delete(pending))
    closing.add(pending)
  }

  function reconcile(): void {
    if (disposed) return
    const runs = readRuns(host.globalState.getSnapshot())
    const readyRuns = runs.filter((run) => run.status === 'running' && run.gatewayPort)
    const readyIds = new Set(readyRuns.map((run) => run.runId))
    for (const [runId, connection] of connections) {
      if (readyIds.has(runId)) continue
      connection.unsubscribe()
      connections.delete(runId)
      snapshots = new Map(snapshots)
      snapshots.delete(runId)
      close(connection.handle, connection.context, 'Run结束或已不再运行')
      changed()
    }
    const tunnels = host.tunnels
    if (!tunnels) return
    for (const run of readyRuns) {
      if (connections.has(run.runId)) continue
      const context = JSON.stringify({
        runId: run.runId,
        profile: run.profile,
        cwd: run.cwd,
        gatewayPort: run.gatewayPort
      })
      log(`申请本地映射 ${context}`)
      try {
        const handle = tunnels.open({ remotePort: run.gatewayPort! })
        let lastLoggedSnapshot: string | null = null
        const update = (): void => {
          if (disposed || !connections.has(run.runId)) return
          const snapshot = handle.getSnapshot()
          const serialized = JSON.stringify(snapshot)
          if (serialized !== lastLoggedSnapshot) {
            log(`本地映射状态 ${context} ${serialized}`)
            lastLoggedSnapshot = serialized
          }
          snapshots = new Map(snapshots).set(run.runId, snapshot)
          changed()
        }
        const connection = { handle, unsubscribe: (): void => undefined, context }
        connections.set(run.runId, connection)
        connection.unsubscribe = handle.subscribe(update)
        update()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          `[${new Date().toISOString()}] [pi-desk-remote-debug] 创建本地映射失败 ${context}：`,
          error
        )
        connections.set(run.runId, { handle: null, unsubscribe: (): void => undefined, context })
        snapshots = new Map(snapshots).set(run.runId, {
          status: 'failed',
          localPort: null,
          path: null,
          error: message
        })
        changed()
      }
    }
  }

  const unsubscribeState = host.globalState.subscribe(reconcile)
  reconcile()
  return {
    getSnapshot: () => snapshots,
    subscribe(listener): () => void {
      listeners.add(listener)
      return (): void => {
        listeners.delete(listener)
      }
    },
    sync: reconcile,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      log(`Browser Owner 释放 mappings=${connections.size}`)
      unsubscribeState()
      listeners.clear()
      for (const connection of connections.values()) {
        connection.unsubscribe()
        close(connection.handle, connection.context, 'Browser Owner释放')
      }
      connections.clear()
      snapshots = new Map()
      await Promise.all(closing)
    }
  }
}
