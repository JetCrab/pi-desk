import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BrowserPluginError,
  type BrowserApplicationImplementation,
  type BrowserEntryFactory,
  type BrowserFilePreviewOptions,
  type BrowserPluginHost,
  type PiNativeBrowserChannel,
  type PiDeskBrowserChannel,
  type PluginPushMessage
} from '@jetcrab/pi-desk-sdk/browser'
import type { L3PluginBrowserEntryDescriptor } from '../src/common/l3_modules/plugin-host/l3-plugin-browser-contract'
import {
  createL4PluginHostRuntime,
  type L4PluginEntryImporter,
  type L4PluginHostRuntime,
  type L4PluginHostTransport,
  type L4PluginHostWorkSessionInput
} from '../src/client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import type { L4PluginLogEvent } from '../src/client/l4_foundation/plugin-host/l4-plugin-log-runtime'
import {
  replaceL4HostSettings,
  startL4Region
} from '../src/client/l4_foundation/locale/l4-region-store'
import {
  L4_LOCALE_STORAGE_KEY,
  L4_TIME_ZONE_STORAGE_KEY
} from '../src/common/l4_foundation/locale/l4-locale'

const mediaListeners = new Set<() => void>()
let darkTheme = false

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    localStorage: { getItem: () => null, setItem: () => undefined },
    matchMedia: () => ({
      matches: false,
      addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener)
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
})

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    documentElement: { classList: { contains: () => darkTheme } },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
})

const source = {
  workId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'session-1',
  branchId: 'v1:main'
}

function entry(
  pluginName = 'fixture-plugin',
  resource = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
): L3PluginBrowserEntryDescriptor {
  return {
    pluginName,
    url: `/api/plugins/browser-resources/${resource}/entry.js`
  }
}

interface FakeTransport extends L4PluginHostTransport {
  emitLog(pluginName: string, message: { path: string; event: L4PluginLogEvent }): void
  emitPush(message: PluginPushMessage): void
  setEntries(entries: readonly L3PluginBrowserEntryDescriptor[]): void
  readonly listCount: number
}

function createTransport(initialEntries: readonly L3PluginBrowserEntryDescriptor[]): FakeTransport {
  let entries = initialEntries
  let pushListener: ((message: PluginPushMessage) => void) | null = null
  const logListeners = new Map<
    string,
    ((message: { path: string; event: L4PluginLogEvent }) => void) | null
  >()
  let listCount = 0
  const pi: PiNativeBrowserChannel = {
    prompt: async () => ({ tempId: 'temp-1' }),
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
  }

  return {
    pi,
    get listCount() {
      return listCount
    },
    async listBrowserEntries() {
      listCount += 1
      return entries
    },
    subscribePush(listener) {
      pushListener = listener
      return () => {
        if (pushListener === listener) pushListener = null
      }
    },
    createPiDeskChannel(): PiDeskBrowserChannel {
      return { invokeGlobal: async () => ({}), invokeSession: async () => ({}) }
    },
    createLogChannel(pluginName) {
      return {
        watch: async () => ({ text: '', truncated: false }),
        unwatch: async () => undefined,
        subscribe(listener) {
          logListeners.set(pluginName, listener)
          return () => {
            if (logListeners.get(pluginName) === listener) logListeners.set(pluginName, null)
          }
        }
      }
    },
    emitLog(pluginName, message) {
      logListeners.get(pluginName)?.(message)
    },
    emitPush(message) {
      pushListener?.(message)
    },
    setEntries(next) {
      entries = next
    }
  }
}

function createImporter(
  factories: ReadonlyMap<string, BrowserEntryFactory>
): L4PluginEntryImporter {
  return async (url) => ({ default: factories.get(url) })
}

async function initialize(
  runtime: L4PluginHostRuntime,
  workSessions: readonly L4PluginHostWorkSessionInput[] = []
): Promise<void> {
  runtime.replaceWorkSessions(workSessions)
  await runtime.refreshEntries()
}

function pushMessage(value: string): PluginPushMessage {
  return {
    pluginName: 'fixture-plugin',
    target: { scope: 'global' },
    event: 'state',
    data: { value }
  }
}

function applicationTarget() {
  return { kind: 'application' as const, initialContext: null, close: () => undefined }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
  }
  throw new Error('等待宿主测试状态超时')
}

test('插件读取宿主当前语言和时区，旧 Host 失效后不能读取', async (context) => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const saved = new Map<string, string>([
    [L4_LOCALE_STORAGE_KEY, 'zh-CN'],
    [L4_TIME_ZONE_STORAGE_KEY, 'Pacific/Honolulu']
  ])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value)
    }
  })
  const stopRegion = startL4Region()
  replaceL4HostSettings({ region: { locale: 'zh-CN', timeZone: 'Pacific/Honolulu' } })
  const descriptor = entry()
  let host: BrowserPluginHost | undefined
  const runtime = createL4PluginHostRuntime(
    createTransport([descriptor]),
    createImporter(
      new Map<string, BrowserEntryFactory>([
        [
          descriptor.url,
          (plugin) => {
            host = plugin.host
          }
        ]
      ])
    )
  )
  context.after(async () => {
    await runtime.dispose()
    stopRegion()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  await initialize(runtime)
  assert.ok(host?.locale)
  assert.deepEqual(host.locale.getSnapshot(), { locale: 'zh-CN', timeZone: 'Pacific/Honolulu' })
  assert.deepEqual(host.settings.getSnapshot(), {
    region: { locale: 'zh-CN', timeZone: 'Pacific/Honolulu' }
  })
  let changes = 0
  host.settings.subscribe(() => {
    changes += 1
  })
  replaceL4HostSettings({ region: { locale: 'zh-CN', timeZone: 'Asia/Kathmandu' } })
  assert.equal(changes, 1)
  assert.deepEqual(host.locale.getSnapshot(), { locale: 'zh-CN', timeZone: 'Asia/Kathmandu' })
  assert.ok(Object.isFrozen(host.settings.getSnapshot().region))
  await runtime.dispose()
  replaceL4HostSettings({ region: { locale: 'en', timeZone: 'UTC' } })
  assert.equal(changes, 1)
  assert.throws(() => host?.settings.getSnapshot(), /Browser Entry 已失效/)
  assert.throws(() => host?.locale?.getSnapshot(), /Browser Entry 已失效/)
})

