import type { PluginJsonObject } from '@jetcrab/pi-desk-sdk/browser'
import type { RemoteDebugRun } from './runtime.js'

export function readRuns(value: PluginJsonObject | null): RemoteDebugRun[] {
  if (!value || !Array.isArray(value.runs)) return []
  return value.runs.filter(
    (run) => run && typeof run === 'object' && !Array.isArray(run) && typeof run.runId === 'string'
  ) as unknown as RemoteDebugRun[]
}
