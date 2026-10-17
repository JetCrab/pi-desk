import type { PluginPushMessage, PluginSource } from '@jetcrab/pi-desk-sdk/browser'
import type { WorkspaceChangedEvent } from './contract.js'

export type BrowserWorkspaceChangedEvent = WorkspaceChangedEvent & {
  source: PluginSource
}

type Listener = (event: BrowserWorkspaceChangedEvent) => void

const listeners = new Set<Listener>()

export const WORKSPACE_SNAPSHOT_TIMEOUT_MS = 10_000

export async function withWorkspaceSnapshotTimeout<T>(
  request: Promise<T>,
  timeoutMs = WORKSPACE_SNAPSHOT_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`读取工作区超时（${Math.ceil(timeoutMs / 1_000)} 秒）`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function publishWorkspaceChanged(
  message: PluginPushMessage
): BrowserWorkspaceChangedEvent | null {
  if (
    message.pluginName !== 'workspace' ||
    message.event !== 'changed' ||
    message.target.scope !== 'session'
  ) {
    return null
  }

  const workspaceId = message.data.workspaceId
  const summary = message.data.summary
  if (workspaceId !== null && typeof workspaceId !== 'string') return null
  if (summary !== undefined && typeof summary !== 'string') return null

  const event: BrowserWorkspaceChangedEvent = {
    source: message.target.source,
    workspaceId,
    ...(summary ? { summary } : {})
  }
  for (const listener of listeners) listener(event)
  return event
}

export function subscribeWorkspaceChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetWorkspaceBrowserRuntime(): void {
  listeners.clear()
}
