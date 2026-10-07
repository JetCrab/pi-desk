'use client'

const VERSION_CHECK_TIMEOUT_MS = 5_000

export function createL2WorkbenchVersionRefresh(
  currentVersion: string,
  readServerVersion: (signal: AbortSignal) => Promise<string | null>,
  reload: () => void
): (openedNewConnection: boolean, signal: AbortSignal, closed: Promise<unknown>) => Promise<void> {
  let hasConnected = false
  let activeCheck: AbortController | null = null
  let reloading = false

  return async (openedNewConnection, signal, closed): Promise<void> => {
    if (signal.aborted) return
    const reconnected = hasConnected && openedNewConnection
    hasConnected = true
    if (!reconnected || reloading) return
    activeCheck?.abort()

    const check = new AbortController()
    activeCheck = check
    const abort = (): void => check.abort()
    signal.addEventListener('abort', abort, { once: true })
    // 检查只属于本次连接，断线或页面卸载后不得用迟到响应刷新页面。
    void closed.then(abort, abort)
    const timeout = setTimeout(abort, VERSION_CHECK_TIMEOUT_MS)
    try {
      const serverVersion = await readServerVersion(check.signal)
      if (check.signal.aborted || !serverVersion || serverVersion === currentVersion || reloading) {
        return
      }
      reloading = true
      reload()
    } catch (cause) {
      if (!check.signal.aborted) {
        console.warn('[Pi Desk][VersionRefresh] 重连版本检查失败，保留当前页面', {
          message: cause instanceof Error ? cause.message : String(cause)
        })
      }
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (activeCheck === check) activeCheck = null
    }
  }
}
