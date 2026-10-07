export interface RemoteDebugBrowserEvents {
  subscribe(listener: () => void): () => void
  changed(): void
  dispose(): void
}

export function createRemoteDebugBrowserEvents(): RemoteDebugBrowserEvents {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener): () => void {
      listeners.add(listener)
      return (): void => {
        listeners.delete(listener)
      }
    },
    changed(): void {
      for (const listener of listeners) listener()
    },
    dispose(): void {
      listeners.clear()
    }
  }
}
