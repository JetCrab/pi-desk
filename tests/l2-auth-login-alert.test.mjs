import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

const testRoot = join(process.cwd(), 'temp/tests/auth-alerts', `login-failures-${process.pid}`)
const agentDir = join(testRoot, 'agent')
const password = 'Test-only password 42!'
let auth
let login
let app
let notifications
let passwordHash
let events

before(async () => {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  await writeFile(
    join(agentDir, 'pi-desk-settings.json'),
    JSON.stringify({ region: { locale: 'zh-CN', timeZone: 'UTC' } })
  )
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === '@earendil-works/pi-coding-agent') return { getAgentDir: () => agentDir }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    const authModule = await import('../src/server/l4_foundation/auth/l4-auth-config.ts')
    const loginModule = await import('../src/server/l2_biz/auth/l2-auth.ts')
    const appModule = await import('../src/server/l3_modules/app-runtime/l3-app-runtime.ts')
    const notificationsModule =
      await import('../src/server/l3_modules/app-runtime/l3-app-notification-runtime.ts')
    auth = authModule.default ?? authModule
    login = loginModule.default ?? loginModule
    app = appModule.default ?? appModule
    notifications = notificationsModule.default ?? notificationsModule
  } finally {
    Module._load = originalLoad
  }
  passwordHash = await auth.hashL4AuthPassword(password)
})

beforeEach(() => {
  notifications.disposeL3AppNotificationRuntime()
  app.disposeL3AppRuntime()
  auth.writeL4AuthConfig({ passwordHash })
  events = []
  app.getL3AppRuntime().subscribe((event) => {
    if (event.key === 'notifications') events.push(event.update)
  })
})

after(async () => {
  notifications?.disposeL3AppNotificationRuntime()
  app?.disposeL3AppRuntime()
  await rm(testRoot, { recursive: true, force: true })
})

async function fail(count) {
  for (let index = 0; index < count; index += 1) {
    assert.equal(await login.authenticateL2WebLogin({ password: 'wrong-password' }), null)
  }
}

function readNotices() {
  return app.getL3AppRuntime().readSnapshot().notifications
}

test('第6次失败告警，后续失败不新增或重复广播，正确密码不被锁定', async () => {
  await fail(5)
  assert.deepEqual(readNotices(), [])
  assert.equal(events.length, 0)
  await fail(1)
  const [notice] = readNotices()
  assert.equal(notice.title, '登录异常提醒')
  assert.equal(notice.description, '登录已连续失败超过 5 次，请确认是否为本人操作。')
  assert.equal(notice.level, 'warning')
  assert.equal(notice.event, null)
  await fail(8)
  assert.deepEqual(readNotices(), [notice])
  assert.deepEqual(
    events.map((event) => event.type),
    ['add']
  )

  assert.ok(await login.authenticateL2WebLogin({ password }))
  assert.deepEqual(readNotices(), [notice], '成功登录不抹掉用户尚未查看的提醒')
  app.getL3AppRuntime().applyClient({
    key: 'notifications',
    update: { type: 'delete', notificationId: notice.notificationId }
  })
  await fail(5)
  assert.deepEqual(readNotices(), [], '成功登录后重新累计失败次数')
  await fail(1)
  assert.equal(readNotices().length, 1)
  assert.notEqual(readNotices()[0].notificationId, notice.notificationId)
})

test('用户关闭通知后持续失败可重新告警，仍只保留一条', async () => {
  await fail(6)
  const [notice] = readNotices()
  app.getL3AppRuntime().applyClient({
    key: 'notifications',
    update: { type: 'delete', notificationId: notice.notificationId }
  })
  await fail(2)
  assert.equal(readNotices().length, 1)
  assert.notEqual(readNotices()[0].notificationId, notice.notificationId)
  assert.deepEqual(
    events.map((event) => event.type),
    ['add', 'delete', 'add']
  )
})

test('修改或关闭登录保护重置计数，异常配置不算密码失败', async () => {
  const session = await login.authenticateL2WebLogin({ password })
  const cookie = `${session.cookieName}=${session.token}`
  await fail(5)
  await login.replaceL2AuthSettings({ password }, cookie)
  await fail(5)
  assert.deepEqual(readNotices(), [])

  await writeFile(auth.getL4AuthConfigPath(), '{broken')
  await assert.rejects(login.authenticateL2WebLogin({ password }), auth.L4AuthConfigError)
  auth.writeL4AuthConfig(null)
  auth.writeL4AuthConfig({ passwordHash })
  assert.deepEqual(readNotices(), [])
  await fail(1)
  assert.equal(readNotices().length, 1)

  const nextSession = await login.authenticateL2WebLogin({ password })
  await fail(5)
  await login.replaceL2AuthSettings(
    { password: null },
    `${nextSession.cookieName}=${nextSession.token}`
  )
  assert.ok(await login.authenticateL2WebLogin({ password: 'anything' }))
  auth.writeL4AuthConfig({ passwordHash })
  const [notice] = readNotices()
  app.getL3AppRuntime().applyClient({
    key: 'notifications',
    update: { type: 'delete', notificationId: notice.notificationId }
  })
  await fail(5)
  assert.deepEqual(readNotices(), [])
})

test('通知运行态重建后失败计数与告警重新开始', async () => {
  await fail(5)
  notifications.disposeL3AppNotificationRuntime()
  app.disposeL3AppRuntime()
  await fail(5)
  assert.deepEqual(readNotices(), [])
  await fail(1)
  assert.equal(readNotices().length, 1)
})
