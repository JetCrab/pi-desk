import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L2ChatDurableMessageSnapshotSchema,
  type L2ChatDurableMessageSnapshot,
  type L2ChatMessageDetail,
  type L2ChatMessageDetailResponse,
  type L2ChatMessageUsage,
  type L2ChatRuntime,
  type L2ChatSource,
  type L2ChatSourceState,
  type L2ChatTemporaryMessageSnapshot
} from '../src/common/l2_biz/chat/l2-chat-contract'
import { L2ChatSocketContracts } from '../src/common/l2_biz/chat/l2-chat-websocket-contract'
import type { L2WorkSessionListItem } from '../src/common/l2_biz/work-session/l2-work-session-contract'
import { L3PiNativeSocketContracts } from '../src/common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import type {
  L4AppSocketPushContract,
  L4AppSocketRequestContract
} from '../src/common/l4_foundation/realtime/l4-app-websocket-contract'
import { createL2WorkbenchBiz } from '../src/client/l2_biz/workbench/l2-workbench-biz'
import { createL2WorkbenchChatRuntime } from '../src/client/l2_biz/workbench/l2-workbench-chat'
import {
  buildL2WorkbenchSlashCommandGroups,
  L2_WORKBENCH_RELOAD_COMMAND,
  readL2WorkbenchSlashCommandQuery
} from '../src/client/l2_biz/workbench/l2-workbench-slash-command'
import type { L2WorkbenchChatRepository } from '../src/client/l2_biz/workbench/l2-workbench-chat-repository'
import { buildL2WorkbenchContextUsageView } from '../src/client/l2_biz/workbench/l2-workbench-context-usage'
import {
  buildL3ConversationTurns,
  formatL3ConversationCost,
  formatL3ConversationTimestamp,
  formatL3ConversationTokenCount
} from '../src/client/l3_modules/conversation/l3-conversation-display'
import {
  findL3ConversationTurnIndexByMessageAnchor,
  selectL3ConversationInitialRange,
  selectL3ConversationTailRange
} from '../src/client/l3_modules/conversation/l3-conversation-progressive-window'
import type {
  L4AppSocketClient,
  L4BrowserSocketCloseInfo
} from '../src/client/l4_foundation/realtime/app-socket/l4-app-socket'

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'
const TEMP_ID = '33333333-3333-4333-8333-333333333333'
const TEMP_ID_2 = '44444444-4444-4444-8444-444444444444'
const TIMESTAMP_MS = 1_765_800_000_000
const USAGE = {
  inputTokens: 1_200,
  outputTokens: 345,
  cacheReadTokens: 6_000,
  costUsd: 0.0042
}
const EMPTY_RUNTIME = {
  extensionMode: 'normal' as const,
  presentationMode: 'normal' as const,
  initializationError: null,
  queues: { steering: [], followUp: [] },
  model: null,
  capabilityMode: null,
  contextUsage: null,
  plugins: {}
}

function workSession(sessionId = SESSION_A, branchId = 'v1:main'): L2WorkSessionListItem {
  return {
    workId: 'work-1',
    cwd: 'C:/projects/test',
    sessionId,
    branchId,
    projectName: 'test',
    sessionTitle: '测试会话',
    status: 'idle',
    messageCounts: { user: 0, total: 0 },
    lastMessageUpdatedAt: null
  }
}

function sourceFor(item: L2WorkSessionListItem): L2ChatSource {
  return { workId: item.workId, sessionId: item.sessionId, branchId: item.branchId }
}

function key(source: L2ChatSource): string {
  return `${source.sessionId}:${source.branchId}`
}

function userMessage(index: number, text: string): L2ChatDurableMessageSnapshot {
  return {
    location: { index, entryId: `entry-user-${index}` },
    fixed: {
      timestampMs: TIMESTAMP_MS + index,
      type: 'user',
      viewKey: 'pi-desk/user',
      hasDetail: false
    },
    summary: { text, images: [] }
  }
}

function assistantMessage(
  index: number,
  text: string,
  options: {
    hasDetail?: boolean
    thinking?: string
    status?: 'completed' | 'error' | 'aborted'
    errorMessage?: string | null
  } = {}
): L2ChatDurableMessageSnapshot {
  const hasDetail = options.hasDetail ?? Boolean(options.thinking)
  return {
    location: { index, entryId: `entry-assistant-${index}` },
    fixed: {
      timestampMs: TIMESTAMP_MS + index,
      type: 'assistant',
      viewKey: 'pi-desk/assistant',
      status: options.status ?? 'completed',
      usage: USAGE,
      hasDetail
    },
    summary: { text, errorMessage: options.errorMessage ?? null },
    ...(options.thinking ? { detail: { thinking: options.thinking } } : {})
  }
}

function toolMessage(
  index: number,
  options: {
    name?: string
    reasoning?: string | null
    inputPreview?: string | null
    activity?: string | null
    hasDetail?: boolean
    status?: 'running' | 'completed' | 'error'
    usage?: L2ChatMessageUsage | null
  } = {}
): L2ChatDurableMessageSnapshot {
  return {
    location: { index, entryId: `entry-tool-${index}` },
    fixed: {
      timestampMs: TIMESTAMP_MS + index,
      type: 'tool',
      viewKey: 'pi-desk/tool',
      status: options.status ?? 'completed',
      hasDetail: options.hasDetail ?? true,
      usage: options.usage ?? null
    },
    summary: {
      name: options.name ?? 'read',
      reasoning: options.reasoning ?? '读取实现',
      inputPreview: options.inputPreview ?? 'src/client/chat.tsx',
      activity: options.activity ?? '1-200'
    }
  }
}

function compactionMessage(index: number, text = '## Goal\n\n继续当前工作。') {
  return {
    location: { index, entryId: `entry-compaction-${index}` },
    fixed: {
      timestampMs: TIMESTAMP_MS + index,
      type: 'custom' as const,
      viewKey: 'pi-desk/compaction',
      hasDetail: true
    },
    summary: {},
    detail: { text }
  }
}

function compactionTemporary(tempId = TEMP_ID) {
  return {
    location: { tempId },
    fixed: {
      timestampMs: null,
      type: 'custom' as const,
      viewKey: 'pi-desk/compaction',
      hasDetail: false
    },
    summary: {}
  }
}

function assistantTemporary(text = '', thinking = '', tempId = TEMP_ID) {
  return {
    location: { tempId },
    fixed: {
      timestampMs: null,
      type: 'assistant' as const,
      viewKey: 'pi-desk/assistant',
      status: 'running' as const,
      hasDetail: thinking.length > 0,
      usage: { ...USAGE, outputTokens: 0, costUsd: 0 }
    },
    summary: { text, errorMessage: null },
    ...(thinking ? { detail: { thinking } } : {})
  }
}

