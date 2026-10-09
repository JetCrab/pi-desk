import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { L4PluginHostContext } from '../src/client/l4_foundation/plugin-host/l4-plugin-host-context'
import type {
  L4PluginHostRuntime,
  L4PluginMessageViewResolution
} from '../src/client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import { L3ConversationMessageView } from '../src/client/l3_modules/conversation/l3-conversation-plugin-message'
import type { L3ConversationDisplayMessage } from '../src/client/l3_modules/conversation/l3-conversation-display'
import { L3ConversationDurableMessageSnapshotSchema } from '../src/common/l3_modules/conversation/l3-conversation-contract'
import { L3_CONVERSATION_LOCALE_MESSAGES } from '../src/common/l3_modules/conversation/l3-conversation-locale-messages'

const i18n = createInstance()
test.before(async () => {
  await i18n.init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { conversation: L3_CONVERSATION_LOCALE_MESSAGES['zh-CN'] } }
  })
})

function renderMessage(
  viewKey: string,
  maintaining: boolean,
  resolution: L4PluginMessageViewResolution = null
): string {
  const snapshot = L3ConversationDurableMessageSnapshotSchema.parse({
    location: { index: 0, entryId: 'entry-1' },
    fixed: { type: 'user', viewKey, timestampMs: 1, hasDetail: false },
    summary: { text: '已保存的聊天正文', images: [] }
  })
  const message: L3ConversationDisplayMessage = {
    identity: 'entry-1',
    position: 0,
    viewKey,
    snapshot,
    summary: { type: 'user', text: '已保存的聊天正文', images: [], hasDetail: false },
    detail: undefined,
    temporary: false,
    timestampMs: 1,
    durable: snapshot,
    tempId: null
  }
  const registry = { revision: 1, descriptors: [] }
  // 仅隔离Entry状态；正文选择由真实消息组件执行。
  const runtime = Object.create(null) as L4PluginHostRuntime
  Object.assign(runtime, {
    subscribeRegistry: (): (() => void) => () => undefined,
    getRegistrySnapshot: () => registry,
    getMessageViewResolution: () => resolution,
    areEntriesInitialized: () => true,
    isRefreshingEntries: () => maintaining,
    getEntryState: () => ({ status: 'ready', runtime: {} })
  })
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        L4PluginHostContext.Provider,
        { value: runtime },
        createElement(L3ConversationMessageView, {
          message,
          loadDetail: async () => null,
          defaultView: createElement('p', null, '内置正文持续可读')
        })
      )
    )
  )
}

test('插件维护标记往返不会隐藏无覆盖的内置聊天正文', () => {
  for (const maintaining of [false, true, false, true]) {
    assert.match(renderMessage('pi-desk/user', maintaining), /内置正文持续可读/)
  }
})

test('覆盖内置协议的插件加载期间使用该项内置展示', () => {
  const resolution: L4PluginMessageViewResolution = {
    status: 'winner',
    pluginName: 'fixture-view',
    descriptor: {
      kind: 'message-view',
      contributionName: 'user-view',
      viewKey: 'pi-desk/user',
      priority: 100
    }
  }
  assert.match(renderMessage('pi-desk/user', true, resolution), /内置正文持续可读/)
})

test('视图优先级冲突保留正文及诊断，不选择另一个插件视图', () => {
  const markup = renderMessage('pi-desk/user', false, {
    status: 'conflict',
    viewKey: 'pi-desk/user',
    candidates: []
  })
  assert.match(markup, /内置正文持续可读/)
  assert.match(markup, /role="alert"/)
})

test('未知插件协议过渡期间保留公共内容入口，不错误套用内置正文', () => {
  const markup = renderMessage('fixture/custom', true)
  assert.doesNotMatch(markup, /内置正文持续可读/)
  assert.match(markup, /已保存的聊天正文/)
  assert.match(markup, /<details/)
})
