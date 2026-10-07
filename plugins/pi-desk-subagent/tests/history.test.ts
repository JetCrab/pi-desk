import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { restoreSubagentRecords } from '../src/subagent-runtime'

function launchEntry(input: {
  id: string
  toolName: 'agent' | 'agent_resume'
  taskId: string
  startedAt: number
  timestamp: string
}): SessionEntry {
  return {
    type: 'message',
    id: input.id,
    parentId: null,
    timestamp: input.timestamp,
    message: {
      role: 'toolResult',
      toolCallId: `call-${input.id}`,
      toolName: input.toolName,
      content: [{ type: 'text', text: 'started' }],
      details: {
        version: 1,
        kind: 'launch',
        taskId: input.taskId,
        agentType: 'explore',
        title: '调查实现',
        sessionFile: `C:/sessions/${input.taskId}.jsonl`,
        startedAt: input.startedAt
      },
      isError: false,
      timestamp: input.startedAt
    }
  } as SessionEntry
}

function delegatedLaunchEntry(input: {
  id: string
  taskId: string
  startedAt: number
  timestamp: string
}): SessionEntry {
  return {
    type: 'custom',
    id: input.id,
    parentId: null,
    timestamp: input.timestamp,
    customType: 'pi-desk-subagent:launch:v1',
    data: {
      version: 1,
      kind: 'launch',
      taskId: input.taskId,
      agentType: 'research-worker',
      title: '调研独立对象',
      sessionFile: `C:/sessions/${input.taskId}.jsonl`,
      startedAt: input.startedAt
    }
  } as SessionEntry
}

function completionEntry(input: {
  id: string
  taskId: string
  status: 'completed' | 'failed' | 'interrupted'
  endedAt: number
  timestamp: string
}): SessionEntry {
  return {
    type: 'custom_message',
    id: input.id,
    parentId: null,
    timestamp: input.timestamp,
    customType: 'pi-desk-subagent:completion:v1',
    content: 'done',
    display: true,
    details: {
      version: 1,
      kind: 'terminal',
      taskId: input.taskId,
      status: input.status,
      endedAt: input.endedAt,
      sessionFile: `C:/sessions/${input.taskId}.jsonl`
    }
  }
}

test('旧版 Pi Super customType 历史记录继续恢复', () => {
  const records = restoreSubagentRecords([
    {
      type: 'custom',
      id: 'legacy-launch',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.100Z',
      customType: 'pi-super-subagent:launch:v1',
      data: {
        version: 1,
        kind: 'launch',
        taskId: 'legacy-agent',
        agentType: 'explore',
        title: '旧版探索任务',
        sessionFile: 'C:/sessions/legacy-agent.jsonl',
        startedAt: 100
      }
    } as SessionEntry,
    {
      type: 'custom_message',
      id: 'legacy-completion',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.200Z',
      customType: 'pi-super-subagent:completion:v1',
      content: 'done',
      display: true,
      details: {
        version: 1,
        kind: 'terminal',
        taskId: 'legacy-agent',
        status: 'completed',
        endedAt: 200,
        sessionFile: 'C:/sessions/legacy-agent.jsonl'
      }
    },
    {
      type: 'custom',
      id: 'legacy-worker-launch',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.300Z',
      customType: 'pi-super-subagent:launch:v1',
      data: {
        version: 1,
        kind: 'launch',
        taskId: 'legacy-worker',
        agentType: 'research-worker',
        title: '旧版调研任务',
        sessionFile: 'C:/sessions/legacy-worker.jsonl',
        startedAt: 300
      }
    } as SessionEntry,
    {
      type: 'custom',
      id: 'legacy-worker-state',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.400Z',
      customType: 'pi-super-subagent:state:v1',
      data: {
        version: 1,
        kind: 'terminal',
        taskId: 'legacy-worker',
        status: 'stopped',
        endedAt: 400,
        sessionFile: 'C:/sessions/legacy-worker.jsonl'
      }
    } as SessionEntry
  ])

  assert.equal(records.get('legacy-agent')?.status, 'completed')
  assert.equal(records.get('legacy-agent')?.persistLifecycle, true)
  assert.equal(records.get('legacy-worker')?.status, 'stopped')
  assert.equal(records.get('legacy-worker')?.sessionFile, 'C:/sessions/legacy-worker.jsonl')
  assert.equal(records.get('legacy-worker')?.persistLifecycle, true)
})

test('完成记录恢复为终态并保留 child sessionFile', () => {
  const records = restoreSubagentRecords([
    launchEntry({
      id: 'launch-1',
      toolName: 'agent',
      taskId: 'agent-1',
      startedAt: 100,
      timestamp: '2026-01-01T00:00:00.100Z'
    }),
    completionEntry({
      id: 'complete-1',
      taskId: 'agent-1',
      status: 'completed',
      endedAt: 200,
      timestamp: '2026-01-01T00:00:00.200Z'
    })
  ])
  const record = records.get('agent-1')
  assert.equal(record?.status, 'completed')
  assert.equal(record?.endedAt, 200)
  assert.equal(record?.sessionFile, 'C:/sessions/agent-1.jsonl')
  assert.equal(record?.session, null)
})

test('间接 Worker Launch 和隐藏终态恢复为普通子代理记录', () => {
  const records = restoreSubagentRecords([
    delegatedLaunchEntry({
      id: 'worker-launch',
      taskId: 'worker-1',
      startedAt: 100,
      timestamp: '2026-01-01T00:00:00.100Z'
    }),
    {
      type: 'custom',
      id: 'worker-terminal',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.200Z',
      customType: 'pi-desk-subagent:state:v1',
      data: {
        version: 1,
        kind: 'terminal',
        taskId: 'worker-1',
        status: 'completed',
        endedAt: 200,
        sessionFile: 'C:/sessions/worker-1.jsonl'
      }
    } as SessionEntry
  ])
  const record = records.get('worker-1')
  assert.equal(record?.agentType, 'research-worker')
  assert.equal(record?.status, 'completed')
  assert.equal(record?.persistLifecycle, true)
  assert.equal(record?.notifyParent, false)
})

test('resume 复用同一任务，缺少新终态时恢复为 interrupted', () => {
  const records = restoreSubagentRecords([
    launchEntry({
      id: 'launch-1',
      toolName: 'agent',
      taskId: 'agent-1',
      startedAt: 100,
      timestamp: '2026-01-01T00:00:00.100Z'
    }),
    completionEntry({
      id: 'complete-1',
      taskId: 'agent-1',
      status: 'completed',
      endedAt: 200,
      timestamp: '2026-01-01T00:00:00.200Z'
    }),
    launchEntry({
      id: 'resume-1',
      toolName: 'agent_resume',
      taskId: 'agent-1',
      startedAt: 300,
      timestamp: '2026-01-01T00:00:00.300Z'
    })
  ])
  const record = records.get('agent-1')
  assert.equal(records.size, 1)
  assert.equal(record?.status, 'interrupted')
  assert.equal(record?.startedAt, 300)
  assert.equal(record?.endedAt, Date.parse('2026-01-01T00:00:00.300Z'))
})
