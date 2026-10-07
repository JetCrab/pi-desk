import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent'
import { createJiti } from 'jiti'
import {
  L3ConversationBashToolSummarySchema,
  L3ConversationBashToolTimingSchema
} from '../src/common/l3_modules/conversation/l3-conversation-contract'
import type { L4PiChatMessage } from '../src/server/l4_foundation/pi/l4-pi-chat-projection'
import { formatL3ConversationBashToolDuration } from '../src/client/l3_modules/conversation/l3-conversation-display'

const source = { workId: 'work-1', sessionId: 'session-1', branchId: 'v1:main' }
const TEMP_ID = '11111111-1111-4111-8111-111111111111'
const serverOnlyEntry = createRequire(import.meta.url).resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})
const serverModulesPromise = Promise.all([
  jiti.import<
    typeof import('../src/server/l3_modules/conversation/l3-conversation-projection-core')
  >('../src/server/l3_modules/conversation/l3-conversation-projection-core.ts'),
  jiti.import<typeof import('../src/server/l4_foundation/pi/l4-pi-chat-projection')>(
    '../src/server/l4_foundation/pi/l4-pi-chat-projection.ts'
  ),
  jiti.import<typeof import('../src/server/l4_foundation/pi/l4-pi-message-declaration-core')>(
    '../src/server/l4_foundation/pi/l4-pi-message-declaration-core.ts'
  ),
  jiti.import<typeof import('@earendil-works/pi-coding-agent')>('@earendil-works/pi-coding-agent'),
  jiti.import<typeof import('../src/server/l4_foundation/pi/l4-pi-chat-worker')>(
    '../src/server/l4_foundation/pi/l4-pi-chat-worker.ts'
  ),
  jiti.import<typeof import('../src/server/l4_foundation/pi/l4-pi-agent-tool-runtime')>(
    '../src/server/l4_foundation/pi/l4-pi-agent-tool-runtime.ts'
  )
])

function bashMessage(
  options: {
    name?: string
    status?: 'running' | 'completed' | 'error'
    startedAtMs?: number | null
    durationMs?: number | null
  } = {}
): L4PiChatMessage {
  const name = options.name ?? 'bash'
  return {
    type: 'tool',
    name,
    reasoning: '执行命令',
    inputPreview: 'printf test',
    activity: null,
    status: options.status ?? 'running',
    usage: null,
    output: '',
    startedAtMs: options.startedAtMs ?? null,
    durationMs: options.durationMs ?? null,
    declaration: {
      message: {
        kind: 'tool',
        toolName: name,
        toolCallId: 'call-bash',
        arguments: { command: 'printf test' },
        partialResult: null,
        result: null,
        isError: false
      },
      raw: null
    }
  }
}

function toolResultEntry(id: string, details?: unknown): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'toolResult',
      toolCallId: 'call-bash',
      toolName: 'bash',
      content: [{ type: 'text', text: '命令完成' }],
      ...(details === undefined ? {} : { details }),
      isError: false,
      timestamp: Date.parse('2026-01-01T00:00:00.000Z')
    }
  } as SessionEntry
}

test('Bash timing 格式按完整秒向下取整并切换分钟和小时单位', () => {
  assert.equal(formatL3ConversationBashToolDuration(59_000), '59s')
  assert.equal(formatL3ConversationBashToolDuration(60_000), '1m 0s')
  assert.equal(formatL3ConversationBashToolDuration(62_000), '1m 2s')
  assert.equal(formatL3ConversationBashToolDuration(3_728_000), '1h 2m 8s')
  assert.equal(formatL3ConversationBashToolDuration(999), '0s')
  assert.equal(formatL3ConversationBashToolDuration(1_999), '1s')
})

