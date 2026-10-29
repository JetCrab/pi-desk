import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const script = await readFile(
  new URL('../apps/desktop/src-tauri/src/window-chrome.js', import.meta.url),
  'utf8'
)

function fixture() {
  const sent = []
  const requests = []
  const pageListeners = new Map()
  const timeouts = []
  const window = {
    chrome: { webview: {} },
    addEventListener(name, listener) {
      pageListeners.set(name, listener)
    }
  }
  window.top = window
  vm.runInNewContext(script, {
    window,
    AbortController,
    AbortSignal: {
      any: AbortSignal.any.bind(AbortSignal),
      timeout(delay) {
        assert.equal(delay, 10_000)
        const controller = new AbortController()
        timeouts.push(controller)
        return controller.signal
      }
    },
    fetch(url, options) {
      assert.equal(url, 'http://pi-desk-window.localhost/')
      assert.equal(options.method, 'POST')
      assert.equal(options.headers['Content-Type'], 'application/json')
      sent.push(JSON.parse(options.body))
      return new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason)
        options.signal.addEventListener('abort', abort, { once: true })
        requests.push((value, status = 200) => {
          options.signal.removeEventListener('abort', abort)
          resolve({ ok: status < 400, json: async () => value })
        })
      })
    }
  })
  return { window, sent, requests, timeouts, pagehide: () => pageListeners.get('pagehide')() }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('窗口挂载、释放和再次挂载串行，错误响应不阻断后续动作', async () => {
  const f = fixture()
  const bridge = f.window.__PI_DESK_WINDOW__
  assert.equal(Object.isFrozen(bridge), true)
  const first = bridge.invoke('attach')
  const cleanup = bridge.invoke('detach')
  const last = bridge.invoke('attach')
  await flush()
  assert.deepEqual(f.sent, [{ action: 'attach' }])
  f.requests[0]({ maximized: false })
  await first
  await flush()
  assert.deepEqual(f.sent, [{ action: 'attach' }, { action: 'detach' }])
  const rejected = assert.rejects(cleanup, (error) => error === '操作失败')
  f.requests[1]('操作失败', 500)
  await rejected
  await flush()
  assert.deepEqual(f.sent, [{ action: 'attach' }, { action: 'detach' }, { action: 'attach' }])
  f.requests[2]({ maximized: true })
  assert.deepEqual(await last, { maximized: true })
})

test('页面释放取消在途和排队请求，旧结果不能污染新文档', async () => {
  const old = fixture()
  const first = old.window.__PI_DESK_WINDOW__.invoke('attach')
  const next = old.window.__PI_DESK_WINDOW__.invoke('detach')
  const firstRejected = assert.rejects(first, (error) => error === '页面已释放')
  const nextRejected = assert.rejects(next, (error) => error === '页面已释放')
  await flush()
  old.pagehide()
  await Promise.all([firstRejected, nextRejected])
  assert.equal(old.sent.length, 1)
  const current = fixture()
  const request = current.window.__PI_DESK_WINDOW__.invoke('attach')
  await flush()
  old.requests[0]({ maximized: true })
  current.requests[0]({ maximized: false })
  assert.deepEqual(await request, { maximized: false })
})

test('原生未响应时请求有界，后续恢复动作仍可执行', async () => {
  const f = fixture()
  const first = f.window.__PI_DESK_WINDOW__.invoke('attach')
  const rejected = assert.rejects(first, (error) => error === '窗口操作超时')
  const next = f.window.__PI_DESK_WINDOW__.invoke('detach')
  await flush()
  f.timeouts[0].abort(new DOMException('超时', 'TimeoutError'))
  await rejected
  await flush()
  assert.deepEqual(f.sent, [{ action: 'attach' }, { action: 'detach' }])
  f.requests[1]({ maximized: false })
  await next
})

test('原生拒绝未知动作后仍可查询状态', async () => {
  const f = fixture()
  const invalid = f.window.__PI_DESK_WINDOW__.invoke('destroy')
  const rejected = assert.rejects(invalid, (error) => error === '不支持的窗口操作')
  const valid = f.window.__PI_DESK_WINDOW__.invoke('state')
  await flush()
  f.requests[0]('不支持的窗口操作', 400)
  await rejected
  await flush()
  f.requests[1]({ maximized: false })
  await valid
})

test('普通浏览器和子框架不注入窗口通道', () => {
  const browser = {}
  browser.top = browser
  vm.runInNewContext(script, { window: browser })
  assert.equal(browser.__PI_DESK_WINDOW__, undefined)
  const frame = { top: {}, chrome: { webview: {} } }
  vm.runInNewContext(script, { window: frame })
  assert.equal(frame.__PI_DESK_WINDOW__, undefined)
})