class FakeRepository implements L2WorkbenchChatRepository {
  readonly messagesBySource = new Map<string, L2ChatDurableMessageSnapshot[]>()
  readonly readLatestCursorCount = new Map<string, number>()
  replaceStarted = 0
  replaceBlock: Promise<void> | null = null
  readLatestCursorBlock: Promise<void> | null = null

  async readMessages(source: L2ChatSource): Promise<L2ChatDurableMessageSnapshot[]> {
    return [...(this.messagesBySource.get(key(source)) ?? [])]
  }

  async readLatestCursor(source: L2ChatSource) {
    const sourceKey = key(source)
    this.readLatestCursorCount.set(sourceKey, (this.readLatestCursorCount.get(sourceKey) ?? 0) + 1)
    const block = this.readLatestCursorBlock
    this.readLatestCursorBlock = null
    if (block) await block
    const messages = await this.readMessages(source)
    const latest = messages.at(-1)
    return latest ? { index: latest.location.index, entryId: latest.location.entryId } : null
  }

  async replaceMessages(
    source: L2ChatSource,
    messages: readonly L2ChatDurableMessageSnapshot[]
  ): Promise<void> {
    this.replaceStarted += 1
    const block = this.replaceBlock
    this.replaceBlock = null
    if (block) await block
    this.messagesBySource.set(key(source), [...messages])
  }

  async appendMessage(source: L2ChatSource, message: L2ChatDurableMessageSnapshot): Promise<void> {
    const current = this.messagesBySource.get(key(source)) ?? []
    this.messagesBySource.set(key(source), [...current, message])
  }

  async saveDetail(
    source: L2ChatSource,
    index: number,
    entryId: string,
    detail: L2ChatMessageDetail
  ): Promise<void> {
    const messages = [...(this.messagesBySource.get(key(source)) ?? [])]
    const target = messages.findIndex(
      (message) => message.location.index === index && message.location.entryId === entryId
    )
    if (target < 0) throw new Error('detail target missing')
    messages[target] = L2ChatDurableMessageSnapshotSchema.parse({
      ...messages[target]!,
      detail: detail ?? undefined
    })
    this.messagesBySource.set(key(source), messages)
  }

  async clearSource(source: L2ChatSource): Promise<void> {
    this.messagesBySource.delete(key(source))
  }
}

class FakeAppSocket implements L4AppSocketClient {
  readonly requests: Array<{ path: string; input: unknown }> = []
  presentationResponseBlock: Promise<void> | null = null
  failNextPresentation = false
  private readonly listeners = new Map<string, Set<(body: unknown) => void>>()

  connect(): Promise<boolean> {
    return Promise.resolve(false)
  }

  request<TInput, TOutput>(
    contract: L4AppSocketRequestContract<TInput, TOutput>,
    input: TInput
  ): Promise<TOutput> {
    this.requests.push({ path: contract.path, input })
    if (contract.path === L3PiNativeSocketContracts.commandsList.path) {
      return Promise.resolve(contract.outputSchema.parse({ commands: [] }))
    }
    if (contract.path === L2ChatSocketContracts.presentationSet.path) {
      if (this.failNextPresentation) {
        this.failNextPresentation = false
        return Promise.reject(new Error('presentation request failed'))
      }
      const block = this.presentationResponseBlock
      this.presentationResponseBlock = null
      if (block) return block.then(() => contract.outputSchema.parse({}))
    }
    return Promise.resolve(contract.outputSchema.parse({}))
  }

  subscribe<TBody>(
    contract: L4AppSocketPushContract<TBody>,
    listener: (data: TBody) => void
  ): () => void {
    const listeners = this.listeners.get(contract.path) ?? new Set<(body: unknown) => void>()
    const wrapped = (body: unknown): void => listener(contract.bodySchema.parse(body))
    listeners.add(wrapped)
    this.listeners.set(contract.path, listeners)
    return () => listeners.delete(wrapped)
  }

  waitForClose(): Promise<L4BrowserSocketCloseInfo> {
    return new Promise<L4BrowserSocketCloseInfo>(() => undefined)
  }

  emit<TBody>(contract: L4AppSocketPushContract<TBody>, body: TBody): void {
    for (const listener of this.listeners.get(contract.path) ?? []) listener(body)
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待客户端消息状态超时')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function fullSync(
  source: L2ChatSource,
  messages: L2ChatDurableMessageSnapshot[],
  temporaryMessages: L2ChatTemporaryMessageSnapshot[] = [],
  runtime: L2ChatRuntime = EMPTY_RUNTIME
) {
  return {
    source,
    event: {
      type: 'session_sync' as const,
      mode: 'full' as const,
      baseCursor: null,
      messages,
      temporaryMessages,
      runtime
    }
  }
}

function incrementalSync(
  source: L2ChatSource,
  baseCursor: { index: number; entryId: string },
  messages: L2ChatDurableMessageSnapshot[] = [],
  temporaryMessages: L2ChatTemporaryMessageSnapshot[] = [],
  runtime: L2ChatRuntime = EMPTY_RUNTIME
) {
  return {
    source,
    event: {
      type: 'session_sync' as const,
      mode: 'incremental' as const,
      baseCursor,
      messages,
      temporaryMessages,
      runtime
    }
  }
}

test('Workbench Biz 通过统一 plugins/invoke 合同调用 Session 方法', async () => {
  const socket = new FakeAppSocket()
  const source = sourceFor(workSession())
  const biz = createL2WorkbenchBiz('9cc3c65d-89c2-4b33-ac1f-1829c3344a21', socket)

  assert.deepEqual(
    await biz.invokePluginMethod({
      pluginName: 'context-ignore',
      method: 'ignore',
      scope: 'session',
      source,
      input: {}
    }),
    {}
  )
  assert.deepEqual(socket.requests, [
    {
      path: 'plugins/invoke',
      input: {
        pluginName: 'context-ignore',
        method: 'ignore',
        scope: 'session',
        source,
        input: {}
      }
    }
  ])
})

test('Workbench Biz 通过统一 Pi 命令合同查询当前 Source', async () => {
  const socket = new FakeAppSocket()
  const source = sourceFor(workSession())
  const biz = createL2WorkbenchBiz('9cc3c65d-89c2-4b33-ac1f-1829c3344a21', socket)

  assert.deepEqual(await biz.listPiCommands({ source }), { commands: [] })
  assert.deepEqual(socket.requests, [{ path: 'pi/commands/list', input: { source } }])
})

test('Slash Command 只识别首个命令 Token 并按来源分组', () => {
  assert.equal(readL2WorkbenchSlashCommandQuery('/'), '')
  assert.equal(readL2WorkbenchSlashCommandQuery('/skill:tapd'), 'skill:tapd')
  assert.equal(readL2WorkbenchSlashCommandQuery('/review arg'), null)
  assert.equal(readL2WorkbenchSlashCommandQuery('请执行 /review'), null)
  assert.equal(readL2WorkbenchSlashCommandQuery('src/app/page.tsx'), null)

  assert.deepEqual(
    buildL2WorkbenchSlashCommandGroups(
      [
        {
          key: 'extension:api-review',
          name: 'api-review',
          description: '检查接口',
          source: 'extension'
        },
        {
          key: 'prompt:review',
          name: 'review',
          description: '审查代码',
          source: 'prompt'
        },
        {
          key: 'skill:skill:tapd',
          name: 'skill:tapd',
          description: '查询 TAPD',
          source: 'skill'
        }
      ],
      'review'
    ).map((group) => ({
      source: group.source,
      commands: group.commands.map((command) => command.name)
    })),
    [
      { source: 'prompt', commands: ['review'] },
      { source: 'extension', commands: ['api-review'] }
    ]
  )
})

test('初始化诊断跟随服务端Runtime更新，恢复清除并随Source替换释放', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const failedRuntime: L2ChatRuntime = {
    ...EMPTY_RUNTIME,
    extensionMode: 'basic',
    initializationError: 'fixture initialization failure'
  }
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [], [], failedRuntime))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  assert.equal(runtime.getSourceState(source).runtime.extensionMode, 'basic')
  assert.equal(
    runtime.getSourceState(source).runtime.initializationError,
    'fixture initialization failure'
  )

  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: { type: 'runtime_update', runtime: EMPTY_RUNTIME }
  })
  await waitUntil(() => runtime.getSourceState(source).runtime.initializationError === null)
  assert.equal(runtime.getSourceState(source).runtime.extensionMode, 'normal')

  const replacement = workSession(SESSION_B)
  runtime.reconcileWorkSessions([replacement])
  assert.equal(runtime.getSourceState(source).syncStatus, 'loading')
  assert.equal(runtime.getSourceState(source).runtime.initializationError, null)
  assert.equal(runtime.getSourceState(sourceFor(replacement)).runtime.initializationError, null)
  runtime.dispose()
})

