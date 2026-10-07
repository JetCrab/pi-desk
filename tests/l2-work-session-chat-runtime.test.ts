import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { PluginMessageDeclaration } from '@jetcrab/pi-desk-sdk/entry'
import type { WorkSession } from '../src/server/l3_modules/work-session/l3-work-session'
import {
  L4PiPluginOwnerRuntime,
  type L4PiMessageDeclarationRegistration,
  type L4PiPluginPackageSource
} from '../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime'
import type {
  L4PiChatMessage,
  L4PiChatProjectedEntry
} from '../src/server/l4_foundation/pi/l4-pi-chat-projection'

type ChatRuntimeModule =
  typeof import('../src/server/l2_biz/work-session/l2-work-session-chat-runtime')
type PiRuntimeModule = typeof import('../src/server/l4_foundation/pi/l4-pi-work-session-runtime')
type PiRuntimeInstance = ReturnType<PiRuntimeModule['L4PiWorkSessionRuntime']['create']>
type PiChatWorkerEventListener = Parameters<PiRuntimeInstance['subscribeChat']>[0]
type PiChatWorkerEvent = Parameters<PiChatWorkerEventListener>[0]

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const testPiRoot = join(
  process.cwd(),
  'temp/pi/l2-work-session-chat-runtime',
  `host-review-${process.pid}`
)
const testAgentDir = join(testPiRoot, 'agent')
process.env.PI_CODING_AGENT_DIR = testAgentDir
process.env.PI_CODING_AGENT_SESSION_DIR = join(testAgentDir, 'sessions')
test.after(async () => {
  await rm(testPiRoot, { recursive: true, force: true })
})

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})

const modulesPromise: Promise<[ChatRuntimeModule, PiRuntimeModule]> = Promise.all([
  jiti.import<ChatRuntimeModule>(
    '../src/server/l2_biz/work-session/l2-work-session-chat-runtime.ts'
  ),
  jiti.import<PiRuntimeModule>('../src/server/l4_foundation/pi/l4-pi-work-session-runtime.ts')
])

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function fakeWorkSession(
  workId: string,
  cwd: string,
  runtime: ReturnType<PiRuntimeModule['L4PiWorkSessionRuntime']['create']>,
  operations: {
    send: WorkSession['send']
    compact: PiRuntimeInstance['compact']
    reload?: PiRuntimeInstance['reload']
    interrupt?: WorkSession['interrupt']
  }
): WorkSession {
  Object.defineProperties(runtime, {
    compact: { configurable: true, value: operations.compact },
    reload: { configurable: true, value: operations.reload ?? (async () => undefined) }
  })
  const fake = Object.create(null) as WorkSession
  Object.defineProperties(fake, {
    workId: { value: workId, enumerable: true },
    cwd: { value: cwd, enumerable: true },
    sessionId: { value: runtime.sessionId, enumerable: true },
    branchId: { value: runtime.branchId, enumerable: true },
    send: { value: operations.send, enumerable: true },
    interrupt: { value: operations.interrupt ?? (async () => undefined), enumerable: true }
  })
  return fake
}

