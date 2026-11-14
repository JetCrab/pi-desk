import assert from 'node:assert/strict'
import test from 'node:test'
import type { L2ChatSource } from '../src/common/l2_biz/chat/l2-chat-contract'
import type { L2WorkbenchBiz } from '../src/client/l2_biz/workbench/l2-workbench-biz'
import type { L2WorkbenchChatRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat'
import { createL2WorkbenchChatInputRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat-input-runtime'
import type {
  L2WorkbenchChatInputRepository,
  L2WorkbenchStoredInput
} from '../src/client/l2_biz/workbench/l2-workbench-chat-input-repository'

const source: L2ChatSource = {
  workId: 'send-stop-work',
  sessionId: 'send-stop-session',
  branchId: 'v1:main'
}

function createFixture(input: L2WorkbenchStoredInput = { text: '保留这条输入', images: [] }) {
  let draft: L2WorkbenchStoredInput | null = input
  let outbox: L2WorkbenchStoredInput | null = null
  const sent: string[] = []
  const interrupted: L2ChatSource[] = []
  const hooks = {
    write: async (): Promise<void> => undefined,
    move: async (): Promise<void> => undefined,
    clear: async (): Promise<void> => undefined,
    send: async (): Promise<{ tempId: string }> => ({ tempId: 'accepted-input' }),
    interrupt: async (): Promise<void> => undefined
  }
  const repository: L2WorkbenchChatInputRepository = {
    async recoverOutbox() {
      return { input: draft ?? { text: '', images: [] }, recovered: false }
    },
    async writeDraft(_source, value) {
      await hooks.write()
      draft = value
    },
    async moveDraftToOutbox(_source, value) {
      await hooks.move()
      outbox = value
      draft = null
    },
    async clearOutbox() {
      await hooks.clear()
      outbox = null
    },
    async restoreOutboxToDraft() {
      assert.ok(outbox, '恢复必须有尚未发送的Outbox')
      const restored = {
        text: [outbox.text, draft?.text].filter(Boolean).join('\n\n'),
        images: [...outbox.images, ...(draft?.images ?? [])]
      }
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
  const biz = {
    async sendChat(request: { text: string }): Promise<{ tempId: string }> {
      sent.push(request.text)
      return hooks.send()
    },
    async interruptChat(request: { source: L2ChatSource }): Promise<void> {
      interrupted.push(request.source)
      await hooks.interrupt()
    }
  } as unknown as L2WorkbenchBiz
  const chat = {
    getSourceState: () => ({ syncStatus: 'ready' }),
    subscribeSourceEvents: () => () => undefined
  } as unknown as L2WorkbenchChatRuntime
  const runtime = createL2WorkbenchChatInputRuntime(biz, chat, repository)
  return { runtime, hooks, sent, interrupted, stored: () => ({ draft, outbox }) }
}

test('草稿落盘期间停止：不发请求，保留输入，下一次发送不继承停止意图', async () => {
  const fixture = createFixture()
  const gate = Promise.withResolvers<void>()
  fixture.hooks.write = () => gate.promise
  try {
    await fixture.runtime.loadSource(source)
    fixture.runtime.setText(source, '尚未发出的草稿')
    const sending = fixture.runtime.send(source, 'auto')
    const stopping = fixture.runtime.interrupt(source)
    gate.resolve()
    await Promise.all([sending, stopping])
    assert.deepEqual(fixture.sent, [])
    assert.deepEqual(fixture.interrupted, [])
    assert.equal(fixture.runtime.getState(source).text, '尚未发出的草稿')
    assert.equal(fixture.runtime.getState(source).outbox, null)
    assert.equal(fixture.stored().draft?.text, '尚未发出的草稿')
    assert.equal(fixture.stored().outbox, null)

    await fixture.runtime.send(source, 'auto')
    assert.deepEqual(fixture.sent, ['尚未发出的草稿'])
    assert.deepEqual(fixture.interrupted, [])
  } finally {
    gate.resolve()
    fixture.runtime.dispose()
  }
})

test('移入Outbox期间停止：文字和图片恢复草稿且图片地址仍可使用', async () => {
  const image = {
    blob: new Blob(['image-content'], { type: 'image/png' }),
    mimeType: 'image/png',
    width: 2,
    height: 2,
    optimized: true
  }
  const fixture = createFixture({ text: '带图片的草稿', images: [image] })
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  fixture.hooks.move = async () => {
    started.resolve()
    await gate.promise
  }
  try {
    await fixture.runtime.loadSource(source)
    const sending = fixture.runtime.send(source, 'auto')
    await started.promise
    const stopping = fixture.runtime.interrupt(source)
    gate.resolve()
    await Promise.all([sending, stopping])
    const state = fixture.runtime.getState(source)
    assert.deepEqual(fixture.sent, [])
    assert.deepEqual(fixture.interrupted, [])
    assert.equal(state.text, '带图片的草稿')
    assert.equal(state.images.length, 1)
    assert.equal(await (await fetch(state.images[0]!.objectUrl)).text(), 'image-content')
    assert.equal(state.outbox, null)
    assert.equal(fixture.stored().draft?.images.length, 1)
    assert.equal(fixture.stored().outbox, null)
  } finally {
    gate.resolve()
    fixture.runtime.dispose()
  }
})

test('发送确认前停止：确认后立即中断，不等待本地Outbox清理', async () => {
  const fixture = createFixture()
  const started = Promise.withResolvers<void>()
  const accepted = Promise.withResolvers<{ tempId: string }>()
  const clearing = Promise.withResolvers<void>()
  const cleared = Promise.withResolvers<void>()
  const interrupted = Promise.withResolvers<void>()
  fixture.hooks.send = async () => {
    started.resolve()
    return accepted.promise
  }
  fixture.hooks.clear = async () => {
    clearing.resolve()
    await cleared.promise
  }
  fixture.hooks.interrupt = async () => {
    interrupted.resolve()
  }
  try {
    await fixture.runtime.loadSource(source)
    const sending = fixture.runtime.send(source, 'auto')
    await started.promise
    const stopping = fixture.runtime.interrupt(source)
    assert.deepEqual(fixture.interrupted, [])
    accepted.resolve({ tempId: 'accepted-input' })
    await clearing.promise
    await interrupted.promise
    assert.deepEqual(fixture.interrupted, [source])
    cleared.resolve()
    await Promise.all([sending, stopping])
    assert.equal(fixture.runtime.getState(source).outbox, null)
    assert.equal(fixture.stored().draft, null)
    assert.deepEqual(fixture.sent, ['保留这条输入'])
  } finally {
    accepted.resolve({ tempId: 'accepted-input' })
    cleared.resolve()
    fixture.runtime.dispose()
  }
})

test('接纳后的中断失败不把已发消息恢复为草稿，停止可以重试', async () => {
  const fixture = createFixture()
  const started = Promise.withResolvers<void>()
  const accepted = Promise.withResolvers<{ tempId: string }>()
  fixture.hooks.send = async () => {
    started.resolve()
    return accepted.promise
  }
  fixture.hooks.interrupt = async () => {
    throw new Error('中断请求失败')
  }
  try {
    await fixture.runtime.loadSource(source)
    const sending = fixture.runtime.send(source, 'auto')
    await started.promise
    const stopping = assert.rejects(fixture.runtime.interrupt(source), /中断请求失败/)
    accepted.resolve({ tempId: 'accepted-input' })
    await Promise.all([sending, stopping])
    assert.equal(fixture.runtime.getState(source).outbox, null)
    assert.equal(fixture.runtime.getState(source).text, '')
    assert.equal(fixture.stored().outbox, null)
    assert.equal(fixture.stored().draft, null)
    assert.match(fixture.runtime.getState(source).error ?? '', /中断请求失败/)
    fixture.hooks.interrupt = async () => undefined
    await fixture.runtime.interrupt(source)
    assert.equal(fixture.runtime.getState(source).error, null)
    assert.equal(fixture.interrupted.length, 2)
  } finally {
    accepted.resolve({ tempId: 'accepted-input' })
    fixture.runtime.dispose()
  }
})

test('点击停止后发送结果未知：保留未知Outbox，不重发或假定未发送', async () => {
  const fixture = createFixture()
  const started = Promise.withResolvers<void>()
  const accepted = Promise.withResolvers<{ tempId: string }>()
  const failure = new Error('连接断开，发送结果未知')
  Object.defineProperty(failure, 'rawMessage', { value: 'WebSocket 连接已断开' })
  fixture.hooks.send = async () => {
    started.resolve()
    return accepted.promise
  }
  try {
    await fixture.runtime.loadSource(source)
    const sending = assert.rejects(
      fixture.runtime.send(source, 'auto'),
      (cause) => cause === failure
    )
    await started.promise
    const stopping = Promise.allSettled([fixture.runtime.interrupt(source)])
    accepted.reject(failure)
    await Promise.all([sending, stopping])
    assert.equal(fixture.runtime.getState(source).outbox?.status, 'unknown')
    assert.equal(fixture.runtime.getState(source).text, '')
    assert.equal(fixture.stored().outbox?.text, '保留这条输入')
    assert.equal(await fixture.runtime.prepareForPageReload(), false)
    await assert.rejects(fixture.runtime.send(source, 'auto'))
    assert.equal(fixture.sent.length, 1)
    assert.deepEqual(fixture.interrupted, [])
  } finally {
    fixture.runtime.dispose()
  }
})

test('运行中准备后续输入时停止：立即中断当前回复，同时保留未发出的追加输入', async () => {
  const fixture = createFixture()
  const started = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const interrupted = Promise.withResolvers<void>()
  fixture.hooks.move = async () => {
    started.resolve()
    await gate.promise
  }
  fixture.hooks.interrupt = async () => {
    interrupted.resolve()
  }
  try {
    await fixture.runtime.loadSource(source)
    const sending = fixture.runtime.send(source, 'follow_up')
    await started.promise
    const stopping = fixture.runtime.interrupt(source, true)
    await interrupted.promise
    assert.deepEqual(fixture.interrupted, [source])
    gate.resolve()
    await Promise.all([sending, stopping])
    assert.deepEqual(fixture.sent, [])
    assert.equal(fixture.runtime.getState(source).text, '保留这条输入')
    assert.equal(fixture.runtime.getState(source).outbox, null)
  } finally {
    gate.resolve()
    fixture.runtime.dispose()
  }
})

test('释放运行态后不执行等待确认的停止意图', async () => {
  const fixture = createFixture()
  const started = Promise.withResolvers<void>()
  const accepted = Promise.withResolvers<{ tempId: string }>()
  fixture.hooks.send = async () => {
    started.resolve()
    return accepted.promise
  }
  try {
    await fixture.runtime.loadSource(source)
    const sending = fixture.runtime.send(source, 'auto')
    await started.promise
    const stopping = fixture.runtime.interrupt(source)
    fixture.runtime.dispose()
    accepted.resolve({ tempId: 'accepted-input' })
    await Promise.all([sending, stopping])
    assert.deepEqual(fixture.interrupted, [])
  } finally {
    accepted.resolve({ tempId: 'accepted-input' })
    fixture.runtime.dispose()
  }
})
