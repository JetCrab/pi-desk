import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createJiti } from 'jiti'

const testPiRoot = join(
  process.cwd(),
  'temp/pi/l1-task-center-socket-controller',
  `host-review-${process.pid}`
)
const agentDir = join(testPiRoot, 'agent')
process.env.PI_CODING_AGENT_DIR = agentDir
process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
await mkdir(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true })
test.after(async () => {
  await rm(testPiRoot, { recursive: true, force: true })
})

const require = createRequire(import.meta.url)
const serverOnlyEntry = require.resolve('server-only')
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
  alias: { 'server-only': join(dirname(serverOnlyEntry), 'empty.js') }
})
const { L1TaskCenterSocketController } = await jiti.import(
  '../src/server/l1_entry/websocket/l1-task-center-socket-controller.ts'
)

function fakeConnection() {
  const responses = []
  const errors = []
  const pushes = []
  return {
    clientId: 'host-review-fixture',
    responses,
    errors,
    pushes,
    sendSuccess(contract, requestId, data) {
      responses.push({ path: contract.path, requestId, data })
    },
    sendError(path, requestId, code, msg) {
      errors.push({ path, requestId, code, msg })
    },
    sendPush(contract, body) {
      pushes.push({ path: contract.path, body })
    },
    isCurrent: () => true,
    close(code, reason) {
      errors.push({ code, reason })
    }
  }
}

test('Task Socket保留L1参数错误、通用错误响应与Source失效推送', async () => {
  const source = {
    workId: randomUUID(),
    sessionId: randomUUID(),
    branchId: 'v1:main'
  }
  let watchError = null
  let interruptError = null
  let sourceListener
  let releaseCount = 0
  const manage = {
    subscribeMessageEvents(listener) {
      sourceListener = listener
      return () => {
        sourceListener = undefined
      }
    }
  }
  const taskCenter = {
    async watchDetail() {
      if (watchError) throw watchError
      return {
        snapshot: {
          taskId: 'task-1',
          canInterrupt: false,
          body: { kind: 'text', text: 'fixture snapshot', truncated: false }
        },
        release() {
          releaseCount += 1
        }
      }
    },
    async interrupt() {
      if (interruptError) throw interruptError
    }
  }
  const connection = fakeConnection()
  const controller = new L1TaskCenterSocketController(connection, manage, taskCenter)
  const watch = controller.routes.find((route) => route.path === 'task-center/detail-watch')
  const interrupt = controller.routes.find((route) => route.path === 'task-center/interrupt')
  assert.ok(watch)
  assert.ok(interrupt)

  await watch.handle({ head: { path: watch.path, requestId: 'invalid-watch' }, body: {} })
  assert.deepEqual(connection.errors.at(-1), {
    path: watch.path,
    requestId: 'invalid-watch',
    code: 400,
    msg: '任务详情参数无效'
  })

  await watch.handle({
    head: { path: watch.path, requestId: 'empty-watch' },
    body: { source, taskId: null }
  })
  assert.deepEqual(connection.responses.at(-1), {
    path: watch.path,
    requestId: 'empty-watch',
    data: { snapshot: null }
  })

  watchError = new Error('message detail unavailable')
  await watch.handle({
    head: { path: watch.path, requestId: 'unavailable-watch' },
    body: { source, taskId: 'task-1' }
  })
  assert.deepEqual(connection.errors.at(-1), {
    path: watch.path,
    requestId: 'unavailable-watch',
    code: 500,
    msg: '任务详情初始化失败'
  })

  watchError = null
  await watch.handle({
    head: { path: watch.path, requestId: 'ready-watch' },
    body: { source, taskId: 'task-1' }
  })
  assert.equal(connection.responses.at(-1)?.data.snapshot.body.text, 'fixture snapshot')
  sourceListener({ type: 'source_invalidated', source })
  assert.deepEqual(connection.pushes.at(-1)?.body.event, { type: 'unavailable' })
  assert.equal(releaseCount, 1)

  interruptError = new Error('synthetic interrupt failure')
  await interrupt.handle({
    head: { path: interrupt.path, requestId: 'interrupt-failed' },
    body: { source, taskId: 'task-1' }
  })
  assert.deepEqual(connection.errors.at(-1), {
    path: interrupt.path,
    requestId: 'interrupt-failed',
    code: 500,
    msg: '打断任务失败'
  })

  controller.dispose()
  controller.dispose()
})

test('Source在任务观察交付前失效时不发送旧Snapshot并释放观察', async () => {
  const source = { workId: randomUUID(), sessionId: randomUUID(), branchId: 'v1:main' }
  let sourceListener
  let resolveWatch
  let released = 0
  const manage = {
    subscribeMessageEvents(listener) {
      sourceListener = listener
      return () => {
        sourceListener = undefined
      }
    }
  }
  const taskCenter = {
    watchDetail() {
      return new Promise((resolve) => {
        resolveWatch = resolve
      })
    }
  }
  const connection = fakeConnection()
  const controller = new L1TaskCenterSocketController(connection, manage, taskCenter)
  try {
    const watch = controller.routes.find((route) => route.path === 'task-center/detail-watch')
    const pending = watch.handle({
      head: { path: watch.path, requestId: 'pending-watch' },
      body: { source, taskId: 'task-1' }
    })
    await Promise.resolve()
    sourceListener({ type: 'source_invalidated', source })
    resolveWatch({
      snapshot: {
        taskId: 'task-1',
        canInterrupt: false,
        body: { kind: 'text', text: 'old source', truncated: false }
      },
      release() {
        released += 1
      }
    })
    await pending
    assert.equal(connection.responses.length, 0)
    assert.equal(connection.errors.at(-1)?.code, 409)
    assert.equal(released, 1)
  } finally {
    controller.dispose()
  }
})