test('Bash timing Common schema 接受开始、完成和空值并拒绝冲突或负数', () => {
  assert.equal(L3ConversationBashToolTimingSchema.safeParse({ startedAtMs: 123 }).success, true)
  assert.equal(L3ConversationBashToolTimingSchema.safeParse({ durationMs: 62_000 }).success, true)
  assert.equal(
    L3ConversationBashToolSummarySchema.safeParse({
      name: 'bash',
      reasoning: '执行命令',
      inputPreview: 'printf test',
      activity: null,
      timing: null
    }).success,
    true
  )
  assert.equal(
    L3ConversationBashToolTimingSchema.safeParse({ startedAtMs: 123, durationMs: 1 }).success,
    false
  )
  assert.equal(L3ConversationBashToolTimingSchema.safeParse({ startedAtMs: -1 }).success, false)
  assert.equal(L3ConversationBashToolTimingSchema.safeParse({ durationMs: -1 }).success, false)
})

test('默认 Bash 声明按生命周期投影 timing，非 Bash 不携带 timing', async () => {
  const [, , { projectL4PiMessageDeclarationCore }] = await serverModulesPromise
  const running = projectL4PiMessageDeclarationCore({
    source,
    stage: 'temporary',
    message: bashMessage({ startedAtMs: 1_700_000_000_000 }),
    declarations: []
  })
  assert.equal(running.viewKey, 'pi-desk/bash-tool')
  assert.deepEqual(running.summary.timing, { startedAtMs: 1_700_000_000_000 })

  const completed = projectL4PiMessageDeclarationCore({
    source,
    stage: 'temporary',
    message: bashMessage({ status: 'completed', durationMs: 62_000 }),
    declarations: []
  })
  assert.equal(completed.viewKey, 'pi-desk/bash-tool')
  assert.deepEqual(completed.summary.timing, { durationMs: 62_000 })

  const nonBash = projectL4PiMessageDeclarationCore({
    source,
    stage: 'durable',
    message: bashMessage({ name: 'read', status: 'completed', durationMs: 62_000 }),
    declarations: []
  })
  assert.equal(nonBash.viewKey, 'pi-desk/read')
  assert.equal('timing' in nonBash.summary, false)
})

test('公共 Temporary/Durable 投影保留 Bash timing，并保持非 Bash Summary 形状', async () => {
  const [{ projectL3ConversationDurableMessageCore, projectL3ConversationTemporaryMessageCore }] =
    await serverModulesPromise
  const temporary = projectL3ConversationTemporaryMessageCore(
    TEMP_ID,
    bashMessage({ startedAtMs: 1_700_000_000_000 }),
    source,
    []
  )
  assert.equal(temporary.fixed.viewKey, 'pi-desk/bash-tool')
  assert.deepEqual(temporary.summary.timing, { startedAtMs: 1_700_000_000_000 })

  const durable = projectL3ConversationDurableMessageCore(
    0,
    'entry-bash',
    1_700_000_000_100,
    bashMessage({ status: 'completed', durationMs: 62_000 }),
    source,
    []
  )
  assert.equal(durable.fixed.viewKey, 'pi-desk/bash-tool')
  assert.deepEqual(durable.summary.timing, { durationMs: 62_000 })
})

test('Durable ToolResult 从 details.durationMs 恢复，非法或缺失值被忽略', async () => {
  const [, { projectL4PiChatEntries }] = await serverModulesPromise
  const cases: Array<{ details?: unknown; expected: number | null }> = [
    { details: { durationMs: 62_000 }, expected: 62_000 },
    { details: { durationMs: -1 }, expected: null },
    { details: { durationMs: '62s' }, expected: null },
    { details: { durationMs: null }, expected: null },
    { details: { kind: 'other' }, expected: null },
    { expected: null }
  ]

  for (const [index, item] of cases.entries()) {
    const projected = projectL4PiChatEntries([
      toolResultEntry(`entry-bash-${index}`, item.details)
    ])[0]
    assert.ok(projected)
    assert.equal(projected.message.type, 'tool')
    assert.equal(projected.message.durationMs, item.expected)
  }
})