test('Workbench Chat Runtime 通过 chat/compact 合同请求当前 Source 压缩', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )
  const item = workSession()
  const source = sourceFor(item)

  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, []))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  await runtime.compact(source)

  assert.deepEqual(socket.requests, [
    { path: 'chat/subscribe', input: { subscriptions: [{ source, cursor: null }] } },
    { path: 'chat/compact', input: { source } }
  ])
  runtime.dispose()
})

test('Workbench Chat Runtime 通过 chat/reload 合同重载当前 Source', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )
  const item = workSession()
  const source = sourceFor(item)

  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, []))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  await runtime.reload(source)

  assert.deepEqual(socket.requests, [
    { path: 'chat/subscribe', input: { subscriptions: [{ source, cursor: null }] } },
    { path: 'chat/reload', input: { source } }
  ])
  runtime.dispose()
})

test('首次加载不提前展示 IndexedDB 缓存，full snapshot 后才进入 ready', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  repository.messagesBySource.set(key(source), [userMessage(0, '仅本地缓存')])
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  const expectedInitialState = {
    messages: [],
    temporaryMessages: [],
    runtime: EMPTY_RUNTIME,
    syncStatus: 'loading' as const
  }
  assert.deepEqual(runtime.getSourceState(source), expectedInitialState)
  await runtime.applyWorkSessionsList([item])
  assert.deepEqual(runtime.getSourceState(source), expectedInitialState)
  await assert.rejects(() => runtime.compact(source), /会话正在同步/)

  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [userMessage(0, '权威消息')]))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')
  assert.deepEqual(runtime.getSourceState(source).messages, [userMessage(0, '权威消息')])
  runtime.dispose()
})

test('首次快照前到达 Source 事件时仍等待权威快照建立状态', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const errors: unknown[] = []
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    errors.push(cause)
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: { type: 'message_start', snapshot: assistantTemporary('过早事件') }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(errors, [])
  assert.deepEqual(runtime.getSourceState(source), {
    messages: [],
    temporaryMessages: [],
    runtime: EMPTY_RUNTIME,
    syncStatus: 'loading'
  })

  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [userMessage(0, '权威消息')]))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')
  assert.deepEqual(runtime.getSourceState(source).temporaryMessages, [])
  runtime.dispose()
})

test('已加载 Source 在 A-B-A 切换中复用内存状态且不重新读取游标', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const itemA = workSession()
  const itemB = { ...workSession(SESSION_B), workId: 'work-2' }
  const sourceA = sourceFor(itemA)
  const sourceB = sourceFor(itemB)
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([itemA, itemB])
  await runtime.applyWorkSessionsList([itemA, itemB])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(sourceA, [userMessage(0, 'A')]))
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(sourceB, [userMessage(0, 'B')]))
  await waitUntil(() => runtime.getSourceState(sourceA).syncStatus === 'ready')
  await waitUntil(() => runtime.getSourceState(sourceB).syncStatus === 'ready')

  const stateA = runtime.getSourceState(sourceA)
  const cursorReadsA = repository.readLatestCursorCount.get(key(sourceA))
  runtime.ensureDisplayedWorkSessions([itemB])
  runtime.ensureDisplayedWorkSessions([itemA])

  assert.strictEqual(runtime.getSourceState(sourceA), stateA)
  assert.equal(runtime.getSourceState(sourceA).messages[0]?.summary.text, 'A')
  assert.equal(repository.readLatestCursorCount.get(key(sourceA)), cursorReadsA)
  assert.equal(socket.requests.length, 1)
  runtime.dispose()
})

test('断线保留 Durable、Temporary、Runtime，重连全量快照替换旧临时内容', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const beforeRuntime: L2ChatRuntime = {
    extensionMode: 'normal',
    presentationMode: 'normal',
    initializationError: null,
    queues: { steering: [], followUp: [] },
    model: { provider: 'test', modelId: 'before', thinkingLevel: 'medium' },
    capabilityMode: null,
    contextUsage: { tokens: 12, contextWindow: 100 },
    plugins: { fixture: { state: 'before' } }
  }
  const afterRuntime: L2ChatRuntime = {
    ...beforeRuntime,
    model: { provider: 'test', modelId: 'after', thinkingLevel: 'high' },
    plugins: { fixture: { state: 'after' } }
  }
  const beforeTemporary = assistantTemporary('断线前临时内容')
  const afterTemporary = assistantTemporary('重连后临时内容')
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    fullSync(source, [userMessage(0, '已完成')], [beforeTemporary], beforeRuntime)
  )
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')
  runtime.saveViewportSnapshot(source, { messageId: 'entry-user-0', offset: 88 })

  runtime.disconnected()
  const disconnected = runtime.getSourceState(source)
  assert.equal(disconnected.syncStatus, 'syncing')
  assert.deepEqual(disconnected.messages, [userMessage(0, '已完成')])
  assert.deepEqual(disconnected.temporaryMessages, [beforeTemporary])
  assert.deepEqual(disconnected.runtime, beforeRuntime)
  await assert.rejects(() => runtime.reload(source), /会话正在同步/)

  await runtime.applyWorkSessionsList([item])
  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    fullSync(
      source,
      [userMessage(0, '已完成'), assistantMessage(1, '重连后完成')],
      [afterTemporary],
      afterRuntime
    )
  )
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')
  const reconnected = runtime.getSourceState(source)
  assert.deepEqual(reconnected.messages, [
    userMessage(0, '已完成'),
    assistantMessage(1, '重连后完成')
  ])
  assert.deepEqual(reconnected.temporaryMessages, [afterTemporary])
  assert.deepEqual(reconnected.runtime, afterRuntime)
  assert.deepEqual(runtime.getViewportSnapshot(source), {
    messageId: 'entry-user-0',
    offset: 88
  })
  runtime.dispose()
})

