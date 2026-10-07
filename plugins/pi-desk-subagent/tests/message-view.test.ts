import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PluginJsonObject,
  PluginJsonValue,
  PluginMessageDeclarationInput
} from '@jetcrab/pi-desk-sdk/entry'
import {
  projectSubagentReturnMessage,
  projectSubagentStartMessage,
  projectSubagentListMessage,
  projectSubagentControlMessage
} from '../src/pi-desk.js'

const source = { workId: 'work-1', sessionId: 'session-1', branchId: 'v1:main' }
const defaultProjection = { viewKey: 'pi-desk/tool', summary: {}, detail: null }

function input(
  message: PluginMessageDeclarationInput['message'],
  stage: PluginMessageDeclarationInput['stage'] = 'temporary'
): PluginMessageDeclarationInput {
  return { source, stage, message, raw: null, defaultProjection }
}

test('agent Tool 在 Temporary 阶段先投影摘要和 Markdown Prompt', () => {
  assert.deepEqual(
    projectSubagentStartMessage(
      input({
        kind: 'tool',
        toolName: 'agent',
        toolCallId: 'call-1',
        arguments: {
          subagent_type: 'explore',
          description: '调查消息展示',
          prompt: '## 调查目标\n\n检查消息生命周期。'
        },
        partialResult: null,
        result: null,
        isError: false
      })
    ),
    {
      viewKey: 'subagent/start',
      summary: {
        action: 'start',
        taskId: null,
        agentType: 'explore',
        title: '调查消息展示',
        error: null
      },
      detail: { markdown: '## 调查目标\n\n检查消息生命周期。' }
    }
  )
})

test('agent_resume 完成后使用现有 LaunchDetails 补全类型和标题', () => {
  const projection = projectSubagentStartMessage(
    input(
      {
        kind: 'tool',
        toolName: 'agent_resume',
        toolCallId: 'call-2',
        arguments: {
          agent_id: 'agent-12345678',
          prompt: '继续调查剩余路径。'
        },
        partialResult: null,
        result: {
          content: [{ type: 'text', text: '子代理已恢复运行。' }],
          details: {
            version: 1,
            kind: 'launch',
            taskId: 'agent-12345678',
            agentType: 'research',
            title: '调查外部文档'
          }
        },
        isError: false
      },
      'durable'
    )
  )
  assert.deepEqual(projection, {
    viewKey: 'subagent/start',
    summary: {
      action: 'resume',
      taskId: 'agent-12345678',
      agentType: 'research',
      title: '调查外部文档',
      error: null
    },
    detail: { markdown: '继续调查剩余路径。' }
  })
})

test('completion Custom Message 将摘要与 Markdown 返回分层', () => {
  const projection = projectSubagentReturnMessage(
    input(
      {
        kind: 'custom',
        customType: 'pi-desk-subagent:completion:v1',
        content: `子代理已完成。\n\nAgent ID: agent-1\n类型: explore\n任务: 调查消息展示\n\n结果:\n## 结论\n\n- 已完成`,
        details: {
          version: 1,
          kind: 'terminal',
          taskId: 'agent-1',
          status: 'completed',
          endedAt: 200,
          sessionFile: 'C:/sessions/agent-1.jsonl'
        }
      },
      'durable'
    )
  )
  assert.deepEqual(projection, {
    viewKey: 'subagent/return',
    summary: {
      taskId: 'agent-1',
      agentType: 'explore',
      title: '调查消息展示',
      status: 'completed'
    },
    detail: { markdown: '## 结论\n\n- 已完成' }
  })
})

function toolInput(
  toolName: string,
  argumentsValue: PluginJsonObject = {},
  result: PluginJsonValue = null,
  isError = false
): PluginMessageDeclarationInput {
  return input(
    {
      kind: 'tool',
      toolName,
      toolCallId: 'query-call',
      arguments: argumentsValue,
      partialResult: null,
      result,
      isError
    },
    'durable'
  )
}

test('agent_list 首屏展示结构化记录，历史文本仅在详情加载', () => {
  const agents = [
    { taskId: 'task-1', agentType: 'dev', title: '修复列表', status: 'running', startedAt: 100 }
  ]
  const current = projectSubagentListMessage(
    toolInput('agent_list', { agent_id: 'task-1' }, { details: { agents } })
  )
  assert.deepEqual(current, {
    viewKey: 'subagent/list',
    summary: { query: 'task-1', agents, error: null },
    detail: null
  })
  const empty = projectSubagentListMessage(toolInput('agent_list', {}, { details: { agents: [] } }))
  assert.deepEqual(empty.summary.agents, [])
  const legacy = projectSubagentListMessage(
    toolInput(
      'agent_list',
      {},
      { content: [{ type: 'text', text: 'task-1  dev  completed  历史任务' }], details: {} }
    )
  )
  assert.equal(legacy.summary.agents, null)
  assert.deepEqual(legacy.detail, { output: 'task-1  dev  completed  历史任务' })
  const failure = projectSubagentListMessage(
    toolInput(
      'agent_list',
      { agent_id: 'missing' },
      { content: [{ type: 'text', text: '未知 Agent ID：missing' }] },
      true
    )
  )
  assert.equal(failure.summary.error, '未知 Agent ID：missing')
  assert.equal(failure.detail, null)
})

