import assert from 'node:assert/strict'
import test from 'node:test'
import type { EventBusController } from '@earendil-works/pi-coding-agent'
import { TASK_REPORT_EVENT, type TaskInfoItem, type TaskReportEvent } from '@jetcrab/pi-desk-sdk'
import { L4PiTaskRuntime } from '../src/server/l4_foundation/pi/l4-pi-task-runtime'

class FakeEventBus {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()

  on(channel: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
    return () => listeners.delete(listener)
  }

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(payload)
  }
}

function createBus(): EventBusController & FakeEventBus {
  return new FakeEventBus() as EventBusController & FakeEventBus
}

function runningTask(taskId: string, interrupt: (() => Promise<void>) | null = null) {
  return {
    taskId,
    title: taskId,
    status: 'running' as const,
    activity: null,
    startedAt: 100,
    endedAt: null,
    detailSource: null,
    interrupt
  }
}

test('Task Runtime 聚合任务并以 running 集合驱动后台状态', () => {
  const bus = createBus()
  const snapshots: Array<{ ids: readonly string[]; count: number }> = []
  const runtime = new L4PiTaskRuntime(bus, {
    onChanged: (tasks, ids) => snapshots.push({ ids, count: tasks.length }),
    onInvalidReport: (cause) => {
      throw cause
    }
  })

  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: [runningTask('a'), runningTask('b')]
  } satisfies TaskReportEvent)
  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: [
      {
        ...runningTask('a'),
        status: 'completed',
        endedAt: 200,
        interrupt: null
      }
    ]
  } satisfies TaskReportEvent)

  assert.deepEqual(runtime.activeTaskIds(), ['b'])
  assert.deepEqual(snapshots, [
    { ids: ['a', 'b'], count: 2 },
    { ids: ['b'], count: 2 }
  ])
  runtime.dispose()
})

test('Task Runtime 统一按启动时间倒序，不按状态分组', () => {
  const bus = createBus()
  const runtime = new L4PiTaskRuntime(bus, {
    onChanged: () => undefined,
    onInvalidReport: (cause) => {
      throw cause
    }
  })

  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: [
      { ...runningTask('older-running'), startedAt: 100 },
      {
        ...runningTask('newer-completed'),
        status: 'completed',
        startedAt: 300,
        endedAt: 400,
        interrupt: null
      },
      {
        ...runningTask('middle-failed'),
        status: 'failed',
        startedAt: 200,
        endedAt: 500,
        interrupt: null
      }
    ]
  } satisfies TaskReportEvent)

  assert.deepEqual(
    runtime.summaries().map((task) => task.taskId),
    ['newer-completed', 'middle-failed', 'older-running']
  )
  runtime.dispose()
})

test('Task Runtime 同一任务重新上报时采用新的启动时间', () => {
  const bus = createBus()
  const runtime = new L4PiTaskRuntime(bus, {
    onChanged: () => undefined,
    onInvalidReport: (cause) => {
      throw cause
    }
  })

  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: [
      {
        ...runningTask('restarted'),
        status: 'completed',
        startedAt: 100,
        endedAt: 200,
        interrupt: null
      },
      { ...runningTask('other'), startedAt: 250 }
    ]
  } satisfies TaskReportEvent)
  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: [{ ...runningTask('restarted'), startedAt: 300 }]
  } satisfies TaskReportEvent)

  assert.equal(runtime.record('restarted')?.startedAt, 300)
  assert.deepEqual(
    runtime.summaries().map((task) => task.taskId),
    ['restarted', 'other']
  )
  runtime.dispose()
})

test('Task Runtime 在所有终态统一截断过长 activity', () => {
  const bus = createBus()
  const runtime = new L4PiTaskRuntime(bus, {
    onChanged: () => undefined,
    onInvalidReport: (cause) => {
      throw cause
    }
  })
  const statuses = ['completed', 'failed', 'stopped', 'interrupted'] as const
  const longActivity = '任务执行输出 '.repeat(100)

  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: statuses.map((_, index) => runningTask(`terminal-${index}`))
  } satisfies TaskReportEvent)

  for (const [index, taskStatus] of statuses.entries()) {
    const taskId = `terminal-${index}`
    bus.emit(TASK_REPORT_EVENT, {
      type: 'upsert',
      tasks: [
        {
          ...runningTask(taskId),
          status: taskStatus,
          activity: longActivity,
          endedAt: 200,
          interrupt: null
        }
      ]
    } satisfies TaskReportEvent)
  }

  for (const [index, taskStatus] of statuses.entries()) {
    const task = runtime.record(`terminal-${index}`)
    assert.ok(task)
    assert.equal(task.status, taskStatus)
    assert.equal(task.activity?.length, 300)
    assert.equal(task.activity?.endsWith('…'), true)
  }
  assert.deepEqual(runtime.activeTaskIds(), [])
  runtime.dispose()
})