async function createFixture(
  operations: {
    send: WorkSession['send']
    compact: PiRuntimeInstance['compact']
    reload?: PiRuntimeInstance['reload']
    interrupt?: WorkSession['interrupt']
  },
  prepareRuntime?: (
    runtime: ReturnType<PiRuntimeModule['L4PiWorkSessionRuntime']['create']>
  ) => void
): Promise<{
  chatRuntime: InstanceType<ChatRuntimeModule['L2WorkSessionChatRuntime']>
  workSession: WorkSession
  piRuntime: ReturnType<PiRuntimeModule['L4PiWorkSessionRuntime']['create']>
  source: {
    workId: string
    sessionId: string
    branchId: string
  }
  dispose: () => Promise<void>
}> {
  const [chatRuntimeModule, { L4PiWorkSessionRuntime }] = await modulesPromise
  const dataRoot = join(
    process.cwd(),
    'temp/tests/l2-work-session-chat-runtime/c7-source-recovery-01a0dcda'
  )
  await mkdir(dataRoot, { recursive: true })
  const cwd = await mkdtemp(join(dataRoot, 'session-'))
  const piRuntime = L4PiWorkSessionRuntime.create(cwd)
  prepareRuntime?.(piRuntime)
  const workSession = fakeWorkSession('work-1', cwd, piRuntime, operations)
  const chatRuntime = new chatRuntimeModule.L2WorkSessionChatRuntime()
  await chatRuntime.initialize([workSession])

  return {
    chatRuntime,
    workSession,
    piRuntime,
    source: {
      workId: workSession.workId,
      sessionId: workSession.sessionId,
      branchId: workSession.branchId
    },
    dispose: async (): Promise<void> => {
      await piRuntime.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

function installChatSnapshot(
  runtime: PiRuntimeInstance,
  entries: () => readonly L4PiChatProjectedEntry[]
): (event: PiChatWorkerEvent) => void {
  let listener: PiChatWorkerEventListener | undefined
  Object.defineProperties(runtime, {
    readChatSnapshot: {
      configurable: true,
      value: () => ({ sessionName: null, entries: [...entries()] })
    },
    subscribeChat: {
      configurable: true,
      value: (nextListener: PiChatWorkerEventListener): (() => void) => {
        listener = nextListener
        return () => {
          if (listener === nextListener) listener = undefined
        }
      }
    }
  })

  return (event): void => {
    if (!listener) throw new Error('Chat event listener has not been subscribed')
    listener(event)
  }
}

function assistantEntry(
  entryId: string,
  text: string,
  thinking: string,
  timestampMs: number
): L4PiChatProjectedEntry {
  return {
    entryId,
    timestampMs,
    message: {
      type: 'assistant',
      text,
      thinking,
      status: 'completed',
      errorMessage: null,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0.001 }
    }
  }
}

function temporaryAssistantMessage(
  text: string,
  thinking: string
): Extract<L4PiChatMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    text,
    thinking,
    status: 'running',
    errorMessage: null,
    usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    declaration: {
      message: { kind: 'assistant', text, thinking, stopReason: null },
      raw: { unsafe: () => undefined }
    }
  }
}

function customMessage(text: string): Extract<L4PiChatMessage, { type: 'custom' }> {
  return {
    type: 'custom',
    text,
    declaration: {
      message: { kind: 'custom', customType: 'fixture/custom', content: text, details: null },
      raw: { text }
    }
  }
}

test('有效cursor只返回后缀且保留Canonical Detail，无效cursor回退全量', async () => {
  const entries = [
    assistantEntry('cursor-first', 'first', 'first-thinking', 100),
    assistantEntry('cursor-last', 'last', 'last-thinking', 101)
  ]
  const fixture = await createFixture(
    {
      async send() {
        throw new Error('unused')
      },
      async compact() {}
    },
    (runtime) => {
      installChatSnapshot(runtime, () => entries)
    }
  )
  try {
    const { chatRuntime, source } = fixture
    const sync = chatRuntime.createSync(source, { index: 0, entryId: 'cursor-first' })
    assert.equal(sync.event.mode, 'incremental')
    assert.deepEqual(
      sync.event.messages.map((message) => message.location.entryId),
      ['cursor-last']
    )
    assert.equal(sync.event.messages[0]?.detail, undefined)
    assert.deepEqual(
      chatRuntime.getMessageDetail({
        sessionId: source.sessionId,
        branchId: source.branchId,
        entryId: 'cursor-last'
      }).detail,
      { thinking: 'last-thinking' }
    )
    const end = chatRuntime.createSync(source, { index: 1, entryId: 'cursor-last' })
    assert.equal(end.event.mode, 'incremental')
    assert.deepEqual(end.event.messages, [])
    assert.equal(end.watermark, sync.watermark)
    assert.deepEqual(end.event.temporaryMessages, sync.event.temporaryMessages)
    assert.deepEqual(end.event.runtime, sync.event.runtime)
    const invalid = chatRuntime.createSync(source, { index: 0, entryId: 'wrong-entry' })
    assert.equal(invalid.event.mode, 'full')
    assert.deepEqual(
      invalid.event.messages.map((message) => message.location.entryId),
      ['cursor-first', 'cursor-last']
    )
    assert.ok(invalid.event.messages.every((message) => message.detail === undefined))
  } finally {
    await fixture.dispose()
  }
})