test('热替换不等待旧Entry清理，迟到清理不能影响新版注册', async (context) => {
  const oldEntry = entry()
  const newEntry = entry('fixture-plugin', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  const transport = createTransport([oldEntry])
  let releaseCleanup!: () => void
  const cleanup = new Promise<void>((resolveCleanup) => {
    releaseCleanup = resolveCleanup
  })
  const pushes: string[] = []
  const factories = new Map<string, BrowserEntryFactory>([
    [
      oldEntry.url,
      (plugin) => {
        plugin.onPush(() => pushes.push('old'))
        plugin.registerContribution('application', 'app', {
          label: 'Old',
          load: async () => ({ mount: () => undefined })
        })
        return () => cleanup
      }
    ],
    [
      newEntry.url,
      (plugin) => {
        plugin.onPush(() => pushes.push('new'))
        plugin.registerContribution('application', 'app', {
          label: 'New',
          load: async () => ({ mount: () => undefined })
        })
      }
    ]
  ])
  const runtime = createL4PluginHostRuntime(transport, createImporter(factories))
  context.after(async () => {
    releaseCleanup()
    await runtime.dispose()
  })
  await initialize(runtime)
  transport.setEntries([newEntry])
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      runtime.refreshEntries(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('旧插件清理阻塞了新版加载')), 1000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
  transport.emitPush(pushMessage('after-replace'))
  assert.deepEqual(pushes, ['new'])
  releaseCleanup()
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'ready')
  const application = runtime
    .getBrowserDescriptors()[0]
    ?.contributions.find((contribution) => contribution.kind === 'application')
  assert.equal(application?.label, 'New')
})

test('插件维护中的空清单不撤销当前View，结束后按最终清单替换', async (context) => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('message-view', 'card', {
      viewKey: 'fixture-plugin/card',
      priority: 100,
      load: async () => ({ mount: () => undefined })
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  context.after(() => runtime.dispose())
  await initialize(runtime)
  const current = runtime.getEntryState('fixture-plugin')

  runtime.setEntriesMaintaining(true)
  transport.setEntries([])
  await runtime.refreshEntries()
  assert.equal(runtime.isRefreshingEntries(), true)
  assert.equal(runtime.getEntryState('fixture-plugin'), current)
  assert.equal(runtime.getMessageViewResolution('fixture-plugin/card')?.status, 'winner')

  const settled = runtime.refreshEntries()
  runtime.setEntriesMaintaining(false)
  await settled
  assert.equal(runtime.isRefreshingEntries(), false)
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'unloaded')
  assert.equal(runtime.getMessageViewResolution('fixture-plugin/card'), null)
})

test('维护期间断线释放旧状态，重连后可刷新最终入口', async (context) => {
  const previous = entry()
  const next = entry('fixture-plugin', 'dddddddddddddddddddddddddddddddd')
  const transport = createTransport([previous])
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('message-view', 'card', {
      viewKey: 'fixture-plugin/card',
      priority: 100,
      load: async () => ({ mount: () => undefined })
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(
      new Map([
        [previous.url, factory],
        [next.url, factory]
      ])
    )
  )
  context.after(() => runtime.dispose())
  await initialize(runtime)
  runtime.setEntriesMaintaining(true)
  runtime.markDisconnected()
  assert.equal(runtime.isRefreshingEntries(), false)

  transport.setEntries([next])
  runtime.markReady()
  await runtime.refreshEntries()
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'ready')
  assert.equal(runtime.getMessageViewResolution('fixture-plugin/card')?.status, 'winner')
})

test('热替换等待新Entry期间缺失View仍为加载态，稳定插件保留原Winner', async (context) => {
  const oldEntry = entry()
  const newEntry = entry('fixture-plugin', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  const stableEntry = entry('stable-plugin', 'cccccccccccccccccccccccccccccccc')
  const transport = createTransport([oldEntry, stableEntry])
  let releaseNew!: () => void
  const newEntryReady = new Promise<void>((resolveReady) => {
    releaseNew = resolveReady
  })
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('message-view', 'card', {
      viewKey: 'fixture-plugin/card',
      priority: 100,
      load: async () => ({ mount: () => undefined })
    })
  }
  const stableFactory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('message-view', 'card', {
      viewKey: 'stable-plugin/card',
      priority: 100,
      load: async () => ({ mount: () => undefined })
    })
  }
  const runtime = createL4PluginHostRuntime(transport, async (url) => {
    if (url === newEntry.url) await newEntryReady
    return { default: url === stableEntry.url ? stableFactory : factory }
  })
  context.after(async () => {
    releaseNew()
    await runtime.dispose()
  })
  await initialize(runtime)
  const stable = runtime.getEntryState('stable-plugin')
  const transitions: boolean[] = []
  const unsubscribe = runtime.subscribeRegistry(() => {
    transitions.push(runtime.isRefreshingEntries())
  })
  context.after(unsubscribe)

  transport.setEntries([newEntry, stableEntry])
  const replacing = runtime.refreshEntries()
  await waitFor(() => runtime.getEntryState('fixture-plugin').status === 'loading')
  assert.equal(runtime.isRefreshingEntries(), true)
  assert.equal(runtime.getMessageViewResolution('fixture-plugin/card'), null)
  assert.equal(runtime.getEntryState('stable-plugin'), stable)
  assert.equal(runtime.getMessageViewResolution('stable-plugin/card')?.status, 'winner')
  assert.deepEqual(runtime.getFailedEntries(), [])

  releaseNew()
  await replacing
  assert.equal(runtime.isRefreshingEntries(), false)
  assert.equal(runtime.getMessageViewResolution('fixture-plugin/card')?.status, 'winner')
  assert.equal(transitions[0], true)
  assert.equal(transitions.at(-1), false)
})

