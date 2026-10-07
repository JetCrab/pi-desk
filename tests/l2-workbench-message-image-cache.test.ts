import assert from 'node:assert/strict'
import test from 'node:test'
import type { L2ChatSource } from '../src/common/l2_biz/chat/l2-chat-contract'
import type { L2ChatSourceEvent } from '../src/common/l2_biz/chat/l2-chat-websocket-contract'
import {
  applyL2ChatSourceEvent,
  L2_EMPTY_CHAT_SOURCE_STATE
} from '../src/common/l2_biz/chat/l2-chat-state'
import type { L2WorkbenchBiz } from '../src/client/l2_biz/workbench/l2-workbench-biz'
import type { L2WorkbenchChatRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat'
import type { L2WorkbenchChatInputRepository } from '../src/client/l2_biz/workbench/l2-workbench-chat-input-repository'
import { createL2WorkbenchChatInputRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat-input-runtime'

const source: L2ChatSource = {
  workId: 'image-work',
  sessionId: 'image-session',
  branchId: 'v1:main'
}
const input = { source, tempId: null, entryId: 'user-entry', imageIndex: 0 }
const response = { mimeType: 'image/png' as const, data: 'aW1hZ2U=' }

function runtimeFor(
  getChatImage: L2WorkbenchBiz['getChatImage']
): ReturnType<typeof createL2WorkbenchChatInputRuntime> {
  return createL2WorkbenchChatInputRuntime(
    { getChatImage } as unknown as L2WorkbenchBiz,
    { subscribeSourceEvents: () => () => undefined } as unknown as L2WorkbenchChatRuntime,
    { clearSource: async () => undefined } as unknown as L2WorkbenchChatInputRepository
  )
}

const localImageTexts = ['first local image', 'second local image']
const localTempId = 'local-temp'

function localImageRuntime(
  clearOutbox: L2WorkbenchChatInputRepository['clearOutbox'],
  sendChat: L2WorkbenchBiz['sendChat'] = async () => ({ tempId: localTempId })
): {
  runtime: ReturnType<typeof createL2WorkbenchChatInputRuntime>
  imageReads: Parameters<L2WorkbenchBiz['getChatImage']>[0][]
  startMessage: () => void
  commitMessage: () => void
} {
  const listeners = new Set<Parameters<L2WorkbenchChatRuntime['subscribeSourceEvents']>[0]>()
  const imageReads: Parameters<L2WorkbenchBiz['getChatImage']>[0][] = []
  let state = L2_EMPTY_CHAT_SOURCE_STATE
  const metadata = { mimeType: 'image/png', width: 1, height: 1 }
  const runtime = createL2WorkbenchChatInputRuntime(
    {
      sendChat,
      getChatImage: async (request) => {
        imageReads.push(request)
        throw new Error('模拟弱网：图片下载失败')
      }
    } as Pick<L2WorkbenchBiz, 'sendChat' | 'getChatImage'> as L2WorkbenchBiz,
    {
      getSourceState: () => ({ ...state, syncStatus: 'ready' }),
      subscribeSourceEvents: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    } as Pick<
      L2WorkbenchChatRuntime,
      'getSourceState' | 'subscribeSourceEvents'
    > as L2WorkbenchChatRuntime,
    {
      recoverOutbox: async () => ({
        recovered: false,
        input: {
          text: '本地图片',
          images: localImageTexts.map((text) => ({
            ...metadata,
            blob: new Blob([text], { type: metadata.mimeType }),
            optimized: true
          }))
        }
      }),
      writeDraft: async () => undefined,
      moveDraftToOutbox: async () => undefined,
      clearOutbox,
      restoreOutboxToDraft: async () => {
        throw new Error('图片缓存测试不应恢复发送记录')
      },
      deleteOutbox: async () => undefined,
      clearSource: async () => undefined
    }
  )
  const emit = (event: L2ChatSourceEvent): void => {
    state = applyL2ChatSourceEvent(state, event)
    for (const listener of listeners) listener({ source, event }, state)
  }
  return {
    runtime,
    imageReads,
    startMessage(): void {
      emit({
        type: 'message_start',
        snapshot: {
          location: { tempId: localTempId },
          fixed: { type: 'user', viewKey: 'pi-desk/user', timestampMs: null, hasDetail: false },
          summary: { text: '本地图片', images: localImageTexts.map(() => metadata) }
        }
      })
    },
    commitMessage(): void {
      emit({
        type: 'message_commit',
        location: { tempId: localTempId },
        durable: { index: 0, entryId: input.entryId },
        fixed: { timestampMs: 1 }
      })
    }
  }
}

// 发送确认与消息推送连续到达时，慢速 IndexedDB 不得迫使本地图重新下载。
test('发送记录清理未完成时，本地图已可展示并随正式消息继续复用', async () => {
  const clearing = Promise.withResolvers<void>()
  const cleared = Promise.withResolvers<void>()
  const fixture = localImageRuntime(async () => {
    clearing.resolve()
    await cleared.promise
  })
  const { runtime } = fixture
  let sending: Promise<void> | undefined
  try {
    await runtime.loadSource(source)
    const draftUrls = runtime.getState(source).images.map((image) => image.objectUrl)
    sending = runtime.send(source, 'auto')
    await clearing.promise
    fixture.startMessage()
    const temporary = localImageTexts.map((_, imageIndex) =>
      runtime.acquireMessageImage({ source, tempId: localTempId, entryId: null, imageIndex })
    )
    assert.ok(temporary.every((image) => !('then' in image)))
    const images = await Promise.all(temporary)
    fixture.commitMessage()
    for (const [imageIndex, image] of images.entries()) {
      const durable = await runtime.acquireMessageImage({ ...input, imageIndex })
      assert.equal(durable.url, image.url)
      assert.equal(await (await fetch(durable.url)).text(), localImageTexts[imageIndex])
      image.release()
      durable.release()
    }
    cleared.resolve()
    await sending
    assert.equal(runtime.getState(source).outbox, null)
    for (const url of draftUrls) await assert.rejects(fetch(url))
    const reopened = await runtime.acquireMessageImage(input)
    assert.equal(reopened.url, images[0]!.url)
    assert.deepEqual(fixture.imageReads, [])
    reopened.release()
    runtime.dispose()
    for (const image of images) await assert.rejects(fetch(image.url))
  } finally {
    cleared.resolve()
    await sending
    runtime.dispose()
  }
})

test('发送确认后的本地清理失败不丢图，删除发送记录不影响消息图片', async () => {
  const fixture = localImageRuntime(async () => {
    throw new Error('模拟本地存储清理失败')
  })
  const { runtime } = fixture
  try {
    await runtime.loadSource(source)
    await assert.rejects(runtime.send(source, 'auto'), /本地存储清理失败/)
    fixture.startMessage()
    fixture.commitMessage()
    const image = await runtime.acquireMessageImage(input)
    await runtime.deleteOutbox(source)
    assert.equal(await (await fetch(image.url)).text(), localImageTexts[0])
    assert.deepEqual(fixture.imageReads, [])
    image.release()
    runtime.reconcileWorkSessions([])
    await assert.rejects(fetch(image.url))
  } finally {
    runtime.dispose()
  }
})

test('来源失效后的发送响应不重新登记本地图', async () => {
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<{ tempId: string }>()
  const fixture = localImageRuntime(
    async () => undefined,
    async () => {
      started.resolve()
      return response.promise
    }
  )
  const { runtime } = fixture
  let sending: Promise<void> | undefined
  try {
    await runtime.loadSource(source)
    sending = runtime.send(source, 'auto')
    await started.promise
    runtime.reconcileWorkSessions([])
    response.resolve({ tempId: localTempId })
    await sending
    assert.throws(() =>
      runtime.acquireMessageImage({ source, tempId: localTempId, entryId: null, imageIndex: 0 })
    )
  } finally {
    response.resolve({ tempId: localTempId })
    await sending
    runtime.dispose()
  }
})

test('聊天图片合并读取，窗口重开同步复用，来源失效撤销地址', async () => {
  let reads = 0
  const runtime = runtimeFor(async () => {
    reads += 1
    return response
  })
  try {
    const [first, concurrent] = await Promise.all([
      runtime.acquireMessageImage(input),
      runtime.acquireMessageImage(input)
    ])
    assert.equal(reads, 1)
    assert.equal(first.url, concurrent.url)
    first.release()
    first.release()
    concurrent.release()
    assert.equal(await (await fetch(first.url)).text(), 'image')
    const reopened = runtime.acquireMessageImage(input)
    assert.equal('then' in reopened, false)
    const image = await reopened
    assert.equal(image.url, first.url)
    assert.equal(reads, 1)
    image.release()
    runtime.reconcileWorkSessions([])
    await assert.rejects(fetch(first.url))
  } finally {
    runtime.dispose()
  }
})

test('来源失效后迟到的图片读取不重建缓存，新请求可重新读取', async () => {
  let finish!: (value: typeof response) => void
  let reads = 0
  const runtime = runtimeFor(() => {
    reads += 1
    return reads === 1
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve(response)
  })
  try {
    const pending = runtime.acquireMessageImage(input)
    runtime.reconcileWorkSessions([])
    finish(response)
    await assert.rejects(pending as Promise<unknown>, /图片/)
    const retried = await runtime.acquireMessageImage(input)
    assert.equal(reads, 2)
    retried.release()
    runtime.dispose()
    await assert.rejects(fetch(retried.url))
  } finally {
    runtime.dispose()
  }
})
