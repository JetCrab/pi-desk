import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { bindConfigStore } from '@jetcrab/pi-desk-sdk/config'
import type { PiDeskPluginFacade, PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import type { CommandResult, ManagedCommand } from '../src/command.js'
import type { DebugGatewayHandle } from '../src/gateway.js'
import type { RunLogger } from '../src/log.js'
import { RemoteDebugRuntime as Runtime } from '../src/runtime.js'
import { RemoteDebugSettingsStore } from '../src/l4-remote-debug-settings.js'

class RemoteDebugRuntime extends Runtime {
  constructor(
    plugin: PiDeskPluginFacade,
    dependencies: ConstructorParameters<typeof Runtime>[1] = {}
  ) {
    super(plugin, { preparePorts: async () => [], ...dependencies })
  }
}
import type { ManagedTunnelClient, TunnelClientResult } from '../src/tunnel-client.js'

const root = resolve('temp', 'pi', 'remote-debug-runtime-test', String(process.pid))
const cwd = join(root, 'project')

function source() {
  return { workId: 'work', sessionId: 'session', branchId: 'v1:main' }
}

function pluginFacade(
  states: Array<PluginJsonObject | null>,
  workSessions: Array<{ source: ReturnType<typeof source>; cwd: string; status: 'idle' }> = [
    { source: source(), cwd, status: 'idle' }
  ]
): PiDeskPluginFacade {
  return {
    name: 'remote-debug',
    config: bindConfigStore('plugins', 'remote-debug', { agentDir: join(root, 'agent') }),
    notifications: {
      publish: () => '11111111-1111-4111-8111-111111111111',
      update: () => undefined,
      delete: () => undefined
    },
    setState(state) {
      states.push(state)
    },
    host: {
      events: {
        on(): () => void {
          return () => undefined
        },
        onPlugin(): () => void {
          return () => undefined
        },
        emit: (): void => undefined
      },
      settings: {
        getSnapshot: () => ({ region: { locale: 'en', timeZone: 'UTC' } }),
        subscribe: () => () => undefined
      },
      workSessions: {
        listWorkSessions: async () => workSessions
      }
    },
    registerMethod: () => () => undefined,
    registerBrowserEntry: () => () => undefined,
    declareCapabilities: () => () => undefined,
    declareMessage: () => () => undefined,
    pushGlobal: () => undefined,
    pushSession: () => undefined
  }
}

async function writeConfig(content: string): Promise<void> {
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await writeFile(join(cwd, '.pi', 'remote_debug.yaml'), content, 'utf8')
}

const desktopEnvironmentKeys = ['PI_DESK_DESKTOP_EXECUTABLE', 'PI_DESK_DESKTOP_CONFIG'] as const
const originalDesktopEnvironment = desktopEnvironmentKeys.map((key) => process.env[key])
const originalAgentDir = process.env.PI_CODING_AGENT_DIR

test.before(async () => {
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  for (const key of desktopEnvironmentKeys) delete process.env[key]
  await writeConfig(
    `version: 1
profiles:
  web:
    command: pnpm dev
    entryPort: 30333
    publicPort: 43333
    routes:
      /api: 8080
  api:
    command: pnpm dev:api
    entryPort: 30334
    publicPort: 43333
`
  )
})

test.after(async () => {
  for (const [index, key] of desktopEnvironmentKeys.entries()) {
    const value = originalDesktopEnvironment[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  await rm(root, { recursive: true, force: true })
})

test('运行到公网就绪后可显式停止并完整清理', async () => {
  const states: Array<PluginJsonObject | null> = []
  let ownerActive = true
  let callsAfterOwnerInactive = 0
  const facade = pluginFacade(states)
  facade.setState = (state) => {
    if (!ownerActive) {
      callsAfterOwnerInactive += 1
      throw new Error('Plugin Owner 已失效')
    }
    states.push(state)
  }
  const command = deferredCommand()
  const tunnel = deferredTunnel('tunnel.example:43333')
  let tunnelPorts: { localPort: number; publicPort: number } | undefined
  let gatewayClosed = 0
  const gateway: DebugGatewayHandle = {
    port: 39123,
    async close() {
      gatewayClosed += 1
    }
  }
  const runtime = new RemoteDebugRuntime(facade, {
    startCommand: () => command.handle,
    waitForPort: async () => undefined,
    startGateway: async () => gateway,
    startTunnel: (input) => {
      assert.equal('configPath' in input, false)
      assert.equal('binaryPath' in input, false)
      tunnelPorts = { localPort: input.localPort, publicPort: input.publicPort }
      return tunnel.handle
    }
  })

  const started = await runtime.start(cwd, 'web')
  assert.ok('runId' in started)
  await waitFor(() => Boolean(runtime.state().runs[0]?.publicUrl))
  assert.equal(runtime.state().runs[0]?.publicUrl, 'http://tunnel.example:43333')
  assert.equal(runtime.state().runs[0]?.localUrl, 'http://127.0.0.1:30333')
  assert.equal(runtime.state().runs[0]?.gatewayPort, 39123)
  assert.deepEqual(tunnelPorts, { localPort: 39123, publicPort: 43333 })

  await runtime.stop(started.runId)

  const run = runtime.state().runs[0]
  assert.equal(run?.status, 'stopped')
  assert.equal(run?.publicUrl, null)
  assert.equal(run?.localUrl, null)
  assert.equal(run?.gatewayPort, null)
  assert.equal(command.stopCalls(), 1)
  assert.equal(tunnel.stopCalls(), 1)
  assert.equal(gatewayClosed, 1)
  assert.ok(states.length >= 4)
  const publishedStateCount = states.length
  ownerActive = false
  await runtime.dispose()
  assert.equal(callsAfterOwnerInactive, 0)
  assert.equal(states.length, publishedStateCount)
  assert.deepEqual(runtime.state(), { runs: [] })
})

test('Run 仅按 cwd 启动，不依赖 WorkSession 继续存在', async () => {
  const command = deferredCommand()
  const tunnel = deferredTunnel('tunnel.example:43333')
  const runtime = new RemoteDebugRuntime(pluginFacade([], []), {
    startCommand: () => command.handle,
    waitForPort: async () => undefined,
    startGateway: async () => ({ port: 39124, close: async () => undefined }),
    startTunnel: () => tunnel.handle
  })

  const started = await runtime.start(cwd, 'web')
  assert.ok('runId' in started)
  await waitFor(() => runtime.state().runs[0]?.status === 'running')
  assert.equal(runtime.state().runs[0]?.runId, started.runId)
  const projects = await runtime.catalog([])
  assert.equal(projects[0]?.cwd, cwd)
  assert.equal(projects[0]?.status, 'ready')
  await runtime.stop(started.runId)
  await runtime.dispose()
})

test('活动 Run 的公网端口冲突不阻止第二个本地项目启动', async () => {
  const commands = [deferredCommand(), deferredCommand()]
  const tunnel = deferredTunnel('tunnel.example:43333')
  let starts = 0
  let tunnelStarts = 0
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    startCommand: () => commands[starts++].handle,
    waitForPort: async () => undefined,
    startGateway: async () => ({ port: 39125 + starts, close: async () => undefined }),
    startTunnel: () => {
      if (tunnelStarts++ > 0) throw new Error('公网端口 43333 已被占用')
      return tunnel.handle
    }
  })
  try {
    await runtime.start(cwd, 'web')
    await waitFor(() => Boolean(runtime.state().runs[0]?.publicUrl))
    const second = await runtime.start(cwd, 'api')
    assert.ok('runId' in second)
    await waitFor(() => Boolean(runtime.state().runs[1]?.failure))
    const [web, api] = runtime.state().runs
    assert.equal(web.status, 'running')
    assert.equal(web.publicUrl, 'http://tunnel.example:43333')
    assert.equal(api.status, 'running')
    assert.equal(api.localUrl, 'http://127.0.0.1:30334')
    assert.equal(api.publicUrl, null)
    assert.match(api.failure?.message ?? '', /43333.*占用.*本地访问仍可用/)
    assert.equal(commands[0].stopCalls(), 0)
    assert.equal(commands[1].stopCalls(), 0)
  } finally {
    await runtime.dispose()
  }
})

test('项目命令在入口就绪前退出时收敛失败且不启动 Gateway', async () => {
  const command = deferredCommand()
  let gatewayStarts = 0
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    startCommand: () => command.handle,
    waitForPort: async (_port, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      }),
    startGateway: async () => {
      gatewayStarts += 1
      throw new Error('不应启动 Gateway')
    }
  })

  const started = await runtime.start(cwd, 'web')
  assert.ok('runId' in started)
  command.resolve({ exitCode: 2, signal: null, error: null })
  await waitFor(() => runtime.state().runs[0]?.status === 'failed')

  const run = runtime.state().runs.find((item) => item.runId === started.runId)
  assert.equal(run?.failure?.message, '项目命令退出码 2')
  assert.equal(gatewayStarts, 0)
  await runtime.dispose()
})