test('旧Browser Method迟到结果不能越过Entry失效边界', async (context) => {
  const oldEntry = entry()
  const newEntry = entry('fixture-plugin', 'cccccccccccccccccccccccccccccccc')
  const transport = createTransport([oldEntry])
  let complete!: (value: Record<string, string>) => void
  const response = new Promise<Record<string, string>>((resolveResponse) => {
    complete = resolveResponse
  })
  transport.createPiDeskChannel = () => ({
    invokeGlobal: () => response,
    invokeSession: () => response
  })
  let oldHost: BrowserPluginHost | undefined
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(
      new Map<string, BrowserEntryFactory>([
        [
          oldEntry.url,
          (plugin) => {
            oldHost = plugin.host
          }
        ],
        [newEntry.url, () => undefined]
      ])
    )
  )
  context.after(() => runtime.dispose())
  await initialize(runtime)
  assert.ok(oldHost)
  const pending = oldHost.piDesk.invokeGlobal('get', {})
  const rejected = assert.rejects(pending)
  transport.setEntries([newEntry])
  await runtime.refreshEntries()
  complete({ value: 'old' })
  await rejected
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'ready')
})

test('页面 ready 后创建轻量 Entry，未挂载视图也能处理 Push 和通知', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  const pushes: string[] = []
  const notifications: string[] = []
  let entryDisposeCount = 0
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.onPush((message) => {
      pushes.push(String(message.data.value))
      plugin.notify({ level: 'success', title: '收到状态' })
    })
    plugin.registerContribution('application', 'fixture-app', {
      label: 'Fixture App',
      load: async () => ({ mount: () => undefined })
    })
    return () => {
      entryDisposeCount += 1
    }
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]])),
    (_pluginName, input) => notifications.push(input.title)
  )

  await initialize(runtime)
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'ready')
  assert.deepEqual(runtime.getBrowserDescriptors()[0]?.contributions, [
    {
      kind: 'application',
      contributionName: 'fixture-app',
      label: 'Fixture App',
      title: 'Fixture App',
      chrome: 'host'
    }
  ])

  transport.emitPush(pushMessage('ready'))
  assert.deepEqual(pushes, ['ready'])
  assert.deepEqual(notifications, ['收到状态'])
  await runtime.dispose()
  assert.equal(entryDisposeCount, 1)
})

test('Browser Entry 读取自己的全局状态并处理通知 Event', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  const stateSnapshots: unknown[] = []
  const notificationEvents: unknown[] = []
  const factory: BrowserEntryFactory = (plugin) => {
    const readState = () => stateSnapshots.push(plugin.host.globalState.getSnapshot())
    readState()
    const unsubscribeState = plugin.host.globalState.subscribe(readState)
    const unsubscribeNotification = plugin.notifications.onEvent('open-result', (event) => {
      notificationEvents.push(event)
    })
    return () => {
      unsubscribeNotification()
      unsubscribeState()
    }
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  runtime.replaceGlobalPluginStates({
    'fixture-plugin': { status: 'ready' },
    'other-plugin': { secret: true }
  })
  await initialize(runtime)

  assert.deepEqual(stateSnapshots, [{ status: 'ready' }])
  runtime.replaceGlobalPluginStates({
    'fixture-plugin': { status: 'running' },
    'other-plugin': { secret: false }
  })
  assert.deepEqual(stateSnapshots, [{ status: 'ready' }, { status: 'running' }])

  await runtime.dispatchNotificationEvent('11111111-1111-4111-8111-111111111111', {
    type: 'plugin',
    pluginName: 'fixture-plugin',
    name: 'open-result',
    data: { runId: 'run-1' }
  })
  assert.deepEqual(notificationEvents, [
    {
      notificationId: '11111111-1111-4111-8111-111111111111',
      data: { runId: 'run-1' }
    }
  ])
  await assert.rejects(
    runtime.dispatchNotificationEvent('22222222-2222-4222-8222-222222222222', {
      type: 'plugin',
      pluginName: 'fixture-plugin',
      name: 'missing-event',
      data: {}
    }),
    /未注册通知事件/
  )
  await runtime.dispose()
})

