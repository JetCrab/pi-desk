;(() => {
  if (window !== window.top || location.origin !== __ORIGIN__) return
  const nativeDocument = __DOCUMENT__
  if (window.__PI_DESK_TUNNELS__) {
    if (nativeDocument)
      window.dispatchEvent(new CustomEvent('pi-desk-tunnels-document', { detail: nativeDocument }))
    return
  }
  const platform = '__PLATFORM__'
  let documentId = null
  let initialize
  const initialized = new Promise((resolve) => {
    initialize = resolve
  })
  function attach(value) {
    if (documentId || !value) return
    if (platform === 'macos' && !window.webkit?.messageHandlers?.piDeskTunnels) return
    documentId = value
    window.removeEventListener('pi-desk-tunnels-document', onDocument)
    initialize()
    window.dispatchEvent(new Event('pi-desk-tunnels-ready'))
  }
  function onDocument(event) {
    attach(event.detail)
  }
  window.addEventListener('pi-desk-tunnels-document', onDocument)
  const lifetime = new AbortController()

  function send(message, releasing = false) {
    const body = JSON.stringify(message)
    if (platform === 'windows') {
      return fetch('http://pi-desk-tunnels.localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        ...(releasing ? { keepalive: true } : { signal: lifetime.signal })
      }).then(async (response) => {
        const value = await response.json()
        if (!response.ok) throw new Error(String(value))
        return value
      })
    }
    return window.webkit.messageHandlers.piDeskTunnels.postMessage(body).then(JSON.parse)
  }

  window.addEventListener(
    'pagehide',
    () => {
      lifetime.abort()
      window.removeEventListener('pi-desk-tunnels-document', onDocument)
      if (documentId) send({ kind: 'release', document: documentId }, true).catch(() => undefined)
    },
    { once: true }
  )

  Object.defineProperty(window, '__PI_DESK_TUNNELS__', {
    value: Object.freeze({
      invoke(request) {
        if (lifetime.signal.aborted) return Promise.reject(new Error('页面已释放'))
        return new Promise((resolve, reject) => {
          let finished = false
          const timer = setTimeout(() => finish(false, new Error('客户端映射操作超时')), 35_000)
          function finish(ok, value) {
            if (finished) return
            finished = true
            clearTimeout(timer)
            lifetime.signal.removeEventListener('abort', onAbort)
            if (ok) resolve(value)
            else reject(value)
          }
          const onAbort = () => finish(false, new Error('页面已释放'))
          lifetime.signal.addEventListener('abort', onAbort, { once: true })
          initialized
            .then(() => {
              if (finished || lifetime.signal.aborted) throw new Error('页面已释放或请求已结束')
              return send({ kind: 'invoke', document: documentId, request })
            })
            .then(
              (value) => finish(true, value),
              (error) => finish(false, error)
            )
        })
      }
    })
  })
  attach(nativeDocument)
})()
