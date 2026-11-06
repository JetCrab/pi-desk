import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const desktopScript = await readFile(
  new URL('../apps/desktop/src-tauri/src/reminder.js', import.meta.url),
  'utf8'
)
const androidScript = await readFile(
  new URL('../apps/android/app/src/main/assets/reminder.js', import.meta.url),
  'utf8'
)
const origin = 'https://example.test'
const flush = () => new Promise((resolve) => setImmediate(resolve))

function environment() {
  const window = new EventTarget()
  window.top = window
  const timers = new Map()
  let nextTimer = 0
  const context = {
    window,
    location: { origin },
    Event,
    AbortController,
    setTimeout(callback, milliseconds) {
      const id = ++nextTimer
      timers.set(id, { callback, milliseconds })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    }
  }
  return { window, timers, context }
}

function desktop(platform = 'windows') {
  const f = environment()
  const calls = []
  const replies = []
  const respond = (input) => {
    calls.push(input)
    return new Promise((resolve, reject) => replies.push({ resolve, reject }))
  }
  f.context.fetch = async (url, options) => {
    assert.equal(url, 'http://pi-desk-reminder.localhost/')
    assert.equal(options.method, 'POST')
    const value = await respond(JSON.parse(options.body))
    return { ok: true, json: async () => value }
  }
  f.window.webkit = {
    messageHandlers: {
      piDeskReminder: {
        postMessage: async (value) => JSON.stringify(await respond(JSON.parse(value)))
      }
    }
  }
  vm.runInNewContext(
    desktopScript
      .replaceAll('__PLATFORM__', platform)
      .replaceAll('__ORIGIN__', JSON.stringify(origin)),
    f.context
  )
  return { ...f, calls, replies, bridge: f.window.__PI_DESK_REMINDER__ }
}

for (const platform of ['windows', 'macos']) {
  test(`${platform}原生提醒按文档生命周期串行，失败不阻断清除`, async () => {
    const f = desktop(platform)
    assert.equal(Object.isFrozen(f.bridge), true)
    assert.equal(f.bridge.platform, platform)
    const permission = f.bridge.invoke({ action: 'permission', request: false })
    const notice = f.bridge.invoke({ action: 'notify', title: '完成', body: '会话' })
    const noticeRejected = assert.rejects(notice, (error) => error === '系统拒绝')
    const clear = f.bridge.invoke({ action: 'clear' })
    await flush()
    assert.deepEqual(f.calls, [{ action: 'permission', request: false }])
    f.replies[0].resolve('granted')
    assert.equal(await permission, 'granted')
    await flush()
    f.replies[1].reject('系统拒绝')
    await noticeRejected
    await flush()
    assert.deepEqual(f.calls.at(-1), { action: 'clear' })
    f.replies[2].resolve(null)
    assert.equal(await clear, null)
    assert.equal(f.timers.size, 0)
  })

  test(`${platform}导航释放在途和排队提醒，迟到回包不能恢复旧页面`, async () => {
    const f = desktop(platform)
    const first = f.bridge.invoke({ action: 'attention' })
    const firstRejected = assert.rejects(first, (error) => error === '页面已释放')
    const next = f.bridge.invoke({ action: 'notify', title: '完成', body: '' })
    const nextRejected = assert.rejects(next, (error) => error === '页面已释放')
    await flush()
    f.window.dispatchEvent(new Event('pagehide'))
    await Promise.all([firstRejected, nextRejected])
    f.replies[0].resolve(null)
    await flush()
    assert.equal(f.calls.length, 1)
    assert.equal(f.timers.size, 0)
  })
}

test('桌面提醒超时后队列继续，迟到回包不重复完成', async () => {
  const f = desktop()
  const first = f.bridge.invoke({ action: 'attention' })
  const rejected = assert.rejects(first, (error) => error === '提醒操作超时')
  const next = f.bridge.invoke({ action: 'clear' })
  await flush()
  const timer = [...f.timers.entries()][0]
  f.timers.delete(timer[0])
  timer[1].callback()
  await rejected
  await flush()
  assert.deepEqual(f.calls, [{ action: 'attention' }, { action: 'clear' }])
  f.replies[0].resolve(null)
  f.replies[1].resolve(null)
  await next
  assert.equal(f.timers.size, 0)
})

