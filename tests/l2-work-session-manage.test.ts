import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createJiti } from 'jiti'
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

async function createFixture(context: TestContext): Promise<{
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
