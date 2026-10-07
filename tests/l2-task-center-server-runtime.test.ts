import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createJiti } from 'jiti'
import type { L4PiWorkSessionRuntime } from '../src/server/l4_foundation/pi/l4-pi-work-session-runtime'
import type { L4PiTaskDetailEvent } from '../src/server/l4_foundation/pi/l4-pi-task-detail-runtime'

const root = join(
  process.cwd(),
  'temp/pi/l2-task-center-server-runtime',
  `source-check-${process.pid}`
)
process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'agent/sessions')
test.after(async () => {
  await rm(root, { recursive: true, force: true })
})
const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
const modulePromise = jiti.import<
  typeof import('../src/server/l2_biz/task-center/l2-task-center-runtime')
>('../src/server/l2_biz/task-center/l2-task-center-runtime.ts')
const source = { workId: 'task-work', sessionId: 'task-session', branchId: 'v1:main' }
const snapshot = {
  taskId: 'task-1',
  canInterrupt: false,
  body: { kind: 'text' as const, text: 'base', truncated: false }
}

test('观察建立期间Source失效时拒绝返回并释放已创建的观察', async () => {
  const { L2TaskCenterRuntime } = await modulePromise
  let current = true
  let released = 0
  const pi = {
    async watchTaskDetail() {
      current = false
      return {
        snapshot,
        readSnapshot: () => snapshot,
        release: () => {
          released += 1
        }
      }
    }
  } as unknown as L4PiWorkSessionRuntime
  const runtime = new L2TaskCenterRuntime(async () => {
    if (!current) throw new Error('source changed')
    return pi
  })
  await assert.rejects(
    runtime.watchDetail(source, 'task-1', () => undefined),
    /source changed/
  )
  assert.equal(released, 1)
})

test('打断排队后重新解析Source，失败不阻塞后续有效请求', async () => {
  const { L2TaskCenterRuntime } = await modulePromise
  let current = true
  let calls = 0
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const pi = {
    async interruptTask() {
      calls += 1
      if (calls === 1) {
        started.resolve()
        await finish.promise
      }
    }
  } as unknown as L4PiWorkSessionRuntime
  const runtime = new L2TaskCenterRuntime(async () => {
    if (!current) throw new Error('source changed')
    return pi
  })
  const first = runtime.interrupt(source, 'task-1')
  await started.promise
  const second = runtime.interrupt(source, 'task-1')
  const rejected = assert.rejects(second, /source changed/)
  current = false
  finish.resolve()
  await first
  await rejected
  assert.equal(calls, 1)
  current = true
  await runtime.interrupt(source, 'task-1')
  assert.equal(calls, 2)
})

test('观察建立前排队的增量进入基线，释放后忽略迟到事件', async () => {
  const { L2TaskCenterRuntime } = await modulePromise
  let emit!: (event: L4PiTaskDetailEvent) => void
  let released = 0
  const events: string[] = []
  const pi = {
    async watchTaskDetail(_taskId: string, listener: typeof emit) {
      emit = listener
      listener({ type: 'text_append', text: '-queued' })
      return {
        snapshot,
        readSnapshot: () => snapshot,
        release: () => {
          released += 1
        }
      }
    }
  } as unknown as L4PiWorkSessionRuntime
  const runtime = new L2TaskCenterRuntime(async () => pi)
  const observation = await runtime.watchDetail(source, 'task-1', (event) =>
    events.push(event.type)
  )
  assert.equal(observation.snapshot.body?.kind, 'text')
  assert.equal(
    observation.snapshot.body?.kind === 'text' ? observation.snapshot.body.text : '',
    'base-queued'
  )
  assert.deepEqual(events, ['text_append'])
  observation.release()
  observation.release()
  emit({ type: 'text_append', text: '-late' })
  assert.equal(released, 1)
  assert.deepEqual(events, ['text_append'])
})
