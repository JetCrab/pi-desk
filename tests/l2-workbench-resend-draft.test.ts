import assert from 'node:assert/strict'
import test from 'node:test'
import type { L2ChatSource } from '../src/common/l2_biz/chat/l2-chat-contract'
import type { L2WorkSessionListItem } from '../src/common/l2_biz/work-session/l2-work-session-contract'
import type { L2WorkbenchBiz } from '../src/client/l2_biz/workbench/l2-workbench-biz'
import type { L2WorkbenchChatRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat'
import { createL2WorkbenchChatInputRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat-input-runtime'
import type {
  L2WorkbenchChatInputRepository,
  L2WorkbenchStoredInput
} from '../src/client/l2_biz/workbench/l2-workbench-chat-input-repository'

const source: L2ChatSource = {
  workId: 'resend-work',
  sessionId: 'resend-session',
  branchId: 'v1:main'
}
const target: L2ChatSource = { ...source, branchId: 'v1:fork:r:2' }
const key = (value: L2ChatSource): string => JSON.stringify(value)

function fixture(): {
  runtime: ReturnType<typeof createL2WorkbenchChatInputRuntime>
  records: Map<string, L2WorkbenchStoredInput>
  image: Blob
  reconcile: (value: L2ChatSource) => void
} {
  const image = new Blob(['draft-image'], { type: 'image/png' })
  const records = new Map<string, L2WorkbenchStoredInput>([
    [
      key(source),
      {
        text: '尚未发送的草稿',
        images: [{ blob: image, mimeType: 'image/png', width: 1, height: 1, optimized: true }]
      }
    ]
  ])
  const repository = {
    async recoverOutbox(value: L2ChatSource) {
      return { input: records.get(key(value)) ?? { text: '', images: [] }, recovered: false }
    },
    async writeDraft(value: L2ChatSource, input: L2WorkbenchStoredInput) {
      records.set(key(value), input)
    },
    async clearSource(value: L2ChatSource) {
      records.delete(key(value))
    }
  } as L2WorkbenchChatInputRepository
  const chat = {
    subscribeSourceEvents: () => () => undefined
  } as unknown as L2WorkbenchChatRuntime
  const runtime = createL2WorkbenchChatInputRuntime({} as L2WorkbenchBiz, chat, repository)
  const reconcile = (value: L2ChatSource): void => {
    runtime.reconcileWorkSessions([value as L2WorkSessionListItem])
  }
  return { runtime, records, image, reconcile }
}

test('主动重发切换 Source 时保留最新文字和图片，释放原图片地址', async () => {
  const { runtime, records, image, reconcile } = fixture()
  try {
    await runtime.loadSource(source)
    const previousUrl = runtime.getState(source).images[0]!.objectUrl
    const release = runtime.preserveDraftOnBranch(source)
    runtime.setText(source, '重发等待期间更新的草稿')
    reconcile(target)
    release()
    await runtime.loadSource(target)
    assert.equal(runtime.getState(target).text, '重发等待期间更新的草稿')
    assert.equal(runtime.getState(target).images[0]!.blob, image)
    assert.notEqual(runtime.getState(target).images[0]!.objectUrl, previousUrl)
    await assert.rejects(fetch(previousUrl))
    assert.equal(runtime.getState(target).outbox, null)
    assert.equal(await runtime.prepareForPageReload(), true)
    assert.equal(records.get(key(target))?.text, '重发等待期间更新的草稿')
    assert.equal(records.has(key(source)), false)
  } finally {
    runtime.dispose()
  }
})

for (const scenario of ['普通分支切换', '重发取消后切换', '会话绑定被替换'] as const) {
  test(`${scenario}不迁移草稿`, async () => {
    const { runtime, reconcile } = fixture()
    try {
      await runtime.loadSource(source)
      const release =
        scenario === '普通分支切换' ? undefined : runtime.preserveDraftOnBranch(source)
      if (scenario === '重发取消后切换') release?.()
      const destination =
        scenario === '会话绑定被替换' ? { ...target, sessionId: 'other-session' } : target
      reconcile(destination)
      await runtime.loadSource(destination)
      assert.equal(runtime.getState(destination).text, '')
      assert.equal(runtime.getState(destination).images.length, 0)
      release?.()
    } finally {
      runtime.dispose()
    }
  })
}
