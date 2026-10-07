import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L2WorkSessionBranchRequestSchema,
  type L2WorkSessionTreeNode
} from '../src/common/l2_biz/work-session/l2-work-session-tree-contract'
import {
  buildL2WorkbenchBranchTreeRows,
  findNearestL2WorkbenchBranchTreeEntryId,
  resolveL2WorkbenchBranchTreeDraft
} from '../src/client/l2_biz/workbench/l2-workbench-branch-tree'

function node(
  entryId: string,
  parentEntryId: string | null,
  kind: L2WorkSessionTreeNode['kind'],
  preview: string,
  timestampMs: number,
  label: string | null = null
): L2WorkSessionTreeNode {
  return { entryId, parentEntryId, kind, preview, timestampMs, label }
}

const nodes = [
  node('root', null, 'user', '根问题', 1),
  node('assistant', 'root', 'assistant', '根回答', 2, '检查点'),
  node('old-user', 'assistant', 'user', '旧分支', 3),
  node('old-tool', 'old-user', 'tool', 'read 文件', 4),
  node('fork-user', 'assistant', 'user', '新分支', 5),
  node('fork-assistant', 'fork-user', 'assistant', '当前回答', 6),
  node('model', 'fork-assistant', 'model_change', 'test/model', 7)
]

test('活动路径优先，默认过滤隐藏元数据但保留其他分支', () => {
  const rows = buildL2WorkbenchBranchTreeRows({
    nodes,
    leafEntryId: 'fork-assistant',
    filter: 'default',
    query: '',
    foldedEntryIds: new Set()
  })

  assert.deepEqual(
    rows.map((row) => row.node.entryId),
    ['root', 'assistant', 'fork-user', 'fork-assistant', 'old-user', 'old-tool']
  )
  assert.deepEqual(
    rows.filter((row) => row.active).map((row) => row.node.entryId),
    ['root', 'assistant', 'fork-user', 'fork-assistant']
  )
  assert.deepEqual(
    rows.map((row) => [row.node.entryId, row.depth, row.visibleParentEntryId, row.foldable]),
    [
      ['root', 0, null, true],
      ['assistant', 0, 'root', false],
      ['fork-user', 1, 'assistant', true],
      ['fork-assistant', 1, 'fork-user', false],
      ['old-user', 1, 'assistant', true],
      ['old-tool', 1, 'old-user', false]
    ]
  )
  assert.equal(
    rows.some((row) => row.node.entryId === 'model'),
    false
  )
})

test('搜索会把匹配后代挂到最近可见祖先，折叠隐藏后代', () => {
  const searched = buildL2WorkbenchBranchTreeRows({
    nodes,
    leafEntryId: 'fork-assistant',
    filter: 'all',
    query: '旧 read',
    foldedEntryIds: new Set()
  })
  assert.deepEqual(
    searched.map((row) => row.node.entryId),
    []
  )

  const toolSearch = buildL2WorkbenchBranchTreeRows({
    nodes,
    leafEntryId: 'fork-assistant',
    filter: 'all',
    query: 'read',
    foldedEntryIds: new Set()
  })
  assert.deepEqual(
    toolSearch.map((row) => [row.node.entryId, row.depth]),
    [['old-tool', 0]]
  )

  const ignoredLinearFold = buildL2WorkbenchBranchTreeRows({
    nodes,
    leafEntryId: 'fork-assistant',
    filter: 'default',
    query: '',
    foldedEntryIds: new Set(['assistant'])
  })
  assert.equal(
    ignoredLinearFold.some((row) => row.node.entryId === 'fork-assistant'),
    true
  )

  const foldedBranch = buildL2WorkbenchBranchTreeRows({
    nodes,
    leafEntryId: 'fork-assistant',
    filter: 'default',
    query: '',
    foldedEntryIds: new Set(['fork-user'])
  })
  assert.deepEqual(
    foldedBranch.map((row) => row.node.entryId),
    ['root', 'assistant', 'fork-user', 'old-user', 'old-tool']
  )
})

test('纯工具调用 Assistant 隐藏，只保留实际 Tool Result', () => {
  const toolNodes = [
    node('user', null, 'user', '执行检查', 1),
    node('tool-assistant', 'user', 'assistant', '', 2),
    node('tool-result', 'tool-assistant', 'tool', 'bash：检查通过', 3)
  ]
  for (const filter of ['default', 'all'] as const) {
    const rows = buildL2WorkbenchBranchTreeRows({
      nodes: toolNodes,
      leafEntryId: 'tool-result',
      filter,
      query: '',
      foldedEntryIds: new Set()
    })
    assert.deepEqual(
      rows.map((row) => row.node.entryId),
      ['user', 'tool-result']
    )
  }
})

test('分支请求严格区分 Tree、Fork 与 Clone', () => {
  assert.equal(
    L2WorkSessionBranchRequestSchema.safeParse({
      action: 'tree',
      workId: 'work',
      sessionId: 'session',
      entryId: 'entry'
    }).success,
    true
  )
  assert.equal(
    L2WorkSessionBranchRequestSchema.safeParse({
      action: 'fork',
      workId: 'work',
      sessionId: 'session',
      entryId: 'entry'
    }).success,
    true
  )
  assert.equal(
    L2WorkSessionBranchRequestSchema.safeParse({
      action: 'clone',
      workId: 'work',
      sessionId: 'session'
    }).success,
    true
  )
  assert.equal(
    L2WorkSessionBranchRequestSchema.safeParse({
      action: 'create',
      workId: 'work',
      sessionId: 'session',
      entryId: 'entry'
    }).success,
    false
  )
  assert.equal(
    L2WorkSessionBranchRequestSchema.safeParse({
      action: 'clone',
      workId: 'work',
      sessionId: 'session',
      branchId: 'v1:main'
    }).success,
    false
  )
})

test('Tree 非用户节点保留草稿，用户节点替换草稿', () => {
  assert.equal(resolveL2WorkbenchBranchTreeDraft('现有草稿', null), '现有草稿')
  assert.equal(resolveL2WorkbenchBranchTreeDraft('现有草稿', '用户消息'), '用户消息')
  assert.equal(resolveL2WorkbenchBranchTreeDraft('现有草稿', ''), '')
})

test('过滤后从目标沿父链选择最近可见节点', () => {
  const rows = buildL2WorkbenchBranchTreeRows({
    nodes,
    leafEntryId: 'model',
    filter: 'default',
    query: '',
    foldedEntryIds: new Set()
  })
  assert.equal(findNearestL2WorkbenchBranchTreeEntryId(nodes, rows, 'model'), 'fork-assistant')
  assert.equal(findNearestL2WorkbenchBranchTreeEntryId(nodes, [], 'model'), null)
})