test(
  '迟到Node Message Declaration只重投影已接纳前缀并保留Temporary与Canonical Detail',
  { timeout: 45_000 },
  async () => {
    const [chatRuntimeModule, { L4PiWorkSessionRuntime }] = await modulesPromise
    const cwd = await mkdtemp(
      join(process.cwd(), 'temp/tests/l2-work-session-chat-plugin-projection-')
    )
    const ownerRoot = join(
      process.cwd(),
      'temp/tests/l2-work-session-chat-plugin-projection-owner',
      String(process.pid)
    )
    const packageRoot = join(ownerRoot, 'package')
    const packageSource: L4PiPluginPackageSource = {
      source: packageRoot,
      installedPath: packageRoot
    }
    let releasePackageProvider: (() => void) | undefined
    let markPackageProviderStarted: (() => void) | undefined
    const packageProviderStarted = new Promise<void>((resolveStarted) => {
      markPackageProviderStarted = resolveStarted
    })
    const packageProviderGate = new Promise<void>((resolveGate) => {
      releasePackageProvider = resolveGate
    })
    const owner = new L4PiPluginOwnerRuntime(async () => {
      markPackageProviderStarted?.()
      await packageProviderGate
      return [packageSource]
    })
    const globalState = globalThis as Record<string, unknown>
    const globalRuntimeKey = '__piDeskGlobalPluginRuntime'
    const previousGlobalRuntime = globalState[globalRuntimeKey]
    globalState[globalRuntimeKey] = owner
    let piRuntime: ReturnType<typeof L4PiWorkSessionRuntime.create> | undefined
    let chatRuntime: InstanceType<ChatRuntimeModule['L2WorkSessionChatRuntime']> | undefined
    let unsubscribe = (): void => undefined
    let pluginInitialization: Promise<void> | undefined

    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'late-message-declaration',
        type: 'module',
        piDesk: { entry: './entry.mjs' }
      }),
      'utf8'
    )
    await writeFile(
      join(packageRoot, 'entry.mjs'),
      `export default {
  name: 'late-message-declaration',
  setup(plugin) {
    plugin.declareMessage('history', {
      priority: 100,
      match(input) {
        return input.stage === 'durable' && input.message.kind === 'assistant' && input.message.text.includes('history')
      },
      project(input) {
        return {
          viewKey: 'late-message-declaration/history',
          summary: { text: '重新投影：' + input.message.text },
          detail: { output: 'canonical history detail' }
        }
      }
    })
  }
}
`,
      'utf8'
    )

    try {
      piRuntime = L4PiWorkSessionRuntime.create(cwd)
      const sessionManager = Reflect.get(piRuntime, 'sessionManager') as SessionManager
      const usage = {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      }
      const historyEntryId = sessionManager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'history canonical text' }],
        api: 'openai-completions',
        provider: 'fixture',
        model: 'fixture',
        usage,
        stopReason: 'stop',
        timestamp: Date.now()
      })
      const workSession = fakeWorkSession('work-history', cwd, piRuntime, {
        send: async () => ({ tempId: 'unused' }),
        compact: async () => undefined
      })
      chatRuntime = new chatRuntimeModule.L2WorkSessionChatRuntime()
      await chatRuntime.initialize([workSession])
      const source = {
        workId: workSession.workId,
        sessionId: workSession.sessionId,
        branchId: workSession.branchId
      }
      const initial = chatRuntime.createSync(source, null).event
      assert.equal(initial.type, 'session_sync')
      assert.equal(initial.messages[0]?.location.entryId, historyEntryId)
      assert.equal(initial.messages[0]?.fixed.viewKey, 'pi-desk/assistant')

      const futureEntryId = sessionManager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'history not committed to ChatRuntime' }],
        api: 'openai-completions',
        provider: 'fixture',
        model: 'fixture',
        usage,
        stopReason: 'stop',
        timestamp: Date.now() + 1
      })
      const worker = Reflect.get(piRuntime, 'chatWorker')
      const emitWorkerEvent = Reflect.get(worker, 'emit')
      const temporaryMessage = {
        type: 'assistant',
        text: 'live temporary text',
        thinking: 'live temporary thinking',
        status: 'running',
        errorMessage: null,
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }
      }
      const temporaryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      Reflect.apply(emitWorkerEvent, worker, [
        { type: 'message_start', tempId: temporaryId, message: temporaryMessage }
      ])

      const sourceEvents: Array<{ type: string; event?: unknown }> = []
      unsubscribe = chatRuntime.subscribe((event) => sourceEvents.push(event))
      pluginInitialization = owner.initialize()
      await packageProviderStarted
      assert.deepEqual(owner.readMessageDeclarations(), [])
      releasePackageProvider?.()
      await pluginInitialization
      chatRuntime.refreshPluginMessages()

      const refreshedEvent = sourceEvents.at(-1)
      assert.equal(refreshedEvent?.type, 'source_event')
      assert.equal((refreshedEvent?.event as { type: string }).type, 'session_sync')
      const refreshed = refreshedEvent?.event as {
        type: 'session_sync'
        mode: 'full' | 'incremental'
        messages: Array<{
          location: { entryId: string }
          fixed: { viewKey: string }
          summary: { text?: string }
        }>
        temporaryMessages: Array<{ location: { tempId: string } }>
      }
      assert.equal(refreshed.mode, 'full')
      assert.equal(refreshed.messages.length, 1)
      assert.equal(refreshed.messages[0]?.location.entryId, historyEntryId)
      assert.equal(refreshed.messages[0]?.fixed.viewKey, 'late-message-declaration/history')
      assert.equal(refreshed.messages[0]?.summary.text, '重新投影：history canonical text')
      assert.deepEqual(
        refreshed.temporaryMessages.map((message) => message.location.tempId),
        [temporaryId]
      )
      assert.equal(
        sourceEvents.some(
          (event) =>
            (event.event as { type?: string; durable?: { entryId?: string } }).type ===
              'message_commit' &&
            (event.event as { durable?: { entryId?: string } }).durable?.entryId === futureEntryId
        ),
        false
      )
      assert.deepEqual(
        chatRuntime.getMessageDetail({
          sessionId: workSession.sessionId,
          branchId: workSession.branchId,
          entryId: historyEntryId
        }).detail,
        { output: 'canonical history detail' }
      )

      Reflect.apply(emitWorkerEvent, worker, [
        {
          type: 'message_commit',
          tempId: temporaryId,
          entryId: futureEntryId,
          timestampMs: Date.now() + 1,
          message: {
            ...temporaryMessage,
            text: 'history committed after plugin readiness',
            status: 'completed'
          }
        }
      ])
      const afterCommit = chatRuntime.createSync(source, null).event
      assert.equal(afterCommit.type, 'session_sync')
      assert.deepEqual(
        afterCommit.messages.map((message) => message.location.entryId),
        [historyEntryId, futureEntryId]
      )
      assert.equal(afterCommit.temporaryMessages.length, 0)
    } finally {
      unsubscribe()
      releasePackageProvider?.()
      await pluginInitialization?.catch(() => undefined)
      await owner.dispose()
      if (previousGlobalRuntime === undefined) delete globalState[globalRuntimeKey]
      else globalState[globalRuntimeKey] = previousGlobalRuntime
      await piRuntime?.dispose()
      await rm(cwd, { recursive: true, force: true })
      await rm(ownerRoot, { recursive: true, force: true })
    }
  }
)

