import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L4_PI_MAIN_BRANCH_ID,
  L4PiSessionBranchIndex
} from '../src/server/l4_foundation/pi/l4-pi-session-branch'

test('首个子节点沿用分支，后续同父节点创建稳定 fork ID', () => {
  const index = new L4PiSessionBranchIndex([])

  const rootPending = index.predictAppend(null)
  assert.equal(rootPending.branchId, L4_PI_MAIN_BRANCH_ID)
  assert.equal(
    index.confirmAppend(rootPending, { id: 'root', parentId: null }),
    L4_PI_MAIN_BRANCH_ID
  )

  const assistant = index.appendEntry({ id: 'assistant', parentId: 'root' })
  assert.equal(assistant.branchId, L4_PI_MAIN_BRANCH_ID)
  const originalChild = index.appendEntry({ id: 'original-user', parentId: 'assistant' })
  assert.equal(originalChild.branchId, L4_PI_MAIN_BRANCH_ID)

  const forkPending = index.predictAppend('assistant')
  assert.equal(forkPending.branchId, 'v1:fork:e:assistant:2')
  assert.equal(
    index.confirmAppend(forkPending, { id: 'fork-user', parentId: 'assistant' }),
    'v1:fork:e:assistant:2'
  )
  assert.equal(
    index.appendEntry({ id: 'fork-assistant', parentId: 'fork-user' }).branchId,
    'v1:fork:e:assistant:2'
  )
})

test('多个根节点使用独立分支，缺失父节点拒绝预测', () => {
  const index = new L4PiSessionBranchIndex([{ id: 'root-main', parentId: null }])
  assert.equal(index.predictAppend(null).branchId, 'v1:fork:r:2')
  assert.throws(() => index.predictAppend('missing'), /missing Pi session parent/)
})
