import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  L2WorkSessionListItem,
  L2WorkSessionListResponse
} from '../src/common/l2_biz/work-session/l2-work-session-contract'
import { applyL2WorkSessionsUpdate } from '../src/common/l2_biz/work-session/l2-work-session-update'

const SESSION_IDS: Record<string, string> = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222'
}

function item(workId: string, projectName: string): L2WorkSessionListItem {
  return {
    workId,
    cwd: `C:/projects/${projectName}`,
    sessionId: SESSION_IDS[workId] ?? '33333333-3333-4333-8333-333333333333',
    branchId: 'main',
    projectName,
    sessionTitle: null,
    status: 'idle',
    messageCounts: { user: 0, total: 0 },
    lastMessageUpdatedAt: null
  }
}

function state(
  workSessions: L2WorkSessionListItem[],
  pinnedCount: number
): L2WorkSessionListResponse {
  return { workSessions, pinnedCount }
}

test('snapshot 完整替换顺序和固定分界', () => {
  const next = applyL2WorkSessionsUpdate(state([item('a', 'A')], 0), {
    type: 'snapshot',
    workSessions: [item('b', 'B'), item('a', 'A')],
    pinnedCount: 1
  })
  assert.deepEqual(
    next.workSessions.map((workSession) => workSession.workId),
    ['b', 'a']
  )
  assert.equal(next.pinnedCount, 1)
})

test('update 只合并目标字段并保留固定分界', () => {
  const next = applyL2WorkSessionsUpdate(state([item('a', 'A')], 1), {
    type: 'update',
    workId: 'a',
    changes: {
      status: 'completed',
      messageCounts: { user: 2, total: 5 },
      lastMessageUpdatedAt: 1_786_775_400_000
    }
  })
  assert.equal(next.workSessions[0]?.projectName, 'A')
  assert.equal(next.workSessions[0]?.status, 'completed')
  assert.deepEqual(next.workSessions[0]?.messageCounts, { user: 2, total: 5 })
  assert.equal(next.pinnedCount, 1)
})

test('update 和 delete 保留未变化 WorkSession 引用', () => {
  const first = item('a', 'A')
  const second = item('b', 'B')
  const updated = applyL2WorkSessionsUpdate(state([first, second], 1), {
    type: 'update',
    workId: 'b',
    changes: { status: 'completed' }
  })

  assert.strictEqual(updated.workSessions[0], first)
  assert.notStrictEqual(updated.workSessions[1], second)
  assert.strictEqual(updated.workSessions[0]?.messageCounts, first.messageCounts)

  const deleted = applyL2WorkSessionsUpdate(updated, {
    type: 'delete',
    workId: 'b'
  })
  assert.strictEqual(deleted.workSessions[0], first)
})

test('delete 固定项递减分界，删除未固定项保持分界', () => {
  const deletedPinned = applyL2WorkSessionsUpdate(state([item('a', 'A'), item('b', 'B')], 1), {
    type: 'delete',
    workId: 'a'
  })
  assert.deepEqual(deletedPinned, state([item('b', 'B')], 0))

  const deletedUnpinned = applyL2WorkSessionsUpdate(state([item('a', 'A'), item('b', 'B')], 1), {
    type: 'delete',
    workId: 'b'
  })
  assert.deepEqual(deletedUnpinned, state([item('a', 'A')], 1))
})

test('update 找不到 workId 时要求重新同步，重复 delete 保持当前状态', () => {
  assert.throws(() =>
    applyL2WorkSessionsUpdate(state([item('a', 'A')], 0), {
      type: 'update',
      workId: 'missing',
      changes: { status: 'completed' }
    })
  )

  const current = state([item('a', 'A')], 0)
  const repeatedDelete = applyL2WorkSessionsUpdate(current, {
    type: 'delete',
    workId: 'missing'
  })
  assert.strictEqual(repeatedDelete, current)
})