test('Custom Detail只进入Canonical按需查询，不预发Temporary、Commit与重连Snapshot', async () => {
  const declaration: PluginMessageDeclaration = {
    priority: 100,
    match: ({ message }) => message.kind === 'custom' && message.customType === 'fixture/custom',
    project: ({ message, stage }) => {
      if (message.kind !== 'custom') throw new Error('expected custom message')
      return {
        viewKey: 'fixture/custom',
        summary: { text: message.content },
        detail: { output: `canonical:${stage}:${message.content}` }
      }
    }
  }
  const globalState = globalThis as Record<string, unknown>
  const runtimeKey = '__piDeskGlobalPluginRuntime'
  const previousRuntime = globalState[runtimeKey]
  globalState[runtimeKey] = {
    readMessageDeclarations: () => [
      { pluginName: 'fixture', declarationName: 'custom', declaration }
    ]
  }
  const historyEntry: L4PiChatProjectedEntry = {
    entryId: 'entry-custom-history',
    timestampMs: 100,
    message: customMessage('history')
  }
  let emitChatEvent!: (event: PiChatWorkerEvent) => void
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined
  let unsubscribe = (): void => undefined
  const sourceEvents: Array<{ type: string; event?: unknown }> = []

  try {
    fixture = await createFixture(
      {
        send: async () => ({ tempId: 'unused' }),
        compact: async () => undefined
      },
      (runtime) => {
        emitChatEvent = installChatSnapshot(runtime, () => [historyEntry])
      }
    )
    unsubscribe = fixture.chatRuntime.subscribe((event) => {
      if (event.type === 'source_event') sourceEvents.push(event)
    })

    const history = fixture.chatRuntime.createSync(fixture.source, null).event
    assert.equal(history.type, 'session_sync')
    assert.equal(history.messages[0]?.fixed.viewKey, 'fixture/custom')
    assert.equal(history.messages[0]?.fixed.hasDetail, true)
    assert.equal(history.messages[0]?.detail, undefined)
    assert.deepEqual(
      fixture.chatRuntime.getMessageDetail({
        sessionId: fixture.source.sessionId,
        branchId: fixture.source.branchId,
        entryId: 'entry-custom-history'
      }).detail,
      { output: 'canonical:durable:history' }
    )

    const tempId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    emitChatEvent({ type: 'message_start', tempId, message: customMessage('draft') })
    const start = sourceEvents.at(-1)?.event as {
      type: string
      snapshot: { fixed: { hasDetail: boolean }; detail?: unknown }
    }
    assert.equal(start.type, 'message_start')
    assert.equal(start.snapshot.fixed.hasDetail, true)
    assert.equal(start.snapshot.detail, undefined)

    emitChatEvent({
      type: 'message_update',
      tempId,
      message: customMessage('draft updated')
    })
    const update = sourceEvents.at(-1)?.event as { type: string; detail?: unknown }
    assert.equal(update.type, 'message_update')
    assert.equal('detail' in update, false)
    assert.equal(JSON.stringify(update).includes('canonical:'), false)

    emitChatEvent({
      type: 'message_commit',
      tempId,
      entryId: 'entry-custom-live',
      timestampMs: 200,
      message: customMessage('committed')
    })
    const commit = sourceEvents.at(-1)?.event as { type: string }
    assert.equal(commit.type, 'message_commit')
    assert.equal(JSON.stringify(commit).includes('canonical:'), false)
    const reconnect = fixture.chatRuntime.createSync(fixture.source, null).event
    assert.equal(reconnect.type, 'session_sync')
    assert.equal(reconnect.mode, 'full')
    assert.deepEqual(
      reconnect.messages.map((message) => [
        message.location.entryId,
        message.fixed.hasDetail,
        message.detail
      ]),
      [
        ['entry-custom-history', true, undefined],
        ['entry-custom-live', true, undefined]
      ]
    )
    assert.deepEqual(
      fixture.chatRuntime.getMessageDetail({
        sessionId: fixture.source.sessionId,
        branchId: fixture.source.branchId,
        entryId: 'entry-custom-live'
      }).detail,
      { output: 'canonical:final:committed' }
    )

    const assistantTempId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    emitChatEvent({
      type: 'message_start',
      tempId: assistantTempId,
      message: temporaryAssistantMessage('answer', 'private thinking')
    })
    const assistantStart = sourceEvents.at(-1)?.event as {
      type: string
      snapshot: { detail?: { thinking?: string } }
    }
    assert.equal(assistantStart.type, 'message_start')
    assert.deepEqual(assistantStart.snapshot.detail, { thinking: 'private thinking' })

    const toolTempId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    emitChatEvent({
      type: 'message_start',
      tempId: toolTempId,
      message: {
        type: 'tool',
        name: 'exec',
        reasoning: null,
        inputPreview: 'command',
        activity: null,
        status: 'completed',
        usage: null,
        output: 'private tool output'
      }
    })
    const toolStart = sourceEvents.at(-1)?.event as {
      type: string
      snapshot: { fixed: { hasDetail: boolean }; detail?: unknown }
    }
    assert.equal(toolStart.type, 'message_start')
    assert.equal(toolStart.snapshot.fixed.hasDetail, true)
    assert.equal(toolStart.snapshot.detail, undefined)
    assert.equal(JSON.stringify(toolStart).includes('private tool output'), false)

    const bashTempId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    emitChatEvent({
      type: 'message_start',
      tempId: bashTempId,
      message: {
        type: 'bash',
        command: 'echo private',
        status: 'completed',
        output: 'private bash output'
      }
    })
    const bashStart = sourceEvents.at(-1)?.event as {
      type: string
      snapshot: { fixed: { hasDetail: boolean }; detail?: unknown }
    }
    assert.equal(bashStart.type, 'message_start')
    assert.equal(bashStart.snapshot.fixed.hasDetail, true)
    assert.equal(bashStart.snapshot.detail, undefined)
    assert.equal(JSON.stringify(bashStart).includes('private bash output'), false)
  } finally {
    unsubscribe()
    await fixture?.dispose()
    if (previousRuntime === undefined) delete globalState[runtimeKey]
    else globalState[runtimeKey] = previousRuntime
  }
})

