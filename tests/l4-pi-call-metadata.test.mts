import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import { SessionManager } from '@earendil-works/pi-coding-agent'
const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: resolve('tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
const { projectL4PiChatEntries, projectL4PiAgentMessage, projectL4PiChatEntry } = await jiti.import<
  typeof import('../src/server/l4_foundation/pi/l4-pi-chat-projection')
>('../src/server/l4_foundation/pi/l4-pi-chat-projection.ts')
const { projectL4PiMessageDeclarationCore } = await jiti.import<
  typeof import('../src/server/l4_foundation/pi/l4-pi-message-declaration-core')
>('../src/server/l4_foundation/pi/l4-pi-message-declaration-core.ts')
const source = { workId: 'fixture', sessionId: 'fixture-session', branchId: 'v1:main' }
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

test('只读调用列表使用真实回复模型，不随后来的选择变化或生成额外详情', () => {
  const manager = SessionManager.inMemory()
  manager.appendModelChange('router', 'auto')
  manager.appendThinkingLevelChange('high')
  const id = manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
    provider: 'physical-provider',
    model: 'physical-id',
    responseModel: 'actual-response-id',
    api: 'openai-completions',
    providerThinkingLevel: 'provider-medium',
    thinkingLevel: 'medium',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage
  })
  manager.appendModelChange('router', 'later-choice')
  manager.appendThinkingLevelChange('off')
  const message = projectL4PiChatEntries(manager.getBranch()).find(
    (entry) => entry.entryId === id
  )?.message
  assert.ok(message)
  const projected = projectL4PiMessageDeclarationCore({ source, stage: 'durable', message })
  assert.deepEqual(projected.summary.model, {
    provider: 'physical-provider',
    modelId: 'actual-response-id'
  })
  assert.equal(projected.detail, null)
  assert.equal(manager.getEntry(id)?.type, 'message')
  const entry = manager.getEntry(id)!
  const live = projectL4PiChatEntry(entry)!
  assert.deepEqual(
    projectL4PiMessageDeclarationCore({ source, stage: 'durable', message: live.message }).summary,
    projected.summary
  )
})

test('虚拟路由未执行模型时，错误记录不伪装成物理模型响应', () => {
  const message = projectL4PiAgentMessage({
    role: 'assistant',
    api: 'pi-virtual',
    provider: 'router',
    model: 'auto',
    content: [],
    stopReason: 'error',
    errorMessage: 'route failed',
    timestamp: Date.now(),
    usage
  })
  assert.ok(message)
  const projected = projectL4PiMessageDeclarationCore({ source, stage: 'durable', message })
  assert.equal(projected.summary.model, null)
})

test('Codemode 的 canonical 嵌套记录属于父详情，图片只投影元数据', () => {
  const image =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  const message = projectL4PiAgentMessage({
    role: 'toolResult',
    toolCallId: 'parent',
    toolName: 'codemode',
    content: [
      { type: 'text', text: 'done' },
      { type: 'image', mimeType: 'image/png', data: image }
    ],
    nestedCalls: {
      complete: false,
      calls: [
        { id: 'parent/1', name: 'read', arguments: { path: 'a.txt' }, status: 'ok', durationMs: 20 }
      ]
    },
    isError: false,
    timestamp: Date.now()
  })
  assert.ok(message)
  const projected = projectL4PiMessageDeclarationCore({ source, stage: 'durable', message })
  assert.equal(projected.viewKey, 'pi-desk/codemode')
  assert.deepEqual(projected.summary.images, [{ mimeType: 'image/png', width: 1, height: 1 }])
  assert.deepEqual(projected.detail?.nestedCalls, {
    complete: false,
    calls: [{ name: 'read', arguments: { path: 'a.txt' }, status: 'ok', durationMs: 20 }]
  })
  assert.ok(!JSON.stringify(projected).includes(image))
})