test('Contribution load 只在首次使用执行，并发 mount 复用同一 Promise', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let loadCount = 0
  let mountCount = 0
  let resolveLoad!: (implementation: BrowserApplicationImplementation) => void
  const pending = new Promise<BrowserApplicationImplementation>((resolve) => {
    resolveLoad = resolve
  })
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('application', 'fixture-app', {
      label: 'Fixture App',
      load: () => {
        loadCount += 1
        return pending
      }
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  await initialize(runtime)
  assert.equal(loadCount, 0)

  const first = runtime.mountContribution({
    pluginName: 'fixture-plugin',
    kind: 'application',
    contributionName: 'fixture-app',
    container: {} as HTMLElement,
    target: applicationTarget()
  })
  const second = runtime.mountContribution({
    pluginName: 'fixture-plugin',
    kind: 'application',
    contributionName: 'fixture-app',
    container: {} as HTMLElement,
    target: applicationTarget()
  })
  await waitFor(() => loadCount === 1)
  resolveLoad({ mount: () => void (mountCount += 1) })
  const [disposeFirst, disposeSecond] = await Promise.all([first, second])
  assert.equal(mountCount, 2)
  await disposeFirst()
  await disposeSecond()
  await runtime.dispose()
})

test('Application resolve 使用 Browser Host，并在 WorkSession 变化后重新计算', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('application', 'conditional', {
      label: 'Conditional',
      resolve: ({ workSessions }) => workSessions.length > 0,
      load: async () => ({ mount: () => undefined })
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  await initialize(runtime)
  assert.deepEqual(runtime.getBrowserDescriptors()[0]?.contributions, [])
  assert.equal(runtime.getRegisteredBrowserDescriptors()[0]?.contributions[0]?.kind, 'application')

  runtime.replaceWorkSessions([
    {
      ...source,
      cwd: 'C:/project',
      status: 'idle'
    }
  ])
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
  assert.equal(runtime.getBrowserDescriptors()[0]?.contributions[0]?.kind, 'application')
  await runtime.dispose()
})

test('全局插件状态控制 Application 可见性，且无关插件状态不触发重算', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let resolveCount = 0
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('application', 'stateful', {
      label: 'Stateful',
      resolve: ({ host }) => {
        resolveCount += 1
        return host.globalState.getSnapshot()?.enabled === true
      },
      load: async () => ({ mount: () => undefined })
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )

  await initialize(runtime)
  assert.deepEqual(runtime.getBrowserDescriptors()[0]?.contributions, [])
  assert.equal(resolveCount, 1)

  runtime.replaceGlobalPluginStates({ 'other-plugin': { enabled: true } })
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
  assert.equal(resolveCount, 1)

  runtime.replaceGlobalPluginStates({
    'fixture-plugin': { enabled: true },
    'other-plugin': { enabled: true }
  })
  await waitFor(() => runtime.getBrowserDescriptors()[0]?.contributions.length === 1)
  assert.equal(runtime.getBrowserDescriptors()[0]?.contributions[0]?.contributionName, 'stateful')

  runtime.replaceGlobalPluginStates({ 'other-plugin': { enabled: true } })
  await waitFor(() => runtime.getBrowserDescriptors()[0]?.contributions.length === 0)
  assert.equal(resolveCount, 3)
  await runtime.dispose()
})

test('Lazy Contribution 失败只影响自身，并可显式重试', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let attempts = 0
  let mountCount = 0
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('application', 'broken', {
      label: 'Broken',
      load: async () => {
        attempts += 1
        if (attempts === 1) {
          throw new BrowserPluginError({
            pluginName: 'fixture-plugin',
            contributionName: 'broken',
            phase: 'contribution-load',
            message: 'chunk unavailable'
          })
        }
        return { mount: () => void (mountCount += 1) }
      }
    })
    plugin.registerContribution('settings-page', 'healthy', {
      label: 'Healthy',
      load: async () => ({ mount: () => undefined })
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  await initialize(runtime)

  await assert.rejects(
    runtime.mountContribution({
      pluginName: 'fixture-plugin',
      kind: 'application',
      contributionName: 'broken',
      container: {} as HTMLElement,
      target: applicationTarget()
    }),
    (error: unknown) =>
      error instanceof BrowserPluginError &&
      error.phase === 'contribution-load' &&
      error.message === 'chunk unavailable'
  )
  assert.equal(
    runtime.getContributionLoadState('fixture-plugin', 'application', 'broken').status,
    'failed'
  )
  assert.equal(
    runtime.getContributionLoadState('fixture-plugin', 'settings-page', 'healthy').status,
    'unloaded'
  )
  await runtime.retryContribution('fixture-plugin', 'application', 'broken')
  assert.equal(attempts, 2)
  const dispose = await runtime.mountContribution({
    pluginName: 'fixture-plugin',
    kind: 'application',
    contributionName: 'broken',
    container: {} as HTMLElement,
    target: applicationTarget()
  })
  assert.equal(mountCount, 1)
  await dispose()
  await runtime.dispose()
})

test('Message View winner 在 Entry 注册完成后确定，最高优先级冲突保持错误', async () => {
  const first = entry('fixture-plugin', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const second = entry('other-plugin', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  const transport = createTransport([first, second])
  const viewFactory =
    (name: string): BrowserEntryFactory =>
    (plugin) => {
      plugin.registerContribution('message-view', name, {
        viewKey: 'fixture/message',
        priority: 100,
        load: async () => ({ mount: () => undefined })
      })
    }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(
      new Map([
        [first.url, viewFactory('first')],
        [second.url, viewFactory('second')]
      ])
    )
  )
  await initialize(runtime)
  const resolution = runtime.getMessageViewResolution('fixture/message')
  assert.equal(resolution?.status, 'conflict')
  await runtime.dispose()
})

test('Entry URL 变化时先释放旧 mounts 和 Entry，再加载新版本', async () => {
  const first = entry('fixture-plugin', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const second = entry('fixture-plugin', 'cccccccccccccccccccccccccccccccc')
  const transport = createTransport([first])
  const order: string[] = []
  const makeFactory =
    (version: string): BrowserEntryFactory =>
    (plugin) => {
      plugin.registerContribution('application', 'fixture-app', {
        label: version,
        load: async () => ({
          mount: () => () => {
            order.push(`mount:${version}`)
          }
        })
      })
      return () => {
        order.push(`entry:${version}`)
      }
    }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(
      new Map([
        [first.url, makeFactory('v1')],
        [second.url, makeFactory('v2')]
      ])
    )
  )
  await initialize(runtime)
  await runtime.mountContribution({
    pluginName: 'fixture-plugin',
    kind: 'application',
    contributionName: 'fixture-app',
    container: {} as HTMLElement,
    target: applicationTarget()
  })

  transport.setEntries([second])
  await runtime.refreshEntries()
  assert.deepEqual(order, ['mount:v1', 'entry:v1'])
  const contribution = runtime.getBrowserDescriptors()[0]?.contributions[0]
  assert.equal(contribution?.kind, 'application')
  assert.equal(contribution?.kind === 'application' ? contribution.label : null, 'v2')
  await runtime.dispose()
})

test('Entry Factory 必须同步完成注册', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  const factory = (() => Promise.resolve()) as unknown as BrowserEntryFactory
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  await initialize(runtime)
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'failed')
  assert.equal(runtime.getBrowserDescriptors().length, 0)
  await runtime.dispose()
})

test('插件终端能力不依赖WorkSession，同目录每次调用且解绑后拒绝', async (context) => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let host: BrowserPluginHost | null = null
  const factory: BrowserEntryFactory = (plugin) => {
    host = plugin.host
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  context.after(() => runtime.dispose())
  const calls: string[] = []
  const unbind = runtime.bindTerminalOpen(async (cwd, signal) => {
    signal.throwIfAborted()
    calls.push(cwd)
  })
  await initialize(runtime)
  assert.ok(host!.terminals)
  await host!.terminals!.open({ cwd: 'C:/independent-workspace' })
  await host!.terminals!.open({ cwd: 'C:/independent-workspace' })
  assert.deepEqual(calls, ['C:/independent-workspace', 'C:/independent-workspace'])
  await assert.rejects(host!.terminals!.open({ cwd: ' ' }), /cwd/)
  unbind()
  await assert.rejects(host!.terminals!.open({ cwd: 'C:/other' }), /尚未准备好/)
})

test('插件失效取消终端迟到展示意图，不能从旧Host再次新建', async (context) => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let host: BrowserPluginHost | null = null
  const factory: BrowserEntryFactory = (plugin) => {
    host = plugin.host
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  context.after(() => runtime.dispose())
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let observed: AbortSignal | undefined
  let displayed = false
  runtime.bindTerminalOpen(async (_cwd, signal) => {
    observed = signal
    await pending
    if (!signal.aborted) displayed = true
  })
  await initialize(runtime)
  const operation = host!.terminals!.open({ cwd: 'C:/workspace' })
  const rejected = assert.rejects(operation, /Browser Entry 已失效/)
  await waitFor(() => observed !== undefined)
  transport.setEntries([])
  await runtime.refreshEntries()
  assert.equal(observed?.aborted, true)
  release()
  await rejected
  assert.equal(displayed, false)
  await assert.rejects(host!.terminals!.open({ cwd: 'C:/workspace' }), /Browser Entry 已失效/)
})

test('Browser Host 复用WorkSession、Source文件并提供projects.preview能力', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let host: BrowserPluginHost | null = null
  const factory: BrowserEntryFactory = (plugin) => {
    host = plugin.host
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  runtime.bindWorkSessionCreate(async (cwd) => ({
    ...source,
    cwd,
    status: 'idle'
  }))
  const goToInputs: unknown[] = []
  runtime.bindWorkSessionGoTo(async (input) => {
    goToInputs.push(input)
    return { ...source, cwd: 'C:/current-project', status: 'idle' }
  })
  const previews: unknown[] = []
  const reveals: unknown[] = []
  const projectPreviews: string[] = []
  runtime.bindProjectPreview((directory) => projectPreviews.push(directory))
  runtime.bindWorkSessionFilePreview((input) => previews.push(input))
  runtime.bindWorkSessionFileReveal(async (input) => {
    reveals.push(input)
  })
  await initialize(runtime, [{ ...source, cwd: 'C:/current-project', status: 'idle' }])
  assert.deepEqual(await host!.workSessions.create({ cwd: 'C:/new-project' }), {
    source,
    cwd: 'C:/new-project',
    status: 'idle'
  })
  assert.deepEqual(await host!.workSessions.goTo({ sessionId: source.sessionId }), {
    source,
    cwd: 'C:/current-project',
    status: 'idle'
  })
  assert.deepEqual(goToInputs, [{ sessionId: source.sessionId }])
  host!.projects.preview('C:/preview-project')
  host!.projects.preview('C:/preview-project')
  host!.projects.preview('C:/other-project')
  assert.deepEqual(projectPreviews, [
    'C:/preview-project',
    'C:/preview-project',
    'C:/other-project'
  ])
  host!.workSessionFiles.preview(source, 'artifact.txt')
  host!.workSessionFiles.preview(source, 'artifact.txt', { mode: 'expanded' })
  host!.workSessionFiles.preview(source, 'artifact.txt', { mode: 'standalone' })
  host!.workSessionFiles.preview(source, 'second.png', {
    mode: 'standalone',
    imagePaths: ['first.png', 'second.png', 'third.png']
  })
  assert.deepEqual(previews, [
    {
      source,
      cwd: 'C:/current-project',
      path: 'artifact.txt',
      mode: 'session'
    },
    {
      source,
      cwd: 'C:/current-project',
      path: 'artifact.txt',
      mode: 'expanded'
    },
    {
      source,
      cwd: 'C:/current-project',
      path: 'artifact.txt',
      mode: 'standalone'
    },
    {
      source,
      cwd: 'C:/current-project',
      path: 'second.png',
      mode: 'standalone',
      imagePaths: ['first.png', 'second.png', 'third.png']
    }
  ])
  assert.throws(
    () =>
      host!.workSessionFiles.preview(source, 'artifact.txt', {
        mode: 'invalid'
      } as unknown as BrowserFilePreviewOptions),
    /文件预览模式无效/
  )
  assert.throws(
    () =>
      host!.workSessionFiles.preview(
        source,
        'artifact.txt',
        null as unknown as BrowserFilePreviewOptions
      ),
    /文件预览选项无效/
  )
  assert.throws(
    () => host!.workSessionFiles.preview({ ...source, branchId: 'v1:fork' }, 'artifact.txt'),
    /来源已变化/
  )
  await host!.workSessionFiles.reveal(source, 'artifact.txt')
  assert.deepEqual(reveals, [
    {
      source,
      cwd: 'C:/current-project',
      path: 'artifact.txt'
    }
  ])
  await assert.rejects(
    host!.workSessionFiles.reveal({ ...source, branchId: 'v1:fork' }, 'artifact.txt'),
    /来源已变化/
  )
  await runtime.dispose()
  assert.throws(() => host!.projects.preview('C:/after-dispose'), /Browser Entry 已失效/)
})

test('文件图片读取绑定Source和相对路径，取消与Entry失效释放请求', async (context) => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let host!: BrowserPluginHost
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(
      new Map([
        [
          descriptor.url,
          (plugin) => {
            host = plugin.host
          }
        ]
      ])
    )
  )
  context.after(() => runtime.dispose())
  await initialize(runtime, [{ ...source, cwd: 'C:/image-project', status: 'idle' }])
  const image = new Blob(['image-bytes'], { type: 'image/png' })
  let calls = 0
  const unbind = runtime.bindImageReader(async (input, signal) => {
    calls += 1
    signal.throwIfAborted()
    assert.equal(input.cwd, 'C:/image-project')
    assert.deepEqual(input.source, source)
    if (input.path === 'missing.png') return null
    if (input.path === 'failed.png') throw new Error('图片读取失败')
    return image
  })
  assert.equal(await host.workSessionFiles.readImage(source, 'result.png'), image)
  assert.equal(await host.workSessionFiles.readImage(source, 'missing.png'), null)
  await assert.rejects(host.workSessionFiles.readImage(source, 'failed.png'), /图片读取失败/)
  for (const path of ['../outside.png', 'C:/outside.png', '/outside.png', 'dir\\image.png']) {
    await assert.rejects(host.workSessionFiles.readImage(source, path), /规范相对路径/)
  }
  await assert.rejects(
    host.workSessionFiles.readImage({ ...source, branchId: 'other' }, 'result.png'),
    /工作会话来源已变化/
  )
  assert.equal(calls, 3)
  unbind()
  let resolveImage!: (image: Blob) => void
  const unbindPending = runtime.bindImageReader(
    () =>
      new Promise((resolve) => {
        resolveImage = resolve
      })
  )
  const pending = host.workSessionFiles.readImage(source, 'result.png')
  runtime.replaceWorkSessions([
    { ...source, branchId: 'changed', cwd: 'C:/image-project', status: 'idle' }
  ])
  resolveImage(image)
  await assert.rejects(pending, /工作会话来源已变化/)
  unbindPending()
  runtime.replaceWorkSessions([{ ...source, cwd: 'C:/image-project', status: 'idle' }])
  let observedSignal: AbortSignal | undefined
  runtime.bindImageReader(
    (_input, signal) =>
      new Promise((_resolve, reject) => {
        observedSignal = signal
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
  const controller = new AbortController()
  const cancelled = host.workSessionFiles.readImage(source, 'result.png', controller.signal)
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.equal(observedSignal?.aborted, true)
  const disposed = host.workSessionFiles.readImage(source, 'result.png')
  const disposedOutcome = assert.rejects(disposed, { name: 'AbortError' })
  await runtime.dispose()
  await disposedOutcome
  assert.equal(observedSignal?.aborted, true)
  await assert.rejects(
    host.workSessionFiles.readImage(source, 'result.png'),
    /Browser Entry 已失效/
  )
})

test('Host 各类订阅、Push 和日志回调异常不阻断健康监听器', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  const healthy = {
    workSessions: 0,
    connection: 0,
    theme: 0,
    globalState: 0,
    push: 0,
    log: 0
  }
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.host.workSessions.subscribe(() => {
      throw new Error('work sync')
    })
    plugin.host.workSessions.subscribe(async () => {
      throw new Error('work async')
    })
    plugin.host.workSessions.subscribe(() => {
      healthy.workSessions += 1
    })
    plugin.host.connection.subscribe(() => {
      throw new Error('connection sync')
    })
    plugin.host.connection.subscribe(async () => {
      throw new Error('connection async')
    })
    plugin.host.connection.subscribe(() => {
      healthy.connection += 1
    })
    plugin.host.theme.subscribe(() => {
      throw new Error('theme sync')
    })
    plugin.host.theme.subscribe(async () => {
      throw new Error('theme async')
    })
    plugin.host.theme.subscribe(() => {
      healthy.theme += 1
    })
    plugin.host.globalState.subscribe(() => {
      throw new Error('global sync')
    })
    plugin.host.globalState.subscribe(async () => {
      throw new Error('global async')
    })
    plugin.host.globalState.subscribe(() => {
      healthy.globalState += 1
    })
    plugin.onPush(() => {
      throw new Error('push sync')
    })
    plugin.onPush(async () => {
      throw new Error('push async')
    })
    plugin.onPush(() => {
      healthy.push += 1
    })
    const logHandle = plugin.host.logs.open('C:\\temp\\callback-errors.log')
    logHandle.subscribe(() => {
      throw new Error('log sync')
    })
    logHandle.subscribe(async () => {
      throw new Error('log async')
    })
    logHandle.subscribe(() => {
      healthy.log += 1
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )

  await initialize(runtime)
  runtime.replaceWorkSessions([{ ...source, cwd: 'C:/project', status: 'idle' }])
  runtime.markConnecting()
  runtime.replaceGlobalPluginStates({ 'fixture-plugin': { status: 'ready' } })
  darkTheme = true
  for (const listener of [...mediaListeners]) listener()
  darkTheme = false
  transport.emitPush(pushMessage('callback-errors'))
  transport.emitLog('fixture-plugin', {
    path: 'C:\\temp\\callback-errors.log',
    event: { type: 'text_append', text: '日志事件\\n' }
  })
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate))

  assert.equal(healthy.workSessions, 1)
  assert.equal(healthy.connection, 1)
  assert.equal(healthy.theme, 1)
  assert.equal(healthy.globalState, 1)
  assert.equal(healthy.push, 1)
  assert.equal(healthy.log, 1)
  await runtime.dispose()
})

test('失败 Entry Factory 不残留宿主订阅', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let callbacks = 0
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.host.workSessions.subscribe(() => {
      callbacks += 1
    })
    plugin.host.connection.subscribe(() => {
      callbacks += 1
    })
    plugin.host.theme.subscribe(() => {
      callbacks += 1
    })
    plugin.host.globalState.subscribe(() => {
      callbacks += 1
    })
    throw new Error('factory failed')
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )

  await initialize(runtime)
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'failed')
  runtime.replaceWorkSessions([{ ...source, cwd: 'C:/project', status: 'idle' }])
  runtime.markReady()
  runtime.replaceGlobalPluginStates({ 'fixture-plugin': { status: 'failed' } })
  darkTheme = true
  for (const listener of [...mediaListeners]) listener()
  darkTheme = false
  assert.equal(callbacks, 0)
  await runtime.dispose()
})

