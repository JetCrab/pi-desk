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
