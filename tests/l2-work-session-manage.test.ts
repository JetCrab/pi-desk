import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createJiti } from 'jiti'
import type { PluginWorkSession } from '@jetcrab/pi-desk-sdk/entry'
import { L4PiPluginOwnerRuntime } from '../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime'
import type { L2WorkSessionListResponse } from '../src/common/l2_biz/work-session/l2-work-session-contract'
import type { L2WorkSessionsUpdate } from '../src/common/l2_biz/work-session/l2-work-session-realtime-contract'
import type { L4PiChatWorkerEvent } from '../src/server/l4_foundation/pi/l4-pi-chat-worker'

type ManageModule = typeof import('../src/server/l2_biz/work-session/l2-work-session-manage')
type PiRuntimeModule = typeof import('../src/server/l4_foundation/pi/l4-pi-work-session-runtime')

const runRoot = join(process.cwd(), 'temp/run/work-session-update', `sparse-fields-${process.pid}`)
process.env.PI_CODING_AGENT_DIR = join(runRoot, 'agent')
process.env.PI_CODING_AGENT_SESSION_DIR = join(runRoot, 'agent/sessions')

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
const modulesPromise: Promise<[ManageModule, PiRuntimeModule]> = Promise.all([
  jiti.import<ManageModule>('../src/server/l2_biz/work-session/l2-work-session-manage.ts'),
  jiti.import<PiRuntimeModule>('../src/server/l4_foundation/pi/l4-pi-work-session-runtime.ts')
])

