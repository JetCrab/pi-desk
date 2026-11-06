;(() => {
  if (window !== window.top || location.origin !== __ORIGIN__ || window.__PI_DESK_REMINDER__) return
  const platform = '__PLATFORM__'
  if (platform === 'macos' && !window.webkit?.messageHandlers?.piDeskReminder) return

  const lifetime = new AbortController()
  let pending = Promise.resolve()
  window.addEventListener('pagehide', () => lifetime.abort(), { once: true })

  function send(request) {
    return new Promise((resolve, reject) => {
      let finished = false
      const controller = new AbortController()
      const timeout = setTimeout(() => finish(false, '提醒操作超时'), 10_000)
      function finish(ok, value) {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        lifetime.signal.removeEventListener('abort', onAbort)
        controller.abort()
        if (ok) resolve(value)
        else reject(value)
      }
      function onAbort() {
        finish(false, '页面已释放')
      }
      lifetime.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const result =
          platform === 'windows'
            ? fetch('http://pi-desk-reminder.localhost/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: controller.signal
              }).then(async (response) => {
                const value = await response.json()
                if (!response.ok) throw value
                return value
              })
            : window.webkit.messageHandlers.piDeskReminder
                .postMessage(JSON.stringify(request))
                .then(JSON.parse)
        result.then(
          (value) => finish(true, value),
          (error) => finish(false, error)
        )
      } catch (error) {
        finish(false, error)
      }
    })
  }

  Object.defineProperty(window, '__PI_DESK_REMINDER__', {
    value: Object.freeze({
      platform,
      invoke(request) {
        // 同一文档串行提交，确保 clear 不会被此前的 attention 覆盖。
        const result = pending.then(() => {
          if (lifetime.signal.aborted) throw '页面已释放'
          return send(request)
        })
        pending = result.catch(() => undefined)
        return result
      }
    })
  })
  window.dispatchEvent(new Event('pi-desk-reminder-ready'))
})()
