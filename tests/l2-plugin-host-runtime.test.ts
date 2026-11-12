import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import type { BrowserPluginHost, ChatSubmitResult } from '@jetcrab/pi-desk-sdk/browser'
import { createL2WorkbenchBiz } from '../src/client/l2_biz/workbench/l2-workbench-biz'
import { createL2WorkbenchChatInputRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat-input-runtime'
import type { L2WorkbenchChatRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat'
import type {
  L2WorkbenchChatInputRepository,
  L2WorkbenchStoredInput
} from '../src/client/l2_biz/workbench/l2-workbench-chat-input-repository'
import { createL2PluginHostRuntime } from '../src/client/l2_biz/plugin-host/l2-plugin-host-runtime'
import type { L4AppSocketOwner } from '../src/client/l4_foundation/realtime/app-socket/l4-app-socket'
import { L2ChatSocketContracts } from '../src/common/l2_biz/chat/l2-chat-websocket-contract'
import type { L4AppSocketRequestContract } from '../src/common/l4_foundation/realtime/l4-app-websocket-contract'

const source = {
  workId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'reload-test',
  branchId: 'v1:main'
}

test('SDK Pi reload 按 workId 解析当前绑定并复用 chat/reload 合同，不发送 Prompt 或刷新页面', async (context) => {
  const url = `data:text/javascript,${encodeURIComponent('export const state = {}; export default function(plugin) { state.host = plugin.host }')}`
  const entryUrl = '/api/plugins/browser-resources/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/entry.js'
  // 在 Node 测试中将宿主托管的合法 Entry URL 映射到内存 Fixture。
  register(
    `data:text/javascript,${encodeURIComponent(`export function resolve(specifier, context, next) { return next(specifier === ${JSON.stringify(entryUrl)} ? ${JSON.stringify(url)} : specifier, context) }`)}`,
    import.meta.url
  )
  const fixture = (await import(url)) as { state: { host?: BrowserPluginHost } }
  const calls: Array<{ contract: unknown; input: unknown }> = []
  let finish!: () => void
  let failure: Error | null = null
  const owner: L4AppSocketOwner = {
    connect: async () => false,
    async request<TInput, TOutput>(
      contract: L4AppSocketRequestContract<TInput, TOutput>,
      input: TInput
    ): Promise<TOutput> {
      if (contract.path === 'plugins/browser-entries/list') {
        return contract.outputSchema.parse({
          entries: [{ pluginName: 'reload-test', url: entryUrl }]
        })
      }
      calls.push({ contract, input })
      if (failure) throw failure
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return contract.outputSchema.parse({})
    },
    subscribe: () => () => undefined,
    waitForClose: async () => ({ code: 1000, reason: '' }),
    close: () => undefined
  }
  const { pluginHost } = createL2PluginHostRuntime(owner)
  context.after(() => pluginHost.dispose())
  pluginHost.replaceWorkSessions([{ ...source, cwd: '/test', status: 'idle' }])
  pluginHost.markReady()
  await pluginHost.refreshEntries()
  assert.equal(pluginHost.getEntryState('reload-test').status, 'ready')
  const reload = fixture.state.host?.pi.reload
  assert.ok(reload)
  let completed = false
  const pending = reload(source.workId).then(() => {
    completed = true
  })
  assert.equal(completed, false)
  assert.equal(calls[0]?.contract, L2ChatSocketContracts.reload)
  assert.deepEqual(calls[0]?.input, { source })
  assert.equal(L2ChatSocketContracts.reload.timeoutMs, 125_000)
  finish()
  await pending
  assert.equal(completed, true)
  const current = { ...source, sessionId: 'new-session', branchId: 'v1:new' }
  pluginHost.replaceWorkSessions([{ ...current, cwd: '/test', status: 'idle' }])
  const rebound = reload(source.workId)
  assert.equal(calls[1]?.contract, L2ChatSocketContracts.reload)
  assert.deepEqual(calls[1]?.input, { source: current })
  finish()
  await rebound
  failure = new Error('当前会话不能重载 Pi 配置：模型正在运行')
  await assert.rejects(reload(source.workId), (error) => error === failure)
  assert.equal(calls.length, 3)
})

test('输入区和插件 Prompt 共用一次提交结果，接管后清理失败不误报、本地拒绝不发布', async (context) => {
  const url = `data:text/javascript,${encodeURIComponent('export const state = {}; export default function(plugin) { state.host = plugin.host } // submit-events')}`
  const entryUrl = '/api/plugins/browser-resources/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/entry.js'
  register(
    `data:text/javascript,${encodeURIComponent(`export function resolve(specifier, context, next) { return next(specifier === ${JSON.stringify(entryUrl)} ? ${JSON.stringify(url)} : specifier, context) }`)}`,
    import.meta.url
  )
  const fixture = (await import(url)) as { state: { host?: BrowserPluginHost } }
  let sendCalls = 0
  let failure: Error | null = null
  const owner: L4AppSocketOwner = {
    connect: async () => false,
    async request<TInput, TOutput>(
      contract: L4AppSocketRequestContract<TInput, TOutput>
    ): Promise<TOutput> {
      if (contract.path === 'plugins/browser-entries/list') {
        return contract.outputSchema.parse({
          entries: [{ pluginName: 'submit-test', url: entryUrl }]
        })
      }
      assert.equal(contract.path, 'chat/send')
      sendCalls += 1
      if (failure) throw failure
      return contract.outputSchema.parse({
        tempId: `00000000-0000-4000-8000-${String(sendCalls).padStart(12, '0')}`
      })
    },
    subscribe: () => () => undefined,
    waitForClose: async () => ({ code: 1000, reason: '' }),
    close: () => undefined
  }
  const { appSocket, pluginHost } = createL2PluginHostRuntime(owner)
  context.after(() => pluginHost.dispose())
  pluginHost.markReady()
  await pluginHost.refreshEntries()
  const host = fixture.state.host
  assert.ok(host)
  const events: ChatSubmitResult[] = []
  host.events.on('chat-submit-result', (result) => {
    events.push(result)
  })
  await Promise.resolve()
  assert.deepEqual(events, [])
  const biz = createL2WorkbenchBiz('client-test', appSocket)
  const chat = {
    getSourceState: () => ({ syncStatus: 'ready' }),
    subscribeSourceEvents: () => () => undefined
  } as unknown as L2WorkbenchChatRuntime
  const stored: { draft: L2WorkbenchStoredInput | null; outbox: L2WorkbenchStoredInput | null } = {
    draft: null,
    outbox: null
  }
  let failClear = true
  let deleteCalls = 0
  const repository: L2WorkbenchChatInputRepository = {
    async recoverOutbox() {
      if (stored.outbox) {
        return { input: await this.restoreOutboxToDraft(source), recovered: true }
      }
      return { input: structuredClone(stored.draft ?? { text: '', images: [] }), recovered: false }
    },
    async writeDraft(_source, value) {
      stored.draft = structuredClone(value)
    },
    async moveDraftToOutbox(_source, value) {
      stored.outbox = structuredClone(value)
      stored.draft = null
    },
    async clearOutbox() {
      if (failClear) throw new Error('本地清理失败')
      stored.outbox = null
    },
    async restoreOutboxToDraft() {
      assert.ok(stored.outbox)
      stored.draft = {
        text: [stored.outbox.text, stored.draft?.text].filter(Boolean).join('\n\n'),
        images: [...stored.outbox.images, ...(stored.draft?.images ?? [])]
      }
      stored.outbox = null
      return structuredClone(stored.draft)
    },
    async deleteOutbox() {
      deleteCalls += 1
      await this.clearOutbox(source)
    },
    async clearSource() {
      stored.draft = null
      stored.outbox = null
    }
  }
  const input = createL2WorkbenchChatInputRuntime(biz, chat, repository)
  context.after(() => input.dispose())
  await input.loadSource(source)
  await assert.rejects(input.send(source, 'auto'))
  await assert.rejects(host.pi.prompt(source, { mode: 'auto', text: '' }))
  assert.equal(sendCalls, 0)
  assert.deepEqual(events, [])

  const callbackErrors: unknown[][] = []
  const originalConsoleError = console.error
  console.error = (...args): void => {
    callbackErrors.push(args)
  }
  context.after(() => {
    console.error = originalConsoleError
  })
  const offSync = host.events.on('chat-submit-result', () => {
    throw new Error('同步监听失败')
  })
  const offAsync = host.events.on('chat-submit-result', async () => {
    throw new Error('异步监听失败')
  })
  await biz.sendChat({ source, mode: 'auto', text: '输入业务发送', images: [] })
  await Promise.resolve()
  offSync()
  offAsync()
  assert.equal(callbackErrors.length, 2)
  assert.match(JSON.stringify(callbackErrors), /submit-test/)
  await host.pi.prompt(source, { mode: 'auto', text: '插件发送' })
  input.setText(source, '已接管之后清理失败')
  await assert.rejects(input.send(source, 'auto'), /本地清理失败/)
  assert.equal(input.getState(source).outbox?.status, 'failed')
  assert.equal(input.getState(source).outbox?.text, '已接管之后清理失败')
  assert.equal(input.getState(source).outbox?.error, '本地清理失败')
  assert.deepEqual(stored.outbox, { text: '已接管之后清理失败', images: [] })
  assert.equal(input.getState(source).followRequested, true)
  assert.deepEqual(events, [
    { source, status: 'accepted', tempId: '00000000-0000-4000-8000-000000000001' },
    { source, status: 'accepted', tempId: '00000000-0000-4000-8000-000000000002' },
    { source, status: 'accepted', tempId: '00000000-0000-4000-8000-000000000003' }
  ])

  failClear = false
  await input.deleteOutbox(source)
  assert.equal(deleteCalls, 1)
  assert.equal(stored.outbox, null)
  assert.equal(input.getState(source).outbox, null)
  input.dispose()
  const restored = createL2WorkbenchChatInputRuntime(biz, chat, repository)
  context.after(() => restored.dispose())
  await restored.loadSource(source)
  assert.equal(restored.getState(source).text, '')
  assert.equal(restored.getState(source).notice, null)
  assert.equal(restored.getState(source).outbox, null)
  assert.equal(events.length, 3)
  assert.equal(sendCalls, 3)

  failure = new Error('当前来源已失效')
  await assert.rejects(biz.sendChat({ source, mode: 'auto', text: '拒绝', images: [] }))
  failure = new Error('翻译后的断线消息')
  Object.defineProperty(failure, 'rawMessage', { value: 'WebSocket 连接已断开' })
  await assert.rejects(host.pi.prompt(source, { mode: 'auto', text: '未知' }))
  assert.deepEqual(events.slice(3), [
    { source, status: 'failed', message: '当前来源已失效' },
    { source, status: 'unknown', message: '翻译后的断线消息' }
  ])
  assert.equal(sendCalls, 5)
})
