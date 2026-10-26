import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  SESSION_PLUGIN_METHOD_EVENT,
  SESSION_PLUGIN_PUSH_EVENT,
  type SessionPluginFacade,
  type SessionPluginMethodEvent,
  type SessionPluginMethodRegistration,
  type PluginJsonObject
} from '@jetcrab/pi-desk-sdk/session'
import extension from '../src/index.js'
import { TodoRuntime } from '../src/runtime.js'
import { TodoInputSchema } from '../src/schema.js'
import {
  countTodoItems,
  deriveTodoStatus,
  parseTodoInput,
  type TodoInput
} from '../src/contract.js'

function input(): TodoInput {
  return {
    title: '接口迁移',
    items: [
      { id: 'prepare', title: '接口梳理', status: 2 },
      {
        id: 'migration',
        title: '分端迁移',
        children: [
          { id: 'client', title: '客户端', status: 2 },
          { id: 'backend', title: '后台', status: 1 },
          { id: 'sales', title: '销售端', status: 3, note: '等待兼容范围确认' }
        ]
      },
      { id: 'verify', title: '联调验证', status: 0 }
    ]
  }
}
function runtime(): { value: TodoRuntime; pushes: string[] } {
  const pushes: string[] = []
  const plugin = {
    name: 'todo',
    push: (event: string): void => {
      pushes.push(event)
    },
    setState: (): void => undefined
  } as unknown as SessionPluginFacade
  return { value: new TodoRuntime(plugin), pushes }
}

test('状态Schema说明0/1/2/3，父子完成数分别计算', () => {
  const schema = JSON.stringify(TodoInputSchema)
  for (const text of ['0', '1', '2', '3', '待开始', '进行中', '已完成', '受阻'])
    assert.ok(schema.includes(text))
  const parsed = parseTodoInput(input())
  assert.deepEqual(countTodoItems(parsed.items), { completed: 1, total: 3 })
  const parent = parsed.items[1]
  assert.ok('children' in parent)
  assert.deepEqual(countTodoItems(parent.children), { completed: 1, total: 3 })
  assert.equal(deriveTodoStatus(parent), 1)
  assert.equal(
    deriveTodoStatus({
      ...parent,
      children: parent.children.map((child) => ({ ...child, status: 2 as const }))
    }),
    2
  )
  assert.equal(
    deriveTodoStatus({
      ...parent,
      children: [{ id: 'wait', title: '等待', status: 3, note: '等待确认' }]
    }),
    3
  )
})

test('全量替换仅保留一份，隐藏保留内存，新登记重新显示', () => {
  const { value, pushes } = runtime()
  assert.deepEqual(value.get(), { todo: null, hidden: false })
  assert.deepEqual(value.replace(input()), { todo: input(), hidden: false })
  assert.deepEqual(value.hide(), { todo: input(), hidden: true })
  assert.deepEqual(value.get(), { todo: input(), hidden: true })
  const replacement: TodoInput = {
    title: '新进度',
    items: [{ id: 'new', title: '核对结果', status: 1 }]
  }
  assert.deepEqual(value.replace(replacement), { todo: replacement, hidden: false })
  assert.equal(value.get().todo?.items.length, 1)
  assert.deepEqual(pushes, ['changed', 'changed', 'changed'])
  value.clear()
  assert.deepEqual(value.get(), { todo: null, hidden: false })
  assert.deepEqual(runtime().value.get(), { todo: null, hidden: false })
})

test('非法全量登记原子拒绝并保留已有进度', () => {
  const { value } = runtime()
  value.replace(input())
  const invalid = [
    { title: '错误', items: [{ id: 'x', title: '任务', status: 4 }] },
    { title: '错误', items: [{ id: 'x', title: '任务', status: '1' }] },
    { title: '错误', items: [{ id: 'x', title: '任务', status: 3 }] },
    { title: '错误', items: [{ id: 'x', title: '任务', status: 3, note: ' ' }] },
    {
      title: '错误',
      items: [
        { id: 'x', title: '任务', status: 0 },
        { id: 'x', title: '重复', status: 1 }
      ]
    },
    {
      title: '错误',
      items: [
        {
          id: 'x',
          title: '父节点',
          status: 2,
          children: [{ id: 'child', title: '子任务', status: 0 }]
        }
      ]
    },
    { title: '错误', items: [{ id: 'x', title: '父节点', children: [] }] },
    { title: '错误', items: [] }
  ]
  for (const candidate of invalid) {
    assert.throws(() => value.replace(candidate))
    assert.deepEqual(value.get(), { todo: input(), hidden: false })
  }
})

test('输入和读取快照不能通过外部引用修改权威内容', () => {
  const { value } = runtime()
  const original = input()
  value.replace(original)
  original.title = '外部覆盖'
  assert.equal(value.get().todo?.title, '接口迁移')
  const snapshot = value.get()
  snapshot.todo!.title = '读取后覆盖'
  assert.equal(value.get().todo?.title, '接口迁移')
})

