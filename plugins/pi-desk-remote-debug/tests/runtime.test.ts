import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { PiDeskPluginFacade, PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'
import type { CommandResult, ManagedCommand } from '../src/command.js'
import type { DebugGatewayHandle } from '../src/gateway.js'
import type { RunLogger } from '../src/log.js'
import { RemoteDebugRuntime as Runtime } from '../src/runtime.js'

class RemoteDebugRuntime extends Runtime {
  constructor(
    plugin: PiDeskPluginFacade,
    dependencies: ConstructorParameters<typeof Runtime>[1] = {}
  ) {
    super(plugin, { assertPortsAvailable: async () => undefined, ...dependencies })
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
    notifications: {
      publish: () => '11111111-1111-4111-8111-111111111111',
      update: () => undefined,
      delete: () => undefined
    },
    setState(state) {
      states.push(state)
    },
    host: {
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
  await waitFor(() => runtime.state().runs[0]?.status === 'running')
  assert.equal(runtime.state().runs[0]?.publicUrl, 'http://tunnel.example:43333')
  assert.equal(runtime.state().runs[0]?.localUrl, 'http://127.0.0.1:30333')
  assert.deepEqual(tunnelPorts, { localPort: 39123, publicPort: 43333 })

  await runtime.stop(started.runId)

  const run = runtime.state().runs[0]
  assert.equal(run?.status, 'stopped')
  assert.equal(run?.publicUrl, null)
  assert.equal(run?.localUrl, null)
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
  await waitFor(() => runtime.state().runs[0]?.status === 'running')
  assert.equal(runtime.state().runs[0]?.runId, started.runId)
  const projects = await runtime.catalog([])
  assert.equal(projects[0]?.cwd, cwd)
  assert.equal(projects[0]?.status, 'ready')
  await runtime.stop(started.runId)
  await runtime.dispose()
})

test('活动 Run 使用相同公网端口时明确拒绝', async () => {
  const command = deferredCommand()
  const tunnel = deferredTunnel('tunnel.example:43333')
  const runtime = new RemoteDebugRuntime(pluginFacade([]), {
    startCommand: () => command.handle,
    waitForPort: async () => undefined,
    startGateway: async () => ({ port: 39125, close: async () => undefined }),
    startTunnel: () => tunnel.handle
  })

  const started = await runtime.start(cwd, 'web')
  await waitFor(() => runtime.state().runs[0]?.status === 'running')
  await assert.rejects(runtime.start(cwd, 'api'), /公网端口 43333 正在被 web 使用/)
  await runtime.stop(started.runId)
  await runtime.dispose()
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
  await waitFor(() => runtime.state().runs[0]?.status === 'running')
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
    assertPortsAvailable: async (ports) => {
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