test('持久化阻塞期间不应用后续增量，快照完成后按序排空并 ready', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, []))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  let releaseSnapshot!: () => void
  repository.replaceBlock = new Promise<void>((resolve) => {
    releaseSnapshot = resolve
  })
  runtime.disconnected()
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [userMessage(0, '恢复历史')]))
  await waitUntil(() => repository.replaceStarted === 2)
  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: { type: 'message_start', snapshot: assistantTemporary() }
  })
  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: {
      type: 'message_update',
      location: { tempId: TEMP_ID },
      increments: { 'summary.text': '恢复流式' }
    }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.getSourceState(source).temporaryMessages.length, 0)
  assert.equal(runtime.getSourceState(source).syncStatus, 'syncing')

  releaseSnapshot()
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')
  assert.equal(
    (runtime.getSourceState(source).temporaryMessages[0]?.summary as { text: string }).text,
    '恢复流式'
  )
  runtime.dispose()
})

test('增量同步使用 DB 超前前缀并避免重复追加其他标签页消息', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const first = userMessage(0, '第一条')
  const otherTabMessage = userMessage(1, '其他标签页已追加')
  const currentMessage = assistantMessage(2, '当前连接新增')
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [first]))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  repository.messagesBySource.set(key(source), [first, otherTabMessage])
  runtime.disconnected()
  await runtime.applyWorkSessionsList([item])
  // 订阅 cursor 已确定后，另一标签页先把本次增量中的消息写入共享数据库。
  repository.messagesBySource.set(key(source), [first, otherTabMessage, currentMessage])
  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    incrementalSync(source, { index: 1, entryId: otherTabMessage.location.entryId }, [
      currentMessage
    ])
  )
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  const messages = runtime.getSourceState(source).messages
  assert.deepEqual(messages, [first, otherTabMessage, currentMessage])
  assert.equal(new Set(messages.map((message) => message.location.entryId)).size, 3)
  runtime.dispose()
})

test('增量 cursor 不匹配时保留旧画面并自动以 cursor:null 全量恢复', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const first = userMessage(0, '旧画面')
  const corruptedCache = userMessage(1, '损坏缓存')
  const errors: unknown[] = []
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    errors.push(cause)
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [first]))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  repository.messagesBySource.set(key(source), [first, corruptedCache])
  runtime.disconnected()
  await runtime.applyWorkSessionsList([item])
  const previousRequestCount = socket.requests.length
  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    incrementalSync(source, { index: 1, entryId: 'missing-base-entry' })
  )
  await new Promise((resolve) => setImmediate(resolve))
  await waitUntil(() => socket.requests.length === previousRequestCount + 1)
  assert.deepEqual(socket.requests.at(-1), {
    path: 'chat/subscribe',
    input: { subscriptions: [{ source, cursor: null }] }
  })
  assert.deepEqual(runtime.getSourceState(source).messages, [first])
  assert.equal(runtime.getSourceState(source).syncStatus, 'syncing')
  assert.deepEqual(errors, [])

  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    fullSync(source, [first, assistantMessage(1, '恢复')])
  )
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')
  assert.equal(runtime.getSourceState(source).messages[1]?.summary.text, '恢复')
  runtime.dispose()
})

test('一个 Source 事件应用失败时只重订阅该 Source，其他 Source 独立排空', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const itemA = workSession()
  const itemB = { ...workSession(SESSION_B), workId: 'work-2' }
  const sourceA = sourceFor(itemA)
  const sourceB = sourceFor(itemB)
  const errors: unknown[] = []
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    errors.push(cause)
  })
  runtime.ensureDisplayedWorkSessions([itemA, itemB])
  await runtime.applyWorkSessionsList([itemA, itemB])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(sourceA, [userMessage(0, 'A')]))
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(sourceB, [userMessage(0, 'B')]))
  await waitUntil(() => runtime.getSourceState(sourceA).syncStatus === 'ready')
  await waitUntil(() => runtime.getSourceState(sourceB).syncStatus === 'ready')

  runtime.disconnected()
  await runtime.applyWorkSessionsList([itemA, itemB])
  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    incrementalSync(sourceA, { index: 0, entryId: 'entry-user-0' })
  )
  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source: sourceA,
    event: {
      type: 'message_update' as const,
      location: { tempId: TEMP_ID },
      increments: { 'summary.text': '没有目标' }
    }
  })
  const nextRuntime: L2ChatRuntime = {
    ...EMPTY_RUNTIME,
    plugins: { sourceB: { updated: true } }
  }
  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    incrementalSync(sourceB, { index: 0, entryId: 'entry-user-0' }, [], [], nextRuntime)
  )
  await new Promise((resolve) => setImmediate(resolve))
  await waitUntil(() => runtime.getSourceState(sourceB).syncStatus === 'ready')
  assert.deepEqual(runtime.getSourceState(sourceB).runtime, nextRuntime)
  await waitUntil(() =>
    socket.requests
      .filter((request) => request.path === 'chat/subscribe')
      .some((request) => {
        const input = request.input
        return (
          typeof input === 'object' &&
          input !== null &&
          JSON.stringify(input).includes('"cursor":null') &&
          !JSON.stringify(input).includes('work-2')
        )
      })
  )
  assert.deepEqual(errors, [])

  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(sourceA, [userMessage(0, 'A恢复')]))
  await waitUntil(() => runtime.getSourceState(sourceA).syncStatus === 'ready')
  runtime.dispose()
})