test('共享 AgentToolRuntime 在无详情监听器时按 turn_end 清理已完成工具', async () => {
  const [, , , , , { retainL4PiAgentToolRuntime }] = await serverModulesPromise
  const agentListeners = new Set<(event: unknown) => void>()
  const sessionListeners = new Set<(event: unknown) => void>()
  const fakeAgent = {
    state: { pendingToolCalls: new Set<string>(), streamingMessage: null },
    subscribe(listener: (event: unknown) => void): () => void {
      agentListeners.add(listener)
      return () => agentListeners.delete(listener)
    },
    emit(event: unknown): void {
      for (const listener of [...agentListeners]) listener(event)
    }
  }
  const session = {
    sessionId: 'turn-end-cleanup-session',
    agent: fakeAgent,
    sessionManager: {
      getBranch: () => [],
      getLeafEntry: () => null,
      getEntries: () => []
    },
    subscribe(listener: (event: unknown) => void): () => void {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    }
  } as unknown as AgentSession
  const lease = retainL4PiAgentToolRuntime(session)
  const events: string[] = []
  const unsubscribe = lease.runtime.subscribe((event) => {
    events.push(event.type)
  })

  try {
    for (let index = 0; index < 40; index += 1) {
      const toolCallId = `call-read-${index}`
      fakeAgent.emit({
        type: 'tool_execution_start',
        toolCallId,
        toolName: 'read',
        args: { path: `docs/第${index}轮.md` }
      })
      fakeAgent.emit({
        type: 'tool_execution_end',
        toolCallId,
        toolName: 'read',
        result: { content: [{ type: 'text', text: '读取完成' }] },
        isError: false
      })
      fakeAgent.emit({ type: 'turn_end', toolResults: [{ toolCallId }] })
      assert.equal(lease.runtime.size, 0)
    }

    assert.equal(events.filter((type) => type === 'message_discard').length, 40)

    fakeAgent.emit({
      type: 'tool_execution_start',
      toolCallId: 'call-settled',
      toolName: 'read',
      args: { path: 'README.md' }
    })
    for (const listener of [...sessionListeners]) listener({ type: 'agent_settled' })
    await Promise.resolve()
    assert.equal(lease.runtime.size, 0)
  } finally {
    unsubscribe()
    lease.release()
  }
})

test('共享 AgentToolRuntime 只接纳顶层工具，嵌套事件不创建独立临时消息', async () => {
  const [, , , , , { retainL4PiAgentToolRuntime }] = await serverModulesPromise
  const listeners = new Set<(event: unknown) => void>()
  const emit = (event: unknown): void => {
    for (const listener of listeners) listener(event)
  }
  const session = {
    sessionId: 'nested-tool-fixture',
    agent: {
      state: { pendingToolCalls: new Set<string>(), streamingMessage: null },
      subscribe(listener: (event: unknown) => void): () => void {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    },
    sessionManager: { getBranch: () => [] },
    subscribe: () => () => undefined
  } as unknown as AgentSession
  const lease = retainL4PiAgentToolRuntime(session)
  const started: string[] = []
  const unsubscribe = lease.runtime.subscribe((event) => {
    if (event.type === 'message_start' && event.message.type === 'tool')
      started.push(event.message.name)
  })
  try {
    emit({
      type: 'tool_execution_start',
      toolCallId: 'top/with-slash',
      toolName: 'codemode',
      args: { code: 'return 1' }
    })
    for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
      emit({
        type,
        toolCallId: 'nested-opaque-id',
        parentToolCallId: 'top/with-slash',
        toolName: 'read',
        args: {},
        partialResult: { content: [] },
        result: { content: [] },
        isError: false
      })
      assert.equal(lease.runtime.size, 1)
      assert.equal(lease.runtime.tempId('nested-opaque-id'), null)
    }
    assert.deepEqual(started, ['codemode'])
    assert.ok(lease.runtime.tempId('top/with-slash'))
    emit({
      type: 'tool_execution_end',
      toolCallId: 'top/with-slash',
      toolName: 'codemode',
      result: { content: [] },
      isError: false
    })
    emit({ type: 'turn_end', toolResults: [{ toolCallId: 'top/with-slash' }] })
    assert.equal(lease.runtime.size, 0)
  } finally {
    unsubscribe()
    lease.release()
  }
})

