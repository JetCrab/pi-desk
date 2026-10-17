import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commandImpact,
  operationName,
  workspaceDuration,
  workspaceGroups,
  workspaceOperations,
  workspaceProjectName,
  workspaceTime,
  workspaceTimeFormatter
} from '../src/l2-workspace-browser-model.js'
import type { WorkspaceOperation, WorkspaceSnapshotItem } from '../src/contract.js'

test('占用列表按本次占用时间倒序，当前选择和目录 ID 不影响排序', () => {
  function workspace(id: string, occupiedAt: number | null, active = false): WorkspaceSnapshotItem {
    return {
      id,
      active,
      root: `/workspace/${id}`,
      definition: 'demo',
      issue: null,
      workspaceRef: occupiedAt === null ? null : `${id}@assignment`,
      status: occupiedAt === null ? 'available' : 'occupied',
      occupation:
        occupiedAt === null
          ? null
          : {
              id: 'assignment',
              requirement: id,
              occupiedAt,
              operations: []
            }
    }
  }
  const input = [
    workspace('a', 100, true),
    workspace('b', null),
    workspace('z', 300),
    workspace('c', 200)
  ]
  const groups = workspaceGroups(input)
  assert.deepEqual(
    groups.occupied.map((item) => item.id),
    ['z', 'c', 'a']
  )
  assert.deepEqual(
    groups.available.map((item) => item.id),
    ['b']
  )
  assert.deepEqual(
    input.map((item) => item.id),
    ['a', 'b', 'z', 'c']
  )
})

test('迟到的外部记录按操作开始时间展示，不修改原始记录或摘要', () => {
  const operations: WorkspaceOperation[] = [
    { command: 'verify', startedAt: 200, endedAt: 300, result: 'success', logPath: '/verify.log' },
    {
      command: 'git-commit',
      startedAt: 100,
      endedAt: 400,
      result: 'success',
      logPath: '/commit.log',
      summary: '提交完成\n完整说明\n路径：/workspace/demo'
    },
    { command: 'verify', startedAt: 500, endedAt: null, result: null, logPath: '/running.log' }
  ]
  const original = structuredClone(operations)
  assert.deepEqual(
    workspaceOperations(operations).map((item) => item.logPath),
    ['/running.log', '/verify.log', '/commit.log']
  )
  assert.deepEqual(operations, original)
  assert.equal(workspaceOperations(operations)[2]?.summary, original[1]?.summary)
})

test('外部操作保留命令名，不推断额外动作', () => {
  assert.equal(
    operationName({
      command: 'git-commit',
      startedAt: 100,
      endedAt: 200,
      result: 'success',
      logPath: '/example/commit.log'
    }),
    'git-commit'
  )
})

test('项目标题只提取目录名，并保留根路径可辨识名称', () => {
  assert.equal(workspaceProjectName('C:\\code\\demo\\'), 'demo')
  assert.equal(workspaceProjectName('/home/project/demo/'), 'demo')
  assert.equal(workspaceProjectName('/'), '/')
  assert.equal(workspaceProjectName('C:\\'), 'C:')
  assert.equal(workspaceDuration(0), '不到 1 分钟')
  assert.equal(workspaceDuration(4 * 3600000 + 48 * 60000), '4 小时 48 分钟')
  assert.equal(workspaceDuration(27 * 3600000), '1 天 3 小时')
})

test('重置提示区分占用记录与来源聊天，说明未提交文件风险', () => {
  const impact = commandImpact({
    id: 'cleanup',
    description: '恢复基线',
    from: ['occupied'],
    onSuccess: 'available',
    parameters: { properties: {} }
  })
  assert.match(impact!, /本次占用记录/u)
  assert.match(impact!, /未提交文件可能被清理/u)
  assert.match(impact!, /来源聊天本身不会被删除/u)
})

const timestamp = Date.UTC(2026, 0, 1, 1, 30)
const dateOptions: Intl.DateTimeFormatOptions = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
}

test('Workspace 时间格式使用页面语言与本地非上海时区且不改时间戳', () => {
  const original = Intl.DateTimeFormat.prototype.resolvedOptions
  Intl.DateTimeFormat.prototype.resolvedOptions = function (this: Intl.DateTimeFormat) {
    return { ...original.call(this), timeZone: 'America/Los_Angeles' }
  }

  let chinese: Intl.DateTimeFormat
  let english: Intl.DateTimeFormat
  try {
    chinese = workspaceTimeFormatter('zh-CN')
    english = workspaceTimeFormatter('en')
  } finally {
    Intl.DateTimeFormat.prototype.resolvedOptions = original
  }

  assert.equal(chinese.resolvedOptions().timeZone, 'America/Los_Angeles')
  assert.equal(english.resolvedOptions().timeZone, 'America/Los_Angeles')
  assert.match(chinese.resolvedOptions().locale, /^zh-CN/u)
  assert.match(english.resolvedOptions().locale, /^en/u)
  assert.equal(
    workspaceTime(timestamp, chinese),
    new Intl.DateTimeFormat('zh-CN', {
      ...dateOptions,
      timeZone: 'America/Los_Angeles'
    }).format(timestamp)
  )
  assert.equal(
    workspaceTime(timestamp, english),
    new Intl.DateTimeFormat('en', { ...dateOptions, timeZone: 'America/Los_Angeles' }).format(
      timestamp
    )
  )
  assert.notEqual(
    workspaceTime(timestamp, english),
    new Intl.DateTimeFormat('en', { ...dateOptions, timeZone: 'Asia/Shanghai' }).format(timestamp)
  )
  assert.equal(timestamp, Date.UTC(2026, 0, 1, 1, 30))
})

test('时区探测异常和格式器拒绝时区时均回退 UTC', () => {
  const original = Intl.DateTimeFormat.prototype.resolvedOptions
  let detectionFallback: Intl.DateTimeFormat
  Intl.DateTimeFormat.prototype.resolvedOptions = () => {
    throw new Error('timezone unavailable')
  }
  try {
    detectionFallback = workspaceTimeFormatter('en')
  } finally {
    Intl.DateTimeFormat.prototype.resolvedOptions = original
  }

  let initializationFallback: Intl.DateTimeFormat
  Intl.DateTimeFormat.prototype.resolvedOptions = function (this: Intl.DateTimeFormat) {
    return { ...original.call(this), timeZone: 'Invalid/Timezone' }
  }
  try {
    initializationFallback = workspaceTimeFormatter('zh-CN')
  } finally {
    Intl.DateTimeFormat.prototype.resolvedOptions = original
  }

  assert.equal(detectionFallback.resolvedOptions().timeZone, 'UTC')
  assert.equal(initializationFallback.resolvedOptions().timeZone, 'UTC')
  assert.match(initializationFallback.resolvedOptions().locale, /^zh-CN/u)
  assert.equal(
    workspaceTime(timestamp, initializationFallback),
    new Intl.DateTimeFormat('zh-CN', { ...dateOptions, timeZone: 'UTC' }).format(timestamp)
  )
  assert.equal(
    workspaceTime(timestamp, detectionFallback),
    new Intl.DateTimeFormat('en', { ...dateOptions, timeZone: 'UTC' }).format(timestamp)
  )
})
