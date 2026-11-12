import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BrowserEntryFactory,
  BrowserPluginHost,
  PluginJsonObject,
  PluginPushMessage,
  WorkbenchContext
} from '@jetcrab/pi-desk-sdk/browser'
import {
  createL4PluginHostRuntime,
  type L4PluginHostTransport,
  type L4PluginHostRuntime
} from '../src/client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import { replaceL4HostSettings } from '../src/client/l4_foundation/locale/l4-region-store'

const source = { workId: 'work-a', sessionId: 'session-a', branchId: 'branch-a' }
const contextA = { source, cwd: '/shared' }

interface EventFixture {
  runtime: L4PluginHostRuntime
  factories: Map<string, BrowserEntryFactory>
  host: (name?: string) => BrowserPluginHost
  emitPush: (message: PluginPushMessage) => void
  setEntries: (names: string[], version?: number) => void
  reload: (name: string) => Promise<void>
}

function fixture(initialNames = ['plugin-a', 'plugin-b', 'plugin-c']): EventFixture {
  const hosts = new Map<string, BrowserPluginHost>()
  const factories = new Map<string, BrowserEntryFactory>()
  let descriptors = initialNames.map((pluginName) => ({ pluginName, url: `${pluginName}:1` }))
  let push: (message: PluginPushMessage) => void = () => undefined
  const transport: L4PluginHostTransport = {
    pi: {
      prompt: async () => ({ tempId: 'temp-a' }),
      commands: { list: async () => [], execute: async () => undefined },
      tools: { list: async () => [] },
      bash: {
        execute: async () => ({
          output: '',
          exitCode: 0,
          cancelled: false,
          truncated: false,
          fullOutputPath: null
        }),
        abort: async () => undefined
      },
      interrupt: async () => undefined
    },
    listBrowserEntries: async () => descriptors,
    subscribePush: (listener) => {
      push = listener
      return () => {
        push = () => undefined
      }
    },
    createPiDeskChannel: () => ({
      invokeGlobal: async () => ({}),
      invokeSession: async () => ({})
    }),
    createLogChannel: () => ({
      watch: async () => ({ text: '', truncated: false }),
      unwatch: async () => undefined,
      subscribe: () => () => undefined
    })
  }
  const runtime = createL4PluginHostRuntime(transport, async (url) => ({
    default: (plugin: Parameters<BrowserEntryFactory>[0]): void => {
      hosts.set(plugin.name, plugin.host)
      factories.get(url)?.(plugin)
    }
  }))
  return {
    runtime,
    factories,
    host: (name = 'plugin-a'): BrowserPluginHost => {
      const host = hosts.get(name)
      assert.ok(host)
      return host
    },
    emitPush: (message: PluginPushMessage): void => push(message),
    setEntries: (names: string[], version = 1): void => {
      descriptors = names.map((pluginName) => ({ pluginName, url: `${pluginName}:${version}` }))
    },
    reload: async (name: string): Promise<void> => {
      descriptors = descriptors.map((entry) =>
        entry.pluginName === name ? { ...entry, url: `${name}:${Math.random()}` } : entry
      )
      await runtime.refreshEntries()
    }
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}

test('状态首次值等待真实基线、交付最新值，之后按变化顺序且旧 subscribe 无首次值', async (t) => {
  const f = fixture()
  t.after(() => f.runtime.dispose())
  await f.runtime.refreshEntries()
  const host = f.host()
  const seen: unknown[] = []
  const getterMatches: boolean[] = []
  let oldCalls = 0
  host.workSessions.subscribe(() => {
    oldCalls += 1
  })
  host.events.on('work-sessions', (value) => {
    getterMatches.push(host.workSessions.getSnapshot() === value)
    seen.push(value.map((item) => item.cwd))
  })
  assert.deepEqual(seen, [])
  await flush()
  assert.deepEqual(seen, [])
  f.runtime.replaceWorkSessions([{ ...source, cwd: '/old', status: 'idle' }])
  f.runtime.replaceWorkSessions([{ ...source, cwd: '/latest', status: 'idle' }])
  assert.deepEqual(seen, [])
  await flush()
  assert.deepEqual(seen, [['/latest']])
  f.runtime.replaceWorkSessions([{ ...source, cwd: '/next', status: 'idle' }])
  f.runtime.replaceWorkSessions([{ ...source, cwd: '/last', status: 'idle' }])
  f.runtime.replaceWorkSessions([{ ...source, cwd: '/last', status: 'idle' }])
  assert.deepEqual(seen, [['/latest'], ['/next'], ['/last']])
  assert.equal(oldCalls, 4)
  assert.deepEqual(getterMatches, [true, true, true])
  const empty = fixture()
  t.after(() => empty.runtime.dispose())
  await empty.runtime.refreshEntries()
  const values: unknown[] = []
  empty.host().events.on('work-sessions', (value) => {
    values.push(value)
  })
  empty.runtime.replaceWorkSessions([])
  await flush()
  assert.deepEqual(values, [[]])
})

test('首次交付前退订、Owner 替换和 Runtime 关闭均撤销待交付值', async (t) => {
  const f = fixture()
  t.after(() => f.runtime.dispose())
  await f.runtime.refreshEntries()
  let calls = 0
  const old = f.host()
  const off = old.events.on('connection', () => {
    calls += 1
  })
  off()
  off()
  await flush()
  assert.equal(calls, 0)
  old.events.on('workbench-context', () => {
    calls += 1
  })
  await f.reload('plugin-a')
  f.runtime.replaceWorkbenchContext(contextA)
  await flush()
  assert.equal(calls, 0)
  assert.throws(() => old.events.emit('changed', {}), /失效/)
  assert.throws(() => old.events.on('theme', () => undefined), /失效/)
  assert.throws(() => old.events.onPlugin('plugin-b', 'changed', () => undefined), /失效/)
  f.host().events.on('connection', () => {
    calls += 1
  })
  await f.runtime.dispose()
  await flush()
  assert.equal(calls, 0)
})

test('工作上下文完整比较 Source 与 cwd，并与其他页面隔离', async (t) => {
  const f = fixture()
  const other = fixture()
  t.after(() => Promise.all([f.runtime.dispose(), other.runtime.dispose()]))
  await Promise.all([f.runtime.refreshEntries(), other.runtime.refreshEntries()])
  const seen: WorkbenchContext[] = []
  const otherSeen: WorkbenchContext[] = []
  f.host().events.on('workbench-context', (value) => {
    seen.push(value)
  })
  other.host().events.on('workbench-context', (value) => {
    otherSeen.push(value)
  })
  f.runtime.replaceWorkbenchContext(contextA)
  await flush()
  const contextB = { source: { ...source, workId: 'work-b' }, cwd: '/shared' }
  const branch = { source: { ...source, branchId: 'branch-b' }, cwd: '/shared' }
  const cwd = { source: branch.source, cwd: '/changed' }
  for (const next of [contextA, contextB, branch, cwd, null, null])
    f.runtime.replaceWorkbenchContext(next)
  assert.deepEqual(seen, [contextA, contextB, branch, cwd, null])
  assert.deepEqual(otherSeen, [])
  const late: WorkbenchContext[] = []
  f.host('plugin-b').events.on('workbench-context', (value) => {
    late.push(value)
  })
  await flush()
  assert.deepEqual(late, [null])
})

test('连接、设置、主题与自身状态槽提供真实首次值、变化去重和删除', async (t) => {
  const f = fixture()
  t.after(() => f.runtime.dispose())
  await f.runtime.refreshEntries()
  const host = f.host()
  const connection: unknown[] = []
  const settings: unknown[] = []
  const theme: unknown[] = []
  const a: unknown[] = []
  const b: unknown[] = []
  const getterMatches: boolean[] = []
  host.events.on('connection', (value) => {
    getterMatches.push(host.connection.getSnapshot() === value)
    connection.push(value)
  })
  host.events.on('settings', (value) => {
    getterMatches.push(JSON.stringify(host.settings.getSnapshot()) === JSON.stringify(value))
    settings.push(value)
  })
  host.events.on('theme', (value) => {
    theme.push(value)
  })
  host.events.on('plugin-state', (value) => {
    getterMatches.push(host.globalState.getSnapshot() === value)
    a.push(value)
  })
  f.host('plugin-b').events.on('plugin-state', (value) => {
    b.push(value)
  })
  await flush()
  assert.deepEqual(connection, [{ status: 'disconnected', error: null }])
  assert.deepEqual(theme, [{ mode: 'light' }])
  assert.deepEqual(settings, [])
  assert.deepEqual(a, [])
  f.runtime.replaceGlobalPluginStates({ 'plugin-a': { ready: true } })
  replaceL4HostSettings({ region: { locale: 'en', timeZone: 'UTC' } })
  f.runtime.markReady()
  await flush()
  assert.deepEqual(a, [{ ready: true }])
  assert.deepEqual(b, [null])
  assert.equal(settings.length, 1)
  f.runtime.replaceGlobalPluginStates({ 'plugin-a': { ready: true }, 'plugin-b': { count: 1 } })
  f.runtime.replaceGlobalPluginStates({ 'plugin-b': { count: 1 } })
  f.runtime.markReady()
  f.runtime.markDisconnected('断开')
  f.runtime.markDisconnected('断开')
  replaceL4HostSettings({ region: { locale: 'zh-CN', timeZone: 'Asia/Shanghai' } })
  assert.deepEqual(a, [{ ready: true }, null])
  assert.deepEqual(b, [null, { count: 1 }])
  assert.equal(settings.length, 2)
  assert.deepEqual(connection, [
    { status: 'disconnected', error: null },
    { status: 'ready', error: null },
    { status: 'disconnected', error: '断开' }
  ])
  assert.ok(getterMatches.every(Boolean))
})

test('自定义事件按发布者和名称路由、自身可收、旧 Push 不开放且页面独立', async (t) => {
  const f = fixture()
  const other = fixture()
  t.after(() => Promise.all([f.runtime.dispose(), other.runtime.dispose()]))
  let pushCalls = 0
  f.factories.set('plugin-a:1', (plugin) => {
    plugin.onPush(() => {
      pushCalls += 1
    })
  })
  await Promise.all([f.runtime.refreshEntries(), other.runtime.refreshEntries()])
  const calls: string[] = []
  f.host('plugin-c').events.onPlugin('plugin-a', 'theme', () => {
    calls.push('a')
  })
  f.host('plugin-c').events.onPlugin('plugin-b', 'theme', () => {
    calls.push('b')
  })
  f.host().events.onPlugin('plugin-a', 'theme', () => {
    calls.push('self')
  })
  f.host().events.on('theme', () => {
    calls.push('host')
  })
  other.host().events.onPlugin('plugin-a', 'theme', () => {
    calls.push('other-page')
  })
  await flush()
  assert.deepEqual(calls, ['host'])
  f.host().events.emit('theme', {})
  f.host('plugin-b').events.emit('theme', {})
  f.emitPush({ pluginName: 'plugin-a', target: { scope: 'global' }, event: 'theme', data: {} })
  assert.deepEqual(calls, ['host', 'a', 'self', 'b'])
  assert.equal(pushCalls, 1)
})

test('迟加载发布者无回放、发布者重载保留外部订阅，订阅者重载与重复退订独立释放', async (t) => {
  const f = fixture(['plugin-c'])
  t.after(() => f.runtime.dispose())
  await f.runtime.refreshEntries()
  let count = 0
  const listener = (): void => {
    count += 1
  }
  const off = f.host('plugin-c').events.onPlugin('plugin-a', 'changed', listener)
  f.host('plugin-c').events.onPlugin('plugin-a', 'changed', listener)
  f.setEntries(['plugin-a', 'plugin-c'])
  await f.runtime.refreshEntries()
  f.host().events.emit('unobserved', {})
  assert.equal(count, 0)
  f.host().events.emit('changed', {})
  assert.equal(count, 2)
  off()
  off()
  await f.reload('plugin-a')
  f.host().events.emit('changed', {})
  assert.equal(count, 3)
  await f.reload('plugin-c')
  f.host().events.emit('changed', {})
  assert.equal(count, 3)
  f.host('plugin-c').events.onPlugin('plugin-a', 'changed', listener)
  assert.equal(count, 3)
  f.host().events.emit('changed', {})
  assert.equal(count, 4)
})

test('回调按注册顺序开始、同步及异步故障隔离，不等待 Promise 且日志不打印数据', async (t) => {
  const f = fixture()
  t.after(() => f.runtime.dispose())
  await f.runtime.refreshEntries()
  const order: number[] = []
  const logs: unknown[][] = []
  const previous = console.error
  console.error = (...args): void => {
    logs.push(args)
  }
  t.after(() => {
    console.error = previous
  })
  const pending = Promise.withResolvers<void>()
  t.after(() => pending.resolve())
  const events = f.host('plugin-c').events
  events.onPlugin('plugin-a', 'changed', () => {
    order.push(1)
    throw new Error('同步失败')
  })
  events.onPlugin('plugin-a', 'changed', async () => {
    order.push(2)
    throw new Error('异步失败')
  })
  events.onPlugin('plugin-a', 'changed', async () => {
    order.push(3)
    await pending.promise
  })
  events.onPlugin('plugin-a', 'changed', () => {
    order.push(4)
  })
  f.host().events.emit('changed', { secret: 'payload-not-logged' })
  assert.deepEqual(order, [1, 2, 3, 4])
  await flush()
  assert.equal(logs.length, 2)
  assert.match(JSON.stringify(logs), /plugin-c/)
  assert.match(JSON.stringify(logs), /plugin-a\/changed/)
  assert.doesNotMatch(JSON.stringify(logs), /payload-not-logged/)
})

test('自定义 JSON Object 发布隔离并递归只读，非法值与 64KB 边界在无人监听时也拒绝', async (t) => {
  const f = fixture()
  t.after(() => f.runtime.dispose())
  await f.runtime.refreshEntries()
  const snapshots: unknown[] = []
  const payload = { nested: { count: 1 }, items: [1, 2] }
  const protectedData: boolean[] = []
  f.host('plugin-b').events.onPlugin('plugin-a', 'changed', (data) => {
    protectedData.push(data !== payload, Object.isFrozen(data), Object.isFrozen(data.nested))
    protectedData.push(!Reflect.set(data.nested as object, 'count', 99))
  })
  f.host('plugin-c').events.onPlugin('plugin-a', 'changed', (data) => {
    snapshots.push(data)
  })
  f.host().events.emit('changed', payload)
  payload.nested.count = 2
  payload.items.push(3)
  assert.deepEqual(snapshots, [{ nested: { count: 1 }, items: [1, 2] }])
  assert.deepEqual(protectedData, [true, true, true, true])
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  class CustomArray extends Array<number> {
    toJSON(): string {
      return '不可静默替换事件数据'
    }
  }
  const invalid: unknown[] = [
    null,
    [],
    'text',
    new Date(),
    cycle,
    { x: undefined },
    { x: () => undefined },
    { x: NaN },
    { x: Infinity },
    { x: BigInt(1) },
    { x: Symbol('x') },
    { x: new Date() },
    { x: new Map() },
    { x: new CustomArray(1, 2) },
    { x: [, 1] },
    { [Symbol('x')]: 1 }
  ]
  for (const value of invalid)
    assert.throws(() => f.host().events.emit('no-consumer', value as PluginJsonObject))
  assert.throws(() => f.host().events.emit('Bad_Name', {}))
  assert.throws(() => f.host().events.onPlugin('Bad_Name', 'changed', () => undefined))
  assert.throws(() => f.host().events.onPlugin('plugin-a', '', () => undefined))
  assert.throws(() => f.host().events.emit('no-consumer', { text: '中'.repeat(22_000) }), /64KB/)
  f.host().events.emit('no-consumer', { text: 'a'.repeat(65_525) })
  assert.throws(() => f.host().events.emit('no-consumer', { text: 'a'.repeat(65_526) }), /64KB/)
})
