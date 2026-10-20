import { useRef, useState } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import type {
  RemoteDebugPortConflict,
  RemoteDebugStartResult
} from '../l4-remote-debug-contract.js'
import type { RemoteDebugRun } from '../runtime.js'
import { errorMessage, restartProfile, startProfile } from '../l2-browser-biz.js'

interface PortConfirmation {
  cwd: string
  profile: string
  conflicts: RemoteDebugPortConflict[]
}

export function useProfileStart(
  host: BrowserPluginHost,
  signal: AbortSignal
): {
  confirmation: PortConfirmation | null
  pending: boolean
  error: string | null
  start(cwd: string, profile: string): Promise<void>
  restart(run: RemoteDebugRun): Promise<void>
  confirm(): Promise<void>
  cancel(): void
} {
  const [confirmation, setConfirmation] = useState<PortConfirmation | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirming = useRef(false)

  function acceptResult(cwd: string, profile: string, result: RemoteDebugStartResult): void {
    if (signal.aborted) return
    setConfirmation('conflicts' in result ? { cwd, profile, conflicts: result.conflicts } : null)
    setError(null)
  }

  async function start(cwd: string, profile: string): Promise<void> {
    acceptResult(cwd, profile, await startProfile(host, cwd, profile))
  }

  async function restart(run: RemoteDebugRun): Promise<void> {
    acceptResult(run.cwd, run.profile, await restartProfile(host, run))
  }

  async function confirm(): Promise<void> {
    if (!confirmation || signal.aborted || confirming.current) return
    confirming.current = true
    setPending(true)
    setError(null)
    try {
      const { cwd, profile, conflicts } = confirmation
      const result = await startProfile(
        host,
        cwd,
        profile,
        conflicts.map(({ port, pid }) => ({ port, pid }))
      )
      acceptResult(cwd, profile, result)
      if (!signal.aborted && 'conflicts' in result) {
        setError('端口占用进程已变化，请核对后重新确认。')
      }
    } catch (cause) {
      if (!signal.aborted) setError(errorMessage(cause))
    } finally {
      confirming.current = false
      if (!signal.aborted) setPending(false)
    }
  }

  function cancel(): void {
    if (confirming.current) return
    setConfirmation(null)
    setError(null)
  }

  return { confirmation, pending, error, start, restart, confirm, cancel }
}