test('数据大小和总节点数有界', () => {
  const { value } = runtime()
  assert.throws(() =>
    value.replace({
      title: '大数据',
      items: [{ id: 'x', title: '任务', status: 3, note: '字'.repeat(65536) }]
    })
  )
  assert.throws(() =>
    value.replace({
      title: '过多节点',
      items: Array.from({ length: 101 }, (_, i) => ({ id: String(i), title: '任务', status: 0 }))
    })
  )
  assert.deepEqual(value.get(), { todo: null, hidden: false })
})

type Handler = (event: unknown, context: ExtensionContext) => unknown
interface CapturedTool {
  name: string
  description: string
  promptGuidelines?: string[]
  execute(
    id: string,
    input: TodoInput,
    signal: AbortSignal,
    update: undefined,
    context: ExtensionContext
  ): Promise<{ details?: unknown; content: Array<{ type: string; text?: string }> }>
}
function capture(): {
  tool: CapturedTool
  events: Map<string, Handler[]>
  methods: Map<string, SessionPluginMethodRegistration>
  pushes: unknown[]
  context: ExtensionContext
} {
  let tool: CapturedTool | undefined
  const events = new Map<string, Handler[]>()
  const methods = new Map<string, SessionPluginMethodRegistration>()
  const pushes: unknown[] = []
  const context = {
    cwd: 'C:/test-project',
    sessionManager: {
      getBranch: (): never => {
        throw new Error('不能从历史恢复Todo')
      }
    }
  } as unknown as ExtensionContext
  const pi = {
    registerTool: (definition: CapturedTool): void => {
      tool = definition
    },
    on: (event: string, handler: Handler): void => {
      events.set(event, [...(events.get(event) ?? []), handler])
    },
    appendEntry: (): never => {
      throw new Error('不能持久化Todo')
    },
    sendMessage: (): never => {
      throw new Error('不能持久化Todo')
    },
    events: {
      emit: (channel: string, payload: unknown): void => {
        if (channel === SESSION_PLUGIN_METHOD_EVENT) {
          const event = payload as SessionPluginMethodEvent
          if (event.type === 'register') methods.set(event.registration.method, event.registration)
        }
        if (channel === SESSION_PLUGIN_PUSH_EVENT) pushes.push(payload)
      }
    }
  } as unknown as ExtensionAPI
  extension(pi)
  assert.ok(tool)
  return { tool, events, methods, pushes, context }
}

test('Native入口只登记一个全量工具，get/hide复用内存，生命周期清空且不持久化', async () => {
  const fixture = capture()
  assert.equal(fixture.tool.name, 'todo')
  const guidance = [fixture.tool.description, ...(fixture.tool.promptGuidelines ?? [])].join('\n')
  assert.match(guidance, /不是开发计划|不.*开发计划/)
  assert.match(guidance, /实际/)
  assert.match(guidance, /完整|全量/)
  const source = { workId: 'work', sessionId: 'session', branchId: 'v1:root' }
  const call = async (name: string, params: PluginJsonObject = {}): Promise<PluginJsonObject> => {
    const method = fixture.methods.get(name)
    assert.ok(method)
    return method.execute(params, { source, extensionContext: fixture.context })
  }
  assert.deepEqual([...fixture.methods.keys()].sort(), ['get', 'hide'])
  const execute = (): ReturnType<CapturedTool['execute']> =>
    fixture.tool.execute(
      'todo-call',
      input(),
      new AbortController().signal,
      undefined,
      fixture.context
    )
  const result = await execute()
  assert.equal(result.details, undefined)
  assert.deepEqual(await call('get'), { todo: input(), hidden: false })
  await call('hide')
  assert.deepEqual(await call('get'), { todo: input(), hidden: true })
  await assert.rejects(call('hide', { unexpected: true }))
  await assert.rejects(call('get', { unexpected: true }))
  for (const event of ['session_tree', 'session_start', 'session_shutdown']) {
    await execute()
    assert.ok(fixture.events.has(event))
    for (const handler of fixture.events.get(event)!) await handler({}, fixture.context)
    assert.deepEqual(await call('get'), { todo: null, hidden: false })
  }
  assert.equal(fixture.pushes.length > 0, true)
})

test('两个Native会话独立，恢复实例不读取旧会话工具记录', async () => {
  const first = capture()
  const second = capture()
  await first.tool.execute('one', input(), new AbortController().signal, undefined, first.context)
  const source = { workId: 'two', sessionId: 'two', branchId: 'v1:root' }
  const get = second.methods.get('get')!
  assert.deepEqual(await get.execute({}, { source, extensionContext: second.context }), {
    todo: null,
    hidden: false
  })
})
