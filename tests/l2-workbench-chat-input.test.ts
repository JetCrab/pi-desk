import assert from 'node:assert/strict'
import test from 'node:test'
import type { L2ChatSource } from '../src/common/l2_biz/chat/l2-chat-contract'
import { createL2WorkbenchChatInputRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat-input-runtime'
import type {
  L2WorkbenchChatInputRepository,
  L2WorkbenchStoredInput
} from '../src/client/l2_biz/workbench/l2-workbench-chat-input-repository'
import type { L2WorkbenchBiz } from '../src/client/l2_biz/workbench/l2-workbench-biz'
import type { L2WorkbenchChatRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat'

const source: L2ChatSource = {
  workId: 'work-1',
  sessionId: 'session-1',
  branchId: 'v1:main'
}

test('断线的未知发送结果保留Outbox且不会自动重新发送', async () => {
  let sendCalls = 0
  const failure = new Error('WebSocket connection closed')
  Object.defineProperty(failure, 'rawMessage', { value: 'WebSocket 连接已断开' })
  const biz = {
    async sendChat() {
      sendCalls += 1
      throw failure
    }
  } as unknown as L2WorkbenchBiz
  const chatRuntime = {
    getSourceState: () => ({ syncStatus: 'ready' }),
    subscribeSourceEvents: () => () => undefined
  } as unknown as L2WorkbenchChatRuntime
  let draft: L2WorkbenchStoredInput | null = null
  let outbox: L2WorkbenchStoredInput | null = null
  const repository: L2WorkbenchChatInputRepository = {
    async recoverOutbox() {
      return { input: { text: '', images: [] }, recovered: false }
    },
    async writeDraft(_source, input) {
      draft = input
    },
    async moveDraftToOutbox(_source, input) {
      outbox = input
      draft = null
    },
    async clearOutbox() {
      outbox = null
    },
    async restoreOutboxToDraft() {
      const restored = outbox ?? { text: '', images: [] }
      draft = restored
      outbox = null
      return restored
    },
    async deleteOutbox() {
      outbox = null
    },
    async clearSource() {
      draft = null
      outbox = null
    }
  }
  const runtime = createL2WorkbenchChatInputRuntime(biz, chatRuntime, repository)

  try {
    runtime.setText(source, 'send once')
    await assert.rejects(runtime.send(source, 'auto'), (cause) => cause === failure)
    assert.equal(runtime.getState(source).followRequested, false)
    assert.equal(runtime.getState(source).outbox?.status, 'unknown')
    assert.equal(runtime.getState(source).outbox?.error, 'WebSocket connection closed')
    assert.equal(await runtime.prepareForPageReload(), false)
    await assert.rejects(runtime.send(source, 'auto'))
    assert.equal(sendCalls, 1)
    assert.equal(draft, null)
    assert.deepEqual(outbox, { text: 'send once', images: [] })
  } finally {
    runtime.dispose()
  }
})

test('仅成功接管在当前页面的对应Source请求跟随，消费后不重发', async () => {
  let rejectSend = false
  const accepted = Promise.withResolvers<{ tempId: string }>()
  const started = Promise.withResolvers<void>()
  const biz = {
    async sendChat(): Promise<{ tempId: string }> {
      if (rejectSend) throw new Error('拒绝发送')
      started.resolve()
      return accepted.promise
    }
  } as unknown as L2WorkbenchBiz
  const chatRuntime = {
    getSourceState: () => ({ syncStatus: 'ready' }),
    subscribeSourceEvents: () => () => undefined
  } as unknown as L2WorkbenchChatRuntime
  const repository = {
    writeDraft: async () => undefined,
    moveDraftToOutbox: async () => undefined,
    clearOutbox: async () => undefined
  } as unknown as L2WorkbenchChatInputRepository
  const runtime = createL2WorkbenchChatInputRuntime(biz, chatRuntime, repository)
  const otherPage = createL2WorkbenchChatInputRuntime(biz, chatRuntime, repository)
  const otherSource = { ...source, workId: 'work-2' }
  const otherBranch = { ...source, branchId: 'v1:other' }
  let sending: Promise<void> | undefined
  try {
    runtime.setText(source, '接管后恢复跟随')
    sending = runtime.send(source, 'auto')
    await started.promise
    assert.equal(runtime.getState(source).followRequested, false)
    accepted.resolve({ tempId: 'accepted-message' })
    await sending
    assert.equal(runtime.getState(source).followRequested, true)
    assert.equal(runtime.getState(otherSource).followRequested, false)
    assert.equal(runtime.getState(otherBranch).followRequested, false)
    assert.equal(otherPage.getState(source).followRequested, false)

    runtime.clearFollowRequest(source)
    runtime.setText(source, '拒绝的消息不请求跟随')
    assert.equal(runtime.getState(source).followRequested, false)
    rejectSend = true
    await assert.rejects(runtime.send(source, 'follow_up'), /拒绝发送/)
    assert.equal(runtime.getState(source).followRequested, false)
  } finally {
    accepted.resolve({ tempId: 'accepted-message' })
    await sending
    runtime.dispose()
    otherPage.dispose()
  }
})

test('停止重试成功清除旧错误，关闭反馈不改变草稿', async () => {
  let fail = true
  const biz = {
    async interruptChat(): Promise<void> {
      if (fail) throw new Error('WebSocket 请求超时：chat/interrupt')
    }
  } as unknown as L2WorkbenchBiz
  const chatRuntime = {
    getSourceState: () => ({ syncStatus: 'ready' }),
    subscribeSourceEvents: () => () => undefined
  } as unknown as L2WorkbenchChatRuntime
  const repository = {
    async recoverOutbox(): Promise<{ input: L2WorkbenchStoredInput; recovered: boolean }> {
      return { input: { text: '保留草稿', images: [] }, recovered: false }
    }
  } as unknown as L2WorkbenchChatInputRepository
  const runtime = createL2WorkbenchChatInputRuntime(biz, chatRuntime, repository)
  try {
    await runtime.loadSource(source)
    await assert.rejects(runtime.interrupt(source), /请求超时/)
    fail = false
    await runtime.interrupt(source)
    assert.equal(runtime.getState(source).error, null)

    fail = true
    await assert.rejects(runtime.interrupt(source), /请求超时/)
    runtime.dismissFeedback(source)
    assert.equal(runtime.getState(source).error, null)
    assert.equal(runtime.getState(source).text, '保留草稿')
    assert.deepEqual(runtime.getState(source).images, [])
  } finally {
    runtime.dispose()
  }
})
