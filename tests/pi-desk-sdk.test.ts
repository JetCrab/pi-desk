import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  PluginMethodError,
  SESSION_PLUGIN_METHOD_EVENT,
  SESSION_PLUGIN_STATE_EVENT,
  TASK_REPORT_EVENT,
  bindSessionPlugin,
  isPluginMethodError,
  reportTasks,
  startTask,
  type SessionPluginMethodEvent,
  type TaskReportEvent
} from '@jetcrab/pi-desk-sdk'

function target(events: TaskReportEvent[]) {
  return {
    events: {
      emit(channel: string, payload: unknown): void {
        assert.equal(channel, TASK_REPORT_EVENT)
        events.push(payload as TaskReportEvent)
      }
    }
  }
}

function extensionTarget(events: Array<{ channel: string; payload: unknown }>): ExtensionAPI {
  return {
    events: {
      emit(channel: string, payload: unknown): void {
        events.push({ channel, payload })
      }
    }
  } as ExtensionAPI
}

test('Session Plugin Facade 绑定名称并包装状态、方法和任务', () => {
  const events: Array<{ channel: string; payload: unknown }> = []
  const plugin = bindSessionPlugin(extensionTarget(events), 'context-ignore')
  assert.equal(plugin.name, 'context-ignore')

  plugin.setState({ ignoredTokens: 12_000 })
  const execute = async () => ({ ignored: true })
  const unregister = plugin.registerMethod('ignore', execute)
  const task = plugin.startTask({ taskId: 'facade-task', title: 'Facade 任务' })
  task.complete()
  unregister()
  unregister()
  plugin.setState(null)

  assert.deepEqual(events[0], {
    channel: SESSION_PLUGIN_STATE_EVENT,
    payload: { 'context-ignore': { ignoredTokens: 12_000 } }
  })
  const registrationEvent = events[1]?.payload as SessionPluginMethodEvent
  assert.equal(events[1]?.channel, SESSION_PLUGIN_METHOD_EVENT)
  assert.equal(registrationEvent.type, 'register')
  assert.equal(registrationEvent.registration.pluginName, 'context-ignore')
  assert.equal(registrationEvent.registration.method, 'ignore')
  assert.equal(registrationEvent.registration.execute, execute)
  assert.equal(events[2]?.channel, TASK_REPORT_EVENT)
  assert.equal(events[3]?.channel, TASK_REPORT_EVENT)
  assert.deepEqual(events[4], {
    channel: SESSION_PLUGIN_METHOD_EVENT,
    payload: { type: 'unregister', registration: registrationEvent.registration }
  })
  assert.deepEqual(events[5], {
    channel: SESSION_PLUGIN_STATE_EVENT,
    payload: { 'context-ignore': null }
  })
  assert.equal(events.length, 6)
})

test('PluginMethodError 支持业务 400、404、409', () => {
  for (const code of [400, 404, 409] as const) {
    const error = new PluginMethodError(code, `code-${code}`)
    assert.equal(isPluginMethodError(error), true)
    assert.equal(error.code, code)
  }
})

test('Session Plugin Facade 拒绝不稳定名称', () => {
  const pi = extensionTarget([])
  assert.throws(() => bindSessionPlugin(pi, 'Context Ignore'))
  const plugin = bindSessionPlugin(pi, 'context-ignore')
  assert.throws(() => plugin.registerMethod('Ignore_Now', async () => ({})))
})

test('Task Handle 上报 running、update、terminal 和 remove', () => {
  const events: TaskReportEvent[] = []
  const task = startTask(target(events), {
    taskId: 'task-1',
    taskKind: '构建',
    taskType: 'web',
    title: '执行任务',
    info: [{ label: '运行目标', value: 'production' }],
    activity: '启动中'
  })
  task.update({ activity: '执行中', info: [{ label: '运行目标', value: 'production/x64' }] })
  task.complete()
  task.remove()

  assert.equal(events.length, 4)
  assert.equal(events[0]?.type, 'upsert')
  assert.deepEqual(events[0]?.type === 'upsert' ? events[0].tasks[0]?.status : null, 'running')
  assert.deepEqual(
    events[0]?.type === 'upsert'
      ? {
          taskKind: events[0].tasks[0]?.taskKind,
          taskType: events[0].tasks[0]?.taskType,
          info: events[0].tasks[0]?.info
        }
      : null,
    {
      taskKind: '构建',
      taskType: 'web',
      info: [{ label: '运行目标', value: 'production' }]
    }
  )
  assert.deepEqual(events[1]?.type === 'upsert' ? events[1].tasks[0]?.activity : null, '执行中')
  assert.deepEqual(events[1]?.type === 'upsert' ? events[1].tasks[0]?.info : null, [
    { label: '运行目标', value: 'production/x64' }
  ])
  assert.deepEqual(events[2]?.type === 'upsert' ? events[2].tasks[0]?.status : null, 'completed')
  assert.deepEqual(events[2]?.type === 'upsert' ? events[2].tasks[0]?.interrupt : undefined, null)
  assert.deepEqual(events[3], { type: 'remove', taskIds: ['task-1'] })
  assert.throws(() => task.update({ activity: '不应复活' }))
})

test('终态 AgentSession 自动收敛为 sessionFile', () => {
  const events: TaskReportEvent[] = []
  const session = {
    sessionFile: 'C:/sessions/child.jsonl'
  } as AgentSession
  const task = startTask(target(events), {
    taskId: 'task-session',
    title: '子代理',
    detailSource: { kind: 'pi-conversation', session }
  })
  task.fail('失败')

  const terminal = events[1]?.type === 'upsert' ? events[1].tasks[0] : null
  assert.deepEqual(terminal?.detailSource, {
    kind: 'pi-conversation',
    sessionFile: 'C:/sessions/child.jsonl'
  })
})

test('历史批量 reportTasks 保留完整终态快照', () => {
  const events: TaskReportEvent[] = []
  reportTasks(target(events), [
    {
      taskId: 'history-1',
      title: '历史任务',
      status: 'failed',
      activity: '执行失败',
      startedAt: 100,
      endedAt: 200,
      detailSource: null,
      interrupt: null
    }
  ])
  assert.deepEqual(events, [
    {
      type: 'upsert',
      tasks: [
        {
          taskId: 'history-1',
          title: '历史任务',
          status: 'failed',
          activity: '执行失败',
          startedAt: 100,
          endedAt: 200,
          detailSource: null,
          interrupt: null
        }
      ]
    }
  ])
})