test('基础展示切换保留Canonical内容并允许运行中双向重投影', async () => {
  const declaration: PluginMessageDeclaration = {
    priority: 100,
    match: ({ message }) => message.kind === 'assistant',
    project: ({ message }) => {
      if (message.kind !== 'assistant') throw new Error('expected assistant declaration input')
      return {
        viewKey: 'fixture/assistant',
        summary: { text: `插件投影：${message.text}` },
        detail: { output: '插件详情' }
      }
    }
  }
  const declarations: L4PiMessageDeclarationRegistration[] = [
    { pluginName: 'fixture', declarationName: 'assistant', declaration }
  ]
  const globalState = globalThis as Record<string, unknown>
  const runtimeKey = '__piDeskGlobalPluginRuntime'
  const previousRuntime = globalState[runtimeKey]
  globalState[runtimeKey] = { readMessageDeclarations: () => declarations }
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined
  let emitChatEvent!: (event: PiChatWorkerEvent) => void
  let unsubscribe = (): void => undefined
  const calls = { reload: 0, interrupt: 0 }

  try {
    fixture = await createFixture(
      {
        send: async () => ({ tempId: 'unused' }),
        compact: async () => undefined,
        async reload(): Promise<void> {
          calls.reload += 1
        },
        async interrupt(): Promise<void> {
          calls.interrupt += 1
        }
      },
      (runtime) => {
        emitChatEvent = installChatSnapshot(runtime, () => [
          assistantEntry('entry-durable', 'Durable正文', 'Durable思考', 100)
        ])
      }
    )
    const sourceEvents: Array<{ type: string; event?: unknown }> = []
    unsubscribe = fixture.chatRuntime.subscribe((event) => sourceEvents.push(event))
    const tempId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const temporaryMessage = temporaryAssistantMessage('Temporary正文', 'Temporary思考')
    emitChatEvent({ type: 'agent_started' })
    emitChatEvent({ type: 'message_start', tempId, message: temporaryMessage })

    const normal = fixture.chatRuntime.createSync(fixture.source, null).event
    assert.equal(normal.type, 'session_sync')
    assert.equal(normal.messages[0]?.fixed.viewKey, 'fixture/assistant')
    assert.equal(normal.messages[0]?.summary.text, '插件投影：Durable正文')
    assert.equal(normal.temporaryMessages[0]?.fixed.viewKey, 'fixture/assistant')

    await fixture.chatRuntime.setPresentation(fixture.source, 'basic')
    const basic = fixture.chatRuntime.createSync(fixture.source, null).event
    assert.equal(basic.type, 'session_sync')
    assert.equal(basic.mode, 'full')
    assert.equal(basic.runtime.presentationMode, 'basic')
    assert.deepEqual(
      basic.messages.map((message) => [
        message.location.entryId,
        message.fixed.viewKey,
        message.summary.text
      ]),
      [['entry-durable', 'pi-desk/assistant', 'Durable正文']]
    )
    assert.equal(basic.temporaryMessages[0]?.location.tempId, tempId)
    assert.equal(basic.temporaryMessages[0]?.fixed.viewKey, 'pi-desk/assistant')
    assert.equal((basic.temporaryMessages[0]?.summary as { text: string }).text, 'Temporary正文')
    assert.deepEqual(
      fixture.chatRuntime.getMessageDetail({
        sessionId: fixture.source.sessionId,
        branchId: fixture.source.branchId,
        entryId: 'entry-durable'
      }).detail,
      { thinking: 'Durable思考' }
    )

    const continuedMessage = temporaryAssistantMessage('Temporary正文继续', 'Temporary思考继续')
    emitChatEvent({ type: 'message_update', tempId, message: continuedMessage })
    const continued = fixture.chatRuntime.createSync(fixture.source, null).event
    assert.equal(
      (continued.temporaryMessages[0]?.summary as { text: string }).text,
      'Temporary正文继续'
    )

    await fixture.chatRuntime.setPresentation(fixture.source, 'normal')
    const restored = fixture.chatRuntime.createSync(fixture.source, null).event
    assert.equal(restored.type, 'session_sync')
    assert.equal(restored.mode, 'full')
    assert.equal(restored.runtime.presentationMode, 'normal')
    assert.equal(restored.messages[0]?.fixed.viewKey, 'fixture/assistant')
    assert.equal(restored.messages[0]?.summary.text, '插件投影：Durable正文')
    assert.equal(calls.reload, 0)
    assert.equal(calls.interrupt, 0)
    assert.equal((sourceEvents.at(-1)?.event as { mode?: string }).mode, 'full')
  } finally {
    unsubscribe()
    await fixture?.dispose()
    if (previousRuntime === undefined) delete globalState[runtimeKey]
    else globalState[runtimeKey] = previousRuntime
  }
})