test('Owner失效后dispose仍等待活动Run释放命令、Gateway、Tunnel和logger', async () => {
  const states: Array<PluginJsonObject | null> = []
  let ownerActive = true
  let callsAfterOwnerInactive = 0
  const facade = pluginFacade(states)
  facade.setState = (state) => {
    if (!ownerActive) {
      callsAfterOwnerInactive += 1
      throw new Error('Plugin Owner 已失效')
    }
    states.push(state)
  }
  const command = deferredCommand()
  const tunnel = deferredTunnel('tunnel.example:43333')
  let gatewayClosed = 0
  let loggerClosed = 0
  const runtime = new RemoteDebugRuntime(facade, {
    createLogger: async () => testLogger(() => (loggerClosed += 1)),
    startCommand: () => command.handle,
    waitForPort: async () => undefined,
    startGateway: async () => ({
      port: 39126,
      async close() {
        gatewayClosed += 1
      }
    }),
    startTunnel: () => tunnel.handle
  })

  await runtime.start(cwd, 'web')
  await waitFor(() => Boolean(runtime.state().runs[0]?.publicUrl))
  const publishedStateCount = states.length
  ownerActive = false
  await runtime.dispose()

  assert.equal(command.stopCalls(), 1)
  assert.equal(gatewayClosed, 1)
  assert.equal(tunnel.stopCalls(), 1)
  assert.equal(loggerClosed, 1)
  assert.equal(callsAfterOwnerInactive, 0)
  assert.equal(states.length, publishedStateCount)
  assert.deepEqual(runtime.state(), { runs: [] })
})

