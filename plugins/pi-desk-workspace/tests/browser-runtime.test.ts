import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  getWorkspaceSubmissions,
  publishWorkspaceChanged,
  reconcileWorkspaceSubmissions,
  resetWorkspaceBrowserRuntime,
  submitWorkspaceCommand,
  subscribeWorkspaceSubmissions,
  subscribeWorkspaceChanged,
  withWorkspaceSnapshotTimeout
} from '../src/browser-runtime.js'

afterEach(resetWorkspaceBrowserRuntime)

const source = { workId: 'work-1', sessionId: 'session-1', branchId: 'branch-1' }
const draft = {
  commandId: 'reset',
  workspaceRef: 'ws-first@as-first',
  values: { branch: 'release' },
  confirmation: {}
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('提交立即登记，同一工作区防重复，其他工作区可并行', async () => {
  const first = deferred<Record<string, string>>()
  let calls = 0
  const input = { source, workspaceId: 'ws-first', draft }
  const pending = submitWorkspaceCommand(input, () => {
    calls += 1
    return first.promise
  })
  assert.equal(getWorkspaceSubmissions()[0]?.error, null)
  assert.equal(
    await submitWorkspaceCommand(input, async () => {
      calls += 1
      return {}
    }),
    null
  )
  assert.deepEqual(
    await submitWorkspaceCommand({ ...input, workspaceId: 'ws-second' }, async () => ({
      command: 'reset'
    })),
    { command: 'reset' }
  )
  assert.equal(calls, 1)
  assert.equal(getWorkspaceSubmissions().length, 1)
  first.resolve({ command: 'reset' })
  await pending
  assert.equal(getWorkspaceSubmissions().length, 0)
})

test('视图退订不取消提交，失败保存草稿并通知页面Owner', async () => {
  const request = deferred<Record<string, string>>()
  const failures: string[] = []
  const stopOwner = subscribeWorkspaceSubmissions((failure) => {
    if (failure?.error) failures.push(failure.error)
  })
  const stopView = subscribeWorkspaceSubmissions(() => undefined)
  const pending = submitWorkspaceCommand(
    { source, workspaceId: 'ws-first', draft },
    () => request.promise
  )
  stopView()
  request.reject(new Error('连接中断'))
  assert.equal(await pending, null)
  const failed = getWorkspaceSubmissions()[0]!
  assert.deepEqual(failed.draft.values, { branch: 'release' })
  assert.equal(failed.draft.confirmation, null)
  assert.match(failed.error!, /连接中断/)
  assert.equal(failures.length, 1)
  stopOwner()
})

test('Owner释放后迟到响应不恢复状态或污染新Owner', async () => {
  const request = deferred<Record<string, string>>()
  const input = { source, workspaceId: 'ws-first', draft }
  const old = submitWorkspaceCommand(input, () => request.promise)
  resetWorkspaceBrowserRuntime()
  const current = deferred<Record<string, string>>()
  const active = submitWorkspaceCommand(input, () => current.promise)
  request.reject(new Error('旧请求失败'))
  assert.equal(await old, null)
  assert.equal(getWorkspaceSubmissions().length, 1)
  assert.equal(getWorkspaceSubmissions()[0]?.error, null)
  current.resolve({})
  await active
})

test('失败草稿最多20份，工作区重新分配或删除后移除对应草稿', async (context) => {
  context.mock.method(console, 'warn', () => undefined)
  for (let index = 0; index < 23; index += 1) {
    await submitWorkspaceCommand({ source, workspaceId: `ws-${index}`, draft }, async () => {
      throw new Error('参数无效')
    })
  }
  assert.equal(getWorkspaceSubmissions().length, 20)
  reconcileWorkspaceSubmissions({ ...source, branchId: 'other' }, {
    workspaces: []
  } as unknown as Parameters<typeof reconcileWorkspaceSubmissions>[1])
  assert.equal(getWorkspaceSubmissions().length, 20)
  reconcileWorkspaceSubmissions(source, { workspaces: [] } as unknown as Parameters<
    typeof reconcileWorkspaceSubmissions
  >[1])
  assert.equal(getWorkspaceSubmissions().length, 0)
})

test('Workspace Snapshot 正常响应不会等待超时', async () => {
  assert.equal(await withWorkspaceSnapshotTimeout(Promise.resolve('ready'), 100), 'ready')
})

test('Workspace Snapshot 永久 pending 时返回可重试超时错误', async () => {
  await assert.rejects(
    () => withWorkspaceSnapshotTimeout(new Promise<never>(() => undefined), 10),
    /读取工作区超时（1 秒）/
  )
})

test('后台命令失败推送保留错误级别', () => {
  const event = publishWorkspaceChanged({
    pluginName: 'workspace',
    event: 'changed',
    target: { scope: 'session', source },
    data: { workspaceId: 'ws-123456789abc', summary: 'reset 执行失败', level: 'error' }
  } as Parameters<typeof publishWorkspaceChanged>[0])
  assert.equal(event?.level, 'error')
  assert.equal(event?.summary, 'reset 执行失败')
})

test('Workspace changed Push 到达时通知订阅者并保留其 Source', () => {
  resetWorkspaceBrowserRuntime()
  const received: unknown[] = []
  const unsubscribe = subscribeWorkspaceChanged((event) => received.push(event))
  const source = { workId: 'work-1', sessionId: 'session-1', branchId: 'branch-1' }

  try {
    const event = publishWorkspaceChanged({
      pluginName: 'workspace',
      event: 'changed',
      target: { scope: 'session', source },
      data: { workspaceId: 'ws-123456789abc', summary: 'run completed' }
    } as Parameters<typeof publishWorkspaceChanged>[0])

    assert.deepEqual(event, {
      source,
      workspaceId: 'ws-123456789abc',
      summary: 'run completed'
    })
    assert.deepEqual(received, [event])
  } finally {
    unsubscribe()
    resetWorkspaceBrowserRuntime()
  }
})
