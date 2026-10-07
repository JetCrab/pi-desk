import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  L3AppNotification,
  L3AppRuntime
} from '../src/common/l3_modules/app-runtime/l3-app-runtime-contract'
import { applyL3AppRuntimeEvent } from '../src/common/l3_modules/app-runtime/l3-app-runtime-state'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

function notification(notificationId: string, title: string): L3AppNotification {
  return {
    notificationId,
    level: 'info',
    title,
    description: null,
    createdAt: 1_786_775_400_000,
    event: null
  }
}

function emptyRuntime(): L3AppRuntime {
  return {
    mode: 'normal',
    notifications: [],
    plugins: {},
    capabilityModes: {},
    settings: { region: { locale: 'en', timeZone: 'UTC' } }
  }
}

test('replace 完整建立 App Runtime 基线', () => {
  const next = applyL3AppRuntimeEvent(emptyRuntime(), {
    type: 'replace',
    runtime: {
      mode: 'normal',
      notifications: [notification(firstId, '第一条')],
      plugins: { fixture: { status: 'ready' } },
      capabilityModes: {},
      settings: { region: { locale: 'en', timeZone: 'UTC' } }
    }
  })

  assert.equal(next.notifications[0]?.title, '第一条')
  assert.deepEqual(next.plugins, { fixture: { status: 'ready' } })
})

test('notification add/update/delete 保持旧到新顺序', () => {
  const first = notification(firstId, '第一条')
  let runtime = applyL3AppRuntimeEvent(emptyRuntime(), {
    type: 'update',
    key: 'notifications',
    update: { type: 'add', notification: first }
  })
  runtime = applyL3AppRuntimeEvent(runtime, {
    type: 'update',
    key: 'notifications',
    update: { type: 'add', notification: notification(secondId, '第二条') }
  })
  assert.deepEqual(
    runtime.notifications.map((item) => item.notificationId),
    [firstId, secondId]
  )

  runtime = applyL3AppRuntimeEvent(runtime, {
    type: 'update',
    key: 'notifications',
    update: {
      type: 'update',
      notificationId: firstId,
      changes: { level: 'warning', title: '第一条已更新' }
    }
  })
  assert.equal(runtime.notifications[0]?.title, '第一条已更新')
  assert.equal(runtime.notifications[0]?.level, 'warning')
  assert.equal(runtime.notifications[1]?.notificationId, secondId)

  runtime = applyL3AppRuntimeEvent(runtime, {
    type: 'update',
    key: 'notifications',
    update: { type: 'delete', notificationId: firstId }
  })
  assert.deepEqual(
    runtime.notifications.map((item) => item.notificationId),
    [secondId]
  )
})

test('plugins 对单个槽位整体替换并用 null 删除', () => {
  let runtime = applyL3AppRuntimeEvent(emptyRuntime(), {
    type: 'update',
    key: 'plugins',
    update: {
      pluginName: 'fixture-plugin',
      state: { nested: { value: 1 }, stale: true }
    }
  })
  runtime = applyL3AppRuntimeEvent(runtime, {
    type: 'update',
    key: 'plugins',
    update: {
      pluginName: 'fixture-plugin',
      state: { nested: { value: 2 } }
    }
  })
  assert.deepEqual(runtime.plugins, {
    'fixture-plugin': { nested: { value: 2 } }
  })

  runtime = applyL3AppRuntimeEvent(runtime, {
    type: 'update',
    key: 'plugins',
    update: { pluginName: 'fixture-plugin', state: null }
  })
  assert.deepEqual(runtime.plugins, {})
})

test('重复 add 和缺失 update/delete 要求重新建立基线', () => {
  const runtime: L3AppRuntime = {
    mode: 'normal',
    notifications: [notification(firstId, '第一条')],
    plugins: {},
    capabilityModes: {},
    settings: { region: { locale: 'en', timeZone: 'UTC' } }
  }
  assert.throws(() =>
    applyL3AppRuntimeEvent(runtime, {
      type: 'update',
      key: 'notifications',
      update: { type: 'add', notification: notification(firstId, '重复') }
    })
  )
  assert.throws(() =>
    applyL3AppRuntimeEvent(runtime, {
      type: 'update',
      key: 'notifications',
      update: {
        type: 'update',
        notificationId: secondId,
        changes: { title: '不存在' }
      }
    })
  )
  assert.throws(() =>
    applyL3AppRuntimeEvent(runtime, {
      type: 'update',
      key: 'notifications',
      update: { type: 'delete', notificationId: secondId }
    })
  )
})
