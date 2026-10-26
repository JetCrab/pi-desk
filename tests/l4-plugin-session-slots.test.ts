import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BrowserEntryFactory,
  BrowserPluginFacade,
  BrowserSessionHeaderItemDefinition,
  BrowserWidgetDefinition,
  BrowserWidgetImplementation,
  PluginDisposer,
  PluginSource
} from '@jetcrab/pi-desk-sdk/browser'
import {
  createL4PluginHostRuntime,
  type L4PluginHostRuntime,
  type L4PluginHostTransport
} from '../src/client/l4_foundation/plugin-host/l4-plugin-host-runtime'

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    localStorage: { getItem: () => null, setItem: () => undefined },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    documentElement: { classList: { contains: () => false } },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
})

const source: PluginSource = { workId: 'slot-work', sessionId: 'slot-session', branchId: 'v1:root' }
const otherSource: PluginSource = {
  workId: 'other-work',
  sessionId: 'other-session',
  branchId: 'v1:root'
}
const icon = { type: 'builtin' as const, name: 'wrench' as const }

async function createFixture(factory: BrowserEntryFactory): Promise<{
  runtime: L4PluginHostRuntime
  reload: () => Promise<void>
}> {
  let version = 1
  const transport: L4PluginHostTransport = {
    pi: {
      prompt: async () => ({ tempId: 'temporary' }),
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
    listBrowserEntries: async () => [
      {
        pluginName: 'slot-fixture',
        url: `/api/plugins/browser-resources/fixture-${version}/entry.js`
      }
    ],
    subscribePush: () => () => undefined,
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
  const runtime = createL4PluginHostRuntime(transport, async () => ({ default: factory }))
  runtime.replaceWorkSessions([
    { ...source, cwd: 'C:/fixture', status: 'idle' },
    { ...otherSource, cwd: 'C:/fixture-other', status: 'idle' }
  ])
  await runtime.refreshEntries()
  return {
    runtime,
    reload: async () => {
      version += 1
      await runtime.refreshEntries()
    }
  }
}

function mountWidget(
  runtime: L4PluginHostRuntime,
  targetSource = source,
  signal?: AbortSignal
): Promise<PluginDisposer> {
  return runtime.mountContribution({
    pluginName: 'slot-fixture',
    kind: 'widget',
    contributionName: 'progress',
    container: {} as HTMLElement,
    target: { kind: 'widget', source: targetSource },
    signal
  })
}

function mountHeader(
  runtime: L4PluginHostRuntime,
  presentation: 'inline' | 'overflow',
  signal?: AbortSignal
): Promise<PluginDisposer> {
  return runtime.mountContribution({
    pluginName: 'slot-fixture',
    kind: 'session-header-item',
    contributionName: 'header',
    container: {} as HTMLElement,
    target: { kind: 'session-header-item', source, presentation },
    signal
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000
  while (Date.now() < end) {
    if (predicate()) return
    await new Promise<void>((finish) => setImmediate(finish))
  }
  throw new Error('等待插槽生命周期超时')
}

test('独立注册 Widget 与 Header，描述符可克隆且不泄露函数', async (context) => {
  let facade!: BrowserPluginFacade
  let loadCount = 0
  const { runtime } = await createFixture((plugin) => {
    facade = plugin
    plugin.registerWidget('above', { load: async () => ({ mount: () => undefined }) })
    plugin.registerWidget('below', {
      placement: 'belowEditor',
      load: async () => ({ mount: () => undefined })
    })
    plugin.registerSessionHeaderItem('header', {
      inline: {
        type: 'custom',
        minWidthRem: 8,
        load: async () => {
          loadCount += 1
          return { mount: () => undefined }
        }
      },
      overflow: { type: 'action', icon, label: '查看详情', onSelect: () => undefined }
    })
    plugin.registerContribution('composer-panel', 'existing', {
      label: '旧面板',
      load: async () => ({ mount: () => undefined })
    })
  })
  context.after(() => runtime.dispose())
  assert.equal(runtime.getEntryState('slot-fixture').status, 'ready')
  const descriptions = structuredClone(runtime.getBrowserDescriptors())
  const items = descriptions[0].contributions
  assert.equal(
    items.find((item) => item.kind === 'widget' && item.contributionName === 'above')?.kind,
    'widget'
  )
  const widgets = items.filter((item) => item.kind === 'widget')
  assert.deepEqual(
    widgets.map((item) => item.placement),
    ['aboveEditor', 'belowEditor']
  )
  assert.equal(
    items.some((item) => item.kind === 'composer-panel'),
    true
  )
  assert.equal(loadCount, 0, '注册不能执行懒加载')
  const header = items.find((item) => item.kind === 'session-header-item')
  assert.ok(header?.kind === 'session-header-item')
  assert.equal(header.inline.type, 'custom')
  assert.equal(header.overflow.type, 'action')
  assert.equal('load' in header.inline, false)
  assert.equal('onSelect' in header.overflow, false)
  assert.throws(
    () => facade.registerWidget('late', { load: async () => ({ mount: () => undefined }) }),
    /registration|注册/i
  )
})

test('非法插槽声明拒绝：位置、宽度、缺失折叠态与混用字段', async (context) => {
  const noop = async (): Promise<BrowserWidgetImplementation> => ({ mount: () => undefined })
  const custom = { type: 'custom', minWidthRem: 6, load: noop }
  const action = { type: 'action', label: '操作', icon, onSelect: () => undefined }
  const cases: Array<(plugin: BrowserPluginFacade) => void> = [
    (plugin) =>
      plugin.registerWidget('bad', {
        placement: 'header',
        load: noop
      } as unknown as BrowserWidgetDefinition),
    (plugin) =>
      plugin.registerSessionHeaderItem('bad', {
        inline: custom
      } as unknown as BrowserSessionHeaderItemDefinition),
    (plugin) =>
      plugin.registerSessionHeaderItem('bad', {
        inline: { ...custom, minWidthRem: 0 },
        overflow: action
      } as unknown as BrowserSessionHeaderItemDefinition),
    (plugin) =>
      plugin.registerSessionHeaderItem('bad', {
        inline: { ...custom, onSelect: () => undefined },
        overflow: action
      } as unknown as BrowserSessionHeaderItemDefinition),
    (plugin) =>
      plugin.registerSessionHeaderItem('bad', {
        inline: { ...action, load: noop },
        overflow: action
      } as unknown as BrowserSessionHeaderItemDefinition),
    (plugin) =>
      plugin.registerSessionHeaderItem('bad', {
        inline: { ...action, icon: undefined },
        overflow: action
      } as unknown as BrowserSessionHeaderItemDefinition),
    (plugin) => {
      // @ts-expect-error 新插槽只有专用注册入口。
      plugin.registerContribution('widget', 'bad', { load: noop })
    }
  ]
  for (const register of cases) {
    const { runtime } = await createFixture(register)
    context.after(() => runtime.dispose())
    assert.equal(runtime.getEntryState('slot-fixture').status, 'failed')
    assert.equal(runtime.getBrowserDescriptors().length, 0)
  }
})

test('Widget 同一 loader 多 Source 复用，各挂载独立释放', async (context) => {
  let loads = 0
  const mounted: string[] = []
  const disposed: string[] = []
  const signals: AbortSignal[] = []
  const { runtime } = await createFixture((plugin) => {
    plugin.registerWidget('progress', {
      load: async () => {
        loads += 1
        return {
          mount: ({ target, signal }) => {
            mounted.push(target.source.workId)
            signals.push(signal)
            return () => {
              disposed.push(target.source.workId)
            }
          }
        }
      }
    })
  })
  context.after(() => runtime.dispose())
  const [first, second] = await Promise.all([
    mountWidget(runtime),
    mountWidget(runtime, otherSource)
  ])
  assert.equal(loads, 1)
  assert.deepEqual(mounted, [source.workId, otherSource.workId])
  await first()
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  await first()
  assert.deepEqual(disposed, [source.workId])
  await second()
  assert.deepEqual(disposed, [source.workId, otherSource.workId])
})

test('Header 两种 custom 分别懒加载，折叠视图按真实 presentation 挂载', async (context) => {
  const loads = { inline: 0, overflow: 0 }
  const mounts: string[] = []
  let cleanups = 0
  const { runtime } = await createFixture((plugin) => {
    const load = (presentation: 'inline' | 'overflow') => async () => {
      loads[presentation] += 1
      return {
        mount: ({ target }: { target: { presentation: string } }) => {
          mounts.push(target.presentation)
          return () => {
            cleanups += 1
          }
        }
      }
    }
    plugin.registerSessionHeaderItem('header', {
      inline: { type: 'custom', minWidthRem: 6, load: load('inline') },
      overflow: { type: 'custom', load: load('overflow') }
    })
  })
  context.after(() => runtime.dispose())
  const first = await mountHeader(runtime, 'inline')
  assert.deepEqual(loads, { inline: 1, overflow: 0 })
  await first()
  const second = await mountHeader(runtime, 'overflow')
  await second()
  const third = await mountHeader(runtime, 'inline')
  await third()
  assert.deepEqual(loads, { inline: 1, overflow: 1 })
  assert.deepEqual(mounts, ['inline', 'overflow', 'inline'])
  assert.equal(cleanups, 3)
})

test('Header custom 单个表现加载失败可以独立重试', async (context) => {
  let attempts = 0
  const { runtime } = await createFixture((plugin) => {
    plugin.registerSessionHeaderItem('header', {
      inline: { type: 'custom', minWidthRem: 5, load: async () => ({ mount: () => undefined }) },
      overflow: {
        type: 'custom',
        load: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('折叠模块加载失败')
          return { mount: () => undefined }
        }
      }
    })
  })
  context.after(() => runtime.dispose())
  const dispose = await mountHeader(runtime, 'inline')
  await assert.rejects(mountHeader(runtime, 'overflow'), /折叠模块加载失败/)
  assert.equal(
    runtime.getContributionLoadState('slot-fixture', 'session-header-item', 'header', 'inline')
      .status,
    'ready'
  )
  assert.equal(
    runtime.getContributionLoadState('slot-fixture', 'session-header-item', 'header', 'overflow')
      .status,
    'failed'
  )
  await runtime.retryContribution('slot-fixture', 'session-header-item', 'header', 'overflow')
  const disposeOther = await mountHeader(runtime, 'overflow')
  await disposeOther()
  await dispose()
  assert.equal(attempts, 2)
})

test('迟到 Widget mount 在取消后仍释放且不会影响新挂载', async (context) => {
  let resolveMount!: (disposer: () => void) => void
  let entered = false
  let disposed = false
  const { runtime } = await createFixture((plugin) => {
    plugin.registerWidget('progress', {
      load: async () => ({
        mount: () => {
          entered = true
          return new Promise((finish) => {
            resolveMount = finish
          })
        }
      })
    })
  })
  context.after(() => runtime.dispose())
  const controller = new AbortController()
  const mounting = mountWidget(runtime, source, controller.signal)
  const rejected = assert.rejects(mounting, /关闭|失效|abort/i)
  await waitFor(() => entered)
  controller.abort()
  resolveMount(() => {
    disposed = true
  })
  await rejected
  await waitFor(() => disposed)
})

test('Header action 提供当前Source，拒绝旧Source和已取消的展示', async (context) => {
  const calls: PluginSource[] = []
  const { runtime } = await createFixture((plugin) => {
    const action = {
      type: 'action' as const,
      icon,
      label: '操作',
      onSelect: ({
        source: target,
        host,
        signal
      }: {
        source: PluginSource
        host: unknown
        signal: AbortSignal
      }) => {
        assert.ok(host)
        assert.equal(signal.aborted, false)
        calls.push(target)
      }
    }
    plugin.registerSessionHeaderItem('header', { inline: action, overflow: action })
  })
  context.after(() => runtime.dispose())
  const input = {
    pluginName: 'slot-fixture',
    contributionName: 'header',
    source,
    presentation: 'inline' as const,
    signal: new AbortController().signal
  }
  await runtime.invokeSessionHeaderAction(input)
  await runtime.invokeSessionHeaderAction({ ...input, presentation: 'overflow' })
  assert.deepEqual(calls, [source, source])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runtime.invokeSessionHeaderAction({ ...input, signal: controller.signal }))
  runtime.replaceWorkSessions([
    { ...source, branchId: 'v1:new', cwd: 'C:/fixture', status: 'idle' }
  ])
  await assert.rejects(runtime.invokeSessionHeaderAction(input), /来源|Source|source|失效/)
  assert.equal(calls.length, 2)
})

test('Owner 热重载释放新插槽的旧挂载并取消旧 action', async (context) => {
  let releases = 0
  let actionSignal!: AbortSignal
  let finishAction!: () => void
  const { runtime, reload } = await createFixture((plugin) => {
    plugin.registerWidget('progress', {
      load: async () => ({
        mount: () => () => {
          releases += 1
        }
      })
    })
    const action = {
      type: 'action' as const,
      icon,
      label: '操作',
      onSelect: ({ signal }: { signal: AbortSignal }) => {
        actionSignal = signal
        return new Promise<void>((finish) => {
          finishAction = finish
        })
      }
    }
    plugin.registerSessionHeaderItem('header', { inline: action, overflow: action })
  })
  context.after(() => runtime.dispose())
  await mountWidget(runtime)
  const executing = runtime.invokeSessionHeaderAction({
    pluginName: 'slot-fixture',
    contributionName: 'header',
    presentation: 'inline',
    source,
    signal: new AbortController().signal
  })
  const completed = executing.catch(() => undefined)
  await waitFor(() => actionSignal !== undefined)
  await reload()
  assert.equal(actionSignal.aborted, true)
  assert.equal(releases, 1)
  finishAction()
  await completed
  const dispose = await mountWidget(runtime)
  await dispose()
  assert.equal(releases, 2)
})
