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
  const connections = new Map<string, { handle: TunnelHandle | null; unsubscribe: () => void }>()
  const listeners = new Set<() => void>()
  const closing = new Set<Promise<void>>()
  let snapshots = new Map<string, RemoteDebugTunnelSnapshot>()
  let disposed = false

  function changed(): void {
    for (const listener of listeners) listener()
  }

  function close(handle: TunnelHandle | null): void {
    const pending = Promise.resolve()
      .then(() => handle?.close())
      .catch((error: unknown) => {
        console.warn('[pi-desk-remote-debug] 关闭本地映射失败：', error)
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
      close(connection.handle)
      changed()
    }
    const tunnels = host.tunnels
    if (!tunnels) return
    for (const run of readyRuns) {
      if (connections.has(run.runId)) continue
      try {
        const handle = tunnels.open({ remotePort: run.gatewayPort! })
        const update = (): void => {
          if (disposed || !connections.has(run.runId)) return
          snapshots = new Map(snapshots).set(run.runId, handle.getSnapshot())
          changed()
        }
        const connection = { handle, unsubscribe: (): void => undefined }
        connections.set(run.runId, connection)
        connection.unsubscribe = handle.subscribe(update)
        update()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[pi-desk-remote-debug] 创建本地映射失败：', error)
        connections.set(run.runId, { handle: null, unsubscribe: (): void => undefined })
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
      unsubscribeState()
      listeners.clear()
      for (const connection of connections.values()) {
        connection.unsubscribe()
        close(connection.handle)
      }
      connections.clear()
      snapshots = new Map()
      await Promise.all(closing)
    }
  }
}