test('重投影不提前导入Pi预写Entry且相同cursor仍收到Full Snapshot', async () => {
  const entries = [assistantEntry('entry-accepted', '已接纳正文', '已接纳思考', 100)]
  const globalState = globalThis as Record<string, unknown>
  const runtimeKey = '__piDeskGlobalPluginRuntime'
  const previousRuntime = globalState[runtimeKey]
  globalState[runtimeKey] = { readMessageDeclarations: () => [] }
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined
  let emitChatEvent!: (event: PiChatWorkerEvent) => void
  let unsubscribe = (): void => undefined

  try {
    fixture = await createFixture(
      {
        send: async () => ({ tempId: 'unused' }),
        compact: async () => undefined
      },
      (runtime) => {
        emitChatEvent = installChatSnapshot(runtime, () => entries)
      }
    )
    const sourceEvents: Array<{ type: string; event?: unknown }> = []
    unsubscribe = fixture.chatRuntime.subscribe((event) => sourceEvents.push(event))
    const tempId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const temporaryMessage = temporaryAssistantMessage('等待提交', '等待提交思考')
    emitChatEvent({ type: 'message_start', tempId, message: temporaryMessage })
    entries.push(assistantEntry('entry-uncommitted', 'Pi已写但未提交', '', 101))

    await fixture.chatRuntime.setPresentation(fixture.source, 'basic')
    const reconnect = fixture.chatRuntime.createSync(fixture.source, {
      index: 0,
      entryId: 'entry-accepted'
    }).event
    assert.equal(reconnect.type, 'session_sync')
    assert.equal(reconnect.mode, 'full')
    assert.deepEqual(
      reconnect.messages.map((message) => message.location.entryId),
      ['entry-accepted']
    )
    assert.deepEqual(
      reconnect.temporaryMessages.map((message) => message.location.tempId),
      [tempId]
    )
    assert.equal(
      sourceEvents.some(
        (push) =>
          (push.event as { type?: string; durable?: { entryId?: string } }).type ===
            'message_commit' &&
          (push.event as { durable?: { entryId?: string } }).durable?.entryId ===
            'entry-uncommitted'
      ),
      false
    )

    emitChatEvent({
      type: 'message_commit',
      tempId,
      entryId: 'entry-uncommitted',
      timestampMs: 101,
      message: { ...temporaryMessage, text: '提交后的正文', status: 'completed' }
    })
    const committed = fixture.chatRuntime.createSync(fixture.source, null).event
    assert.equal(committed.type, 'session_sync')
    assert.deepEqual(
      committed.messages.map((message) => message.location.entryId),
      ['entry-accepted', 'entry-uncommitted']
    )
  } finally {
    unsubscribe()
    await fixture?.dispose()
    if (previousRuntime === undefined) delete globalState[runtimeKey]
    else globalState[runtimeKey] = previousRuntime
  }
})