test('准备阶段取消后logger创建完成仍会关闭且不启动命令', async () => {
  const loggerReady = deferredValue<RunLogger>()
  let signalLoggerRequest!: () => void
  const loggerRequested = new Promise<void>((resolve) => {
    signalLoggerRequest = resolve
  })
  let loggerClosed = 0
  let commandStarts = 0
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    createLogger: () => {
      signalLoggerRequest()
      return loggerReady.promise
    },
    startCommand: () => {
      commandStarts += 1
      return deferredCommand().handle
    }
  })

  const start = runtime.start(cwd, 'web')
  await loggerRequested
  await runtime.dispose()
  loggerReady.resolve(testLogger(() => (loggerClosed += 1)))
  await assert.rejects(start, /Remote Debug Runtime 已关闭/)

  assert.equal(loggerClosed, 1)
  assert.equal(commandStarts, 0)
})

test('Host发布状态失败时关闭准备好的logger并且不启动远端资源', async () => {
  const states: Array<PluginJsonObject | null> = []
  let ownerActive = true
  let callsAfterOwnerInactive = 0
  const facade = pluginFacade(states)
  facade.setState = (state) => {
    if (!ownerActive) {
      callsAfterOwnerInactive += 1
      throw new Error('Plugin Owner 已失效')
    }
    states.push(state)
  }
  let loggerClosed = 0
  let commandStarts = 0
  const runtime = new RemoteDebugRuntime(facade, {
    createLogger: async () => testLogger(() => (loggerClosed += 1)),
    startCommand: () => {
      commandStarts += 1
      return deferredCommand().handle
    }
  })
  ownerActive = false

  await assert.rejects(runtime.start(cwd, 'web'), /Plugin Owner 已失效/)
  assert.equal(loggerClosed, 1)
  assert.equal(commandStarts, 0)
  assert.equal(callsAfterOwnerInactive, 1)
  await runtime.dispose()
  assert.equal(callsAfterOwnerInactive, 1)
})

