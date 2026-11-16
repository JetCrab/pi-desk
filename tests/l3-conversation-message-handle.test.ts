import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import type { PluginJsonObject } from '@jetcrab/pi-desk-sdk/browser'
import type { L3ConversationDisplayMessage } from '../src/client/l3_modules/conversation/l3-conversation-display'
import {
  L3ConversationDurableMessageSnapshotSchema,
  L3ConversationTemporaryMessageSnapshotSchema
} from '../src/common/l3_modules/conversation/l3-conversation-contract'

const require = createRequire(import.meta.url)
// 句柄不依赖界面样式；隔离同模块 UI 的 CSS 导入。
require.extensions['.css'] = (module): void => {
  module.exports = {}
}
const { L3ConversationBrowserMessageHandle } =
  require('../src/client/l3_modules/conversation/l3-conversation-plugin-message') as typeof import('../src/client/l3_modules/conversation/l3-conversation-plugin-message')
const tempId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function message(hasDetail: boolean, durable = false): L3ConversationDisplayMessage {
  const layers = {
    fixed: {
      type: 'tool',
      viewKey: 'subagent/start',
      status: durable ? 'completed' : 'running',
      usage: null,
      hasDetail,
      timestampMs: durable ? 100 : null
    },
    summary: { action: 'start', title: '检查启动提示词' }
  }
  const durableSnapshot = durable
    ? L3ConversationDurableMessageSnapshotSchema.parse({
        ...layers,
        location: { index: 0, entryId: 'entry-agent' }
      })
    : null
  const snapshot =
    durableSnapshot ??
    L3ConversationTemporaryMessageSnapshotSchema.parse({ ...layers, location: { tempId } })
  return {
    identity: 'position:0',
    position: 0,
    viewKey: snapshot.fixed.viewKey,
    snapshot,
    summary: {
      type: 'tool',
      kind: 'generic',
      name: 'agent',
      reasoning: null,
      inputPreview: null,
      activity: null,
      status: durable ? 'completed' : 'running',
      usage: null,
      hasDetail
    },
    detail: undefined,
    temporary: !durable,
    timestampMs: snapshot.fixed.timestampMs,
    durable: durableSnapshot,
    tempId: durable ? null : tempId
  }
}

test('空参数流补全提示词并提交后，展开读取完整详情并缓存结果', async () => {
  const prompt = { markdown: '## 任务要求\n\n检查启动提示词的完整内容。' }
  let requests = 0
  const loader = async (): Promise<PluginJsonObject> => {
    requests += 1
    return prompt
  }
  const handle = new L3ConversationBrowserMessageHandle(message(false), loader)
  try {
    handle.replace(message(true), loader, false)
    handle.replace(message(true, true), loader, false)
    assert.deepEqual(await handle.loadDetail(), prompt)
    assert.deepEqual(handle.getSnapshot().detail, prompt)
    assert.deepEqual(await handle.loadDetail(), prompt)
    assert.equal(requests, 1)
  } finally {
    handle.dispose()
  }
})

test('无详情不发请求，临时消息有详情时仍等待 durable 后读取', async () => {
  let requests = 0
  const loader = async (): Promise<PluginJsonObject> => {
    requests += 1
    return { markdown: '完整任务要求' }
  }
  const handle = new L3ConversationBrowserMessageHandle(message(false), loader)
  try {
    assert.equal(await handle.loadDetail(), null)
    handle.replace(message(true), loader, false)
    await assert.rejects(handle.loadDetail(), /Temporary Message/)
    assert.equal(requests, 0)
  } finally {
    handle.dispose()
  }
})

test('已有详情可并发加载，失败后允许重试', async () => {
  let requests = 0
  const prompt = { markdown: '重试后取得完整任务要求' }
  const loader = async (): Promise<PluginJsonObject> => {
    requests += 1
    if (requests === 1) throw new Error('详情查询失败')
    return prompt
  }
  const handle = new L3ConversationBrowserMessageHandle(message(true, true), loader)
  try {
    const first = handle.loadDetail()
    assert.equal(handle.loadDetail(), first)
    await assert.rejects(first, /详情查询失败/)
    assert.deepEqual(await handle.loadDetail(), prompt)
    assert.equal(requests, 2)
  } finally {
    handle.dispose()
  }
})

test('详情可用性变化后，旧请求不能覆盖新详情', async () => {
  let finishOldRequest!: (detail: PluginJsonObject) => void
  const oldLoader = (): Promise<PluginJsonObject> =>
    new Promise((resolve) => {
      finishOldRequest = resolve
    })
  const prompt = { markdown: '当前任务要求' }
  const loader = async (): Promise<PluginJsonObject> => prompt
  const handle = new L3ConversationBrowserMessageHandle(message(true, true), oldLoader)
  try {
    const oldRequest = handle.loadDetail()
    handle.replace(message(false, true), loader, false)
    handle.replace(message(true, true), loader, false)
    assert.deepEqual(await handle.loadDetail(), prompt)
    finishOldRequest({ markdown: '已失效的任务要求' })
    await oldRequest
    assert.deepEqual(handle.getSnapshot().detail, prompt)
  } finally {
    handle.dispose()
  }
})