test('控制工具回执不投影为子代理终态，兼容历史排队结果', () => {
  const stop = projectSubagentControlMessage(
    toolInput(
      'agent_stop',
      { agent_id: 'task' },
      {
        details: { taskId: 'task-full-id', agentType: 'dev', title: '修复列表' }
      }
    )
  )
  assert.deepEqual(stop, {
    viewKey: 'subagent/control',
    summary: {
      action: 'stop',
      taskId: 'task-full-id',
      agentType: 'dev',
      title: '修复列表',
      delivery: null,
      error: null
    },
    detail: null
  })
  const steer = projectSubagentControlMessage(
    toolInput(
      'agent_steer',
      { agent_id: 'task', prompt: '请补充测试' },
      {
        details: { taskId: 'task-full-id', agentType: 'dev', title: '修复列表', delivery: 'queued' }
      }
    )
  )
  assert.equal(steer.summary.delivery, 'queued')
  assert.equal(steer.summary.preview, '请补充测试')
  assert.deepEqual(steer.detail, { markdown: '请补充测试' })
  const legacy = projectSubagentControlMessage(
    toolInput(
      'agent_steer',
      { agent_id: 'task', prompt: '补充' },
      {
        content: [
          { type: 'text', text: '补充条件已排队，将在子代理开始处理后投递。\n\nAgent ID: task' }
        ],
        details: {}
      }
    )
  )
  assert.equal(legacy.summary.delivery, 'queued')
  assert.equal(legacy.summary.taskId, 'task')
  const failure = projectSubagentControlMessage(
    toolInput(
      'agent_stop',
      { agent_id: 'task' },
      {
        content: [{ type: 'text', text: '当前不是 running' }]
      },
      true
    )
  )
  assert.equal(failure.summary.error, '当前不是 running')
})

test('agent_steer 预览和完整详情来自补充条件，不采用工具回执正文', () => {
  const projection = projectSubagentControlMessage(
    toolInput(
      'agent_steer',
      { agent_id: 'task', prompt: '请补充测试\n\n检查恢复失败' },
      {
        content: [{ type: 'text', text: '补充要求已发送。仅用于回执。' }],
        details: { delivery: 'delivered' }
      }
    )
  )
  assert.equal(projection.summary.preview, '请补充测试 检查恢复失败')
  assert.deepEqual(projection.detail, { markdown: '请补充测试\n\n检查恢复失败' })
})

test('简述裁剪有省略标记且不截断字符，完整提示词不变', () => {
  for (const prompt of ['完整补充条件'.repeat(50), '中'.repeat(158) + '🔧'.repeat(4)]) {
    const projection = projectSubagentControlMessage(
      toolInput('agent_steer', { agent_id: 'task', prompt })
    )
    assert.equal(typeof projection.summary.preview, 'string')
    const preview = String(projection.summary.preview)
    assert.equal(Array.from(preview).length, 160)
    assert.ok(preview.endsWith('…'))
    assert.ok(preview.isWellFormed())
    assert.deepEqual(projection.detail, { markdown: prompt })
  }
  const exact = '中'.repeat(160)
  const projection = projectSubagentControlMessage(
    toolInput('agent_steer', { agent_id: 'task', prompt: exact })
  )
  assert.equal(projection.summary.preview, exact)
})

test('失败补充请求保留目标身份与原文，不猜测缺失的类型和任务名', () => {
  const prompt = '补充检查资源释放。'
  const error = 'Agent task-full-id 当前不是 running'
  const projection = projectSubagentControlMessage(
    toolInput(
      'agent_steer',
      { agent_id: 'task-full-id', prompt },
      {
        content: [{ type: 'text', text: error }]
      },
      true
    )
  )
  assert.equal(projection.summary.taskId, 'task-full-id')
  assert.equal(projection.summary.agentType, null)
  assert.equal(projection.summary.title, '子代理任务')
  assert.equal(projection.summary.error, error)
  assert.deepEqual(projection.detail, { markdown: prompt })
})

test('只有身份而没有正文的历史消息不制造详情', () => {
  const projection = projectSubagentStartMessage(
    toolInput('agent_resume', { agent_id: 'task-full-id' })
  )
  assert.equal(projection.summary.taskId, 'task-full-id')
  assert.equal(projection.detail, null)
})