async function createFixture(
  context: TestContext,
  beforeInitialize?: (manage: InstanceType<ManageModule['WorkSessionManage']>) => void
): Promise<{
  manage: InstanceType<ManageModule['WorkSessionManage']>
  workId: string
  updates: L2WorkSessionsUpdate[]
  emit: (event: L4PiChatWorkerEvent) => void
}> {
  await mkdir(runRoot, { recursive: true })
  const root = await mkdtemp(join(runRoot, 'session-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const [{ WorkSessionManage }, { L4PiWorkSessionRuntime }] = await modulesPromise
  const runtime = L4PiWorkSessionRuntime.create(cwd)
  let listener: ((event: L4PiChatWorkerEvent) => void) | undefined
  context.mock.method(runtime, 'subscribeChat', (next: typeof listener): (() => void) => {
    listener = next
    return (): void => {
      listener = undefined
    }
  })
  const workId = randomUUID()
  const storePath = join(root, 'work-sessions.json')
  await writeFile(
    storePath,
    JSON.stringify({
      workSessions: [{ workId, cwd: runtime.cwd, sessionId: runtime.sessionId }],
      pinnedCount: 0
    })
  )
  const manage = new WorkSessionManage(storePath)
  const updates: L2WorkSessionsUpdate[] = []
  const unsubscribe = manage.subscribeUpdates((update) => updates.push(update))
  context.after(async () => {
    unsubscribe()
    await manage.removeWorkSession(workId)
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })
  beforeInitialize?.(manage)
  await manage.initialize()
  assert.ok(listener, '恢复的会话必须已建立 Worker 事件订阅')
  return {
    manage,
    workId,
    updates,
    emit(event): void {
      assert.ok(listener)
      listener(event)
    }
  }
}

test.after(async () => {
  await rm(runRoot, { recursive: true, force: true })
})

test('运行和完成确认只推送状态，不重复标题和消息元数据', async (context) => {
  const { manage, workId, updates, emit } = await createFixture(context)
  emit({ type: 'session_info_changed', sessionTitle: '已有标题' })
  updates.length = 0

  emit({ type: 'agent_started' })
  emit({ type: 'agent_settled' })
  await manage.acknowledgeCompleted(workId)
  await manage.acknowledgeCompleted(workId)

  assert.deepEqual(updates, [
    { type: 'update', workId, changes: { status: 'main_running' } },
    { type: 'update', workId, changes: { status: 'completed' } },
    { type: 'update', workId, changes: { status: 'idle' } }
  ])
})

test('标题更新和清除只携带标题，相同标题不推送', async (context) => {
  const { workId, updates, emit } = await createFixture(context)
  emit({ type: 'session_info_changed', sessionTitle: '新标题' })
  emit({ type: 'session_info_changed', sessionTitle: '新标题' })
  emit({ type: 'session_info_changed', sessionTitle: null })
  emit({ type: 'session_info_changed', sessionTitle: null })

  assert.deepEqual(updates, [
    { type: 'update', workId, changes: { sessionTitle: '新标题' } },
    { type: 'update', workId, changes: { sessionTitle: null } }
  ])
})

test('改名拒绝失效绑定和空标题，合法请求只推送规范化后的标题', async (context) => {
  const { manage, workId, updates, emit } = await createFixture(context)
  const [{ WorkSessionBindingChangedError, WorkSessionNotFoundError }] = await modulesPromise
  const workSession = await manage.getWorkSession(workId)
  assert.ok(workSession)
  const setTitle = context.mock.method(workSession, 'setTitle', async (title: string) => {
    emit({ type: 'session_info_changed', sessionTitle: title })
  })
  const input = { workId, sessionId: workSession.sessionId, title: '  用户指定标题  ' }

  await assert.rejects(
    manage.renameWorkSession({ ...input, sessionId: randomUUID() }),
    WorkSessionBindingChangedError
  )
  await assert.rejects(
    manage.renameWorkSession({ ...input, workId: 'missing-session' }),
    WorkSessionNotFoundError
  )
  assert.throws(() => manage.renameWorkSession({ ...input, title: ' \n ' }))
  assert.equal(setTitle.mock.callCount(), 0)
  assert.deepEqual(updates, [])

  await manage.renameWorkSession(input)
  assert.deepEqual(setTitle.mock.calls[0]?.arguments, ['用户指定标题'])
  assert.deepEqual(updates, [{ type: 'update', workId, changes: { sessionTitle: '用户指定标题' } }])
})

test('消息提交只推送发生变化的标题、计数和时间', async (context) => {
  const { workId, updates, emit } = await createFixture(context)
  const firstTempId = randomUUID()
  const userMessage = { type: 'user' as const, text: '首条消息', images: [] }
  emit({ type: 'message_start', tempId: firstTempId, message: userMessage })
  assert.deepEqual(updates, [])
  emit({
    type: 'message_commit',
    tempId: firstTempId,
    entryId: 'first-user',
    timestampMs: 100,
    message: userMessage
  })

  const secondTempId = randomUUID()
  const assistantMessage = {
    type: 'assistant' as const,
    text: '回复',
    thinking: '',
    status: 'completed' as const,
    errorMessage: null,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0 }
  }
  emit({ type: 'message_start', tempId: secondTempId, message: assistantMessage })
  emit({
    type: 'message_commit',
    tempId: secondTempId,
    entryId: 'first-assistant',
    timestampMs: 101,
    message: assistantMessage
  })

  assert.deepEqual(updates, [
    {
      type: 'update',
      workId,
      changes: {
        sessionTitle: '首条消息',
        messageCounts: { user: 1, total: 1 },
        lastMessageUpdatedAt: 100
      }
    },
    {
      type: 'update',
      workId,
      changes: {
        messageCounts: { user: 1, total: 2 },
        lastMessageUpdatedAt: 101
      }
    }
  ])
})

test('后台任务集合改变但展示状态不变时不推送', async (context) => {
  const { workId, updates, emit } = await createFixture(context)
  emit({ type: 'background_tasks_changed', taskIds: [] })
  emit({ type: 'agent_settled' })
  emit({ type: 'background_tasks_changed', taskIds: ['task-a'] })
  emit({ type: 'background_tasks_changed', taskIds: ['task-b'] })
  emit({ type: 'agent_started' })
  emit({ type: 'background_tasks_changed', taskIds: [] })
  emit({ type: 'main_operation_finished' })
  emit({ type: 'agent_settled' })

  assert.deepEqual(updates, [
    { type: 'update', workId, changes: { status: 'background_running' } },
    { type: 'update', workId, changes: { status: 'main_running' } },
    { type: 'update', workId, changes: { status: 'idle' } }
  ])
})

test('hydrate快照驱动Node列表状态，创建替换排序删除和状态同步，内部元数据变化不重复通知', async (context) => {
  await mkdir(runRoot, { recursive: true })
  const pluginRoot = await mkdtemp(join(runRoot, 'event-owner-'))
  await writeFile(
    join(pluginRoot, 'package.json'),
    JSON.stringify({
      name: 'session-events',
      type: 'module',
      piDesk: { entry: 'entry.js' }
    })
  )
  const states: Array<readonly PluginWorkSession[]> = []
  const accepted: unknown[] = []
  Reflect.set(globalThis, '__piDeskManageEventStates', states)
  Reflect.set(globalThis, '__piDeskManageAccepted', accepted)
  await writeFile(
    join(pluginRoot, 'entry.js'),
    `export default {
    name: 'session-events',
    setup(plugin) {
      plugin.host.events.on('work-sessions', (value) => globalThis.__piDeskManageEventStates.push(value))
      plugin.host.events.on('chat-input-accepted', (value) => globalThis.__piDeskManageAccepted.push(value))
      plugin.host.events.on('chat-input-accepted', () => { throw new Error('listener failure') })
    }
  }`
  )
  const runtime = new L4PiPluginOwnerRuntime(async () => [
    { source: pluginRoot, installedPath: pluginRoot }
  ])
  context.after(async () => {
    await runtime.dispose()
    Reflect.deleteProperty(globalThis, '__piDeskManageEventStates')
    Reflect.deleteProperty(globalThis, '__piDeskManageAccepted')
    await rm(pluginRoot, { recursive: true, force: true })
  })
  await runtime.initialize()
  await Promise.resolve()
  assert.equal(states.length, 0)
  const { manage, workId, emit } = await createFixture(context, (manage) => {
    runtime.bindSessionEvents({
      subscribeWorkSessions: (listener) => manage.subscribePluginWorkSessions(listener),
      subscribeInputAccepted: (listener) => manage.subscribeInputAccepted(listener)
    })
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(states.length, 1)
  const initial = states[0][0]
  assert.equal(initial.source.workId, workId)
  const workSession = await manage.getWorkSession(workId)
  assert.ok(workSession)
  context.mock.method(workSession, 'send', async () => ({ tempId: 'worker-accepted' }))
  const warnings = context.mock.method(console, 'warn', () => undefined)
  assert.deepEqual(
    await manage.sendChat({ source: initial.source, mode: 'auto', text: 'input', images: [] }),
    {
      tempId: 'worker-accepted'
    }
  )
  assert.deepEqual(accepted, [{ source: initial.source, tempId: 'worker-accepted' }])
  assert.equal(warnings.mock.callCount(), 1)
  emit({ type: 'session_info_changed', sessionTitle: '内部标题' })
  assert.equal(states.length, 1)
  emit({ type: 'agent_started' })
  emit({ type: 'agent_settled' })
  await manage.acknowledgeCompleted(workId)
  assert.deepEqual(
    states.map((state) => state[0].status),
    ['idle', 'main_running', 'completed', 'idle']
  )
  const second = await manage.createWorkSession(initial.cwd)
  try {
    assert.deepEqual(
      states.at(-1)?.map((item) => item.source.workId),
      [second.workId, workId]
    )
    await manage.setWorkSessionArrangement([workId, second.workId], 0)
    assert.deepEqual(
      states.at(-1)?.map((item) => item.source.workId),
      [workId, second.workId]
    )
    const beforePin = states.length
    await manage.setWorkSessionArrangement([workId, second.workId], 1)
    assert.equal(states.length, beforePin)
    const beforeReplace = states.at(-1)![1].source
    await manage.replaceWorkSession(second.workId)
    const replaced = states.at(-1)![1]
    assert.equal(replaced.source.workId, second.workId)
    assert.notEqual(replaced.source.sessionId, beforeReplace.sessionId)
    const query = await manage.listWorkSessions()
    assert.deepEqual(
      states.at(-1),
      query.workSessions.map(({ workId, sessionId, branchId, cwd, status }) => ({
        source: { workId, sessionId, branchId },
        cwd,
        status
      }))
    )
  } finally {
    await manage.removeWorkSession(second.workId)
  }
  assert.deepEqual(states.at(-1), [initial])
  await runtime.dispose()
  const count = states.length
  await manage.removeWorkSession(workId)
  assert.equal(states.length, count)
})

function observePluginWorkSessions(
  manage: InstanceType<ManageModule['WorkSessionManage']>,
  listener: (sessions: readonly PluginWorkSession[]) => void
): () => void {
  return manage.subscribePluginWorkSessions(listener)
}

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function nextListTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('P2释放A期间B增量不丢失，插件只观察已提交列表且最终收敛', async (context) => {
  for (const action of ['replace', 'delete'] as const) {
    await context.test(action, async (context) => {
      const { manage, workId: workB, updates, emit } = await createFixture(context)
      const b = await manage.getWorkSession(workB)
      assert.ok(b)
      const a = await manage.createWorkSession(b.cwd)
      const reads = context.mock.method(
        manage as unknown as { createSnapshot(): L2WorkSessionListResponse },
        'createSnapshot'
      )
      const [, pi] = await modulesPromise
      const runtimeA = pi.getL4PiWorkSessionRuntime(a.sessionId)
      const originalDispose = runtimeA.dispose.bind(runtimeA)
      const started = deferredSignal()
      const release = deferredSignal()
      context.mock.method(runtimeA, 'dispose', async () => {
        started.resolve()
        await release.promise
        await originalDispose()
      })
      const states: Array<readonly PluginWorkSession[]> = []
      const lateStates: Array<readonly PluginWorkSession[]> = []
      const off = observePluginWorkSessions(manage, (value) => {
        states.push(value)
      })
      await nextListTurn()
      const errors = context.mock.method(console, 'error', () => undefined)
      updates.length = 0
      const operation =
        action === 'replace'
          ? manage.replaceWorkSession(a.workId)
          : manage.removeWorkSession(a.workId)
      let offLate = (): void => undefined
      try {
        await started.promise
        emit({ type: 'agent_started' })
        emit({ type: 'session_info_changed', sessionTitle: 'B的新标题' })
        const message = { type: 'user' as const, text: 'B消息', images: [] }
        const tempId = randomUUID()
        emit({ type: 'message_start', tempId, message })
        emit({ type: 'message_commit', tempId, entryId: 'b-entry', timestampMs: 100, message })
        assert.deepEqual(updates, [
          { type: 'update', workId: workB, changes: { status: 'main_running' } },
          { type: 'update', workId: workB, changes: { sessionTitle: 'B的新标题' } },
          {
            type: 'update',
            workId: workB,
            changes: { messageCounts: { user: 1, total: 1 }, lastMessageUpdatedAt: 100 }
          }
        ])
        assert.equal(errors.mock.callCount(), 0)
        assert.equal(
          states.at(-1)?.find((item) => item.source.workId === workB)?.status,
          'main_running'
        )
        assert.equal(
          states.at(-1)?.find((item) => item.source.workId === a.workId)?.source.sessionId,
          a.sessionId
        )
        offLate = observePluginWorkSessions(manage, (value) => {
          lateStates.push(value)
        })
        await nextListTurn()
        assert.equal(lateStates.length, 0, '生命周期未提交时不能遍历ChatRecord建立新基线')
        release.resolve()
        await operation
        await nextListTurn()
        assert.equal(reads.mock.callCount(), 2, '替换复用已生成快照，删除只为新订阅读取一次基线')
        const current = await manage.listWorkSessions()
        const expected = current.workSessions.map(
          ({ workId, sessionId, branchId, cwd, status }) => ({
            source: { workId, sessionId, branchId },
            cwd,
            status
          })
        )
        assert.deepEqual(states.at(-1), expected)
        assert.deepEqual(lateStates.at(-1), expected)
        const currentB = current.workSessions.find((item) => item.workId === workB)!
        assert.equal(currentB.status, 'main_running')
        assert.equal(currentB.sessionTitle, 'B的新标题')
        assert.deepEqual(currentB.messageCounts, { user: 1, total: 1 })
        assert.equal(errors.mock.callCount(), 0)
      } finally {
        release.resolve()
        await operation
        off()
        offLate()
        await manage.removeWorkSession(a.workId)
      }
    })
  }
})

test('P2列表投影惰性读取，非公开字段不重读，创建排序复用已有完整快照', async (context) => {
  const { manage, workId, emit } = await createFixture(context)
  const methods = manage as unknown as { createSnapshot(): L2WorkSessionListResponse }
  const reads = context.mock.method(methods, 'createSnapshot')
  emit({ type: 'session_info_changed', sessionTitle: '无人订阅' })
  emit({ type: 'agent_started' })
  assert.equal(reads.mock.callCount(), 0)
  const states: Array<readonly PluginWorkSession[]> = []
  const off = observePluginWorkSessions(manage, (value) => {
    states.push(value)
  })
  context.after(off)
  await nextListTurn()
  assert.equal(reads.mock.callCount(), 1)
  assert.equal(states.length, 1)
  emit({ type: 'session_info_changed', sessionTitle: '仅标题变化' })
  const message = { type: 'user' as const, text: '仅计数和时间变化', images: [] }
  const tempId = randomUUID()
  emit({ type: 'message_start', tempId, message })
  emit({ type: 'message_commit', tempId, entryId: 'metadata-entry', timestampMs: 101, message })
  assert.equal(reads.mock.callCount(), 1)
  assert.equal(states.length, 1)
  emit({ type: 'agent_settled' })
  assert.equal(reads.mock.callCount(), 1)
  assert.equal(states.at(-1)?.[0].status, 'completed')
  const second = await manage.createWorkSession(states[0][0].cwd)
  try {
    assert.equal(reads.mock.callCount(), 2, '创建只能使用原流程已有的完整快照')
    await manage.setWorkSessionArrangement([workId, second.workId], 0)
    assert.equal(reads.mock.callCount(), 3, '排序只能使用原流程已有的完整快照')
    assert.deepEqual(
      states.at(-1)?.map((item) => item.source.workId),
      [workId, second.workId]
    )
  } finally {
    await manage.removeWorkSession(second.workId)
    off()
    off()
  }
  assert.equal(reads.mock.callCount(), 3, '删除按已提交delete更新投影')
  emit({ type: 'agent_started' })
  assert.equal(reads.mock.callCount(), 3)
  const latest: Array<readonly PluginWorkSession[]> = []
  const offLatest = observePluginWorkSessions(manage, (value) => {
    latest.push(value)
  })
  await nextListTurn()
  assert.equal(reads.mock.callCount(), 4)
  assert.equal(latest[0][0].status, 'main_running')
  offLatest()
})
