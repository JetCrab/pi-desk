export interface L1WebAuthRuntimeBridge {
  isAuthenticated: (cookieHeader: string | undefined) => boolean
}

declare global {
  var __piDeskWebAuthRuntimeBridge: L1WebAuthRuntimeBridge | undefined
}

export function registerL1WebAuthRuntime(runtime: L1WebAuthRuntimeBridge): void {
  globalThis.__piDeskWebAuthRuntimeBridge = runtime
}

export function getL1WebAuthRuntimeBridge(): L1WebAuthRuntimeBridge | null {
  return globalThis.__piDeskWebAuthRuntimeBridge ?? null
}