test('compact 开始后 send 可提前返回，但不会早于 compact 开始', async () => {
  const compactStarted = deferred<void>()
  const releaseCompact = deferred<void>()
  const sendStarted = deferred<void>()
  const releaseSend = deferred<{ tempId: string }>()
  let compactCompleted = false
  let sendCalls = 0

  const fixture = await createFixture({
    async compact(): Promise<void> {
      compactStarted.resolve()
      await releaseCompact.promise
      compactCompleted = true
    },
    async send(): Promise<{ tempId: string }> {
      sendCalls += 1
      sendStarted.resolve()
      return releaseSend.promise
    }
  })

  try {
    const compactPromise = fixture.chatRuntime.compact(fixture.source)
    await compactStarted.promise
    assert.equal(compactCompleted, false)

    const sendPromise = fixture.chatRuntime.send({
      source: fixture.source,
      mode: 'auto',
      text: '压缩期间消息',
      images: []
    })
    await sendStarted.promise
    assert.equal(sendCalls, 1)
    assert.equal(compactCompleted, false)

    releaseSend.resolve({ tempId: 'temp-1' })
    assert.deepEqual(await sendPromise, { tempId: 'temp-1' })
    assert.equal(compactCompleted, false)

    let compactSettled = false
    void compactPromise.then(() => {
      compactSettled = true
    })
    await Promise.resolve()
    assert.equal(compactSettled, false)

    releaseCompact.resolve()
    await compactPromise
    assert.equal(compactCompleted, true)
  } finally {
    releaseSend.resolve({ tempId: 'cleanup-send' })
    releaseCompact.resolve()
    await fixture.dispose()
  }
})