test('清理抛错或挂起不阻断兄弟替换和 Host dispose', async () => {
  const first = entry('fixture-plugin', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const second = entry('fixture-plugin', 'cccccccccccccccccccccccccccccccc')
  const sibling = entry('sibling-plugin', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  let resolveNever!: () => void
  const never = new Promise<void>((resolve) => {
    resolveNever = resolve
  })
  const factories = new Map<string, BrowserEntryFactory>([
    [
      first.url,
      () => async () => {
        await never
      }
    ],
    [second.url, () => undefined],
    [sibling.url, () => undefined]
  ])
  const transport = createTransport([first])
  const runtime = createL4PluginHostRuntime(transport, createImporter(factories))

  await initialize(runtime)
  transport.setEntries([second, sibling])
  await runtime.refreshEntries()
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'ready')
  assert.equal(runtime.getEntryState('sibling-plugin').status, 'ready')
  resolveNever()
  await runtime.dispose()
})

test('mount观察到abort后完成清理，迟到disposer只执行一次', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let mountStarted = false
  let abortObserved = false
  let disposerCount = 0
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('application', 'abort-aware', {
      label: 'Abort Aware',
      load: async () => ({
        mount: ({ signal }) => {
          mountStarted = true
          return new Promise<() => void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                abortObserved = signal.aborted
                resolve(() => {
                  disposerCount += 1
                })
              },
              { once: true }
            )
          })
        }
      })
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  await initialize(runtime)
  const controller = new AbortController()
  const mounting = runtime.mountContribution({
    pluginName: 'fixture-plugin',
    kind: 'application',
    contributionName: 'abort-aware',
    container: {} as HTMLElement,
    target: applicationTarget(),
    signal: controller.signal
  })
  const outcome = mounting.then(
    () => null,
    (error: unknown) => error
  )
  await waitFor(() => mountStarted)

  controller.abort()
  const error = await outcome
  assert.ok(error instanceof BrowserPluginError)
  assert.equal(error.phase, 'mount')
  assert.equal(abortObserved, true)
  assert.equal(disposerCount, 1)
  await runtime.dispose()
  assert.equal(disposerCount, 1)
})

