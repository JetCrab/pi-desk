import { useRef, useState } from 'react'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import { errorMessage } from '../l2-browser-biz.js'

export function useProfileActions(
  host: BrowserPluginHost,
  signal: AbortSignal
): {
  pending: ReadonlyMap<string, string>
  action(profileKey: string, key: string, execute: () => Promise<void>): Promise<void>
} {
  const running = useRef(new Map<string, string>())
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(() => new Map())

  async function action(
    profileKey: string,
    key: string,
    execute: () => Promise<void>
  ): Promise<void> {
    if (signal.aborted || running.current.has(profileKey)) return
    running.current.set(profileKey, key)
    setPending(new Map(running.current))
    try {
      await execute()
    } catch (cause) {
      if (!signal.aborted)
        host.notify({ level: 'error', title: '远程调试操作失败', description: errorMessage(cause) })
    } finally {
      running.current.delete(profileKey)
      if (!signal.aborted) setPending(new Map(running.current))
    }
  }

  return { pending, action }
}
