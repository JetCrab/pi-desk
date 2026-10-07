import assert from 'node:assert/strict'
import test from 'node:test'
import type { L2WorkSessionListItem } from '../src/common/l2_biz/work-session/l2-work-session-contract'
import {
  findL2InvalidatedWorkSessionIds,
  getL2DisplayedWorkSessionIds,
  parseL2WorkbenchLayout,
  reconcileL2WorkbenchLayout
} from '../src/client/l2_biz/workbench/l2-workbench-layout'
import { calculateL2SidebarShortcutLayout } from '../src/client/l2_biz/workbench/l2-work-session-sidebar-layout'
import {
  getL2WorkSessionVisualSortableIds,
  L2_WORK_SESSION_PIN_BOUNDARY_ID,
  moveL2WorkSessionVisual,
  pinL2CreatedWorkSession,
  toggleL2WorkSessionPinned
} from '../src/client/l2_biz/workbench/l2-work-session-sidebar-order'
import { getL3WorkSessionProjectColor } from '../src/client/l3_modules/work-session-visual/l3-work-session-visual'
import { formatL2WorkSessionUpdatedAt } from '../src/client/l2_biz/workbench/l2-work-session-sidebar-display'

function workSession(
  workId: string,
  sessionId: string,
  branchId = 'v1:main'
): L2WorkSessionListItem {
  return {
    workId,
    cwd: `C:/projects/${workId}`,
    sessionId,
    branchId,
    projectName: workId,
    sessionTitle: workId,
    status: 'idle',
    messageCounts: { user: 0, total: 0 },
    lastMessageUpdatedAt: null
  }
}

test('工作会话时间超过 24 小时后展示自然日或本地化日期', () => {
  const now = Date.parse('2026-08-20T12:00:00+08:00')

  const format = (timestamp: number | null): ReturnType<typeof formatL2WorkSessionUpdatedAt> =>
    formatL2WorkSessionUpdatedAt(timestamp, now, 'zh-CN', 'Asia/Shanghai')

  assert.equal(format(null).compact, '--')
  assert.equal(format(now - 30_000).compact, '刚刚')
  assert.equal(format(now - 23 * 60 * 60_000).compact, '23 小时前')
  assert.equal(format(Date.parse('2026-08-19T10:00:00+08:00')).compact, '昨天')
  assert.equal(format(Date.parse('2026-08-18T10:00:00+08:00')).compact, '前天')
  assert.equal(format(Date.parse('2026-08-17T10:00:00+08:00')).compact, '8月17日')
})

test('工作会话时间按新鲜度分为三级强调色', () => {
  const now = Date.parse('2026-08-20T12:00:00+08:00')

  assert.equal(formatL2WorkSessionUpdatedAt(null, now).tone, 'old')
  assert.equal(formatL2WorkSessionUpdatedAt(now - 4 * 60_000, now).tone, 'fresh')
  assert.equal(formatL2WorkSessionUpdatedAt(now - 5 * 60_000, now).tone, 'recent')
  assert.equal(formatL2WorkSessionUpdatedAt(now - 59 * 60_000, now).tone, 'recent')
  assert.equal(formatL2WorkSessionUpdatedAt(now - 60 * 60_000, now).tone, 'old')
})

test('工作台按 primary 后固定前缀顺序去重展示会话', () => {
  const layout = { primaryWorkId: 'work-1' }
  const pinnedWorkIds = ['work-1', 'work-2', 'work-3', 'work-2']

  assert.deepEqual(getL2DisplayedWorkSessionIds(layout, pinnedWorkIds), [
    'work-1',
    'work-2',
    'work-3'
  ])
})

test('本地布局忽略旧固定集合，只保留当前设备 primary', () => {
  assert.deepEqual(
    parseL2WorkbenchLayout(JSON.stringify({ primaryWorkId: 'work-1', pinnedWorkIds: ['work-2'] })),
    { primaryWorkId: 'work-1' }
  )
  assert.deepEqual(parseL2WorkbenchLayout('{'), { primaryWorkId: null })
})

test('被动删除或替换只清理当前设备 primary', () => {
  const previous = [workSession('work-1', 'session-1'), workSession('work-2', 'session-2')]
  const replaced = [workSession('work-1', 'session-3'), workSession('work-2', 'session-2')]
  const layout = { primaryWorkId: 'work-1' }
  const invalidated = findL2InvalidatedWorkSessionIds(previous, replaced)

  assert.deepEqual(invalidated, ['work-1'])
  assert.deepEqual(reconcileL2WorkbenchLayout(layout, replaced, invalidated), {
    primaryWorkId: null
  })
  assert.strictEqual(reconcileL2WorkbenchLayout(layout, replaced), layout)

  const branched = [
    workSession('work-1', 'session-1', 'v1:fork:e:entry-1:2'),
    workSession('work-2', 'session-2')
  ]
  assert.deepEqual(findL2InvalidatedWorkSessionIds(previous, branched), [])
  assert.strictEqual(reconcileL2WorkbenchLayout(layout, branched), layout)

  const deleted = [workSession('work-2', 'session-2')]
  assert.deepEqual(findL2InvalidatedWorkSessionIds(previous, deleted), ['work-1'])
  assert.deepEqual(reconcileL2WorkbenchLayout(layout, deleted, ['work-1']), {
    primaryWorkId: null
  })
})

