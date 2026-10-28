;(() => {
  let pending = Promise.resolve()
  Object.defineProperty(window, '__PI_DESK_WINDOW__', {
    value: Object.freeze({
      invoke(action) {
        // 同一文档的挂载、释放和按钮动作按调用顺序完成。
        const result = pending.then(() =>
          window.__TAURI_INTERNALS__.invoke('plugin:window-chrome|bridge', { action })
        )
        pending = result.catch(() => undefined)
        return result
      }
    })
  })
})()