test('异步 cursor 读取期间 Source 变化或重连时不发送晚到订阅', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const itemA = workSession()
  const itemB = { ...workSession(SESSION_B), workId: 'work-2' }
  const sourceA = sourceFor(itemA)
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([itemA])
  let releaseCursor!: () => void
  repository.readLatestCursorBlock = new Promise<void>((resolve) => {
    releaseCursor = resolve
  })
  const applying = runtime.applyWorkSessionsList([itemA])
  await waitUntil(() => repository.readLatestCursorCount.get(key(sourceA)) === 1)
  runtime.reconcileWorkSessions([itemB])
  releaseCursor()
  await applying
  assert.equal(socket.requests.length, 0)
  runtime.dispose()

  const secondSocket = new FakeAppSocket()
  const secondRepository = new FakeRepository()
  const secondRuntime = createL2WorkbenchChatRuntime(
    secondSocket,
    async () => {
      throw new Error('unexpected detail request')
    },
    secondRepository
  )
  secondRuntime.start((cause) => {
    throw cause
  })
  secondRuntime.ensureDisplayedWorkSessions([itemA])
  await secondRuntime.applyWorkSessionsList([itemA])
  secondSocket.emit(
    L2ChatSocketContracts.sourceEvent,
    fullSync(sourceA, [userMessage(0, '已加载')])
  )
  await waitUntil(() => secondRuntime.getSourceState(sourceA).syncStatus === 'ready')
  secondRuntime.disconnected()
  let releaseLateCursor!: () => void
  secondRepository.readLatestCursorBlock = new Promise<void>((resolve) => {
    releaseLateCursor = resolve
  })
  const reconnecting = secondRuntime.applyWorkSessionsList([itemA])
  await waitUntil(() => secondRepository.readLatestCursorCount.get(key(sourceA)) === 2)
  secondRuntime.disconnected()
  releaseLateCursor()
  await reconnecting
  assert.equal(secondSocket.requests.length, 1)
  secondRuntime.dispose()
})

test('旧连接未完成的 Snapshot Promise 失败时不触发新连接重订阅', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const errors: unknown[] = []
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )

  runtime.start((cause) => {
    errors.push(cause)
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [userMessage(0, '旧状态')]))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  let rejectSnapshot!: (cause: Error) => void
  repository.replaceBlock = new Promise<void>((_, reject) => {
    rejectSnapshot = reject
  })
  runtime.disconnected()
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [userMessage(0, '旧连接快照')]))
  await waitUntil(() => repository.replaceStarted === 2)
  runtime.disconnected()
  rejectSnapshot(new Error('旧连接写入失败'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(socket.requests.length, 2)
  assert.deepEqual(errors, [])
  runtime.dispose()
})

test('Slash Command 支持 Pi 内置 reload 命令分组', () => {
  assert.deepEqual(
    buildL2WorkbenchSlashCommandGroups([L2_WORKBENCH_RELOAD_COMMAND], 'reload').map((group) => ({
      source: group.source,
      commands: group.commands.map((command) => command.name)
    })),
    [{ source: 'builtin', commands: ['reload'] }]
  )
})

test('上下文用量只在插件有效时计算忽略后位置和可忽略分段', () => {
  assert.deepEqual(
    buildL2WorkbenchContextUsageView(100_000, 200_000, {
      ignoredTokens: 80_000,
      potentialTokens: 60_000
    }),
    {
      contextIgnore: { ignoredTokens: 80_000, potentialTokens: 60_000 },
      currentTokens: 100_000,
      usedPercent: 50,
      projectedTokens: 40_000,
      projectedPercent: 20,
      potentialSegmentPercent: 30
    }
  )

  assert.deepEqual(
    buildL2WorkbenchContextUsageView(180_000, 200_000, {
      ignoredTokens: 80_000,
      potentialTokens: 60_000,
      effectiveTokens: 100_000
    }),
    {
      contextIgnore: {
        ignoredTokens: 80_000,
        potentialTokens: 60_000,
        effectiveTokens: 100_000
      },
      currentTokens: 100_000,
      usedPercent: 50,
      projectedTokens: 40_000,
      projectedPercent: 20,
      potentialSegmentPercent: 30
    }
  )

  assert.deepEqual(buildL2WorkbenchContextUsageView(100_000, 200_000, undefined), {
    contextIgnore: null,
    currentTokens: 100_000,
    usedPercent: 50,
    projectedTokens: null,
    projectedPercent: null,
    potentialSegmentPercent: 0
  })
  assert.equal(
    buildL2WorkbenchContextUsageView(100_000, 200_000, {
      ignoredTokens: 10,
      potentialTokens: 'invalid'
    }).contextIgnore,
    null
  )
})

test('展示会话补充订阅，隐藏会话保留，binding 失效后不自动迁移', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )
  runtime.start((cause) => {
    throw cause
  })

  const initial = workSession()
  runtime.ensureDisplayedWorkSessions([initial])
  assert.equal(socket.requests.length, 0)

  await runtime.applyWorkSessionsList([initial])
  assert.deepEqual(socket.requests[0]?.input, {
    subscriptions: [{ source: sourceFor(initial), cursor: null }]
  })

  runtime.ensureDisplayedWorkSessions([])
  repository.messagesBySource.set(key(sourceFor(initial)), [userMessage(0, '本地消息')])
  runtime.disconnected()
  await runtime.applyWorkSessionsList([initial])
  assert.deepEqual(socket.requests[1]?.input, {
    subscriptions: [{ source: sourceFor(initial), cursor: { index: 0, entryId: 'entry-user-0' } }]
  })

  const replaced = workSession(SESSION_B)
  runtime.reconcileWorkSessions([replaced])
  await runtime.applyWorkSessionsList([replaced])
  assert.equal(socket.requests.length, 2)
  runtime.ensureDisplayedWorkSessions([replaced])
  await waitUntil(() => socket.requests.length === 3)
  runtime.dispose()
})

test('Source 事件串行应用，增量 commit 落库后推进状态', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async (input) => ({
      index: 0,
      entryId: input.entryId,
      detail: { thinking: '按需思考' }
    }),
    repository
  )
  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])

  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    fullSync(source, [assistantMessage(0, '历史回答', { hasDetail: true })])
  )
  await waitUntil(() => repository.messagesBySource.get(key(source))?.length === 1)

  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: { type: 'message_start', snapshot: assistantTemporary() }
  })
  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: {
      type: 'message_update',
      location: { tempId: TEMP_ID },
      fixed: { hasDetail: true },
      detail: { thinking: '实时思考' },
      increments: {
        'summary.text': '实时回答'
      }
    }
  })
  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: {
      type: 'message_update',
      location: { tempId: TEMP_ID },
      fixed: { status: 'completed', usage: USAGE }
    }
  })
  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: {
      type: 'message_commit',
      location: { tempId: TEMP_ID },
      durable: { index: 1, entryId: 'entry-1' },
      fixed: { timestampMs: TIMESTAMP_MS + 1 }
    }
  })

  await waitUntil(() => repository.messagesBySource.get(key(source))?.length === 2)
  const state = runtime.getSourceState(source)
  assert.equal(state.temporaryMessages.length, 0)
  assert.deepEqual(state.messages[1], {
    location: { index: 1, entryId: 'entry-1' },
    fixed: {
      timestampMs: TIMESTAMP_MS + 1,
      type: 'assistant',
      viewKey: 'pi-desk/assistant',
      status: 'completed',
      hasDetail: true,
      usage: USAGE
    },
    summary: { text: '实时回答', errorMessage: null },
    detail: { thinking: '实时思考' }
  })

  await runtime.loadMessageDetail(source, 0, 'entry-assistant-0')
  assert.deepEqual(runtime.getSourceState(source).messages[0]?.detail, {
    thinking: '按需思考'
  })
  runtime.dispose()
})

