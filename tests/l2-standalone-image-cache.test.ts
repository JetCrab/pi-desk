import assert from 'node:assert/strict'
import test from 'node:test'
import type { L2WorkSessionListItem } from '../src/common/l2_biz/work-session/l2-work-session-contract'
import { L2StandaloneImageCache } from '../src/client/l2_biz/workbench/file-workspace/l2-standalone-image-cache'

const session: L2WorkSessionListItem = {
  workId: 'image-work',
  cwd: 'C:/image-project',
  sessionId: 'image-session',
  branchId: 'v1:main',
  projectName: '图片项目',
  sessionTitle: '图片预览',
  status: 'idle',
  messageCounts: { user: 1, total: 1 },
  lastMessageUpdatedAt: null
}
const target = { source: session, cwd: session.cwd }

test('放大预览关闭后保留图片，压缩和原图独立，来源替换清理旧地址', async () => {
  const cache = new L2StandaloneImageCache()
  cache.reconcileWorkSessions([session])
  try {
    const first = cache.store(target, 'generated.png', 'compressed', new Blob(['compressed']))
    first.release()
    first.release()
    const reopened = cache.get(target, 'generated.png', 'compressed')
    assert.ok(reopened)
    assert.equal(reopened.url, first.url)
    assert.equal(cache.get(target, 'generated.png', 'original'), null)
    const original = cache.store(target, 'generated.png', 'original', new Blob(['original']))
    assert.notEqual(original.url, first.url)
    assert.equal(await (await fetch(original.url)).text(), 'original')
    reopened.release()
    original.release()
    cache.reconcileWorkSessions([{ ...session, branchId: 'v1:replacement' }])
    assert.equal(cache.get(target, 'generated.png', 'compressed'), null)
    await assert.rejects(fetch(first.url))
    await assert.rejects(fetch(original.url))
    assert.throws(
      () => cache.store(target, 'generated.png', 'compressed', new Blob(['late'])),
      /来源已变化/
    )
  } finally {
    cache.dispose()
  }
})

test('闲置预览过期后重新读取，正在展示的图片保持有效', async (context) => {
  let now = 1_000
  context.mock.method(Date, 'now', () => now)
  const cache = new L2StandaloneImageCache()
  cache.reconcileWorkSessions([session])
  try {
    const active = cache.store(target, 'active.png', 'compressed', new Blob(['active']))
    const idle = cache.store(target, 'idle.png', 'compressed', new Blob(['idle']))
    idle.release()
    now += 60_001
    assert.equal(cache.get(target, 'idle.png', 'compressed'), null)
    await assert.rejects(fetch(idle.url))
    assert.equal(await (await fetch(active.url)).text(), 'active')
    active.release()
    cache.dispose()
    await assert.rejects(fetch(active.url))
  } finally {
    cache.dispose()
  }
})
