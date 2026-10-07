import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L2WorkSessionTreeGetResponseSchema,
  L2WorkSessionTreeEntryGetResponseSchema
} from '../src/common/l2_biz/work-session/l2-work-session-tree-contract'
import {
  L4PiSessionEntryNotFoundError,
  L4PiSessionForkTargetError,
  readL4PiSessionTree,
  readL4PiSessionTreeEntryDetail,
  resolveL4PiBranchSelection,
  resolveL4PiForkSelection
} from '../src/server/l4_foundation/pi/l4-pi-session-tree'

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function assistant(text: string, timestamp: number) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'openai-responses' as const,
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'stop' as const,
    timestamp
  }
}

test('会话树投影保留所有分支、父节点、标签和当前 leaf', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.inMemory('C:/project')
  const userRoot = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '根问题' }],
    timestamp: 1
  })
  const assistantRoot = manager.appendMessage(assistant('根回答', 2))
  const oldUser = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '旧分支问题' }],
    timestamp: 3
  })
  const oldAssistant = manager.appendMessage(assistant('旧分支回答', 4))
  manager.branch(assistantRoot)
  const forkUser = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '新分支问题' }],
    timestamp: 5
  })
  const forkAssistant = manager.appendMessage(assistant('新分支回答', 6))
  manager.appendLabelChange(assistantRoot, '检查点')

  const tree = readL4PiSessionTree(manager)
  assert.equal(tree.leafEntryId, manager.getLeafId())
  assert.equal(tree.nodes.length, 7)
  assert.deepEqual(
    tree.nodes
      .filter((node) => node.kind === 'user')
      .map((node) => [node.entryId, node.parentEntryId, node.preview]),
    [
      [userRoot, null, '根问题'],
      [oldUser, assistantRoot, '旧分支问题'],
      [forkUser, assistantRoot, '新分支问题']
    ]
  )
  assert.equal(tree.nodes.find((node) => node.entryId === assistantRoot)?.label, '检查点')
  assert.ok(tree.nodes.some((node) => node.entryId === oldAssistant))
  assert.ok(tree.nodes.some((node) => node.entryId === forkAssistant))
})

test('上下文编辑节点保留父链与 leaf，详情不泄露替换的工具结果', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.inMemory('C:/project')
  const tool = manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'call-read',
    toolName: 'read',
    content: [{ type: 'text', text: '原始工具结果' }],
    isError: false,
    timestamp: 1
  })
  const omitted = manager.appendContextEdit(tool, null)
  const replaced = manager.appendContextEdit(tool, {
    content: [{ type: 'text', text: '替换工具结果，不得展示' }]
  })
  const tree = L2WorkSessionTreeGetResponseSchema.parse(readL4PiSessionTree(manager))
  assert.equal(tree.leafEntryId, replaced)
  assert.deepEqual(
    tree.nodes.map((node) => [node.entryId, node.parentEntryId, node.kind]),
    [
      [tool, null, 'tool'],
      [omitted, tool, 'custom'],
      [replaced, omitted, 'custom']
    ]
  )
  assert.match(tree.nodes[1].preview, /移除/)
  assert.match(tree.nodes[2].preview, /替换/)
  for (const entryId of [omitted, replaced]) {
    const detail = L2WorkSessionTreeEntryGetResponseSchema.parse(
      readL4PiSessionTreeEntryDetail(manager, entryId)
    )
    assert.ok(detail.content.includes(tool))
    assert.doesNotMatch(detail.content, /原始工具结果|替换工具结果/)
  }
  assert.equal(resolveL4PiBranchSelection(manager, omitted).targetLeafEntryId, omitted)
  assert.equal(
    readL4PiSessionTreeEntryDetail(manager, tool).content,
    '工具：read\n\n未找到对应的 Tool Call 参数'
  )
})

test('独立用量节点兼容任意用量类别且可以作为当前 leaf', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  for (const kind of ['cache_warm', 'other_operation']) {
    const manager = SessionManager.inMemory('C:/project')
    const entry = manager.appendUsage(kind, 'test', 'test-model', usage)
    const tree = L2WorkSessionTreeGetResponseSchema.parse(readL4PiSessionTree(manager))
    assert.equal(tree.leafEntryId, entry.id)
    assert.equal(tree.nodes[0].kind, 'custom')
    assert.ok(tree.nodes[0].preview.includes(kind))
    const detail = L2WorkSessionTreeEntryGetResponseSchema.parse(
      readL4PiSessionTreeEntryDetail(manager, entry.id)
    )
    assert.match(detail.content, /test\/test-model/)
    assert.match(detail.content, /"totalTokens": 2/)
  }
})