test('并行启动同一项目的不同路径写法仍只执行一次', async () => {
  const command = deferredCommand()
  const tunnel = deferredTunnel('tunnel.example:43333')
  let starts = 0
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    startCommand: () => {
      starts += 1
      return command.handle
    },
    waitForPort: async () => undefined,
    startGateway: async () => ({ port: 39127, close: async () => undefined }),
    startTunnel: () => tunnel.handle
  })
  try {
    const results = await Promise.allSettled([
      runtime.start(cwd, 'web'),
      runtime.start(cwd.replaceAll('\\', '/'), 'web')
    ])
    assert.equal(results[0]?.status, 'fulfilled')
    assert.equal(results[1]?.status, 'rejected')
    if (results[1]?.status === 'rejected') assert.match(String(results[1].reason), /正在运行/)
    assert.equal(starts, 1)
    assert.equal(runtime.state().runs.length, 1)
  } finally {
    await runtime.dispose()
  }
})

test('实际端口占用时不执行项目命令，也不停止外部服务', async () => {
  let commandStarts = 0
  let checkedPorts: readonly number[] = []
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    preparePorts: async (ports) => {
      checkedPorts = ports
      throw new Error('本机端口 30333 已被占用')
    },
    startCommand: () => {
      commandStarts += 1
      return deferredCommand().handle
    }
  })
  try {
    await assert.rejects(runtime.start(cwd, 'web'), /30333.*占用/)
    assert.deepEqual(new Set(checkedPorts), new Set([30333, 8080]))
    assert.equal(commandStarts, 0)
    assert.deepEqual(runtime.state().runs, [])
  } finally {
    await runtime.dispose()
  }
})

test('端口冲突先返回确认清单，确认重试才创建Run并启动命令', async () => {
  const conflicts = [{ port: 30333, pid: 3456, processName: 'fixture' }]
  const command = deferredCommand()
  const tunnel = deferredTunnel('tunnel.example:43333')
  let commandStarts = 0
  let loggerCreates = 0
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    preparePorts: async (_ports, confirmed) => {
      if (confirmed?.length === 0) return conflicts
      assert.deepEqual(confirmed, [{ port: 30333, pid: 3456 }])
      return []
    },
    createLogger: async () => {
      loggerCreates += 1
      return testLogger(() => undefined)
    },
    startCommand: () => {
      commandStarts += 1
      return command.handle
    },
    waitForPort: async () => undefined,
    startGateway: async () => ({ port: 39128, close: async () => undefined }),
    startTunnel: () => tunnel.handle
  })
  try {
    assert.deepEqual(await runtime.start(cwd, 'web'), { conflicts })
    assert.deepEqual(runtime.state().runs, [])
    assert.equal(commandStarts, 0)
    assert.equal(loggerCreates, 0)
    const result = await runtime.start(cwd, 'web', [{ port: 30333, pid: 3456 }])
    assert.ok('runId' in result)
    await waitFor(() => runtime.state().runs[0]?.status === 'running')
    assert.equal(commandStarts, 1)
    assert.equal(loggerCreates, 1)
  } finally {
    await runtime.dispose()
  }
})