test('桌面提醒脚本不向子框架或其他来源注入能力', () => {
  for (const kind of ['frame', 'origin']) {
    const f = environment()
    if (kind === 'frame') f.window.top = {}
    else f.context.location.origin = 'https://other.test'
    vm.runInNewContext(
      desktopScript
        .replaceAll('__PLATFORM__', 'windows')
        .replaceAll('__ORIGIN__', JSON.stringify(origin)),
      f.context
    )
    assert.equal(f.window.__PI_DESK_REMINDER__, undefined)
  }
})

function android() {
  const f = environment()
  const sent = []
  const port = {
    closed: false,
    onmessage: null,
    postMessage(value) {
      sent.push(JSON.parse(value))
    },
    start() {},
    close() {
      this.closed = true
    }
  }
  const token = 'document-token'
  const accepted = vm.runInNewContext(
    androidScript
      .replaceAll('__PI_DESK_ORIGIN__', JSON.stringify(origin))
      .replaceAll('__PI_DESK_TOKEN__', JSON.stringify(token)),
    f.context
  )
  assert.equal(accepted, true)
  const connect = (value = token) =>
    f.window.dispatchEvent(Object.assign(new Event('message'), { data: value, ports: [port] }))
  const reply = (id, result, error) =>
    port.onmessage({ data: JSON.stringify({ id, result, ...(error ? { error } : {}) }) })
  return { ...f, port, token, sent, connect, reply }
}

test('安卓只有正确主文档握手后提供能力，权限与通知各自按请求返回', async () => {
  const f = android()
  f.connect('wrong-token')
  assert.equal(f.window.__PI_DESK_REMINDER__, undefined)
  f.connect()
  const bridge = f.window.__PI_DESK_REMINDER__
  assert.equal(Object.isFrozen(bridge), true)
  assert.equal(bridge.platform, 'android')
  const permission = bridge.invoke({ action: 'permission', request: true })
  const notify = bridge.invoke({ action: 'notify', title: '完成', body: '会话' })
  assert.deepEqual(
    f.sent.map((message) => message.request.action),
    ['permission', 'notify']
  )
  f.reply(f.sent[1].id, null)
  assert.equal(await notify, null)
  f.reply(f.sent[0].id, 'denied')
  assert.equal(await permission, 'denied')
  assert.equal(f.timers.size, 0)
  f.window.dispatchEvent(new Event('pagehide'))
  assert.equal(f.port.closed, true)
  assert.equal(f.window.__PI_DESK_REMINDER__, undefined)
})

test('安卓页面释放拒绝在途调用并取消计时器，旧桥不能继续发送', async () => {
  const f = android()
  f.connect()
  const bridge = f.window.__PI_DESK_REMINDER__
  const result = bridge.invoke({ action: 'permission', request: true })
  const rejected = assert.rejects(result, /连接已关闭/)
  f.window.dispatchEvent(new Event(`pi-desk-reminder-dispose-${f.token}`))
  await rejected
  await assert.rejects(bridge.invoke({ action: 'notify', title: '旧页面', body: '' }), /连接不可用/)
  assert.equal(f.sent.length, 1)
  assert.equal(f.timers.size, 0)
  assert.equal(f.port.closed, true)
})

test('安卓请求超时释放pending，通道仍可处理下一次通知', async () => {
  const f = android()
  f.connect()
  const bridge = f.window.__PI_DESK_REMINDER__
  const result = bridge.invoke({ action: 'permission', request: true })
  const rejected = assert.rejects(result, /请求超时/)
  const timer = [...f.timers.entries()][0]
  f.timers.delete(timer[0])
  timer[1].callback()
  await rejected
  f.reply(f.sent[0].id, 'granted')
  const next = bridge.invoke({ action: 'notify', title: '完成', body: '' })
  f.reply(f.sent[1].id, null)
  assert.equal(await next, null)
  assert.equal(f.timers.size, 0)
  f.window.dispatchEvent(new Event('pagehide'))
})

test('安卓拒绝向其他来源或子框架注入通知桥', () => {
  for (const kind of ['frame', 'origin']) {
    const f = environment()
    if (kind === 'frame') f.window.top = {}
    else f.context.location.origin = 'https://other.test'
    const accepted = vm.runInNewContext(
      androidScript
        .replaceAll('__PI_DESK_ORIGIN__', JSON.stringify(origin))
        .replaceAll('__PI_DESK_TOKEN__', '"token"'),
      f.context
    )
    assert.equal(accepted, false)
    assert.equal(f.window.__PI_DESK_REMINDER__, undefined)
    assert.equal(f.timers.size, 0)
  }
})
