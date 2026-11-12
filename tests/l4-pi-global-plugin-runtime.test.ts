import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import type {
  ChatInputAccepted,
  PiDeskPluginFacade,
  PluginWorkSession
} from '@jetcrab/pi-desk-sdk/entry'
import type { HostSettings } from '@jetcrab/pi-desk-sdk/settings'
import {
  L4PiPluginOwnerRuntime,
  type L4PiPluginPackageSource
} from '../src/server/l4_foundation/pi/l4-pi-plugin-owner-runtime'
import { L4PiPluginMethodNotFoundError } from '../src/server/l4_foundation/pi/l4-pi-plugin-method-runtime-core'

const testRoot = resolve('temp', 'pi', 'l4-owner-replace', String(process.pid), 'agent')
process.env.PI_CODING_AGENT_DIR = testRoot
process.env.PI_CODING_AGENT_SESSION_DIR = join(testRoot, 'sessions')
let fixtureIndex = 0

test.after(async () => {
  await rm(resolve(testRoot, '..'), { recursive: true, force: true })
})

interface PackageFixture {
  name: string
  piDesk: Record<string, string>
  files: Record<string, string>
}

async function writePackageFixture(packageRoot: string, fixture: PackageFixture): Promise<void> {
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: fixture.name, type: 'module', piDesk: fixture.piDesk }),
    'utf8'
  )
  for (const [path, content] of Object.entries(fixture.files)) {
    const filePath = join(packageRoot, path)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf8')
  }
}