test('隧道停止返回失败时仍清理Gateway和命令，Run不能报告已停止', async () => {
  const order: string[] = []
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    createLogger: async () =>
      testLogger(() => {
        order.push('logger')
      }),
    startCommand: () => ({
      pid: 1234,
      completion: new Promise<CommandResult>(() => undefined),
      async stop() {
        order.push('command')
        return { exitCode: 0, signal: null, error: null }
      }
    }),
    waitForPort: async () => undefined,
    startGateway: async () => ({
      port: 39129,
      close: async () => {
        order.push('gateway')
      }
    }),
    startTunnel: () => ({
      ready: Promise.resolve('tunnel.example:43333'),
      completion: new Promise<TunnelClientResult>(() => undefined),
      async stop() {
        order.push('tunnel')
        return { failed: true, detail: '未确认资源释放', exitCode: 1 }
      }
    })
  })
  try {
    const started = await runtime.start(cwd, 'web')
    assert.ok('runId' in started)
    await waitFor(() => Boolean(runtime.state().runs[0]?.publicUrl))
    const run = await runtime.stop(started.runId)
    assert.equal(run.status, 'failed')
    assert.match(run.failure?.message ?? '', /Tunnel 清理失败：未确认资源释放/)
    assert.deepEqual(order, ['tunnel', 'gateway', 'command', 'logger'])
  } finally {
    await runtime.dispose()
  }
})

test('本地就绪不等待 Gateway，Gateway 失败后仍运行且可停止', async () => {
  const command = deferredCommand()
  const gateway = deferredValue<DebugGatewayHandle>()
  let gatewayRequested = false
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    startCommand: () => command.handle,
    waitForPort: async () => undefined,
    startGateway: () => {
      gatewayRequested = true
      return gateway.promise
    }
  })
  try {
    const started = await runtime.start(cwd, 'web')
    assert.ok('runId' in started)
    await waitFor(() => gatewayRequested)
    const run = runtime.state().runs[0]
    assert.equal(run.status, 'running')
    assert.equal(run.localUrl, 'http://127.0.0.1:30333')
    assert.equal(run.publicUrl, null)
    assert.equal(run.gatewayPort, null)
    gateway.reject(new Error('Gateway 无法监听'))
    await waitFor(() => Boolean(runtime.state().runs[0]?.failure))
    assert.equal(runtime.state().runs[0]?.status, 'running')
    assert.equal(command.stopCalls(), 0)
    assert.equal((await runtime.stop(started.runId)).status, 'stopped')
    assert.equal(command.stopCalls(), 1)
  } finally {
    gateway.reject(new Error('取消 Gateway'))
    await runtime.dispose()
  }
})

test('停止期间迟到的 Gateway 会关闭且不会再申请公网端口', async () => {
  const command = deferredCommand()
  const gateway = deferredValue<DebugGatewayHandle>()
  let gatewayRequested = false
  let gatewayClosed = 0
  let tunnelStarts = 0
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    startCommand: () => command.handle,
    waitForPort: async () => undefined,
    startGateway: () => {
      gatewayRequested = true
      return gateway.promise
    },
    startTunnel: () => {
      tunnelStarts += 1
      return deferredTunnel('unused').handle
    }
  })
  try {
    const started = await runtime.start(cwd, 'web')
    assert.ok('runId' in started)
    await waitFor(() => gatewayRequested)
    const stopping = runtime.stop(started.runId)
    gateway.resolve({
      port: 39133,
      close: async () => {
        gatewayClosed += 1
      }
    })
    assert.equal((await stopping).status, 'stopped')
    assert.equal(gatewayClosed, 1)
    assert.equal(tunnelStarts, 0)
    assert.equal(command.stopCalls(), 1)
    assert.equal(runtime.state().runs[0]?.localUrl, null)
    assert.equal(runtime.state().runs[0]?.publicUrl, null)
  } finally {
    gateway.resolve({ port: 39133, close: async () => undefined })
    await runtime.dispose()
  }
})