test('纯工具调用 Assistant 不生成重复工具预览', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.inMemory('C:/project')
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '执行检查' }],
    timestamp: 1
  })
  const assistantEntryId = manager.appendMessage({
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'call-bash',
        name: 'bash',
        arguments: { command: 'pnpm typecheck', reasoning: '验证 TypeScript 类型' }
      }
    ],
    api: 'openai-responses',
    provider: 'test',
    model: 'test-model',
    usage,
    stopReason: 'toolUse',
    timestamp: 2
  })
  const toolEntryId = manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'call-bash',
    toolName: 'bash',
    content: [{ type: 'text', text: '检查通过，但不应进入 Tree 详情' }],
    usage,
    isError: false,
    timestamp: 3
  })
  const bashEntryId = manager.appendMessage({
    role: 'bashExecution',
    command: 'git status --short',
    output: 'M src/example.ts',
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 4
  })
  const missingCallEntryId = manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'missing-call',
    toolName: 'read',
    content: [{ type: 'text', text: '缺失调用时也不能回退展示结果' }],
    usage,
    isError: false,
    timestamp: 5
  })

  const tree = readL4PiSessionTree(manager)
  assert.equal(tree.nodes.find((node) => node.entryId === assistantEntryId)?.preview, '')
  assert.equal(
    tree.nodes.find((node) => node.entryId === toolEntryId)?.preview,
    'bash: pnpm typecheck'
  )
  assert.equal(
    tree.nodes.find((node) => node.entryId === bashEntryId)?.preview,
    'git status --short'
  )
  assert.equal(tree.nodes.find((node) => node.entryId === missingCallEntryId)?.preview, 'read')

  const toolDetail = readL4PiSessionTreeEntryDetail(manager, toolEntryId).content
  assert.match(toolDetail, /工具：bash/)
  assert.match(toolDetail, /目的：验证 TypeScript 类型/)
  assert.match(toolDetail, /调用：pnpm typecheck/)
  assert.match(toolDetail, /"command": "pnpm typecheck"/)
  assert.doesNotMatch(toolDetail, /检查通过/)

  assert.equal(
    readL4PiSessionTreeEntryDetail(manager, bashEntryId).content,
    '命令：git status --short'
  )
  assert.doesNotMatch(
    readL4PiSessionTreeEntryDetail(manager, missingCallEntryId).content,
    /缺失调用时也不能回退展示结果/
  )
})

test('选择用户消息回到父节点并恢复文字，其他节点直接成为 leaf', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const manager = SessionManager.inMemory('C:/project')
  const userRoot = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '根问题' }],
    timestamp: 1
  })
  const assistantRoot = manager.appendMessage(assistant('根回答', 2))
  const user = manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '需要编辑的问题' }],
    timestamp: 3
  })
  const leaf = manager.appendMessage(assistant('回答', 4))

  assert.deepEqual(resolveL4PiBranchSelection(manager, user), {
    selectedEntryId: user,
    targetLeafEntryId: assistantRoot,
    editorText: '需要编辑的问题',
    changed: true
  })
  assert.deepEqual(resolveL4PiBranchSelection(manager, assistantRoot), {
    selectedEntryId: assistantRoot,
    targetLeafEntryId: assistantRoot,
    editorText: null,
    changed: true
  })
  assert.deepEqual(resolveL4PiBranchSelection(manager, leaf), {
    selectedEntryId: leaf,
    targetLeafEntryId: leaf,
    editorText: null,
    changed: false
  })
  assert.deepEqual(resolveL4PiBranchSelection(manager, userRoot), {
    selectedEntryId: userRoot,
    targetLeafEntryId: null,
    editorText: '根问题',
    changed: true
  })
  assert.deepEqual(resolveL4PiForkSelection(manager, user), {
    selectedEntryId: user,
    targetLeafEntryId: assistantRoot,
    editorText: '需要编辑的问题'
  })
  assert.deepEqual(resolveL4PiForkSelection(manager, userRoot), {
    selectedEntryId: userRoot,
    targetLeafEntryId: null,
    editorText: '根问题'
  })
  assert.throws(() => resolveL4PiForkSelection(manager, assistantRoot), L4PiSessionForkTargetError)
  assert.deepEqual(readL4PiSessionTreeEntryDetail(manager, user), {
    entryId: user,
    kind: 'user',
    content: '需要编辑的问题',
    truncated: false
  })
  assert.deepEqual(readL4PiSessionTreeEntryDetail(manager, leaf), {
    entryId: leaf,
    kind: 'assistant',
    content: '回答',
    truncated: false
  })
  assert.throws(() => resolveL4PiBranchSelection(manager, 'missing'), L4PiSessionEntryNotFoundError)
})
