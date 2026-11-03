import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
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