test('隧道迟迟未就绪不阻塞本地运行，停止仍释放所有资源', async () => {
  const command = deferredCommand()
  const tunnel = deferredTunnel('tunnel.example:43333')
  let tunnelStarted = false
  let gatewayClosed = 0
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    startCommand: () => command.handle,
    waitForPort: async () => undefined,
    startGateway: async () => ({
      port: 39130,
      close: async () => {
        gatewayClosed += 1
      }
    }),
    startTunnel: () => {
      tunnelStarted = true
      return { ...tunnel.handle, ready: new Promise<string>(() => undefined) }
    }
  })
  try {
    const started = await runtime.start(cwd, 'web')
    assert.ok('runId' in started)
    await waitFor(() => tunnelStarted)
    assert.equal(runtime.state().runs[0]?.status, 'running')
    assert.equal(runtime.state().runs[0]?.localUrl, 'http://127.0.0.1:30333')
    assert.equal(runtime.state().runs[0]?.publicUrl, null)
    assert.equal(command.stopCalls(), 0)
    assert.equal((await runtime.stop(started.runId)).status, 'stopped')
    assert.equal(tunnel.stopCalls(), 1)
    assert.equal(gatewayClosed, 1)
    assert.equal(command.stopCalls(), 1)
  } finally {
    await runtime.dispose()
  }
})

test('公网运行后隧道退出仅撤下公网地址，本地继续运行', async () => {
  const command = deferredCommand()
  const tunnel = deferredTunnel('tunnel.example:43333')
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    startCommand: () => command.handle,
    waitForPort: async () => undefined,
    startGateway: async () => ({ port: 39131, close: async () => undefined }),
    startTunnel: () => tunnel.handle
  })
  try {
    await runtime.start(cwd, 'web')
    await waitFor(() => Boolean(runtime.state().runs[0]?.publicUrl))
    tunnel.resolve({ failed: true, detail: '控制服务已断开', exitCode: 1 })
    await waitFor(() => Boolean(runtime.state().runs[0]?.failure))
    assert.equal(runtime.state().runs[0]?.status, 'running')
    assert.equal(runtime.state().runs[0]?.localUrl, 'http://127.0.0.1:30333')
    assert.equal(runtime.state().runs[0]?.publicUrl, null)
    assert.match(runtime.state().runs[0]?.failure?.message ?? '', /控制服务已断开/)
    assert.equal(command.stopCalls(), 0)
    await waitFor(() => tunnel.stopCalls() === 1)
  } finally {
    await runtime.dispose()
  }
})

test('端口登记等待或失败均不阻塞配置发现及本地启动', async (context) => {
  context.mock.method(console, 'warn', () => undefined)
  const registration = deferredValue<void>()
  let syncRequested = false
  const settingsStore = new RemoteDebugSettingsStore({
    config: bindConfigStore('plugins', 'remote-debug', { agentDir: join(root, 'agent') })
  })
  context.mock.method(settingsStore, 'syncProject', () => {
    syncRequested = true
    return registration.promise
  })
  context.mock.method(settingsStore, 'get', async () => {
    throw new Error('启动不应查询公网设置')
  })
  const command = deferredCommand()
  const tunnel = deferredTunnel('tunnel.example:43333')
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    settingsStore,
    startCommand: () => command.handle,
    waitForPort: async () => undefined,
    startGateway: async () => ({ port: 39132, close: async () => undefined }),
    startTunnel: () => tunnel.handle
  })
  try {
    const projects = await runtime.catalog()
    assert.equal(projects[0]?.status, 'ready')
    assert.equal(syncRequested, true)
    await runtime.start(cwd, 'web')
    await waitFor(() => Boolean(runtime.state().runs[0]?.publicUrl))
    registration.reject(new Error('登记文件无法写入'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(runtime.state().runs[0]?.status, 'running')
    assert.equal(command.stopCalls(), 0)
  } finally {
    registration.resolve()
    await runtime.dispose()
  }
})