test('Worker Bash Tool 开始只发布一次 startedAtMs，结束写回 result.details 且无周期更新', async () => {
  const [, , , { SessionManager }, { L4PiChatWorker }, { retainL4PiAgentToolRuntime }] =
    await serverModulesPromise
  const manager = SessionManager.inMemory('C:/project')
  const worker = new L4PiChatWorker('C:/project', manager)
  const events: Array<{ type: string; message?: L4PiChatMessage }> = []
  const unsubscribe = worker.subscribe((event) => {
    if ('message' in event) events.push({ type: event.type, message: event.message })
    else events.push({ type: event.type })
  })
  const agentListeners = new Set<(event: unknown) => void>()
  const fakeAgent = {
    state: { pendingToolCalls: new Set<string>(), streamingMessage: null },
    subscribe(listener: (event: unknown) => void): () => void {
      agentListeners.add(listener)
      return () => agentListeners.delete(listener)
    },
    emit(event: unknown): void {
      for (const listener of [...agentListeners]) listener(event)
    }
  }
  const session = {
    sessionId: 'worker-bash-session',
    agent: fakeAgent,
    sessionManager: {
      getBranch: () => [],
      getLeafEntry: () => null,
      getEntries: () => []
    },
    subscribe(): () => void {
      return () => undefined
    },
    clearQueue(): void {},
    abortCompaction(): void {},
    abort(): Promise<void> {
      return Promise.resolve()
    },
    extensionRunner: {
      emit(): Promise<void> {
        return Promise.resolve()
      }
    },
    dispose(): void {}
  } as unknown as AgentSession
  const lease = retainL4PiAgentToolRuntime(session)
  Reflect.set(worker, 'session', session)
  Reflect.set(worker, 'toolRuntime', lease.runtime)
  Reflect.set(worker, 'toolRuntimeLease', lease)
  Reflect.set(
    worker,
    'unsubscribeToolRuntime',
    lease.runtime.subscribe((event) => Reflect.apply(Reflect.get(worker, 'emit'), worker, [event]))
  )
  const result: {
    content: Array<{ type: 'text'; text: string }>
    details: Record<string, unknown>
  } = {
    content: [{ type: 'text', text: '命令完成' }],
    details: { marker: 'preserved' }
  }

  try {
    fakeAgent.emit({
      type: 'tool_execution_start',
      toolCallId: 'call-bash',
      toolName: 'bash',
      args: { command: 'printf test' }
    })
    fakeAgent.emit({
      type: 'tool_execution_end',
      toolCallId: 'call-bash',
      toolName: 'bash',
      result,
      isError: false
    })
    Reflect.apply(Reflect.get(worker, 'flushLiveUpdates'), worker, [])

    assert.deepEqual(
      events.map((event) => event.type),
      ['message_start', 'message_update']
    )
    const started = events[0]?.message
    const completed = events[1]?.message
    assert.equal(started?.type, 'tool')
    assert.equal(completed?.type, 'tool')
    assert.equal(typeof started?.startedAtMs, 'number')
    assert.equal(started?.durationMs, null)
    assert.equal(completed?.startedAtMs, started?.startedAtMs)
    assert.equal(typeof completed?.durationMs, 'number')
    assert.equal(result.details.marker, 'preserved')
    assert.equal(result.details.durationMs, completed?.durationMs)

    await new Promise((resolve) => setTimeout(resolve, 90))
    assert.deepEqual(
      events.map((event) => event.type),
      ['message_start', 'message_update']
    )
  } finally {
    unsubscribe()
    await worker.dispose()
  }
})
