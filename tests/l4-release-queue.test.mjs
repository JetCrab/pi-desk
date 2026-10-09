import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForDevBatch } from '../.github/scripts/release-queue.mjs'

test('后提交批次等待前批次结束，不等待更晚的提交', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let previousActive = true
  context.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/runs/200')) return Response.json({ workflow_id: 1 })
    return Response.json({
      workflow_runs: url.includes('status=in_progress')
        ? [
            ...(previousActive ? [{ id: 100, head_branch: 'dev' }] : []),
            { id: 300, head_branch: 'dev' }
          ]
        : []
    })
  })
  let ready = false
  const waiting = waitForDevBatch({
    repository: 'Fixture/project',
    runId: '200',
    token: 'fixture'
  }).then(() => {
    ready = true
  })
  await new Promise(setImmediate)
  assert.equal(ready, false)
  previousActive = false
  context.mock.timers.tick(15_000)
  await waiting
  assert.equal(ready, true)
})

test('GitHub明确限流时等待额度恢复而不取消批次', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let reads = 0
  context.mock.method(globalThis, 'fetch', async (url) => {
    reads += 1
    if (reads === 1)
      return new Response('', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '15' }
      })
    return Response.json(url.endsWith('/runs/200') ? { workflow_id: 1 } : { workflow_runs: [] })
  })
  const waiting = waitForDevBatch({ repository: 'Fixture/project', runId: '200', token: 'fixture' })
  await new Promise(setImmediate)
  assert.equal(reads, 1)
  context.mock.timers.tick(16_000)
  await waiting
  assert.equal(reads, 7)
})

test('调度查询失败不误认为前批次已经完成', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }))
  await assert.rejects(
    waitForDevBatch({ repository: 'Fixture/project', runId: '200', token: 'fixture' }),
    /HTTP 403/
  )
})