test('排队中的连续 message_update 全部按顺序应用', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )
  let appliedUpdates = 0
  runtime.start((cause) => {
    throw cause
  })
  runtime.subscribeSourceEvents((push) => {
    if (push.event.type === 'message_update') appliedUpdates += 1
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, []))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: { type: 'message_start', snapshot: assistantTemporary() }
  })
  for (let index = 0; index < 100; index += 1) {
    socket.emit(L2ChatSocketContracts.sourceEvent, {
      source,
      event: {
        type: 'message_update',
        location: { tempId: TEMP_ID },
        increments: { 'summary.text': String(index % 10) }
      }
    })
  }

  await waitUntil(() => appliedUpdates === 100)
  const message = runtime.getSourceState(source).temporaryMessages[0]
  assert.equal(message?.fixed.type, 'assistant')
  assert.equal((message?.summary as { text: string }).text.length, 100)
  runtime.dispose()
})

test('full基线期间隔离迟到Detail并串行应用后续增量后才ready', async (context) => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  let resolveDetail!: (response: L2ChatMessageDetailResponse) => void
  let detailCalls = 0
  const detailResponse = new Promise<L2ChatMessageDetailResponse>((resolve) => {
    resolveDetail = resolve
  })
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async (input) => {
      detailCalls += 1
      return {
        index: 0,
        entryId: input.entryId,
        detail: await detailResponse.then((response) => response.detail)
      }
    },
    repository
  )
  context.after(() => runtime.dispose())
  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    fullSync(source, [assistantMessage(0, '旧基线', { hasDetail: true })])
  )
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  const lateDetail = runtime.loadMessageDetail(source, 0, 'entry-assistant-0')
  await waitUntil(() => detailCalls === 1)
  let releaseSnapshot!: () => void
  repository.replaceBlock = new Promise<void>((resolve) => {
    releaseSnapshot = resolve
  })
  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    fullSync(
      source,
      [assistantMessage(0, '新基线', { hasDetail: true })],
      [assistantTemporary('临时基线')]
    )
  )
  await waitUntil(() => repository.replaceStarted === 2)
  assert.equal(runtime.getSourceState(source).syncStatus, 'syncing')

  socket.emit(L2ChatSocketContracts.sourceEvent, {
    source,
    event: {
      type: 'message_update',
      location: { tempId: TEMP_ID },
      increments: { 'summary.text': '追加' }
    }
  })
  resolveDetail({
    index: 0,
    entryId: 'entry-assistant-0',
    detail: { thinking: '旧详情' }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const lateDetailRejected = assert.rejects(lateDetail, /同步/)

  releaseSnapshot()
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')
  await lateDetailRejected

  const state = runtime.getSourceState(source)
  assert.equal(state.messages[0]?.summary.text, '新基线')
  assert.equal(state.messages[0]?.detail, undefined)
  assert.equal((state.temporaryMessages[0]?.summary as { text: string }).text, '临时基线追加')
  const persisted = repository.messagesBySource.get(key(source))?.[0]
  assert.equal(persisted?.summary.text, '新基线')
  assert.equal(persisted?.detail, undefined)
})

test('Presentation仅允许ready后手动切换，同Source并发去重且失败可重试', async (context) => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )
  context.after(() => runtime.dispose())
  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])

  await assert.rejects(runtime.setPresentation(source, 'basic'), /同步/)
  assert.equal(
    socket.requests.filter((request) => request.path === L2ChatSocketContracts.presentationSet.path)
      .length,
    0
  )
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, []))
  await waitUntil(() => runtime.getSourceState(source).syncStatus === 'ready')

  socket.failNextPresentation = true
  await assert.rejects(runtime.setPresentation(source, 'basic'), /request failed/)
  assert.equal(runtime.getSourceState(source).runtime.presentationMode, 'normal')

  let releasePresentation!: () => void
  socket.presentationResponseBlock = new Promise<void>((resolve) => {
    releasePresentation = resolve
  })
  const first = runtime.setPresentation(source, 'basic')
  const second = runtime.setPresentation(source, 'basic')
  const presentationRequests = socket.requests.filter(
    (request) => request.path === L2ChatSocketContracts.presentationSet.path
  )
  assert.equal(presentationRequests.length, 2)
  assert.deepEqual(presentationRequests[1]?.input, { source, mode: 'basic' })
  releasePresentation()
  await Promise.all([first, second])
})

test('旧连接异步 sync 不覆盖重连后的新 Snapshot', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  let releaseOld!: () => void
  repository.replaceBlock = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  const item = workSession()
  const source = sourceFor(item)
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      throw new Error('unexpected detail request')
    },
    repository
  )
  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])

  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [userMessage(0, '旧连接')]))
  await waitUntil(() => repository.replaceStarted === 1)

  runtime.disconnected()
  await runtime.applyWorkSessionsList([item])
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [userMessage(0, '新连接')]))
  releaseOld()

  await waitUntil(() => {
    const state = runtime.getSourceState(source)
    const message = state.messages[0]
    return message?.fixed.type === 'user' && (message.summary as { text: string }).text === '新连接'
  })
  const persisted = repository.messagesBySource.get(key(source))?.[0]
  assert.equal(
    persisted?.fixed.type === 'user' && (persisted.summary as { text: string }).text,
    '新连接'
  )
  runtime.dispose()
})

test('同一 Durable Message 的并发 Detail 请求复用 pending Promise', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  let loaderCalls = 0
  let resolveDetail!: (response: L2ChatMessageDetailResponse) => void
  const detailResponse = new Promise<L2ChatMessageDetailResponse>((resolve) => {
    resolveDetail = resolve
  })
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async () => {
      loaderCalls += 1
      return detailResponse
    },
    repository
  )
  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])
  socket.emit(
    L2ChatSocketContracts.sourceEvent,
    fullSync(source, [assistantMessage(0, '回答', { hasDetail: true })])
  )
  await waitUntil(() => runtime.getSourceState(source).messages.length === 1)

  const first = runtime.loadMessageDetail(source, 0, 'entry-assistant-0')
  const second = runtime.loadMessageDetail(source, 0, 'entry-assistant-0')
  await waitUntil(() => loaderCalls === 1)
  resolveDetail({
    index: 0,
    entryId: 'entry-assistant-0',
    detail: { thinking: '去重详情' }
  })
  assert.deepEqual(await Promise.all([first, second]), [
    { thinking: '去重详情' },
    { thinking: '去重详情' }
  ])
  assert.equal(loaderCalls, 1)
  runtime.dispose()
})