test('公网端口拒绝后真实项目 HTTP 与 Gateway 仍可访问，停止后端口释放', async () => {
  const directory = join(root, 'local-first-http')
  await mkdir(join(directory, '.pi'), { recursive: true })
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const script = join(directory, 'server.mjs')
  await writeFile(
    script,
    `import { createServer } from 'node:http'\ncreateServer((_req, res) => res.end('local-ready')).listen(${port}, '127.0.0.1')\n`
  )
  await writeFile(
    join(directory, '.pi', 'remote_debug.yaml'),
    `version: 1\nprofiles:\n  web:\n    command: node "${script.replaceAll('\\', '/')}"\n    entryPort: ${port}\n    publicPort: 43333\n`
  )
  const tunnel = deferredTunnel('unused')
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    startTunnel: () => ({
      ...tunnel.handle,
      ready: Promise.reject(new Error('公网端口 43333 已被占用'))
    })
  })
  let localUrl = ''
  let gatewayUrl = ''
  try {
    const started = await runtime.start(directory, 'web')
    assert.ok('runId' in started)
    await waitFor(() => Boolean(runtime.state().runs[0]?.failure))
    const run = runtime.state().runs[0]
    assert.equal(run.status, 'running')
    assert.equal(run.publicUrl, null)
    assert.equal(run.endedAt, null)
    localUrl = run.localUrl!
    gatewayUrl = `http://127.0.0.1:${run.gatewayPort}`
    assert.equal(
      await (await fetch(localUrl, { signal: AbortSignal.timeout(3000) })).text(),
      'local-ready'
    )
    assert.equal(
      await (await fetch(gatewayUrl, { signal: AbortSignal.timeout(3000) })).text(),
      'local-ready'
    )
    await waitFor(() => tunnel.stopCalls() === 1)
    assert.equal((await runtime.stop(started.runId)).status, 'stopped')
  } finally {
    await runtime.dispose()
  }
  await assert.rejects(fetch(localUrl, { signal: AbortSignal.timeout(3000) }))
  await assert.rejects(fetch(gatewayUrl, { signal: AbortSignal.timeout(3000) }))
})

function deferredCommand(): {
  handle: ManagedCommand
  resolve(result: CommandResult): void
  stopCalls(): number
} {
  let resolve!: (result: CommandResult) => void
  const completion = new Promise<CommandResult>((resolvePromise) => {
    resolve = resolvePromise
  })
  let stopped = 0
  return {
    handle: {
      pid: 1234,
      completion,
      async stop() {
        stopped += 1
        resolve({ exitCode: null, signal: 'SIGTERM', error: null })
        return completion
      }
    },
    resolve,
    stopCalls: () => stopped
  }
}

function deferredValue<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function testLogger(onClose: () => void): RunLogger {
  return {
    line: () => undefined,
    async close() {
      onClose()
    }
  } as unknown as RunLogger
}

function deferredTunnel(publicAddr: string): {
  handle: ManagedTunnelClient
  resolve(result: TunnelClientResult): void
  stopCalls(): number
} {
  let resolveCompletion!: (result: TunnelClientResult) => void
  const completion = new Promise<TunnelClientResult>((resolve) => {
    resolveCompletion = resolve
  })
  let stopped = 0
  return {
    handle: {
      ready: Promise.resolve(publicAddr),
      completion,
      async stop() {
        stopped += 1
        const result = { failed: false, detail: null, exitCode: 0 }
        resolveCompletion(result)
        return result
      }
    },
    resolve: resolveCompletion,
    stopCalls: () => stopped
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error('等待运行状态超时')
}