test('load期间取消后不再调用迟到实现的mount', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let loadStarted = false
  let mountCount = 0
  let resolveLoad!: (implementation: BrowserApplicationImplementation) => void
  const pendingLoad = new Promise<BrowserApplicationImplementation>((resolve) => {
    resolveLoad = resolve
  })
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('application', 'pending-load', {
      label: 'Pending Load',
      load: () => {
        loadStarted = true
        return pendingLoad
      }
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  await initialize(runtime)
  const controller = new AbortController()
  const mounting = runtime.mountContribution({
    pluginName: 'fixture-plugin',
    kind: 'application',
    contributionName: 'pending-load',
    container: {} as HTMLElement,
    target: applicationTarget(),
    signal: controller.signal
  })
  const outcome = mounting.then(
    () => null,
    (error: unknown) => error
  )
  await waitFor(() => loadStarted)

  controller.abort()
  resolveLoad({ mount: () => void (mountCount += 1) })
  const error = await outcome
  assert.ok(error instanceof BrowserPluginError)
  assert.equal(error.phase, 'mount')
  assert.equal(mountCount, 0)
  await runtime.dispose()
})

test('Owner替换后迟到的旧mount清理不会删除新注册', async () => {
  const first = entry('fixture-plugin', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const second = entry('fixture-plugin', 'cccccccccccccccccccccccccccccccc')
  const transport = createTransport([first])
  let oldMountStarted = false
  let resolveOldMount!: (disposer: () => void) => void
  const pendingOldMount = new Promise<() => void>((resolve) => {
    resolveOldMount = resolve
  })
  let oldDisposerCount = 0
  const makeFactory =
    (version: 'old' | 'new'): BrowserEntryFactory =>
    (plugin) => {
      plugin.registerContribution('application', 'replaceable', {
        label: version,
        load: async () => ({
          mount: () => {
            if (version === 'old') {
              oldMountStarted = true
              return pendingOldMount
            }
            return undefined
          }
        })
      })
    }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(
      new Map([
        [first.url, makeFactory('old')],
        [second.url, makeFactory('new')]
      ])
    )
  )
  await initialize(runtime)
  const oldMountOutcome = runtime
    .mountContribution({
      pluginName: 'fixture-plugin',
      kind: 'application',
      contributionName: 'replaceable',
      container: {} as HTMLElement,
      target: applicationTarget()
    })
    .then(
      () => null,
      (error: unknown) => error
    )
  await waitFor(() => oldMountStarted)

  transport.setEntries([second])
  await runtime.refreshEntries()
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'ready')
  {
    const descriptor = runtime.getBrowserDescriptors()[0]?.contributions[0]
    assert.ok(descriptor?.kind === 'application')
    assert.equal(descriptor.label, 'new')
  }
  const disposeNew = await runtime.mountContribution({
    pluginName: 'fixture-plugin',
    kind: 'application',
    contributionName: 'replaceable',
    container: {} as HTMLElement,
    target: applicationTarget()
  })

  resolveOldMount(() => {
    oldDisposerCount += 1
  })
  const oldError = await oldMountOutcome
  assert.ok(oldError instanceof BrowserPluginError)
  await waitFor(() => oldDisposerCount === 1)
  assert.equal(runtime.getEntryState('fixture-plugin').status, 'ready')
  {
    const descriptor = runtime.getBrowserDescriptors()[0]?.contributions[0]
    assert.ok(descriptor?.kind === 'application')
    assert.equal(descriptor.label, 'new')
  }
  await disposeNew()
  await runtime.dispose()
})

