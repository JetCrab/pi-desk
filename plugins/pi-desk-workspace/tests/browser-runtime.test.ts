import assert from 'node:assert/strict'
import test from 'node:test'
import {
  publishWorkspaceChanged,
  resetWorkspaceBrowserRuntime,
  subscribeWorkspaceChanged,
  withWorkspaceSnapshotTimeout
} from '../src/browser-runtime.js'

test('Workspace Snapshot 正常响应不会等待超时', async () => {
  assert.equal(await withWorkspaceSnapshotTimeout(Promise.resolve('ready'), 100), 'ready')
})

test('Workspace Snapshot 永久 pending 时返回可重试超时错误', async () => {
  await assert.rejects(
    () => withWorkspaceSnapshotTimeout(new Promise<never>(() => undefined), 10),
    /读取工作区超时（1 秒）/
  )
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