test('并发加载 Assistant 和 Tool Detail 时基于最新 Source 状态合并', async () => {
  const socket = new FakeAppSocket()
  const repository = new FakeRepository()
  const item = workSession()
  const source = sourceFor(item)
  const runtime = createL2WorkbenchChatRuntime(
    socket,
    async (input): Promise<L2ChatMessageDetailResponse> =>
      input.entryId === 'entry-assistant-0'
        ? { index: 0, entryId: input.entryId, detail: { thinking: '并发思考' } }
        : { index: 1, entryId: input.entryId, detail: { output: '并发工具详情' } },
    repository
  )
  runtime.start((cause) => {
    throw cause
  })
  runtime.ensureDisplayedWorkSessions([item])
  await runtime.applyWorkSessionsList([item])

  const assistant = assistantMessage(0, '最终回答', { hasDetail: true })
  const tool = {
    ...toolMessage(1, { name: 'bash', status: 'error' }),
    location: { index: 1, entryId: 'entry-tool' }
  }
  socket.emit(L2ChatSocketContracts.sourceEvent, fullSync(source, [assistant, tool]))
  await waitUntil(() => runtime.getSourceState(source).messages.length === 2)

  await Promise.all([
    runtime.loadMessageDetail(source, 0, 'entry-assistant-0'),
    runtime.loadMessageDetail(source, 1, 'entry-tool')
  ])
  assert.deepEqual(
    runtime.getSourceState(source).messages.map((message) => message.detail),
    [{ thinking: '并发思考' }, { output: '并发工具详情' }]
  )
  runtime.dispose()
})

test('长会话初始只选择尾部 Turn，完整数据仍可按锚点选择', () => {
  const messages = Array.from({ length: 1_200 }, (_, turnIndex) => [
    userMessage(turnIndex * 2, `用户 ${turnIndex}`),
    assistantMessage(turnIndex * 2 + 1, `回答 ${turnIndex}`)
  ]).flat()
  const turns = buildL3ConversationTurns({ messages, temporaryMessages: [] })
  const tail = selectL3ConversationTailRange(turns)

  assert.equal(turns.length, 1_200)
  assert.equal(tail.endIndex, 1_200)
  assert.equal(tail.endIndex - tail.startIndex, 30)
  assert.equal(turns[tail.startIndex]?.user?.summary.type, 'user')
  assert.equal(turns.at(-1)?.user?.summary.type, 'user')

  const anchor = `${turns[500]!.user!.identity}:user`
  const anchored = selectL3ConversationInitialRange(turns, anchor)
  assert.ok(anchored.startIndex <= 500)
  assert.ok(anchored.endIndex > 500)
  assert.ok(anchored.endIndex - anchored.startIndex <= 30)
  assert.equal(findL3ConversationTurnIndexByMessageAnchor(turns, anchor), 500)
})

test('初始窗口不拆分超大 Turn，并在存在时至少保留两个用户 Turn', () => {
  const messages = [userMessage(0, '第一轮')]
  for (let index = 1; index <= 260; index += 1) messages.push(toolMessage(index))
  messages.push(userMessage(261, '第二轮'))
  for (let index = 262; index <= 520; index += 1) messages.push(toolMessage(index))

  const turns = buildL3ConversationTurns({ messages, temporaryMessages: [] })
  const range = selectL3ConversationTailRange(turns)

  assert.equal(turns.length, 2)
  assert.deepEqual(range, { startIndex: 0, endIndex: 2 })
  assert.equal(turns[0]?.processItems.length, 260)
  assert.equal(turns[1]?.processItems.length, 259)
})

test('聊天展示按用户轮次折叠过程并保留完整最终回答', () => {
  const turns = buildL3ConversationTurns({
    messages: [
      userMessage(0, '请检查项目'),
      assistantMessage(1, '我先读取文件。'),
      toolMessage(2, { reasoning: '确认实现入口', activity: '1-200', usage: USAGE }),
      assistantMessage(3, '第一段。\n\n第二段。', { thinking: '内部分析' })
    ],
    temporaryMessages: []
  })

  assert.equal(turns.length, 1)
  assert.equal(turns[0]?.finalAssistant?.summary.type, 'assistant')
  assert.deepEqual(
    turns[0]?.processItems.map((process) => [process.message.position, process.hideAssistantText]),
    [
      [1, false],
      [2, false],
      [3, true]
    ]
  )
  assert.equal(turns[0]?.processItems[1]?.message.summary.type, 'tool')
  assert.equal(
    turns[0]?.processItems[1]?.message.summary.type === 'tool' &&
      turns[0].processItems[1].message.summary.activity,
    '1-200'
  )
  assert.deepEqual(
    turns[0]?.processItems[1]?.message.summary.type === 'tool'
      ? turns[0].processItems[1].message.summary.usage
      : null,
    USAGE
  )
})

test('文件工具按最终 viewKey 使用独立 View kind，第三方改写不按工具名回退', () => {
  const baseSummary = {
    reasoning: '检查文件',
    inputPreview: 'src/file.ts',
    activity: '1-20'
  }
  const fileTools: L2ChatDurableMessageSnapshot[] = [
    {
      location: { index: 1, entryId: 'entry-read' },
      fixed: {
        timestampMs: TIMESTAMP_MS + 1,
        type: 'tool',
        viewKey: 'pi-desk/read',
        status: 'completed',
        hasDetail: true,
        usage: null
      },
      summary: { name: 'read', ...baseSummary, path: 'src/file.ts' },
      detail: { content: 'const value = 1' }
    },
    {
      location: { index: 2, entryId: 'entry-edit' },
      fixed: {
        timestampMs: TIMESTAMP_MS + 2,
        type: 'tool',
        viewKey: 'pi-desk/edit',
        status: 'completed',
        hasDetail: true,
        usage: null
      },
      summary: { name: 'edit', ...baseSummary, path: 'src/file.ts' },
      detail: { kind: 'diff', content: '-1 old\n+1 new' }
    },
    {
      location: { index: 3, entryId: 'entry-write' },
      fixed: {
        timestampMs: TIMESTAMP_MS + 3,
        type: 'tool',
        viewKey: 'pi-desk/write',
        status: 'completed',
        hasDetail: true,
        usage: null
      },
      summary: { name: 'write', ...baseSummary, path: 'src/file.ts' },
      detail: { kind: 'content', content: 'export const next = true' }
    },
    {
      location: { index: 4, entryId: 'entry-custom-read' },
      fixed: {
        timestampMs: TIMESTAMP_MS + 4,
        type: 'tool',
        viewKey: 'fixture/custom-read',
        status: 'completed',
        hasDetail: true,
        usage: null
      },
      summary: { name: 'read', ...baseSummary },
      detail: { output: 'custom detail' }
    }
  ]
  const turns = buildL3ConversationTurns({
    messages: [userMessage(0, '处理文件'), ...fileTools],
    temporaryMessages: []
  })
  const messages = turns[0]!.processItems.map((item) => item.message)

  assert.deepEqual(
    messages.map((message) =>
      message.summary.type === 'tool' ? message.summary.kind : message.summary.type
    ),
    ['read', 'edit', 'write', 'generic']
  )
  assert.equal(messages[0]?.detail?.type, 'tool')
  assert.equal(messages[0]?.detail?.type === 'tool' ? messages[0].detail.kind : null, 'read')
  assert.equal(
    messages[1]?.detail?.type === 'tool' && messages[1].detail.kind === 'edit'
      ? messages[1].detail.contentKind
      : null,
    'diff'
  )
  assert.equal(
    messages[2]?.detail?.type === 'tool' && messages[2].detail.kind === 'write'
      ? messages[2].detail.contentKind
      : null,
    'content'
  )
})