test('两个挂起 mount 清理并发超时，先 abort 且迟到 disposer 各执行一次', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  const signals: AbortSignal[] = []
  let mountStarted = 0
  let resolveMount!: (disposer: () => void) => void
  const pendingMount = new Promise<() => void>((resolve) => {
    resolveMount = resolve
  })
  let disposerCount = 0
  const factory: BrowserEntryFactory = (plugin) => {
    plugin.registerContribution('application', 'pending-mount', {
      label: 'Pending Mount',
      load: async () => ({
        mount: async ({ signal }) => {
          mountStarted += 1
          signals.push(signal)
          return pendingMount
        }
      })
    })
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  await initialize(runtime)
  const mounts = [1, 2].map(() =>
    runtime.mountContribution({
      pluginName: 'fixture-plugin',
      kind: 'application',
      contributionName: 'pending-mount',
      container: {} as HTMLElement,
      target: applicationTarget()
    })
  )
  const settledMounts = Promise.allSettled(mounts)
  await waitFor(() => mountStarted === 2)

  const startedAt = Date.now()
  const disposing = runtime.dispose()
  assert.equal(
    signals.every((signal) => signal.aborted),
    true
  )
  await disposing
  assert.ok(Date.now() - startedAt < 2_500)

  resolveMount(() => {
    disposerCount += 1
  })
  const results = await settledMounts
  assert.equal(
    results.every((result) => result.status === 'rejected'),
    true
  )
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
  assert.equal(disposerCount, 2)
})

