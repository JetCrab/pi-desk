import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { L2WorkSessionListItem } from '../src/common/l2_biz/work-session/l2-work-session-contract'
import {
  findL2CompletedWorkSessions,
  remindL2CompletedWorkSessions,
  startL2CompletionReminders
} from '../src/client/l2_biz/workbench/l2-workbench-completion-reminders'
import {
  L3_DEFAULT_COMPLETION_REMINDERS,
  readL3CompletionReminders,
  saveL3CompletionReminders
} from '../src/client/l3_modules/preferences/l3-completion-reminder-preferences'
import {
  disposeL4ClientReminders,
  getL4NotificationPermission,
  sendL4ClientReminder
} from '../src/client/l4_foundation/l4-client-reminders'

function session(status: L2WorkSessionListItem['status']): L2WorkSessionListItem {
  return {
    workId: 'work-1',
    sessionId: 'session-1',
    branchId: 'branch-1',
    cwd: '/example/project',
    projectName: '项目',
    sessionTitle: '修复问题',
    status,
    messageCounts: { user: 1, total: 2 },
    lastMessageUpdatedAt: null
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function fixture(
  context: TestContext,
  platform: 'windows' | 'macos' | 'android' | 'web' = 'windows'
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const calls: unknown[] = []
  const storage = new Map<string, string>()
  const page = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    focused: false,
    hasFocus(): boolean {
      return this.focused
    }
  })
  const window = Object.assign(new EventTarget(), {
    isSecureContext: true,
    localStorage: {
      getItem: (key: string): string | null => storage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        storage.set(key, value)
      }
    },
    focus(): void {
      page.focused = true
    },
    ...(platform === 'web'
      ? {}
      : {
          __PI_DESK_REMINDER__: {
            platform,
            async invoke(input: {
              action: string
              request?: boolean
            }): Promise<NotificationPermission | null> {
              calls.push(input)
              return input.action === 'permission' ? 'granted' : null
            }
          }
        })
  })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page })
  saveL3CompletionReminders(L3_DEFAULT_COMPLETION_REMINDERS)
  context.after(async () => {
    disposeL4ClientReminders()
    await flush()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  return { window, page, calls }
}

test('只有同一Source从主任务或后台任务运行中变成完成才产生提醒', () => {
  const completed = session('completed')
  for (const status of ['main_running', 'background_running'] as const) {
    assert.deepEqual(findL2CompletedWorkSessions([session(status)], [completed]), [completed])
  }
  for (const previous of [[], [session('idle')], [completed]]) {
    assert.deepEqual(findL2CompletedWorkSessions(previous, [completed]), [])
  }
  for (const changed of [
    { ...completed, sessionId: 'another-session' },
    { ...completed, branchId: 'another-branch' },
    { ...completed, workId: 'another-work' }
  ]) {
    assert.deepEqual(findL2CompletedWorkSessions([session('main_running')], [changed]), [])
  }
  assert.deepEqual(findL2CompletedWorkSessions([session('main_running')], []), [])
})

test('默认通道全部开启，关闭系统通知不会关闭桌面图标提醒', async (context) => {
  const f = fixture(context)
  assert.deepEqual(readL3CompletionReminders(), { system: true, sound: true, attention: true })
  saveL3CompletionReminders({ system: false, sound: false })
  remindL2CompletedWorkSessions([session('main_running')], [session('completed')], '会话已完成')
  await flush()
  assert.deepEqual(f.calls, [{ action: 'attention' }])
  assert.equal(readL3CompletionReminders().attention, true)
})

test('完成时页面有焦点不提醒，页面隐藏或失焦才提醒且不重复处理已完成状态', async (context) => {
  const f = fixture(context)
  saveL3CompletionReminders({ sound: false })
  f.page.focused = true
  remindL2CompletedWorkSessions([session('main_running')], [session('completed')], '完成')
  await flush()
  assert.deepEqual(f.calls, [])
  f.page.visibilityState = 'hidden'
  remindL2CompletedWorkSessions([session('background_running')], [session('completed')], '完成')
  await flush()
  assert.deepEqual(f.calls, [
    { action: 'notify', title: '完成', body: '修复问题' },
    { action: 'attention' }
  ])
  remindL2CompletedWorkSessions([session('completed')], [session('completed')], '完成')
  await flush()
  assert.equal(f.calls.length, 2)
})

test('Android不调用桌面attention，通知标题不依赖会话或插件身份', async (context) => {
  const f = fixture(context, 'android')
  await sendL4ClientReminder({
    title: '其他场景',
    body: '结果已就绪',
    system: true,
    sound: false,
    attention: true
  })
  assert.deepEqual(f.calls, [{ action: 'notify', title: '其他场景', body: '结果已就绪' }])
})

test('通知通道失败不阻断桌面图标提醒', async (context) => {
  const f = fixture(context)
  Object.assign(f.window.__PI_DESK_REMINDER__!, {
    async invoke(input: { action: string }): Promise<null> {
      f.calls.push(input)
      if (input.action === 'notify') throw new Error('系统通知失败')
      return null
    }
  })
  await assert.rejects(
    sendL4ClientReminder({ title: '完成', body: '', system: true, sound: false, attention: true }),
    AggregateError
  )
  assert.deepEqual(f.calls, [
    { action: 'notify', title: '完成', body: '' },
    { action: 'attention' }
  ])
})

test('仅显式请求才申请权限，未授权的Web完成事件不弹权限窗口', async (context) => {
  const f = fixture(context, 'web')
  let requested = 0
  let shown = 0
  class BrowserNotification {
    static permission: NotificationPermission = 'default'
    static async requestPermission(): Promise<NotificationPermission> {
      requested++
      return 'granted'
    }
    constructor() {
      shown++
    }
  }
  Object.assign(f.window, { Notification: BrowserNotification })
  assert.equal(await getL4NotificationPermission(), 'default')
  await sendL4ClientReminder({
    title: '完成',
    body: '',
    system: true,
    sound: false,
    attention: true
  })
  assert.equal(requested, 0)
  assert.equal(shown, 0)
  assert.equal(await getL4NotificationPermission(true), 'granted')
  assert.equal(requested, 1)
  f.window.isSecureContext = false
  assert.equal(await getL4NotificationPermission(true), 'unsupported')
  assert.equal(requested, 1)
})

test('Web通知静音且不要求常驻，下一条通知释放上一条', async (context) => {
  const f = fixture(context, 'web')
  const notices: BrowserNotification[] = []
  class BrowserNotification {
    static permission: NotificationPermission = 'granted'
    onclick: (() => void) | null = null
    onclose: (() => void) | null = null
    closed = false
    constructor(
      readonly title: string,
      readonly options: NotificationOptions
    ) {
      notices.push(this)
    }
    close(): void {
      this.closed = true
      this.onclose?.()
    }
  }
  Object.assign(f.window, { Notification: BrowserNotification })
  const input = { title: '完成', body: '会话', system: true, sound: false, attention: true }
  await sendL4ClientReminder(input)
  await sendL4ClientReminder(input)
  assert.equal(notices[0].closed, true)
  assert.equal(notices[1].options.silent, true)
  assert.equal(notices[1].options.requireInteraction, false)
  notices[1].onclick?.()
  assert.equal(f.page.focused, true)
  assert.equal(notices[1].closed, true)
})

test('恢复焦点清除图标提醒，释放后不再响应窗口事件', async (context) => {
  const f = fixture(context)
  const stop = startL2CompletionReminders()
  f.page.focused = true
  f.window.dispatchEvent(new Event('focus'))
  await flush()
  assert.deepEqual(f.calls, [{ action: 'clear' }])
  stop()
  await flush()
  const count = f.calls.length
  f.window.dispatchEvent(new Event('focus'))
  f.page.dispatchEvent(new Event('visibilitychange'))
  await flush()
  assert.equal(f.calls.length, count)
})