test('压缩消息独立切断前后用户轮次，运行态不进入处理过程', () => {
  const completedTurns = buildL3ConversationTurns({
    messages: [
      userMessage(0, '第一轮'),
      assistantMessage(1, '第一轮完成'),
      compactionMessage(2),
      userMessage(3, '第二轮'),
      assistantMessage(4, '第二轮完成')
    ],
    temporaryMessages: []
  })

  assert.equal(completedTurns.length, 3)
  assert.equal(completedTurns[0]?.finalAssistant?.summary.type, 'assistant')
  assert.equal(completedTurns[1]?.compaction?.summary.type, 'compaction')
  assert.deepEqual(completedTurns[1]?.processItems, [])
  assert.equal(completedTurns[2]?.user?.summary.type, 'user')

  const runningTurns = buildL3ConversationTurns({
    messages: [userMessage(0, '第一轮'), assistantMessage(1, '第一轮完成')],
    temporaryMessages: [compactionTemporary()]
  })
  assert.equal(runningTurns.length, 2)
  assert.equal(runningTurns[1]?.compaction?.temporary, true)
  assert.equal(runningTurns[1]?.running, true)
  assert.deepEqual(runningTurns[1]?.processItems, [])
})

test('错误 Summary 无需 Detail 也会进入处理过程', () => {
  const turns = buildL3ConversationTurns({
    messages: [
      userMessage(0, '继续'),
      assistantMessage(1, '', {
        status: 'error',
        errorMessage: 'terminated',
        hasDetail: false
      })
    ],
    temporaryMessages: []
  })

  const errorMessage = turns[0]?.processItems[0]?.message
  assert.equal(turns[0]?.finalAssistant, null)
  assert.equal(errorMessage?.summary.type, 'assistant')
  assert.equal(
    errorMessage?.summary.type === 'assistant' ? errorMessage.summary.errorMessage : null,
    'terminated'
  )
  assert.equal(errorMessage?.detail, undefined)
})

test('空的流式 Assistant 保留等待状态，收到 thinking 增量后显示过程', () => {
  const messages = [userMessage(0, '请分析')]
  const emptyTurns = buildL3ConversationTurns({
    messages,
    temporaryMessages: [assistantTemporary()]
  })
  assert.equal(emptyTurns[0]?.running, true)
  assert.deepEqual(emptyTurns[0]?.processItems, [])

  const thinkingTurns = buildL3ConversationTurns({
    messages,
    temporaryMessages: [assistantTemporary('', '正在分析项目结构。')]
  })
  assert.equal(thinkingTurns[0]?.processItems.length, 1)
})

test('外部运行状态跨越工具 commit 空窗且只保持最后一轮展开', () => {
  const state: L2ChatSourceState = {
    messages: [
      userMessage(0, '第一轮'),
      assistantMessage(1, '第一轮完成'),
      userMessage(2, '第二轮'),
      assistantMessage(3, '准备读取文件。'),
      toolMessage(4)
    ],
    temporaryMessages: [],
    runtime: EMPTY_RUNTIME
  }
  assert.deepEqual(
    buildL3ConversationTurns(state).map((turn) => turn.running),
    [false, false]
  )
  assert.deepEqual(
    buildL3ConversationTurns(state, true).map((turn) => turn.running),
    [false, true]
  )
})

test('流式投影复用 Durable 前缀和未变化 Temporary 消息', () => {
  const messages = [
    userMessage(0, '第一轮'),
    assistantMessage(1, '第一轮完成'),
    userMessage(2, '继续')
  ]
  const stableTemporary = assistantTemporary('先检查上下文。', '', TEMP_ID_2)
  const firstChangingTemporary = assistantTemporary('正在生成')
  const first = buildL3ConversationTurns({
    messages,
    temporaryMessages: [stableTemporary, firstChangingTemporary]
  })
  const second = buildL3ConversationTurns({
    messages,
    temporaryMessages: [
      stableTemporary,
      {
        ...firstChangingTemporary,
        summary: { text: '正在生成更多内容', errorMessage: null }
      }
    ]
  })

  assert.strictEqual(first[0], second[0])
  assert.strictEqual(first[1]?.processItems[0]?.message, second[1]?.processItems[0]?.message)
  assert.notStrictEqual(first[1]?.finalAssistant, second[1]?.finalAssistant)
  const finalAssistant = second[1]?.finalAssistant
  assert.equal(finalAssistant?.summary.type, 'assistant')
  if (finalAssistant?.summary.type !== 'assistant') assert.fail('缺少最终 Assistant')
  assert.equal(finalAssistant.summary.text, '正在生成更多内容')
})

test('工具仍在末尾时不伪造最终回答，临时位置与 commit index 保持稳定', () => {
  const turns = buildL3ConversationTurns({
    messages: [userMessage(0, '继续'), assistantMessage(1, '准备执行命令。')],
    temporaryMessages: [
      {
        location: { tempId: TEMP_ID },
        fixed: {
          timestampMs: null,
          type: 'tool',
          viewKey: 'pi-desk/tool',
          status: 'running',
          hasDetail: false,
          usage: null
        },
        summary: {
          name: 'bash',
          reasoning: '验证类型检查',
          inputPreview: 'pnpm typecheck',
          activity: null
        }
      }
    ]
  })

  assert.equal(turns[0]?.finalAssistant, null)
  assert.equal(turns[0]?.running, true)
  assert.equal(turns[0]?.processItems.at(-1)?.message.identity, 'position:2')
})

test('footer token、费用和上海时间格式保持紧凑且不抬高小额费用', () => {
  assert.equal(formatL3ConversationTokenCount(999), '999')
  assert.equal(formatL3ConversationTokenCount(1_200), '1.2k')
  assert.equal(formatL3ConversationTokenCount(12_500), '12.5k')
  assert.equal(formatL3ConversationTokenCount(1_200_000), '1.2m')
  assert.equal(formatL3ConversationCost(0), '$0')
  assert.equal(formatL3ConversationCost(0.00001), '<$0.0001')
  assert.equal(formatL3ConversationCost(0.0042), '$0.0042')

  const timestamp = Date.UTC(2026, 7, 15, 6, 32, 10)
  assert.equal(
    formatL3ConversationTimestamp(timestamp, timestamp, 'en', 'Asia/Shanghai').compact,
    '14:32'
  )
  assert.equal(
    formatL3ConversationTimestamp(timestamp, Date.UTC(2026, 7, 16, 6, 0), 'en', 'Asia/Shanghai')
      .compact,
    'Aug 15, 14:32'
  )
})
