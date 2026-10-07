const PLUGIN_DISPOSE_TIMEOUT_MS = 1_500

export function runL4PluginCallback(
  callback: () => unknown,
  phase: string,
  pluginName?: string
): void {
  const onError = (cause: unknown): void => {
    console.error('[Pi Desk][PluginHost] 插件回调执行失败', {
      pluginName,
      phase,
      message: cause instanceof Error ? cause.message : String(cause)
    })
  }
  try {
    const result = callback()
    if (
      typeof result === 'object' &&
      result !== null &&
      'then' in result &&
      typeof result.then === 'function'
    ) {
      void Promise.resolve(result).catch(onError)
    }
  } catch (cause) {
    onError(cause)
  }
}

export async function disposeL4PluginResource(
  pluginName: string,
  phase: string,
  dispose: () => void | Promise<void>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const execution = Promise.resolve()
    .then(dispose)
    .catch((cause: unknown) => {
      console.error('[Pi Desk][PluginHost] 插件资源清理失败', {
        pluginName,
        phase,
        message: cause instanceof Error ? cause.message : String(cause)
      })
    })
  try {
    await Promise.race([
      execution,
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(() => {
          console.warn('[Pi Desk][PluginHost] 插件资源清理超时', {
            pluginName,
            phase,
            timeoutMs: PLUGIN_DISPOSE_TIMEOUT_MS
          })
          resolveTimeout()
        }, PLUGIN_DISPOSE_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
