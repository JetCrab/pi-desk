import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(
  new URL('../apps/desktop/src-tauri/src/tunnels.js', import.meta.url),
  'utf8'
)
const origin = 'http://desktop.example.test'
const flush = () => new Promise((resolve) => setImmediate(resolve))

function fixture(platform = 'windows') {
  const window = new EventTarget()
  window.top = window
  const calls = []
  const timers = new Set()
  const respond = async (message) => {
    calls.push(JSON.parse(message))
    return { ready: true, error: null }
  }
  window.webkit = {
    messageHandlers: {
      piDeskTunnels: { postMessage: async (message) => JSON.stringify(await respond(message)) }
    }
  }
  const context = vm.createContext({
    window,
    location: { origin },
    Event,
    CustomEvent,
    AbortController,
    setTimeout(callback) {
      timers.add(callback)
      return callback
    },
    clearTimeout(callback) {
      timers.delete(callback)
    },
    fetch: async (_url, options) => ({ ok: true, json: async () => respond(options.body) })
  })
  const inject = (document) =>
    vm.runInContext(
      source
        .replaceAll('__PLATFORM__', platform)
        .replaceAll('__ORIGIN__', JSON.stringify(origin))
        .replaceAll('__DOCUMENT__', JSON.stringify(document)),
      context
    )
  inject(null)
  return { window, calls, timers, inject }
}

for (const platform of ['windows', 'macos']) {
  test(`${platform}桥接等待原生文档就绪，导航释放后拒绝旧调用`, async () => {
    const f = fixture(platform)
    const pending = f.window.__PI_DESK_TUNNELS__.invoke({ action: 'status' })
    await flush()
    assert.equal(f.calls.length, 0)
    f.inject('native-document')
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { ready: true, error: null })
    assert.deepEqual(f.calls[0], {
      kind: 'invoke',
      document: 'native-document',
      request: { action: 'status' }
    })
    assert.equal(f.timers.size, 0)
    f.window.dispatchEvent(new Event('pagehide'))
    await flush()
    assert.deepEqual(f.calls[1], { kind: 'release', document: 'native-document' })
    await assert.rejects(f.window.__PI_DESK_TUNNELS__.invoke({ action: 'status' }), /页面已释放/)
    assert.equal(f.calls.length, 2)
  })
}

test('macos原生handler晚安装时，补注入当前文档后才接纳排队请求', async () => {
  const f = fixture('macos')
  const handler = f.window.webkit.messageHandlers.piDeskTunnels
  delete f.window.webkit.messageHandlers.piDeskTunnels
  const pending = f.window.__PI_DESK_TUNNELS__.invoke({ action: 'status' })
  f.inject('ready-document')
  await flush()
  assert.equal(f.calls.length, 0)
  f.window.webkit.messageHandlers.piDeskTunnels = handler
  f.inject('ready-document')
  await pending
  assert.deepEqual(f.calls, [
    {
      kind: 'invoke',
      document: 'ready-document',
      request: { action: 'status' }
    }
  ])
  assert.equal(f.timers.size, 0)
  f.window.dispatchEvent(new Event('pagehide'))
})

test('映射脚本不向其他来源或子框架注入能力', () => {
  for (const kind of ['origin', 'frame']) {
    const window = new EventTarget()
    window.top = kind === 'frame' ? {} : window
    const context = {
      window,
      location: { origin: kind === 'origin' ? 'http://other.example.test' : origin }
    }
    vm.runInNewContext(
      source
        .replaceAll('__PLATFORM__', 'windows')
        .replaceAll('__ORIGIN__', JSON.stringify(origin))
        .replaceAll('__DOCUMENT__', 'null'),
      context
    )
    assert.equal(window.__PI_DESK_TUNNELS__, undefined)
  }
})

test('原生初始化超时不会在迟到注入时发送已结束的请求', async () => {
  const f = fixture()
  const pending = f.window.__PI_DESK_TUNNELS__.invoke({ action: 'status' })
  const rejected = assert.rejects(pending, /操作超时/)
  for (const timer of [...f.timers]) timer()
  await rejected
  f.inject('late-document')
  await flush()
  assert.equal(f.calls.length, 0)
  assert.equal(f.timers.size, 0)
})
