;(() => {
  if (window !== window.top || !window.chrome?.webview) return

  const lifetime = new AbortController()
  let pending = Promise.resolve()
  window.addEventListener('pagehide', () => lifetime.abort(), { once: true })

  Object.defineProperty(window, '__PI_DESK_WINDOW__', {
    value: Object.freeze({
      invoke(action) {
        // 挂载、释放和按钮动作串行；导航由浏览器中止原文档请求。
        const result = pending.then(async () => {
          if (lifetime.signal.aborted) throw '页面已释放'
          try {
            const response = await fetch('http://pi-desk-window.localhost/', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action }),
              signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])
            })
            const value = await response.json()
            if (!response.ok) throw value
            return value
          } catch (error) {
            if (lifetime.signal.aborted) throw '页面已释放'
            if (error?.name === 'TimeoutError') throw '窗口操作超时'
            throw error
          }
        })
        pending = result.catch(() => undefined)
        return result
      }
    })
  })
})()