test('已有 commandTail 时 compact 与 send 均保持串行，send 等待 compactionStart', async () => {
  const releaseFirstSend = deferred<{ tempId: string }>()
  const compactStarted = deferred<void>()
  const releaseCompact = deferred<void>()
  const sendAfterCompactStarted = deferred<void>()
  const releaseSecondSend = deferred<{ tempId: string }>()
  const calls: string[] = []

  const fixture = await createFixture({
    async send(): Promise<{ tempId: string }> {
      if (calls.length === 0) {
        calls.push('first-send')
        return releaseFirstSend.promise
      }
      calls.push('second-send')
      sendAfterCompactStarted.resolve()
      return releaseSecondSend.promise
    },
    async compact(): Promise<void> {
      calls.push('compact')
      compactStarted.resolve()
      await releaseCompact.promise
    }
  })

  try {
    const firstSend = fixture.chatRuntime.send({
      source: fixture.source,
      mode: 'auto',
      text: '先占用 commandTail',
      images: []
    })
    await Promise.resolve()

    const compactPromise = fixture.chatRuntime.compact(fixture.source)
    const secondSend = fixture.chatRuntime.send({
      source: fixture.source,
      mode: 'auto',
      text: '压缩后发送',
      images: []
    })
    await Promise.resolve()
    assert.deepEqual(calls, ['first-send'])

    releaseFirstSend.resolve({ tempId: 'first' })
    assert.deepEqual(await firstSend, { tempId: 'first' })
    await compactStarted.promise
    assert.deepEqual(calls, ['first-send', 'compact'])

    await sendAfterCompactStarted.promise
    assert.deepEqual(calls, ['first-send', 'compact', 'second-send'])
    assert.equal(fixture.chatRuntime.statusFor(fixture.workSession), 'idle')

    releaseSecondSend.resolve({ tempId: 'second' })
    assert.deepEqual(await secondSend, { tempId: 'second' })

    releaseCompact.resolve()
    await compactPromise
  } finally {
    releaseFirstSend.resolve({ tempId: 'cleanup-first' })
    releaseSecondSend.resolve({ tempId: 'cleanup-second' })
    releaseCompact.resolve()
    await fixture.dispose()
  }
})

test('普通 send 保持 commandTail 串行，acceptingCommands=false 不绕过调度', async () => {
  const releaseFirstSend = deferred<{ tempId: string }>()
  const secondSendStarted = deferred<void>()
  const releaseSecondSend = deferred<{ tempId: string }>()
  const calls: string[] = []

  const fixture = await createFixture({
    async send(): Promise<{ tempId: string }> {
      if (calls.length === 0) {
        calls.push('first-send')
        return releaseFirstSend.promise
      }
      calls.push('second-send')
      secondSendStarted.resolve()
      return releaseSecondSend.promise
    },
    async compact(): Promise<void> {
      throw new Error('本测试不应调用 compact')
    }
  })

  try {
    const firstSend = fixture.chatRuntime.send({
      source: fixture.source,
      mode: 'auto',
      text: '第一条',
      images: []
    })
    const secondSend = fixture.chatRuntime.send({
      source: fixture.source,
      mode: 'auto',
      text: '第二条',
      images: []
    })
    await Promise.resolve()
    assert.deepEqual(calls, ['first-send'])

    releaseFirstSend.resolve({ tempId: 'first' })
    await secondSendStarted.promise
    assert.deepEqual(calls, ['first-send', 'second-send'])

    releaseSecondSend.resolve({ tempId: 'second' })
    assert.deepEqual(await firstSend, { tempId: 'first' })
    assert.deepEqual(await secondSend, { tempId: 'second' })

    await fixture.chatRuntime.pauseWorkSession(fixture.workSession.workId)
    await assert.rejects(
      () =>
        fixture.chatRuntime.send({
          source: fixture.source,
          mode: 'auto',
          text: '暂停期间不可发送',
          images: []
        }),
      /Chat commands are blocked by WorkSession lifecycle/
    )
    fixture.chatRuntime.resumeWorkSession(fixture.workSession.workId)
  } finally {
    releaseFirstSend.resolve({ tempId: 'cleanup-first' })
    releaseSecondSend.resolve({ tempId: 'cleanup-second' })
    await fixture.dispose()
  }
})