test('侧栏快捷入口先按总数计算行数，再均衡分配每一行', () => {
  assert.deepEqual(calculateL2SidebarShortcutLayout(0, 5, 2), {
    visibleApplicationCount: 0,
    rowItemCounts: [1]
  })
  assert.deepEqual(calculateL2SidebarShortcutLayout(1, 5, 2), {
    visibleApplicationCount: 1,
    rowItemCounts: [2]
  })
  assert.deepEqual(calculateL2SidebarShortcutLayout(5, 5, 2), {
    visibleApplicationCount: 5,
    rowItemCounts: [3, 3]
  })
  assert.deepEqual(calculateL2SidebarShortcutLayout(6, 5, 2), {
    visibleApplicationCount: 6,
    rowItemCounts: [4, 3]
  })
  assert.deepEqual(calculateL2SidebarShortcutLayout(8, 5, 2), {
    visibleApplicationCount: 8,
    rowItemCounts: [5, 4]
  })
  assert.deepEqual(calculateL2SidebarShortcutLayout(12, 8, 3), {
    visibleApplicationCount: 12,
    rowItemCounts: [7, 6]
  })
})

test('侧栏快捷入口超出最大行数时为最后一个更多入口预留位置', () => {
  assert.deepEqual(calculateL2SidebarShortcutLayout(12, 5, 2), {
    visibleApplicationCount: 8,
    rowItemCounts: [5, 5]
  })
  assert.deepEqual(calculateL2SidebarShortcutLayout(12, 4, 3), {
    visibleApplicationCount: 10,
    rowItemCounts: [4, 4, 4]
  })
})

test('固定按钮追加固定区尾部，取消固定进入未固定区底部', () => {
  assert.deepEqual(toggleL2WorkSessionPinned(['fixed', 'active-a', 'active-b'], 1, 'active-b'), {
    workIds: ['fixed', 'active-b', 'active-a'],
    pinnedCount: 2
  })
  assert.deepEqual(toggleL2WorkSessionPinned(['fixed-a', 'fixed-b', 'active'], 2, 'fixed-a'), {
    workIds: ['fixed-b', 'active', 'fixed-a'],
    pinnedCount: 1
  })
})

test('新建会话无论列表推送是否到达都追加到固定区尾部', () => {
  assert.deepEqual(pinL2CreatedWorkSession(['fixed', 'active'], 1, 'created'), {
    workIds: ['fixed', 'created', 'active'],
    pinnedCount: 2
  })
  assert.deepEqual(pinL2CreatedWorkSession(['fixed', 'active', 'created'], 1, 'created'), {
    workIds: ['fixed', 'created', 'active'],
    pinnedCount: 2
  })
})

test('侧栏视觉顺序固定为未固定会话在上、固定会话在下', () => {
  assert.deepEqual(
    getL2WorkSessionVisualSortableIds(['fixed-a', 'fixed-b', 'other-a', 'other-b'], 2),
    ['other-a', 'other-b', L2_WORK_SESSION_PIN_BOUNDARY_ID, 'fixed-a', 'fixed-b']
  )
  assert.deepEqual(getL2WorkSessionVisualSortableIds(['a', 'b'], 0), ['a', 'b'])
  assert.deepEqual(getL2WorkSessionVisualSortableIds(['a', 'b'], 2), ['a', 'b'])
})

test('视觉拖拽可双向跨越以下固定分界线', () => {
  const pinned = moveL2WorkSessionVisual(
    ['fixed-a', 'fixed-b', 'other-a', 'other-b'],
    2,
    'other-a',
    'fixed-b'
  )
  assert.deepEqual(pinned, {
    workIds: ['fixed-a', 'fixed-b', 'other-a', 'other-b'],
    pinnedCount: 3
  })

  const unpinned = moveL2WorkSessionVisual(
    ['fixed-a', 'fixed-b', 'other-a', 'other-b'],
    2,
    'fixed-b',
    'other-b'
  )
  assert.deepEqual(unpinned, {
    workIds: ['fixed-a', 'other-a', 'fixed-b', 'other-b'],
    pinnedCount: 1
  })

  const droppedOnBoundary = moveL2WorkSessionVisual(
    ['fixed-a', 'fixed-b', 'other-a', 'other-b'],
    2,
    'fixed-b',
    L2_WORK_SESSION_PIN_BOUNDARY_ID
  )
  assert.deepEqual(droppedOnBoundary, {
    workIds: ['fixed-a', 'other-a', 'other-b', 'fixed-b'],
    pinnedCount: 1
  })
  assert.equal(droppedOnBoundary?.workIds.includes(L2_WORK_SESSION_PIN_BOUNDARY_ID), false)
})

test('单一分区内仍可正常调整服务端顺序', () => {
  assert.deepEqual(moveL2WorkSessionVisual(['a', 'b', 'c'], 0, 'c', 'a'), {
    workIds: ['c', 'a', 'b'],
    pinnedCount: 0
  })
})

test('项目颜色按规范化 cwd 稳定推导', () => {
  assert.equal(
    getL3WorkSessionProjectColor('C:\\Projects\\SuperPI'),
    getL3WorkSessionProjectColor('c:/projects/superpi')
  )
  assert.notEqual(
    getL3WorkSessionProjectColor('C:/projects/SuperPI'),
    getL3WorkSessionProjectColor('C:/projects/SubCloud')
  )
})