test('Task Runtime 归一化可选分类和详情信息', () => {
  const bus = createBus()
  const runtime = new L4PiTaskRuntime(bus, {
    onChanged: () => undefined,
    onInvalidReport: (cause) => {
      throw cause
    }
  })
  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: [
      {
        ...runningTask('display-task'),
        taskKind: ' 子代理 ',
        taskType: ' explore ',
        info: [{ label: ' 运行信息 ', value: ' test/model · 12,000/128,000 tokens ' }]
      }
    ]
  } satisfies TaskReportEvent)

  assert.deepEqual(runtime.summaries()[0], {
    taskId: 'display-task',
    taskKind: '子代理',
    taskType: 'explore',
    title: 'display-task',
    info: [{ label: '运行信息', value: 'test/model · 12,000/128,000 tokens' }],
    status: 'running',
    activity: null,
    startedAt: 100,
    endedAt: null
  })
  runtime.dispose()
})

test('Task Runtime 详情首次观察时按需加载 info 并复用结果', async () => {
  const bus = createBus()
  let loadCount = 0
  const changedInfos: TaskInfoItem[][] = []
  const runtime = new L4PiTaskRuntime(bus, {
    onChanged: (tasks) => {
      changedInfos.push(tasks.find((task) => task.taskId === 'history')?.info ?? [])
    },
    onInvalidReport: (cause) => {
      throw cause
    }
  })
  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: [
      {
        taskId: 'history',
        title: '历史任务',
        info: [],
        infoLoader: async () => {
          loadCount += 1
          await new Promise<void>((resolve) => setImmediate(resolve))
          return [{ label: '运行信息', value: 'test/model · 12,000/128,000 tokens' }]
        },
        status: 'completed',
        activity: null,
        startedAt: 100,
        endedAt: 200,
        detailSource: null,
        interrupt: null
      }
    ]
  } satisfies TaskReportEvent)

  const [first, second] = await Promise.all([
    runtime.watchDetail('history', () => undefined),
    runtime.watchDetail('history', () => undefined)
  ])

  assert.equal(loadCount, 1)
  assert.deepEqual(runtime.summaries()[0]?.info, [
    { label: '运行信息', value: 'test/model · 12,000/128,000 tokens' }
  ])
  assert.deepEqual(changedInfos.at(-1), [
    { label: '运行信息', value: 'test/model · 12,000/128,000 tokens' }
  ])

  first.release()
  second.release()
  const third = await runtime.watchDetail('history', () => undefined)
  third.release()
  assert.equal(loadCount, 1)
  runtime.dispose()
})

test('Task Runtime 只调用当前 running 任务的 interrupt', async () => {
  const bus = createBus()
  let interrupted = 0
  const runtime = new L4PiTaskRuntime(bus, {
    onChanged: () => undefined,
    onInvalidReport: (cause) => {
      throw cause
    }
  })
  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: [runningTask('a', async () => void (interrupted += 1))]
  } satisfies TaskReportEvent)

  await runtime.interrupt('a')
  assert.equal(interrupted, 1)
  await assert.rejects(() => runtime.interrupt('missing'))
  runtime.dispose()
})

test('Task Runtime 终态历史裁剪为最近 100 条', () => {
  const bus = createBus()
  const runtime = new L4PiTaskRuntime(bus, {
    onChanged: () => undefined,
    onInvalidReport: (cause) => {
      throw cause
    }
  })
  bus.emit(TASK_REPORT_EVENT, {
    type: 'upsert',
    tasks: Array.from({ length: 105 }, (_, index) => ({
      taskId: `task-${index}`,
      title: `任务 ${index}`,
      status: 'completed' as const,
      activity: null,
      startedAt: index,
      endedAt: 1_000 + index,
      detailSource: null,
      interrupt: null
    }))
  } satisfies TaskReportEvent)

  assert.equal(runtime.summaries().length, 100)
  assert.equal(runtime.record('task-0'), null)
  assert.notEqual(runtime.record('task-104'), null)
  runtime.dispose()
})
