;(() => {
  const origin = __PI_DESK_ORIGIN__
  const token = __PI_DESK_TOKEN__
  if (window !== window.top || location.origin !== origin) {
    return false
  }

  let port
  let bridge
  let sequence = 0
  const pending = new Map()
  const disposeEvent = `pi-desk-reminder-dispose-${token}`
  const connectTimeout = setTimeout(dispose, 10000)

  function dispose() {
    clearTimeout(connectTimeout)
    window.removeEventListener('message', connect)
    window.removeEventListener('pagehide', dispose)
    window.removeEventListener(disposeEvent, dispose)
    if (window.__PI_DESK_REMINDER__ === bridge) {
      delete window.__PI_DESK_REMINDER__
    }
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout)
      entry.reject(new Error('安卓提醒连接已关闭'))
    }
    pending.clear()
    if (port) {
      port.close()
      port = null
    }
  }

  function invoke(request) {
    if (!port || pending.size >= 32) {
      return Promise.reject(new Error('安卓提醒连接不可用'))
    }
    return new Promise((resolve, reject) => {
      const id = String(++sequence)
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error('安卓提醒请求超时'))
      }, 60000)
      pending.set(id, { resolve, reject, timeout })
      try {
        const message = JSON.stringify({ id, request })
        if (message.length > 16384) {
          throw new Error('安卓提醒内容过长')
        }
        port.postMessage(message)
      } catch (error) {
        clearTimeout(timeout)
        pending.delete(id)
        reject(error)
      }
    })
  }

  function connect(event) {
    // 原生 postWebMessage 不提供网页来源；随机令牌仅注入配置同源的主 frame。
    if (event.data !== token || event.ports.length !== 1) {
      return
    }
    window.removeEventListener('message', connect)
    clearTimeout(connectTimeout)
    port = event.ports[0]
    port.onmessage = (event) => {
      const response = JSON.parse(event.data)
      const entry = pending.get(response.id)
      if (!entry) {
        return
      }
      pending.delete(response.id)
      clearTimeout(entry.timeout)
      if (response.error) {
        entry.reject(new Error(response.error))
      } else {
        entry.resolve(response.result)
      }
    }
    port.start()
    bridge = Object.freeze({ platform: 'android', invoke })
    window.__PI_DESK_REMINDER__ = bridge
    window.dispatchEvent(new Event('pi-desk-reminder-ready'))
  }

  window.addEventListener('message', connect)
  window.addEventListener('pagehide', dispose)
  window.addEventListener(disposeEvent, dispose)
  return true
})()