test('挂起 Entry import 期间 dispose 及时返回，迟到 factory 不执行', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let importStarted = false
  let resolveImport!: (namespace: { default: BrowserEntryFactory }) => void
  const pendingImport = new Promise<{ default: BrowserEntryFactory }>((resolve) => {
    resolveImport = resolve
  })
  let factoryCalled = false
  const importer: L4PluginEntryImporter = async () => {
    importStarted = true
    return pendingImport
  }
  const factory: BrowserEntryFactory = () => {
    factoryCalled = true
  }
  const runtime = createL4PluginHostRuntime(transport, importer)
  const refreshing = runtime.refreshEntries()
  await waitFor(() => importStarted)

  const startedAt = Date.now()
  const disposing = runtime.dispose()
  await disposing
  assert.ok(Date.now() - startedAt < 500)
  resolveImport({ default: factory })
  await refreshing
  assert.equal(factoryCalled, false)
})

test('非法 async factory 的迟到 disposer 被清理且没有 unhandledRejection', async () => {
  const descriptor = entry()
  const transport = createTransport([descriptor])
  let resolveFactory!: (disposer: () => void) => void
  const pendingFactory = new Promise<() => void>((resolve) => {
    resolveFactory = resolve
  })
  let disposerCount = 0
  const factory = (() => pendingFactory) as unknown as BrowserEntryFactory
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(new Map([[descriptor.url, factory]]))
  )
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await initialize(runtime)
    assert.equal(runtime.getEntryState('fixture-plugin').status, 'failed')
    resolveFactory(() => {
      disposerCount += 1
    })
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    assert.equal(disposerCount, 1)
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await runtime.dispose()
  }
})

test('同插件重载后日志 Host 可重新订阅，旧 Owner 不清理新 Host', async () => {
  const first = entry('fixture-plugin', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  const second = entry('fixture-plugin', 'cccccccccccccccccccccccccccccccc')
  const transport = createTransport([first])
  const handles: Array<ReturnType<BrowserPluginHost['logs']['open']>> = []
  const makeFactory = (): BrowserEntryFactory => (plugin) => {
    const handle = plugin.host.logs.open('C:\\temp\\reload.log')
    handles.push(handle)
  }
  const runtime = createL4PluginHostRuntime(
    transport,
    createImporter(
      new Map([
        [first.url, makeFactory()],
        [second.url, makeFactory()]
      ])
    )
  )

  await initialize(runtime)
  runtime.markReady()
  await waitFor(() => handles[0]?.getSnapshot().loading === false)
  transport.emitLog('fixture-plugin', {
    path: 'C:\\temp\\reload.log',
    event: { type: 'text_append', text: 'v1\\n' }
  })
  assert.equal(handles[0]?.getSnapshot().text, 'v1\\n')

  transport.setEntries([second])
  await runtime.refreshEntries()
  await waitFor(() => handles.length === 2 && handles[1]?.getSnapshot().loading === false)
  transport.emitLog('fixture-plugin', {
    path: 'C:\\temp\\reload.log',
    event: { type: 'text_append', text: 'v2\\n' }
  })
  assert.equal(handles[1]?.getSnapshot().text, 'v2\\n')
  await runtime.dispose()
})
