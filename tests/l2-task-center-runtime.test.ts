import assert from 'node:assert/strict'
import test from 'node:test'
import type { L2TaskDetailEventPush } from '../src/common/l2_biz/task-center/l2-task-center-websocket-contract'
import { createL2TaskCenterRuntime } from '../src/client/l2_biz/task-center/l2-task-center-runtime'
import type { L2TaskCenterBiz } from '../src/client/l2_biz/task-center/l2-task-center-biz'
import { buildL3ConversationTurns } from '../src/client/l3_modules/conversation/l3-conversation-display'

const SOURCE = {
  workId: 'work-1',
  sessionId: 'session-1',
  branchId: 'v1:main'
}
const TEMP_ID = '11111111-1111-4111-8111-111111111111'
const USAGE = {
  inputTokens: 10,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0
}

function textSnapshot(taskId: string, text: string) {
  return {
    taskId,
    canInterrupt: false,
    body: { kind: 'text' as const, text, truncated: false }
  }
}

test('弹层打开期间缓存全部访问详情，关闭时整体清空', async () => {
  const pushListener: { current: ((push: L2TaskDetailEventPush) => void) | null } = {
    current: null
  }
  const watchRequests: Array<{ taskId: string | null }> = []
  const biz: L2TaskCenterBiz = {
    async watchDetail(input) {
      watchRequests.push({ taskId: input.taskId })
      return { snapshot: input.taskId ? textSnapshot(input.taskId, input.taskId) : null }
    },
    async interrupt() {},
    subscribeDetailEvents(next) {
      pushListener.current = next
      return () => {
        pushListener.current = null
      }
    },
    async getMessageDetail() {
      throw new Error('unused')
    },
    async getImage() {
      throw new Error('unused')
    }
  }
  const runtime = createL2TaskCenterRuntime(biz)
  runtime.start((cause) => {
    throw cause
  })

  runtime.open(SOURCE, 'a')
  await new Promise((resolve) => setImmediate(resolve))
  runtime.selectTask('b')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(Object.keys(runtime.getState().details).sort(), ['a', 'b'])
  assert.equal(runtime.getState().selectedTaskId, 'b')

  pushListener.current?.({
    source: SOURCE,
    taskId: 'b',
    event: { type: 'text_append', text: '-updated' }
  })
  const updatedDetail = runtime.getState().details.b
  assert.equal(updatedDetail?.body?.kind, 'text')
  assert.equal(updatedDetail?.body?.kind === 'text' ? updatedDetail.body.text : null, 'b-updated')

  runtime.close()
  assert.deepEqual(runtime.getState().details, {})
  assert.equal(runtime.getState().open, false)
  assert.deepEqual(watchRequests, [{ taskId: 'a' }, { taskId: 'b' }, { taskId: null }])
  runtime.dispose()
})

test('连续会话增量立即应用并按帧合并状态通知', async () => {
  const pushListener: { current: ((push: L2TaskDetailEventPush) => void) | null } = {
    current: null
  }
  const biz: L2TaskCenterBiz = {
    async watchDetail(input) {
      return {
        snapshot: input.taskId
          ? {
              taskId: input.taskId,
              canInterrupt: true,
              body: {
                kind: 'conversation',
                messages: [],
                temporaryMessages: [
                  {
                    location: { tempId: TEMP_ID },
                    fixed: {
                      timestampMs: null,
                      type: 'assistant',
                      viewKey: 'pi-desk/assistant',
                      status: 'running',
                      hasDetail: false,
                      usage: USAGE
                    },
                    summary: { text: '', errorMessage: null }
                  }
                ],
                truncated: false
              }
            }
          : null
      }
    },
    async interrupt() {},
    subscribeDetailEvents(next) {
      pushListener.current = next
      return () => {
        pushListener.current = null
      }
    },
    async getMessageDetail() {
      throw new Error('unused')
    },
    async getImage() {
      throw new Error('unused')
    }
  }
  const runtime = createL2TaskCenterRuntime(biz)
  runtime.start((cause) => {
    throw cause
  })
  runtime.open(SOURCE, 'task-1')
  await new Promise((resolve) => setImmediate(resolve))

  let notifications = 0
  const unsubscribe = runtime.subscribe(() => {
    notifications += 1
  })
  for (let index = 0; index < 100; index += 1) {
    pushListener.current?.({
      source: SOURCE,
      taskId: 'task-1',
      event: {
        type: 'conversation_event',
        event: {
          type: 'message_update',
          location: { tempId: TEMP_ID },
          increments: { 'summary.text': String(index % 10) }
        }
      }
    })
  }

  const detail = runtime.getState().details['task-1']
  assert.equal(
    detail?.body?.kind === 'conversation'
      ? (detail.body.temporaryMessages[0]?.summary as { text: string }).text.length
      : 0,
    100
  )
  assert.equal(notifications, 0)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(notifications, 1)

  unsubscribe()
  runtime.dispose()
})

test('同一任务图片的并发读取复用地址，关闭弹层后全部撤销', async () => {
  const image = { mimeType: 'image/png' as const, data: 'aW1hZ2U=' }
  const snapshot = {
    location: { index: 0, entryId: 'user-image' },
    fixed: {
      timestampMs: 1,
      type: 'user' as const,
      viewKey: 'pi-desk/user',
      hasDetail: false as const
    },
    summary: { text: '', images: [{ mimeType: image.mimeType, width: 1, height: 1 }] }
  }
  const message = buildL3ConversationTurns({ messages: [snapshot], temporaryMessages: [] })[0]?.user
  assert.ok(message)
  const pending: Array<(value: typeof image) => void> = []
  const runtime = createL2TaskCenterRuntime({
    async watchDetail() {
      return { snapshot: null }
    },
    async interrupt() {},
    subscribeDetailEvents() {
      return () => undefined
    },
    async getMessageDetail() {
      throw new Error('unused')
    },
    getImage() {
      return new Promise((resolve) => pending.push(resolve))
    }
  })
  try {
    runtime.open(SOURCE, 'task-image')
    const first = runtime.acquireImage(message, 0)
    const second = runtime.acquireImage(message, 0)
    for (const finish of pending) finish(image)
    const [left, right] = await Promise.all([first, second])
    assert.equal(left.url, right.url)
    left.release()
    right.release()
    assert.equal(await (await fetch(left.url)).text(), 'image')
    runtime.close()
    await assert.rejects(fetch(left.url))
    await assert.rejects(fetch(right.url))
  } finally {
    runtime.dispose()
  }
})

test('断线保留弹层缓存，重连后重新获取完整 Snapshot', async () => {
  let generation = 0
  const biz: L2TaskCenterBiz = {
    async watchDetail(input) {
      if (!input.taskId) return { snapshot: null }
      generation += 1
      return { snapshot: textSnapshot(input.taskId, `snapshot-${generation}`) }
    },
    async interrupt() {},
    subscribeDetailEvents() {
      return () => undefined
    },
    async getMessageDetail() {
      throw new Error('unused')
    },
    async getImage() {
      throw new Error('unused')
    }
  }
  const runtime = createL2TaskCenterRuntime(biz)
  runtime.start(() => undefined)
  runtime.open(SOURCE, 'a')
  await new Promise((resolve) => setImmediate(resolve))
  runtime.disconnected()
  assert.equal(runtime.getState().refreshing, true)
  runtime.reconnected()
  await new Promise((resolve) => setImmediate(resolve))

  const detail = runtime.getState().details.a
  assert.equal(detail?.body?.kind === 'text' ? detail.body.text : null, 'snapshot-2')
  runtime.dispose()
})