async function createRuntime(
  context: test.TestContext,
  fixtures: readonly PackageFixture[],
  settings?: HostSettings
): Promise<L4PiPluginOwnerRuntime> {
  const root = join(testRoot, String((fixtureIndex += 1)))
  await mkdir(root, { recursive: true })
  const packages: L4PiPluginPackageSource[] = []

  for (const [index, fixture] of fixtures.entries()) {
    const packageRoot = join(root, `package-${index}`)
    await writePackageFixture(packageRoot, fixture)
    packages.push({ source: packageRoot, installedPath: packageRoot })
  }

  const runtime = new L4PiPluginOwnerRuntime(async () => packages, settings)
  context.after(async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return runtime
}

test('Node插件读取共享设置并在Owner释放时解除订阅', async (context) => {
  let snapshot = { region: { locale: 'en' as const, timeZone: 'UTC' } }
  const listeners = new Set<() => void>()
  const runtime = await createRuntime(
    context,
    [
      {
        name: 'settings-fixture',
        piDesk: { entry: 'entry.js' },
        files: {
          'entry.js': `export default {
      name: 'settings-fixture',
      setup(plugin) {
        let updates = 0
        plugin.host.settings.subscribe(() => { updates += 1 })
        plugin.registerMethod('read', async () => ({ ...plugin.host.settings.getSnapshot(), updates }))
      }
    }`
        }
      }
    ],
    {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  )
  assert.deepEqual(await runtime.invoke('settings-fixture', 'read', {}), {
    region: { locale: 'en', timeZone: 'UTC' },
    updates: 0
  })
  snapshot = { region: { locale: 'en', timeZone: 'America/New_York' } }
  for (const listener of listeners) listener()
  assert.deepEqual(await runtime.invoke('settings-fixture', 'read', {}), {
    region: { locale: 'en', timeZone: 'America/New_York' },
    updates: 1
  })
  await runtime.dispose()
  assert.equal(listeners.size, 0)
})

async function assertMethodMissing(
  runtime: L4PiPluginOwnerRuntime,
  pluginName: string,
  method: string
): Promise<void> {
  await assert.rejects(runtime.invoke(pluginName, method, {}), L4PiPluginMethodNotFoundError)
}

type ControlledPluginLoadDeadline = {
  active: boolean
  fire: () => void
}

function mockPluginLoadDeadline() {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const deadlines: ControlledPluginLoadDeadline[] = []
  const byHandle = new WeakMap<object, ControlledPluginLoadDeadline>()
  globalThis.setTimeout = new Proxy(originalSetTimeout, {
    apply(target, thisArgument, args) {
      const [callback, delayMs, ...callbackArgs] = args
      if (delayMs !== 15_000) {
        return Reflect.apply(target, thisArgument, args)
      }
      const deadline: ControlledPluginLoadDeadline = {
        active: true,
        fire: () => callback(...callbackArgs)
      }
      const handle = deadline as unknown as ReturnType<typeof setTimeout>
      byHandle.set(handle as object, deadline)
      deadlines.push(deadline)
      return handle
    }
  })
  globalThis.clearTimeout = new Proxy(originalClearTimeout, {
    apply(target, thisArgument, args) {
      const [handle] = args
      const deadline = handle && typeof handle === 'object' ? byHandle.get(handle) : undefined
      if (deadline) {
        deadline.active = false
        return
      }
      return Reflect.apply(target, thisArgument, args)
    }
  })

  return {
    expireNext(): void {
      const deadline = deadlines.find((item) => item.active)
      assert.ok(deadline, '没有待触发的插件加载期限')
      deadline.active = false
      deadline.fire()
    },
    expireAll(): void {
      while (deadlines.some((item) => item.active)) this.expireNext()
    },
    restore(): void {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  }
}

function readGlobalTestValue<T>(key: string): T | undefined {
  return (globalThis as unknown as Record<string, unknown>)[key] as T | undefined
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
  }
  throw new Error(`${label}等待超时`)
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}等待超时`)), timeoutMs)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function delayedOwnerEntry(pluginName: string, stateKey: string): string {
  return `export default {
  name: '${pluginName}',
  setup(plugin) {
    plugin.registerMethod('early', async () => ({ ok: true }))
    const state = { started: true, disposals: 0, finish: () => undefined }
    globalThis.${stateKey} = state
    return new Promise((resolve) => {
      state.finish = () => resolve(() => { state.disposals += 1 })
    })
  }
}
`
}

test('正式替换插件来源刷新依赖代码，移除后再次加载使用新版', async (context) => {
  const runtime = await createRuntime(context, [
    {
      name: 'code-cache-owner-fixture',
      piDesk: { entry: './entry.mjs' },
      files: {
        'helper.mjs': "export const version = 'v1'\n",
        'entry.mjs': `import { version } from './helper.mjs'
export default {
  name: 'code-cache-owner',
  setup(plugin) {
    let count = 0
    plugin.registerMethod('version', async () => ({ version, count: ++count }))
  }
}
`
      }
    }
  ])
  await runtime.initialize()
  const source = runtime.readDiagnostics().packages[0].source
  assert.deepEqual(await runtime.invoke('code-cache-owner', 'version', {}), {
    version: 'v1',
    count: 1
  })
  await writeFile(join(source, 'helper.mjs'), "export const version = 'v2'\n", 'utf8')
  await runtime.replaceSource(source, source)
  assert.deepEqual(await runtime.invoke('code-cache-owner', 'version', {}), {
    version: 'v2',
    count: 1
  })
  await runtime.replaceSource(source, null)
  await assertMethodMissing(runtime, 'code-cache-owner', 'version')
  await writeFile(join(source, 'helper.mjs'), "export const version = 'v3'\n", 'utf8')
  await runtime.replaceSource(source, source)
  assert.deepEqual(await runtime.invoke('code-cache-owner', 'version', {}), {
    version: 'v3',
    count: 1
  })
})

test('Legacy piDesk.global 在无 Session 时注册、调用并释放', async (context) => {
  const marker = '__piDeskLegacyOwnerDisposed'
  delete (globalThis as Record<string, unknown>)[marker]
  const runtime = await createRuntime(context, [
    {
      name: 'legacy-owner-fixture',
      piDesk: { global: './global.mjs' },
      files: {
        'global.mjs': `export default function register(api) {
  const plugin = api.bindPlugin('legacy-fixture')
  plugin.registerMethod('echo', async (input, context) => ({
    value: input.value,
    aborted: context.signal.aborted
  }))
  return () => {
    globalThis.${marker} = (globalThis.${marker} ?? 0) + 1
  }
}
`
      }
    }
  ])

  await runtime.initialize()
  assert.deepEqual(await runtime.invoke('legacy-fixture', 'echo', { value: 'ok' }), {
    value: 'ok',
    aborted: false
  })
  await runtime.dispose()
  await runtime.dispose()
  assert.equal((globalThis as Record<string, unknown>)[marker], 1)
  delete (globalThis as Record<string, unknown>)[marker]
})

test('piDesk.entry 优先于 global，并产出 Host、Browser Entry、Declaration 与 Push', async (context) => {
  const marker = '__piDeskEntryOwnerDisposed'
  delete (globalThis as Record<string, unknown>)[marker]
  const runtime = await createRuntime(context, [
    {
      name: 'entry-owner-fixture',
      piDesk: { entry: './entry.mjs', global: './legacy.mjs' },
      files: {
        'browser/entry.js': 'export default () => undefined\n',
        'legacy.mjs': `export default function legacy() {
  throw new Error('legacy entry must not load')
}
`,
        'entry.mjs': `export default {
  name: 'entry-fixture',
  setup(plugin) {
    plugin.registerMethod('work-session-count', async () => ({
      count: (await plugin.host.workSessions.listWorkSessions()).length
    }))
    plugin.registerMethod('push-state', async (input) => {
      plugin.pushGlobal('state', { value: input.value })
      plugin.pushSession(input.source, 'state', { value: input.value })
      return {}
    })
    plugin.registerMethod('invalid-source', async () => {
      plugin.pushSession({ workId: '', sessionId: 'session', branchId: 'branch' }, 'state', {})
      return {}
    })
    plugin.registerMethod('large-push', async () => {
      plugin.pushGlobal('state', { value: 'x'.repeat(70 * 1024) })
      return {}
    })
    plugin.registerBrowserEntry('./browser/entry.js')
    plugin.declareMessage('build-status', {
      priority: 100,
      match(input) {
        return input.message.kind === 'custom'
      },
      project() {
        return {
          viewKey: 'entry-fixture/build-status',
          summary: { text: '状态' },
          detail: { output: '详情' }
        }
      }
    })
    return () => {
      globalThis.${marker} = (globalThis.${marker} ?? 0) + 1
    }
  }
}
`
      }
    }
  ])
  const pushes: unknown[] = []
  runtime.bindPushSender((message) => pushes.push(message))

  await runtime.initialize()
  assert.deepEqual(await runtime.invoke('entry-fixture', 'work-session-count', {}), { count: 0 })

  const firstProvider = runtime.bindWorkSessionProvider(async () => [
    {
      source: { workId: 'work-1', sessionId: 'session-1', branchId: 'branch-1' },
      cwd: 'C:/project-one',
      status: 'idle'
    }
  ])
  const secondProvider = runtime.bindWorkSessionProvider(async () => [
    {
      source: { workId: 'work-2', sessionId: 'session-2', branchId: 'branch-2' },
      cwd: 'C:/project-two',
      status: 'background_running'
    },
    {
      source: { workId: 'work-3', sessionId: 'session-3', branchId: 'branch-3' },
      cwd: 'C:/project-three',
      status: 'completed'
    }
  ])
  firstProvider()
  assert.deepEqual(await runtime.invoke('entry-fixture', 'work-session-count', {}), { count: 2 })

  const entries = await runtime.listBrowserEntries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.pluginName, 'entry-fixture')
  assert.equal(entries[0]?.entryPath.endsWith(join('browser', 'entry.js')), true)
  assert.equal(typeof entries[0]?.resourceKey, 'string')

  const declarations = await runtime.listMessageDeclarations()
  assert.equal(declarations.length, 1)
  assert.equal(declarations[0]?.pluginName, 'entry-fixture')
  assert.equal(declarations[0]?.declarationName, 'build-status')
  assert.equal(declarations[0]?.declaration.priority, 100)

  const capabilityRegistrations = runtime.readCapabilityRegistrations()
  assert.equal(capabilityRegistrations.length, 1)
  assert.deepEqual(capabilityRegistrations[0]?.methods, [
    { pluginName: 'entry-fixture', method: 'invalid-source' },
    { pluginName: 'entry-fixture', method: 'large-push' },
    { pluginName: 'entry-fixture', method: 'push-state' },
    { pluginName: 'entry-fixture', method: 'work-session-count' }
  ])
  assert.deepEqual(capabilityRegistrations[0]?.browserEntries, [{ pluginName: 'entry-fixture' }])
  assert.deepEqual(capabilityRegistrations[0]?.messageDeclarations, [
    {
      pluginName: 'entry-fixture',
      declarationName: 'build-status',
      priority: 100
    }
  ])

  const source = { workId: 'work-2', sessionId: 'session-2', branchId: 'branch-2' }
  assert.deepEqual(
    await runtime.invoke('entry-fixture', 'push-state', { value: 'ready', source }),
    {}
  )
  assert.deepEqual(pushes, [
    {
      pluginName: 'entry-fixture',
      target: { scope: 'global' },
      event: 'state',
      data: { value: 'ready' }
    },
    {
      pluginName: 'entry-fixture',
      target: { scope: 'session', source },
      event: 'state',
      data: { value: 'ready' }
    }
  ])
  await assert.rejects(runtime.invoke('entry-fixture', 'invalid-source', {}))
  await assert.rejects(runtime.invoke('entry-fixture', 'large-push', {}), /exceeds 64KB/)

  secondProvider()
  assert.deepEqual(await runtime.invoke('entry-fixture', 'work-session-count', {}), { count: 0 })
  assert.equal((await runtime.listBrowserEntries()).length, 1)
  await runtime.dispose()
  assert.equal((globalThis as Record<string, unknown>)[marker], 1)
  delete (globalThis as Record<string, unknown>)[marker]
})

test('Pi Desk Plugin Facade 发布全局状态和通知并在释放时清理', async (context) => {
  const runtime = await createRuntime(context, [
    {
      name: 'app-runtime-fixture',
      piDesk: { entry: './entry.mjs' },
      files: {
        'entry.mjs': `export default {
  name: 'app-runtime-fixture',
  setup(plugin) {
    plugin.setState({ status: 'ready' })
    plugin.registerMethod('publish', async () => ({
      notificationId: plugin.notifications.publish({
        key: 'build:run-1',
        level: 'success',
        title: '构建完成',
        event: { name: 'open-result', data: { runId: 'run-1' } }
      })
    }))
    plugin.registerMethod('update', async (input) => {
      plugin.notifications.update(input.notificationId, { title: '构建失败', level: 'error' })
      return {}
    })
    plugin.registerMethod('delete', async (input) => {
      plugin.notifications.delete(input.notificationId)
      return {}
    })
  }
}
`
      }
    }
  ])
  const calls: unknown[] = []
  runtime.bindAppRuntimeSink({
    setState: (pluginName, state) => calls.push({ type: 'state', pluginName, state }),
    publishNotification: (pluginName, input) => {
      calls.push({ type: 'publish', pluginName, input })
      return '11111111-1111-4111-8111-111111111111'
    },
    updateNotification: (pluginName, notificationId, changes) =>
      calls.push({ type: 'update', pluginName, notificationId, changes }),
    deleteNotification: (pluginName, notificationId) =>
      calls.push({ type: 'delete', pluginName, notificationId }),
    releasePlugin: (pluginName) => calls.push({ type: 'release', pluginName })
  })

  await runtime.initialize()
  const result = await runtime.invoke('app-runtime-fixture', 'publish', {})
  assert.equal(result.notificationId, '11111111-1111-4111-8111-111111111111')
  await runtime.invoke('app-runtime-fixture', 'update', {
    notificationId: result.notificationId
  })
  await runtime.invoke('app-runtime-fixture', 'delete', {
    notificationId: result.notificationId
  })
  await runtime.dispose()

  assert.deepEqual(calls, [
    {
      type: 'state',
      pluginName: 'app-runtime-fixture',
      state: { status: 'ready' }
    },
    {
      type: 'publish',
      pluginName: 'app-runtime-fixture',
      input: {
        key: 'build:run-1',
        level: 'success',
        title: '构建完成',
        event: { name: 'open-result', data: { runId: 'run-1' } }
      }
    },
    {
      type: 'update',
      pluginName: 'app-runtime-fixture',
      notificationId: '11111111-1111-4111-8111-111111111111',
      changes: { title: '构建失败', level: 'error' }
    },
    {
      type: 'delete',
      pluginName: 'app-runtime-fixture',
      notificationId: '11111111-1111-4111-8111-111111111111'
    },
    { type: 'release', pluginName: 'app-runtime-fixture' }
  ])
})

test('piDesk.entry 通过原生 Pi peer alias 加载外部 Package', async (context) => {
  const runtime = await createRuntime(context, [
    {
      name: 'native-pi-peer-fixture',
      piDesk: { entry: './entry.mjs' },
      files: {
        'entry.mjs': `import { getAgentDir } from '@mariozechner/pi-coding-agent'

export default {
  name: 'native-pi-peer',
  setup(plugin) {
    plugin.registerMethod('agent-dir', async () => ({ agentDir: getAgentDir() }))
  }
}
`
      }
    }
  ])

  await runtime.initialize()
  const result = await runtime.invoke('native-pi-peer', 'agent-dir', {})
  assert.equal(typeof result.agentDir, 'string')
})

test('Owner Factory 失败时回滚已经注册的全部能力', async (context) => {
  const runtime = await createRuntime(context, [
    {
      name: 'rollback-fixture',
      piDesk: { entry: './entry.mjs' },
      files: {
        'browser/entry.js': 'export default () => undefined\n',
        'entry.mjs': `export default {
  name: 'rollback-fixture',
  setup(plugin) {
    plugin.registerMethod('should-disappear', async () => ({ leaked: true }))
    plugin.registerBrowserEntry('./browser/entry.js')
    plugin.registerBrowserEntry('./browser/entry.js')
  }
}
`
      }
    }
  ])

  await runtime.initialize()
  await assertMethodMissing(runtime, 'rollback-fixture', 'should-disappear')
  assert.deepEqual(await runtime.listBrowserEntries(), [])
  assert.deepEqual(await runtime.listMessageDeclarations(), [])
})

test('重复 pluginName 只保留先加载 Owner，失败 Owner 不泄漏方法', async (context) => {
  const runtime = await createRuntime(context, [
    {
      name: 'first-owner',
      piDesk: { entry: './entry.mjs' },
      files: {
        'entry.mjs': `export default {
  name: 'duplicate-plugin',
  setup(plugin) {
    plugin.registerMethod('first', async () => ({ owner: 'first' }))
  }
}
`
      }
    },
    {
      name: 'second-owner',
      piDesk: { entry: './entry.mjs' },
      files: {
        'entry.mjs': `export default {
  name: 'duplicate-plugin',
  setup(plugin) {
    plugin.registerMethod('second', async () => ({ owner: 'second' }))
  }
}
`
      }
    }
  ])

  await runtime.initialize()
  assert.deepEqual(await runtime.invoke('duplicate-plugin', 'first', {}), { owner: 'first' })
  await assertMethodMissing(runtime, 'duplicate-plugin', 'second')
})

test('资源校验失败调用 setup disposer 并清理注册', async (context) => {
  const marker = '__piDeskInvalidResourceDisposed'
  delete (globalThis as Record<string, unknown>)[marker]
  const runtime = await createRuntime(context, [
    {
      name: 'invalid-resource-owner',
      piDesk: { entry: './entry.mjs' },
      files: {
        'entry.mjs': `export default {
  name: 'invalid-resource',
  setup(plugin) {
    plugin.registerMethod('leaked', async () => ({ leaked: true }))
    plugin.registerBrowserEntry('./missing/entry.js')
    return () => {
      globalThis.${marker} = (globalThis.${marker} ?? 0) + 1
    }
  }
}
`
      }
    }
  ])

  await runtime.initialize()
  await assertMethodMissing(runtime, 'invalid-resource', 'leaked')
  assert.equal((globalThis as Record<string, unknown>)[marker], 1)
  delete (globalThis as Record<string, unknown>)[marker]
})

test(
  '15秒初始化超时后迟到登记和Host操作失败，迟到disposer清理且其他Owner继续',
  {
    timeout: 45_000
  },
  async (context) => {
    const stateKey = '__piDeskOwnerDeadlineSlow'
    delete (globalThis as Record<string, unknown>)[stateKey]
    const runtime = await createRuntime(context, [
      {
        name: 'slow-owner',
        piDesk: { entry: './entry.mjs' },
        files: {
          'entry.mjs': `export default {
  name: 'slow-owner',
  setup(plugin) {
    plugin.registerMethod('early', async () => ({ ok: true }))
    const state = { started: true, disposals: 0, finish: () => undefined }
    state.tryRegister = () => plugin.registerMethod('late', async () => ({ late: true }))
    state.trySetState = () => plugin.setState({ leaked: true })
    state.readWorkSessions = () => plugin.host.workSessions.listWorkSessions()
    globalThis.${stateKey} = state
    return new Promise((resolve) => {
      state.finish = () => resolve(() => { state.disposals += 1 })
    })
  }
}
`
        }
      },
      {
        name: 'healthy-after-timeout',
        piDesk: { entry: './entry.mjs' },
        files: {
          'entry.mjs': `export default {
  name: 'healthy-after-timeout',
  setup(plugin) {
    plugin.registerMethod('ping', async () => ({ ok: true }))
  }
}
`
        }
      }
    ])
    const workSessionReads: number[] = []
    runtime.bindWorkSessionProvider(async () => {
      workSessionReads.push(1)
      return []
    })
    const sinkWrites: unknown[] = []
    runtime.bindAppRuntimeSink({
      setState: (_pluginName, state) => sinkWrites.push(state),
      publishNotification: () => '11111111-1111-4111-8111-111111111111',
      updateNotification: () => undefined,
      deleteNotification: () => undefined,
      releasePlugin: () => undefined
    })
    const deadlines = mockPluginLoadDeadline()
    const initializing = runtime.initialize()

    try {
      await waitFor(
        () => Boolean(readGlobalTestValue<{ started?: boolean }>(stateKey)?.started),
        '慢速Owner setup'
      )
      deadlines.expireNext()
      await withTimeout(initializing, '插件初始化整体收敛')

      const slowState = readGlobalTestValue<{
        started: boolean
        disposals: number
        finish: () => void
        tryRegister: () => unknown
        trySetState: () => void
        readWorkSessions: () => Promise<unknown>
      }>(stateKey)!
      assert.throws(slowState.tryRegister, /owner is no longer active/)
      assert.throws(slowState.trySetState, /owner is no longer active/)
      await assert.rejects(slowState.readWorkSessions(), /owner is no longer active/)
      assert.deepEqual(workSessionReads, [])
      assert.deepEqual(sinkWrites, [])
      await assertMethodMissing(runtime, 'slow-owner', 'early')
      assert.deepEqual(await runtime.invoke('healthy-after-timeout', 'ping', {}), { ok: true })
      assert.equal(
        runtime.readDiagnostics().packages.find((item) => item.packageName === 'slow-owner')
          ?.status,
        'failed'
      )
      assert.equal(
        runtime
          .readDiagnostics()
          .packages.find((item) => item.packageName === 'healthy-after-timeout')?.status,
        'ready'
      )

      slowState.finish()
      await waitFor(() => slowState.disposals === 1, '迟到setup disposer')
    } finally {
      const slowState = readGlobalTestValue<{ finish?: () => void }>(stateKey)
      slowState?.finish?.()
      deadlines.expireAll()
      deadlines.restore()
      await withTimeout(
        initializing.catch(() => undefined),
        '插件初始化清理'
      ).catch(() => undefined)
      await runtime.dispose()
      delete (globalThis as Record<string, unknown>)[stateKey]
    }
  }
)

test(
  'dispose包含loading owner并在迟到setup返回后执行disposer',
  { timeout: 15_000 },
  async (context) => {
    const stateKey = '__piDeskOwnerDisposedWhileLoading'
    delete (globalThis as Record<string, unknown>)[stateKey]
    const runtime = await createRuntime(context, [
      {
        name: 'loading-owner-dispose-fixture',
        piDesk: { entry: './entry.mjs' },
        files: { 'entry.mjs': delayedOwnerEntry('loading-owner-dispose-fixture', stateKey) }
      }
    ])
    const initializing = runtime.initialize()

    try {
      await waitFor(
        () => Boolean(readGlobalTestValue<{ started?: boolean }>(stateKey)?.started),
        'loading owner setup'
      )
      const loadingState = readGlobalTestValue<{
        finish: () => void
        disposals: number
      }>(stateKey)!
      await withTimeout(runtime.dispose(), 'dispose加载中的Owner')
      assert.deepEqual(runtime.readCapabilityRegistrations(), [])

      loadingState.finish()
      await withTimeout(initializing, '迟到setup结束')
      await waitFor(() => loadingState.disposals === 1, '加载中Owner迟到disposer')
    } finally {
      const loadingState = readGlobalTestValue<{ finish?: () => void }>(stateKey)
      loadingState?.finish?.()
      await withTimeout(
        initializing.catch(() => undefined),
        'dispose fixture初始化清理'
      ).catch(() => undefined)
      await runtime.dispose()
      delete (globalThis as Record<string, unknown>)[stateKey]
    }
  }
)

test(
  '超过四个未完成插件加载后停止继续加载且已就绪Owner仍可调用',
  { timeout: 45_000 },
  async (context) => {
    const slowOwners = Array.from({ length: 5 }, (_, index) => ({
      name: `abandoned-owner-${index + 1}`,
      stateKey: `__piDeskAbandonedOwner${index + 1}`
    }))
    for (const owner of slowOwners) delete (globalThis as Record<string, unknown>)[owner.stateKey]
    const runtime = await createRuntime(context, [
      {
        name: 'owner-before-abandoned-loads',
        piDesk: { entry: './entry.mjs' },
        files: {
          'entry.mjs': `export default {
  name: 'owner-before-abandoned-loads',
  setup(plugin) {
    plugin.registerMethod('ping', async () => ({ ok: true }))
  }
}
`
        }
      },
      ...slowOwners.map(({ name, stateKey }) => ({
        name,
        piDesk: { entry: './entry.mjs' },
        files: { 'entry.mjs': delayedOwnerEntry(name, stateKey) }
      }))
    ])
    const deadlines = mockPluginLoadDeadline()
    const initializing = runtime.initialize()

    try {
      for (const [index, owner] of slowOwners.slice(0, 4).entries()) {
        await waitFor(
          () => Boolean(readGlobalTestValue<{ started?: boolean }>(owner.stateKey)?.started),
          `慢速Owner ${index + 1}`
        )
        deadlines.expireNext()
      }
      await withTimeout(initializing, '达到遗留加载上限后继续Owner初始化')

      assert.equal((globalThis as Record<string, unknown>)[slowOwners[4]!.stateKey], undefined)
      const cappedDiagnostic = runtime
        .readDiagnostics()
        .packages.find((item) => item.packageName === slowOwners[4]!.name)
      assert.equal(cappedDiagnostic?.status, 'failed')
      assert.match(cappedDiagnostic?.error?.message ?? '', /停止继续加载/)
      assert.deepEqual(await runtime.invoke('owner-before-abandoned-loads', 'ping', {}), {
        ok: true
      })

      for (const owner of slowOwners.slice(0, 4)) {
        const state = readGlobalTestValue<{
          finish: () => void
          disposals: number
        }>(owner.stateKey)!
        state.finish()
        await waitFor(() => state.disposals === 1, `${owner.name}迟到disposer`)
      }
    } finally {
      for (const owner of slowOwners.slice(0, 4)) {
        const state = readGlobalTestValue<{ finish?: () => void }>(owner.stateKey)
        state?.finish?.()
      }
      deadlines.expireAll()
      deadlines.restore()
      await withTimeout(
        initializing.catch(() => undefined),
        '遗留Owner初始化清理'
      ).catch(() => undefined)
      await runtime.dispose()
      for (const owner of slowOwners) delete (globalThis as Record<string, unknown>)[owner.stateKey]
    }
  }
)

test('失效Legacy Owner拒绝迟到的pluginName声明', async (context) => {
  const stateKey = '__piDeskDisposedLegacyFacade'
  delete (globalThis as Record<string, unknown>)[stateKey]
  const runtime = await createRuntime(context, [
    {
      name: 'legacy-claim-after-dispose',
      piDesk: { global: './global.mjs' },
      files: {
        'global.mjs': `export default function (api) {
  globalThis.${stateKey} = api
  api.bindPlugin('legacy-owner').registerMethod('ping', async () => ({ ok: true }))
  return () => undefined
}
`
      }
    }
  ])
  await runtime.initialize()
  const legacyApi = (globalThis as Record<string, unknown>)[stateKey] as {
    bindPlugin: (pluginName: string) => unknown
  }

  await runtime.dispose()
  assert.throws(() => legacyApi.bindPlugin('late-owner'), /owner is no longer active/)
  delete (globalThis as Record<string, unknown>)[stateKey]
})

test('可选 beforeReload 尽力执行且旧 disposer 返回值保持兼容', async (context) => {
  const reloadMarker = '__piDeskBeforeReloadCount'
  const disposeMarker = '__piDeskLifecycleDisposeCount'
  delete (globalThis as Record<string, unknown>)[reloadMarker]
  delete (globalThis as Record<string, unknown>)[disposeMarker]
  const runtime = await createRuntime(context, [
    {
      name: 'reload-lifecycle-owner',
      piDesk: { entry: './entry.mjs' },
      files: {
        'entry.mjs': `export default {
  name: 'reload-lifecycle',
  setup(plugin) {
    plugin.registerMethod('ping', async () => ({ ok: true }))
    return {
      beforeReload() {
        globalThis.${reloadMarker} = (globalThis.${reloadMarker} ?? 0) + 1
      },
      dispose() {
        globalThis.${disposeMarker} = (globalThis.${disposeMarker} ?? 0) + 1
      }
    }
  }
}
`
      }
    }
  ])

  await runtime.initialize()
  await runtime.prepareReload()
  assert.equal((globalThis as Record<string, unknown>)[reloadMarker], 1)
  await runtime.dispose()
  assert.equal((globalThis as Record<string, unknown>)[disposeMarker], 1)
  delete (globalThis as Record<string, unknown>)[reloadMarker]
  delete (globalThis as Record<string, unknown>)[disposeMarker]
})

test('插件setup同步抛错只隔离失败Owner且其他Owner仍可初始化', async (context) => {
  const runtime = await createRuntime(context, [
    {
      name: 'owner-sync-setup-failure',
      piDesk: { entry: './entry.mjs' },
      files: {
        'entry.mjs': `export default {
  name: 'owner-sync-setup-failure',
  setup() {
    throw new Error('fixture setup failed')
  }
}
`
      }
    },
    {
      name: 'owner-after-sync-setup-failure',
      piDesk: { entry: './entry.mjs' },
      files: {
        'entry.mjs': `export default {
  name: 'owner-after-sync-setup-failure',
  setup(plugin) {
    plugin.registerMethod('ping', async () => ({ ok: true }))
  }
}
`
      }
    }
  ])

  await runtime.initialize()
  const failedOwner = runtime
    .readDiagnostics()
    .packages.find((item) => item.packageName === 'owner-sync-setup-failure')
  assert.equal(failedOwner?.status, 'failed')
  assert.match(failedOwner?.error?.message ?? '', /fixture setup failed/)
  assert.deepEqual(await runtime.invoke('owner-after-sync-setup-failure', 'ping', {}), {
    ok: true
  })
})

test('Package Provider 失败只记录 loadError，初始化仍然收敛', async () => {
  const runtime = new L4PiPluginOwnerRuntime(async () => {
    throw new Error('settings unavailable')
  })
  await runtime.initialize()
  assert.equal(runtime.readDiagnostics().loadError, 'settings unavailable')
  assert.deepEqual(await runtime.listBrowserEntries(), [])
  await runtime.dispose()
})

test('Server shutdown 中断活动 Global Method 且 disposer 幂等', async (context) => {
  const marker = '__piDeskAbortOwnerDisposed'
  delete (globalThis as Record<string, unknown>)[marker]
  const runtime = await createRuntime(context, [
    {
      name: 'abort-owner',
      piDesk: { entry: './entry.mjs' },
      files: {
        'entry.mjs': `export default {
  name: 'abort-owner',
  setup(plugin) {
    plugin.registerMethod('wait', async (_input, context) =>
      new Promise((resolve) => {
        context.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true })
      })
    )
    return () => {
      globalThis.${marker} = (globalThis.${marker} ?? 0) + 1
    }
  }
}
`
      }
    }
  ])

  await runtime.initialize()
  const waiting = runtime.invoke('abort-owner', 'wait', {})
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
  await runtime.dispose()
  assert.deepEqual(await waiting, { aborted: true })
  await runtime.dispose()
  assert.equal((globalThis as Record<string, unknown>)[marker], 1)
  delete (globalThis as Record<string, unknown>)[marker]
})

const eventHostsKey = '__piDeskNodeEventHosts'

async function createEventRuntime(
  context: test.TestContext,
  names = ['event-publisher', 'event-subscriber'],
  settings?: HostSettings
): Promise<{ runtime: L4PiPluginOwnerRuntime; hosts: Record<string, PiDeskPluginFacade> }> {
  const hosts: Record<string, PiDeskPluginFacade> = {}
  Reflect.set(globalThis, eventHostsKey, hosts)
  context.after(() => {
    Reflect.deleteProperty(globalThis, eventHostsKey)
  })
  const runtime = await createRuntime(
    context,
    names.map((name) => ({
      name,
      piDesk: { entry: 'entry.js' },
      files: {
        'entry.js': `export default {
          name: '${name}',
          setup(plugin) {
            globalThis.${eventHostsKey}[plugin.name] = plugin
            plugin.registerMethod('emit', async (input) => {
              plugin.host.events.emit(input.name, input.data)
              return { ok: true }
            })
          }
        }`
      }
    })),
    settings
  )
  await runtime.initialize()
  return { runtime, hosts }
}

function nextEventTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('Node事件按发布Owner与名称路由，无历史回放，旧Push不公开，回调异常不影响Method', async (context) => {
  const { runtime, hosts } = await createEventRuntime(context)
  const a = hosts['event-publisher'].host.events
  const b = hosts['event-subscriber'].host.events
  const received: string[] = []
  const logs = context.mock.method(console, 'warn', () => undefined)
  const pushes: unknown[] = []
  runtime.bindPushSender((message) => pushes.push(message))
  a.emit('changed', { value: 'past' })
  b.onPlugin('not-loaded', 'changed', () => {
    received.push('wrong-publisher')
  })
  b.onPlugin('event-publisher', 'other', () => {
    received.push('wrong-event')
  })
  b.onPlugin('event-publisher', 'changed', () => {
    received.push('throw')
    throw new Error('sync listener failure')
  })
  b.onPlugin('event-publisher', 'changed', async () => {
    received.push('reject')
    throw new Error('async listener failure')
  })
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  b.onPlugin('event-publisher', 'changed', () => pending)
  a.onPlugin('event-publisher', 'changed', (data) => {
    received.push(`self:${data.value}`)
  })
  b.on('chat-input-accepted', () => {
    received.push('host-event')
  })
  assert.deepEqual(received, [])
  assert.deepEqual(
    await runtime.invoke('event-publisher', 'emit', {
      name: 'changed',
      data: { value: 'current' }
    }),
    { ok: true }
  )
  await nextEventTurn()
  assert.deepEqual(received, ['throw', 'reject', 'self:current'])
  assert.equal(logs.mock.callCount(), 2)
  for (const call of logs.mock.calls) {
    assert.match(JSON.stringify(call.arguments), /event-publisher\/changed/)
    assert.match(JSON.stringify(call.arguments), /event-subscriber/)
    assert.doesNotMatch(JSON.stringify(call.arguments), /current/)
  }
  hosts['event-publisher'].pushGlobal('changed', { value: 'push' })
  hosts['event-publisher'].pushSession(
    { workId: 'work', sessionId: 'session', branchId: 'branch' },
    'changed',
    {}
  )
  b.emit('changed', { value: 'other-publisher' })
  a.emit('chat-input-accepted', {})
  assert.equal(pushes.length, 2)
  assert.deepEqual(received, ['throw', 'reject', 'self:current'])
  release()
})

test('Node事件支持迟加载与自身订阅，发布者替换保留订阅，订阅者替换和draining撤销旧权限', async (context) => {
  const { runtime, hosts } = await createEventRuntime(context)
  const publisher = hosts['event-publisher']
  const subscriber = hosts['event-subscriber']
  const received: number[] = []
  const listener = (): void => {
    received.push(1)
  }
  const off = subscriber.host.events.onPlugin('event-publisher', 'changed', listener)
  subscriber.host.events.onPlugin('event-publisher', 'changed', listener)
  publisher.host.events.emit('changed', {})
  assert.equal(received.length, 2)
  off()
  off()
  const sources = runtime.readDiagnostics().packages
  const publisherSource = sources.find((item) => item.pluginName === publisher.name)!.source
  await runtime.replaceSource(publisherSource, null)
  subscriber.host.events.onPlugin('event-publisher', 'changed', () => {
    received.push(2)
  })
  await runtime.replaceSource(publisherSource, publisherSource)
  hosts['event-publisher'].host.events.emit('changed', {})
  assert.deepEqual(received, [1, 1, 1, 2])
  assert.throws(() => publisher.host.events.emit('changed', {}), /owner is no longer active/)
  const subscriberSource = sources.find((item) => item.pluginName === subscriber.name)!.source
  await runtime.replaceSource(subscriberSource, subscriberSource)
  off()
  hosts['event-publisher'].host.events.emit('changed', {})
  assert.deepEqual(received, [1, 1, 1, 2])
  const current = hosts['event-subscriber'].host.events
  current.onPlugin('event-publisher', 'changed', listener)
  await runtime.prepareReload()
  assert.throws(() => current.on('settings', () => undefined), /owner is no longer active/)
  assert.throws(
    () => hosts['event-publisher'].host.events.emit('changed', {}),
    /owner is no longer active/
  )
  assert.deepEqual(received, [1, 1, 1, 2])
})

test('Node事件严格拒绝非JSON、循环和超限对象，即使无人订阅；只读分发隔离原数据', async (context) => {
  const { hosts } = await createEventRuntime(context)
  const events = hosts['event-publisher'].host.events
  const invalid: unknown[] = [
    [],
    null,
    { value: undefined },
    { value: () => undefined },
    { value: Symbol('x') },
    { value: BigInt(1) },
    { value: NaN },
    { value: Infinity },
    { value: new Date() },
    new (class Example {
      value = 1
    })(),
    { value: [, 1] },
    { value: 'x'.repeat(64 * 1024) },
    { [Symbol('x')]: 1 },
    Object.defineProperty({}, 'value', { value: 1, enumerable: false }),
    {
      get value() {
        return 1
      }
    }
  ]
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  invalid.push(cycle)
  for (const value of invalid) {
    assert.throws(() => events.emit('changed', value as never))
  }
  assert.throws(() => events.emit('Invalid', {}))
  assert.throws(() => events.onPlugin('Invalid', 'changed', () => undefined))
  assert.throws(() => events.onPlugin('event-publisher', 'Invalid', () => undefined))
  const seen: unknown[] = []
  const readonly: boolean[] = []
  events.onPlugin('event-publisher', 'changed', (data) => {
    readonly.push(Object.isFrozen(data), Object.isFrozen(data.nested))
    readonly.push(!Reflect.set(data.nested as object, 'value', 2))
  })
  events.onPlugin('event-publisher', 'changed', (data) => {
    seen.push(data)
  })
  const original = { nested: { value: 1 } }
  events.emit('changed', original)
  original.nested.value = 3
  assert.deepEqual(seen, [{ nested: { value: 1 } }])
  assert.deepEqual(readonly, [true, true, true])
  let special: unknown
  events.onPlugin('event-publisher', 'json-keys', (data) => {
    special = data
  })
  const data = JSON.parse('{"__proto__":{"value":1},"constructor":2}')
  events.emit('json-keys', data)
  assert.deepEqual(special, data)
})

test('Node状态等待真实基线，首次只交付最新值，退订与Owner失效阻止迟到回调', async (context) => {
  const { runtime, hosts } = await createEventRuntime(context)
  const received: Array<readonly PluginWorkSession[]> = []
  const events = hosts['event-subscriber'].host.events
  events.on('work-sessions', (value) => {
    received.push(value)
  })
  await nextEventTurn()
  assert.equal(received.length, 0)
  let update!: (sessions: readonly PluginWorkSession[]) => void
  let accepted!: (event: ChatInputAccepted) => void
  let releases = 0
  const bind = (): (() => void) =>
    runtime.bindSessionEvents({
      subscribeWorkSessions: (listener) => {
        update = listener
        listener([])
        return () => {
          releases += 1
        }
      },
      subscribeInputAccepted: (listener) => {
        accepted = listener
        return () => {
          releases += 1
        }
      }
    })
  const unbind = bind()
  const sessions: PluginWorkSession[] = [
    {
      source: { workId: 'work', sessionId: 'session', branchId: 'branch' },
      cwd: 'C:/project',
      status: 'idle'
    }
  ]
  update(sessions)
  update([{ ...sessions[0], status: 'main_running' }])
  assert.equal(received.length, 0)
  await nextEventTurn()
  assert.deepEqual(
    received.map((value) => value[0]?.status),
    ['main_running']
  )
  update([{ ...sessions[0], status: 'main_running' }])
  update(sessions)
  assert.deepEqual(
    received.map((value) => value[0]?.status),
    ['main_running', 'idle']
  )
  const actions: ChatInputAccepted[] = []
  events.on('chat-input-accepted', (event) => {
    actions.push(event)
  })
  accepted({ source: sessions[0].source, tempId: 'accepted' })
  assert.deepEqual(actions, [{ source: sessions[0].source, tempId: 'accepted' }])
  let cancelled = 0
  const off = events.on('work-sessions', () => {
    cancelled += 1
  })
  off()
  off()
  const emptyValues: unknown[] = []
  unbind()
  events.on('work-sessions', (value) => {
    emptyValues.push(value)
  })
  await nextEventTurn()
  assert.deepEqual(emptyValues, [])
  bind()
  await nextEventTurn()
  assert.deepEqual(emptyValues, [[]])
  unbind()
  assert.equal(releases, 2)
  events.on('work-sessions', () => {
    cancelled += 1
  })
  await runtime.dispose()
  update(sessions)
  accepted({ source: sessions[0].source, tempId: 'late' })
  await nextEventTurn()
  assert.equal(cancelled, 0)
  assert.equal(actions.length, 1)
  assert.equal(releases, 4)
})

test('Node设置事件首次在on返回后取最新值，旧subscribe只通知变化且释放无残留', async (context) => {
  let snapshot = { region: { locale: 'en' as const, timeZone: 'UTC' } }
  const listeners = new Set<() => void>()
  const { runtime, hosts } = await createEventRuntime(context, ['event-publisher'], {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  })
  const host = hosts['event-publisher'].host
  const zones: string[] = []
  const snapshotsAgree: boolean[] = []
  let releaseListener!: () => void
  const listenerPending = new Promise<void>((resolve) => {
    releaseListener = resolve
  })
  let legacy = 0
  host.settings.subscribe(() => {
    legacy += 1
  })
  host.events.on('settings', async (value) => {
    zones.push(value.region.timeZone)
    snapshotsAgree.push(JSON.stringify(value) === JSON.stringify(host.settings.getSnapshot()))
    await listenerPending
  })
  assert.deepEqual(zones, [])
  snapshot = { region: { locale: 'en', timeZone: 'Asia/Shanghai' } }
  for (const listener of listeners) listener()
  await nextEventTurn()
  assert.deepEqual(zones, ['Asia/Shanghai'])
  assert.equal(legacy, 1)
  for (const listener of listeners) listener()
  assert.deepEqual(zones, ['Asia/Shanghai'])
  snapshot = { region: { locale: 'en', timeZone: 'UTC' } }
  for (const listener of listeners) listener()
  assert.deepEqual(zones, ['Asia/Shanghai', 'UTC'])
  assert.deepEqual(snapshotsAgree, [true, true])
  releaseListener()
  host.events.on('settings', () => {
    throw new Error('late callback')
  })
  await runtime.dispose()
  await nextEventTurn()
  assert.equal(listeners.size, 0)
})

test('Node事件运行域独立，相同插件名不串扰，订阅不会加载发布者', async (context) => {
  const first = await createEventRuntime(context)
  const second = await createEventRuntime(context)
  const calls: string[] = []
  first.hosts['event-subscriber'].host.events.onPlugin('event-publisher', 'changed', () => {
    calls.push('first')
  })
  second.hosts['event-subscriber'].host.events.onPlugin('event-publisher', 'changed', () => {
    calls.push('second')
  })
  first.hosts['event-publisher'].host.events.emit('changed', {})
  assert.deepEqual(calls, ['first'])
  second.hosts['event-publisher'].host.events.emit('changed', {})
  assert.deepEqual(calls, ['first', 'second'])
  const packages = second.runtime.readDiagnostics().packages.length
  second.hosts['event-subscriber'].host.events.onPlugin('not-loaded', 'changed', () => undefined)
  assert.equal(second.runtime.readDiagnostics().packages.length, packages)
})

test('P2首末订阅控制列表来源，Owner换代与旧off不会释放新连接', async (context) => {
  const { runtime, hosts } = await createEventRuntime(context)
  let connections = 0
  let releases = 0
  let sourceListener: ((value: readonly PluginWorkSession[]) => void) | undefined
  const bind = (): (() => void) =>
    runtime.bindSessionEvents({
      subscribeWorkSessions: (listener) => {
        connections += 1
        sourceListener = listener
        listener([])
        return () => {
          releases += 1
        }
      },
      subscribeInputAccepted: () => () => undefined
    })
  const unbind = bind()
  assert.equal(connections, 0, '绑定组合根不能建立无人消费的列表订阅')
  const first = hosts['event-publisher'].host.events.on('work-sessions', () => undefined)
  const second = hosts['event-subscriber'].host.events.on('work-sessions', () => undefined)
  assert.equal(connections, 1)
  first()
  first()
  assert.equal(releases, 0)
  second()
  second()
  assert.equal(releases, 1)
  const staleListener = sourceListener!
  const values: Array<readonly PluginWorkSession[]> = []
  const oldOff = hosts['event-publisher'].host.events.on('work-sessions', (value) => {
    values.push(value)
  })
  assert.equal(connections, 2)
  staleListener([
    {
      source: { workId: 'stale', sessionId: 'stale', branchId: 'stale' },
      cwd: 'C:/stale',
      status: 'idle'
    }
  ])
  await nextEventTurn()
  assert.deepEqual(values, [[]], '旧来源的迟到更新不能覆盖新连接基线')
  const source = runtime
    .readDiagnostics()
    .packages.find((item) => item.pluginName === 'event-publisher')!.source
  await runtime.replaceSource(source, source)
  assert.equal(releases, 2)
  const currentOff = hosts['event-publisher'].host.events.on('work-sessions', () => undefined)
  assert.equal(connections, 3)
  oldOff()
  assert.equal(releases, 2)
  const newBinding = bind()
  assert.equal(releases, 3)
  assert.equal(connections, 4)
  unbind()
  assert.equal(releases, 3)
  await runtime.prepareReload()
  assert.equal(releases, 4, 'Owner draining后列表来源应释放')
  currentOff()
  newBinding()
  newBinding()
  await runtime.dispose()
  assert.equal(releases, 4)
})
