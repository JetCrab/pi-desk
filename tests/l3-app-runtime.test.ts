import assert from 'node:assert/strict'
import test from 'node:test'
import { L3AppNotificationRuntime } from '../src/server/l3_modules/app-runtime/l3-app-notification-runtime'
import { L3AppPluginStateRuntime } from '../src/server/l3_modules/app-runtime/l3-app-plugin-state-runtime'
import {
  L3AppRuntime,
  L3AppRuntimeTargetNotFoundError
} from '../src/server/l3_modules/app-runtime/l3-app-runtime'

function createRuntimes(context: test.TestContext) {
  const appRuntime = new L3AppRuntime()
  const notifications = new L3AppNotificationRuntime(appRuntime)
  const plugins = new L3AppPluginStateRuntime(appRuntime)
  context.after(() => {
    notifications.dispose()
    plugins.dispose()
    appRuntime.dispose()
  })
  return { appRuntime, notifications, plugins }
}

test('插件状态整体替换、删除并广播类型化增量', (context) => {
  const { appRuntime, plugins } = createRuntimes(context)
  const events: unknown[] = []
  appRuntime.subscribe((event) => events.push(event))

  plugins.setState('fixture-plugin', { status: 'ready', stale: true })
  plugins.setState('fixture-plugin', { status: 'running' })
  plugins.setState('fixture-plugin', null)

  assert.deepEqual(appRuntime.readSnapshot().plugins, {})
  assert.throws(() => plugins.setState('fixture-plugin', { value: 'x'.repeat(70 * 1024) }), /64KB/)
  assert.deepEqual(events, [
    {
      type: 'update',
      key: 'plugins',
      update: {
        pluginName: 'fixture-plugin',
        state: { status: 'ready', stale: true }
      }
    },
    {
      type: 'update',
      key: 'plugins',
      update: {
        pluginName: 'fixture-plugin',
        state: { status: 'running' }
      }
    },
    {
      type: 'update',
      key: 'plugins',
      update: { pluginName: 'fixture-plugin', state: null }
    }
  ])
})

test('插件通知生成完整 Event、限制 Owner 并允许客户端删除', (context) => {
  const { appRuntime, notifications } = createRuntimes(context)
  const notificationId = notifications.publishPlugin('fixture-plugin', {
    level: 'success',
    title: '构建完成',
    description: 'production',
    event: { name: 'open-build', data: { runId: 'run-1' } }
  })

  const created = appRuntime.readSnapshot().notifications[0]
  assert.equal(created?.notificationId, notificationId)
  assert.equal(created?.event?.pluginName, 'fixture-plugin')
  assert.equal(created?.event?.name, 'open-build')
  assert.deepEqual(created?.event?.data, { runId: 'run-1' })
  assert.equal(Number.isSafeInteger(created?.createdAt), true)

  notifications.updatePlugin('fixture-plugin', notificationId, {
    level: 'error',
    title: '构建失败'
  })
  assert.equal(appRuntime.readSnapshot().notifications[0]?.title, '构建失败')
  assert.throws(() => notifications.updatePlugin('other-plugin', notificationId, { title: '越权' }))

  appRuntime.applyClient({
    key: 'notifications',
    update: { type: 'delete', notificationId }
  })
  assert.deepEqual(appRuntime.readSnapshot().notifications, [])
  assert.throws(
    () =>
      appRuntime.applyClient({
        key: 'notifications',
        update: { type: 'delete', notificationId }
      }),
    L3AppRuntimeTargetNotFoundError
  )
})

test('内部 Publisher 发布无 Event 通知并在释放时清理', (context) => {
  const { appRuntime, notifications } = createRuntimes(context)
  const publisher = notifications.createPublisher()
  const notificationId = publisher.publish({
    level: 'warning',
    title: '内部任务需要关注',
    description: '任务中心'
  })
  assert.deepEqual(appRuntime.readSnapshot().notifications[0], {
    notificationId,
    level: 'warning',
    title: '内部任务需要关注',
    description: '任务中心',
    createdAt: appRuntime.readSnapshot().notifications[0]?.createdAt,
    event: null
  })
  publisher.update(notificationId, { title: '内部任务已更新' })
  assert.equal(appRuntime.readSnapshot().notifications[0]?.title, '内部任务已更新')
  publisher.dispose()
  assert.deepEqual(appRuntime.readSnapshot().notifications, [])
})

test('插件释放同时清理状态槽位和未消费通知', (context) => {
  const { appRuntime, notifications, plugins } = createRuntimes(context)
  plugins.setState('fixture-plugin', { status: 'ready' })
  notifications.publishPlugin('fixture-plugin', {
    level: 'info',
    title: '等待处理'
  })

  notifications.releasePlugin('fixture-plugin')
  plugins.releasePlugin('fixture-plugin')

  assert.deepEqual(appRuntime.readSnapshot(), {
    mode: 'normal',
    notifications: [],
    plugins: {},
    capabilityModes: {},
    settings: { region: { locale: 'en', timeZone: 'UTC' } }
  })
})
