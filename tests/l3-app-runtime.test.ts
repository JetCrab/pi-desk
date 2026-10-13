import assert from 'node:assert/strict'
import test from 'node:test'
import type { L3AppRuntimeEvent } from '../src/common/l3_modules/app-runtime/l3-app-runtime-contract'
import { applyL3AppRuntimeEvent } from '../src/common/l3_modules/app-runtime/l3-app-runtime-state'
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
    key: 'task:fixture',
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

test('相同业务通知复用ID，完整重复不广播，内容与Event变化同步所有客户端', (context) => {
  const { appRuntime, notifications } = createRuntimes(context)
  context.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  let firstClient = appRuntime.readSnapshot()
  let secondClient = appRuntime.readSnapshot()
  const events: L3AppRuntimeEvent[] = []
  appRuntime.subscribe((event) => {
    events.push(event)
    firstClient = applyL3AppRuntimeEvent(firstClient, event)
    secondClient = applyL3AppRuntimeEvent(secondClient, event)
  })

  const id = notifications.publishPlugin('fixture-plugin', {
    key: 'build:run-1',
    level: 'info',
    title: '构建完成',
    description: 'production',
    event: { name: 'open-build', data: { runId: 'run-1', nested: { left: 1, right: 2 } } }
  })
  const created = appRuntime.readSnapshot().notifications[0]!
  context.mock.timers.tick(10)
  const otherId = notifications.publishPlugin('fixture-plugin', {
    key: 'build:run-2',
    level: 'info',
    title: '构建完成'
  })
  const beforeRepeat = events.length
  context.mock.timers.tick(10)
  assert.equal(
    notifications.publishPlugin('fixture-plugin', {
      key: ' build:run-1 ',
      level: 'info',
      title: ' 构建完成 ',
      description: 'production',
      event: { name: 'open-build', data: { nested: { right: 2, left: 1 }, runId: 'run-1' } }
    }),
    id
  )
  assert.equal(events.length, beforeRepeat)

  const event = { name: 'open-result', data: { runId: 'run-1', path: 'result.html' } }
  assert.equal(
    notifications.publishPlugin('fixture-plugin', {
      key: 'build:run-1',
      level: 'info',
      title: '构建完成',
      description: 'production',
      event
    }),
    id
  )
  assert.deepEqual(firstClient.notifications[0]?.event, {
    type: 'plugin',
    pluginName: 'fixture-plugin',
    ...event
  })
  assert.equal(events.length, beforeRepeat + 1)
  assert.equal(
    notifications.publishPlugin('fixture-plugin', {
      key: 'build:run-1',
      level: 'error',
      title: '构建失败'
    }),
    id
  )
  const snapshot = appRuntime.readSnapshot()
  assert.equal(events.length, beforeRepeat + 2)
  assert.deepEqual(
    snapshot.notifications.map((item) => item.notificationId),
    [id, otherId]
  )
  assert.deepEqual(snapshot.notifications[0], {
    ...created,
    level: 'error',
    title: '构建失败',
    description: null,
    event: null
  })
  assert.deepEqual(firstClient, snapshot)
  assert.deepEqual(secondClient, snapshot)
  assert.equal('key' in snapshot.notifications[0]!, false)
})

test('去重限定同插件或发布者，相同文字的不同业务和无key通知不合并', (context) => {
  const { appRuntime, notifications } = createRuntimes(context)
  const input = { key: 'task:1', level: 'info', title: '处理完成' } as const
  const ids = [
    notifications.publishPlugin('first-plugin', input),
    notifications.publishPlugin('second-plugin', input),
    notifications.publishPlugin('first-plugin', { ...input, key: 'task:2' }),
    notifications.publishPlugin('first-plugin', { level: 'info', title: input.title }),
    notifications.publishPlugin('first-plugin', { level: 'info', title: input.title })
  ]
  const firstPublisher = notifications.createPublisher()
  const secondPublisher = notifications.createPublisher()
  ids.push(firstPublisher.publish(input), secondPublisher.publish(input))
  assert.equal(firstPublisher.publish(input), ids[5])
  assert.equal(secondPublisher.publish(input), ids[6])
  assert.equal(new Set(ids).size, 7)
  assert.equal(appRuntime.readSnapshot().notifications.length, 7)
  assert.throws(() => firstPublisher.update(ids[6]!, { title: '越权' }))
})

test('通知删除、完整替换和插件释放后，同key重新创建新ID', (context) => {
  const { appRuntime, notifications } = createRuntimes(context)
  const input = { key: 'post:1', level: 'info', title: '新动态' } as const
  const ids = [notifications.publishPlugin('fixture-plugin', input)]
  appRuntime.applyClient({
    key: 'notifications',
    update: { type: 'delete', notificationId: ids[0]! }
  })
  ids.push(notifications.publishPlugin('fixture-plugin', input))
  notifications.deletePlugin('fixture-plugin', ids[1]!)
  ids.push(notifications.publishPlugin('fixture-plugin', input))
  appRuntime.replace({ ...appRuntime.readSnapshot(), notifications: [] })
  ids.push(notifications.publishPlugin('fixture-plugin', input))
  notifications.releasePlugin('fixture-plugin')
  ids.push(notifications.publishPlugin('fixture-plugin', input))
  assert.equal(new Set(ids).size, 5)
  assert.equal(appRuntime.readSnapshot().notifications.length, 1)
  assert.throws(() => notifications.updatePlugin('fixture-plugin', ids[0]!, { title: '已删除' }))
})

test('容量已满时重复发布不淘汰，已淘汰的key可重新发布', (context) => {
  const { appRuntime, notifications } = createRuntimes(context)
  const input = { key: 'task:0', level: 'info', title: '处理完成' } as const
  const oldestId = notifications.publishPlugin('fixture-plugin', input)
  for (let index = 1; index < 100; index += 1) {
    notifications.publishPlugin('fixture-plugin', { ...input, key: `task:${index}` })
  }
  assert.equal(notifications.publishPlugin('fixture-plugin', input), oldestId)
  assert.equal(appRuntime.readSnapshot().notifications[0]?.notificationId, oldestId)
  notifications.publishPlugin('fixture-plugin', { ...input, key: 'task:100' })
  assert.notEqual(notifications.publishPlugin('fixture-plugin', input), oldestId)
  assert.equal(appRuntime.readSnapshot().notifications.length, 100)
  assert.throws(() => notifications.deletePlugin('fixture-plugin', oldestId))
})

test('非法key、通知内容和超限Event被拒绝且不影响已有通知', (context) => {
  const { appRuntime, notifications } = createRuntimes(context)
  const input = { key: 'task:1', level: 'info', title: '处理完成' } as const
  const id = notifications.publishPlugin('fixture-plugin', input)
  for (const key of ['', ' ', 'x'.repeat(257)]) {
    assert.throws(() => notifications.publishPlugin('fixture-plugin', { ...input, key }))
  }
  assert.throws(() => notifications.publishPlugin('fixture-plugin', { ...input, title: ' ' }))
  assert.throws(
    () =>
      notifications.publishPlugin('fixture-plugin', {
        ...input,
        event: { name: 'open-result', data: { text: 'x'.repeat(70 * 1024) } }
      }),
    /64KB/
  )
  assert.deepEqual(
    appRuntime.readSnapshot().notifications.map((item) => item.notificationId),
    [id]
  )
})
