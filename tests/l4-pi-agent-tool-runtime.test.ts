import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { createJiti } from 'jiti'
import type {
  L4PiAgentToolRuntime,
  L4PiAgentToolRuntimeEvent
} from '../src/server/l4_foundation/pi/l4-pi-agent-tool-runtime'

const serverOnlyEntry = createRequire(import.meta.url).resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})
const runtimeModule = jiti.import<
  typeof import('../src/server/l4_foundation/pi/l4-pi-agent-tool-runtime')
>('../src/server/l4_foundation/pi/l4-pi-agent-tool-runtime.ts')

async function createFixture(): Promise<{
  runtime: L4PiAgentToolRuntime
  events: L4PiAgentToolRuntimeEvent[]
  emitAgent: (event: AgentEvent) => void
  emitSession: (event: AgentSessionEvent) => void
}> {
  const { L4PiAgentToolRuntime } = await runtimeModule
  const agentListeners = new Set<(event: AgentEvent) => void>()
  const sessionListeners = new Set<(event: AgentSessionEvent) => void>()
  const session = {
    sessionId: 'tool-turn-cleanup',
    agent: {
      state: { pendingToolCalls: new Set<string>(), streamingMessage: null },
      subscribe(listener: (event: AgentEvent) => void): () => void {
        agentListeners.add(listener)
        return () => agentListeners.delete(listener)
      }
    },
    sessionManager: { getBranch: () => [] },
    subscribe(listener: (event: AgentSessionEvent) => void): () => void {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    }
  } as unknown as AgentSession
  const runtime = new L4PiAgentToolRuntime(session)
  const events: L4PiAgentToolRuntimeEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return {
    runtime,
    events,
    emitAgent(event): void {
      for (const listener of agentListeners) listener(event)
    },
    emitSession(event): void {
      for (const listener of sessionListeners) listener(event)
    }
  }
}

function assistantMessage(names: string[]): AssistantMessage {
  return {
    role: 'assistant',
    content: names.map((name, index) => ({
      type: 'toolCall',
      id: `call-${index}-${name}`,
      name,
      arguments: {}
    })),
    api: 'openai-responses',
    provider: 'openai',
    model: 'fixture',
    stopReason: 'pending',
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  }
}

for (const name of ['agent', 'read', 'bash']) {
  for (const stopReason of ['aborted', 'error'] as const) {
    test(`${name} 参数流 ${stopReason} 后立即移除卡片，不等待后续会话 settled`, async () => {
      const { runtime, events, emitAgent, emitSession } = await createFixture()
      try {
        const message = assistantMessage([name])
        runtime.syncStreamingTools(message)
        const tempId = runtime.tempId(`call-0-${name}`)
        assert.ok(tempId)
        message.stopReason = stopReason
        runtime.syncStreamingTools(message)
        emitAgent({ type: 'turn_end', message, toolResults: [] })
        emitSession({ type: 'agent_end', messages: [message], willRetry: false })
        await Promise.resolve()

        assert.deepEqual(runtime.activeMessages(), [])
        assert.deepEqual(
          events.filter((event) => event.type === 'message_discard'),
          [{ type: 'message_discard', tempId }]
        )

        emitAgent({ type: 'agent_start' })
        emitAgent({ type: 'turn_start' })
        const nextMessage = assistantMessage(['write'])
        runtime.syncStreamingTools(nextMessage)
        await Promise.resolve()
        assert.deepEqual(
          runtime.activeMessages().map(({ message }) => message.type === 'tool' && message.name),
          ['write']
        )
      } finally {
        runtime.dispose()
      }
    })
  }
}

test('批量工具中断时只丢弃未提交卡片，保留已提交结果且不重复丢弃', async () => {
  const { runtime, events, emitAgent, emitSession } = await createFixture()
  try {
    const message = assistantMessage(['read', 'bash', 'agent'])
    message.stopReason = 'toolUse'
    runtime.syncStreamingTools(message)
    const skippedTempId = runtime.tempId('call-2-agent')
    assert.ok(skippedTempId)
    const results: ToolResultMessage[] = []
    for (const [index, name] of ['read', 'bash'].entries()) {
      const toolCallId = `call-${index}-${name}`
      emitAgent({ type: 'tool_execution_start', toolCallId, toolName: name, args: {} })
      const result: ToolResultMessage = {
        role: 'toolResult',
        toolCallId,
        toolName: name,
        content: [{ type: 'text', text: name === 'bash' ? 'Operation aborted' : '读取完成' }],
        isError: name === 'bash',
        timestamp: 0
      }
      emitAgent({
        type: 'tool_execution_end',
        toolCallId,
        toolName: name,
        result,
        isError: result.isError
      })
      // Worker 在真实 ToolResult 提交后移除映射；轮次清理不得再发这些 tempId 的 discard。
      runtime.remove(toolCallId)
      results.push(result)
    }
    emitAgent({ type: 'turn_end', message, toolResults: results })
    assert.deepEqual(runtime.activeMessages(), [])
    emitSession({ type: 'agent_settled' })
    await Promise.resolve()
    assert.deepEqual(
      events.filter((event) => event.type === 'message_discard'),
      [{ type: 'message_discard', tempId: skippedTempId }]
    )
  } finally {
    runtime.dispose()
  }
})
