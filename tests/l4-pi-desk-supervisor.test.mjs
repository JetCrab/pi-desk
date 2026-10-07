import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  watchManagedChild
} = require('../src/server/l4_foundation/process/l4-pi-desk-supervisor.js')
const projectRoot = resolve('.')
const heartbeatIntervalMs = 5_000

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error(`${label}等待超时`)
}

function observeSupervisor(options = {}) {
  const failures = []
  const failureDetails = []
  const diagnostics = []
  const supervisor = watchManagedChild(
    (message, details) => {
      failures.push(message)
      failureDetails.push(details)
    },
    {
      ...options,
      onDiagnostic(message, details) {
        diagnostics.push({ message, ...details })
      }
    }
  )
  return { failures, failureDetails, diagnostics, supervisor }
}

function useVirtualClock(context) {
  context.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100_000 })
  context.mock.method(performance, 'now', () => Date.now())
  return (milliseconds) => {
    while (milliseconds > 0) {
      const step = Math.min(1_000, milliseconds)
      context.mock.timers.tick(step)
      milliseconds -= step
    }
  }
}

function sample(sentAt) {
  return {
    sentAt,
    intervalMs: 5_000,
    timerDelayMs: 0,
    cpuMs: 12,
    rssBytes: 64 * 1024 * 1024,
    heapUsedBytes: 16 * 1024 * 1024
  }
}

test('运行期默认60秒超时，15秒警告一次且超时后释放监护', (context) => {
  const advance = useVirtualClock(context)
  const { failures, failureDetails, diagnostics, supervisor } = observeSupervisor()
  try {
    supervisor.accept({ type: 'pi-desk.supervisor-ready' })
    advance(14_000)
    assert.deepEqual(diagnostics, [])
    advance(1_000)
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0].message, /超过15秒/)
    assert.equal(diagnostics[0].heartbeatAgeMs, 15_000)
    assert.equal(diagnostics[0].deadlineAt, 160_000)
    assert.equal(diagnostics[0].lastHeartbeat, null)

    advance(44_000)
    assert.deepEqual(failures, [])
    assert.equal(diagnostics.length, 1)
    advance(1_000)
    assert.deepEqual(failures, ['服务事件循环持续无响应'])
    assert.equal(failureDetails[0].phase, 'ready')
    assert.equal(failureDetails[0].heartbeatAgeMs, 60_000)
    assert.equal(failureDetails[0].checkDelayMs, 0)

    supervisor.accept({ type: 'pi-desk.supervisor-ready' })
    supervisor.accept({ type: 'pi-desk.heartbeat', diagnostics: sample(Date.now()) })
    advance(60_000)
    assert.equal(failures.length, 1)
    assert.equal(diagnostics.length, 1)
  } finally {
    supervisor.dispose()
  }
})

test('正常心跳不刷日志，显式dispose后忽略迟到事件', (context) => {
  const advance = useVirtualClock(context)
  const { failures, diagnostics, supervisor } = observeSupervisor()
  try {
    supervisor.accept({ type: 'pi-desk.supervisor-ready' })
    for (let index = 0; index < 15; index += 1) {
      advance(5_000)
      supervisor.accept({ type: 'pi-desk.heartbeat', diagnostics: sample(Date.now()) })
    }
    assert.deepEqual(failures, [])
    assert.deepEqual(diagnostics, [])
    supervisor.dispose()
    advance(60_000)
    supervisor.accept({ type: 'pi-desk.heartbeat', diagnostics: sample(Date.now() - 5_000) })
    assert.deepEqual(failures, [])
    assert.deepEqual(diagnostics, [])
  } finally {
    supervisor.dispose()
  }
})

test('失联与恢复日志标明最后采样年龄，只保留最新心跳并兼容旧payload', (context) => {
  const advance = useVirtualClock(context)
  const { failures, diagnostics, supervisor } = observeSupervisor()
  try {
    supervisor.accept({ type: 'pi-desk.supervisor-ready' })
    const previousSample = sample(Date.now() - 10)
    supervisor.accept({ type: 'pi-desk.heartbeat', diagnostics: previousSample })
    advance(15_000)
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].lastHeartbeat.receivedAt, 100_000)
    assert.equal(diagnostics[0].heartbeatAgeMs, 15_000)
    assert.equal(diagnostics[0].lastHeartbeat.sampleAgeMs, 15_010)
    assert.equal(diagnostics[0].lastHeartbeat.transportDelayMs, 10)
    assert.deepEqual(diagnostics[0].lastHeartbeat.sample, previousSample)

    advance(3_000)
    const latestSample = sample(Date.now() - 20)
    supervisor.accept({ type: 'pi-desk.heartbeat', diagnostics: latestSample })
    assert.equal(diagnostics.length, 2)
    assert.match(diagnostics[1].message, /已恢复/)
    assert.equal(diagnostics[1].missingMs, 18_000)
    assert.equal(diagnostics[1].heartbeatAgeMs, 0)
    assert.equal(diagnostics[1].lastHeartbeat.sampleAgeMs, 20)
    assert.deepEqual(diagnostics[1].lastHeartbeat.sample, latestSample)

    advance(15_000)
    assert.equal(diagnostics.length, 3)
    supervisor.accept({ type: 'pi-desk.heartbeat' })
    assert.equal(diagnostics.length, 4)
    assert.equal(diagnostics[3].lastHeartbeat.sample, null)
    assert.equal(diagnostics[3].lastHeartbeat.transportDelayMs, null)
    assert.deepEqual(failures, [])
  } finally {
    supervisor.dispose()
  }
})

test('心跳传输延迟限频30秒，超时诊断不冒充当前资源采样', (context) => {
  const advance = useVirtualClock(context)
  const { failures, failureDetails, diagnostics, supervisor } = observeSupervisor()
  try {
    supervisor.accept({ type: 'pi-desk.supervisor-ready' })
    for (let index = 0; index < 7; index += 1) {
      advance(5_000)
      supervisor.accept({ type: 'pi-desk.heartbeat', diagnostics: sample(Date.now() - 2_000) })
    }
    assert.equal(diagnostics.length, 2)
    assert.ok(diagnostics.every((entry) => entry.message === '服务心跳接收延迟'))
    assert.equal(diagnostics[1].lastHeartbeat.transportDelayMs, 2_000)
    advance(60_000)
    assert.deepEqual(failures, ['服务事件循环持续无响应'])
    assert.equal(failureDetails[0].heartbeatAgeMs, 60_000)
    assert.equal(failureDetails[0].lastHeartbeat.sampleAgeMs, 62_000)
    assert.equal(failureDetails[0].lastHeartbeat.sample.sentAt, 133_000)
  } finally {
    supervisor.dispose()
  }
})

test('Supervisor分别对未ready、heartbeat丢失和关闭超时失败', { timeout: 5_000 }, async () => {
  const startup = observeSupervisor({ intervalMs: 5, startupTimeoutMs: 20 })
  try {
    await waitFor(() => startup.failures.length > 0, 'startup deadline', 500)
    assert.deepEqual(startup.failures, ['服务启动未在截止时间内就绪'])
  } finally {
    startup.supervisor.dispose()
  }

  const heartbeat = observeSupervisor({
    intervalMs: 5,
    startupTimeoutMs: 100,
    heartbeatTimeoutMs: 20
  })
  try {
    heartbeat.supervisor.accept({ type: 'pi-desk.supervisor-ready' })
    await waitFor(() => heartbeat.failures.length > 0, 'heartbeat deadline', 500)
    assert.deepEqual(heartbeat.failures, ['服务事件循环持续无响应'])
  } finally {
    heartbeat.supervisor.dispose()
  }

  const shutdown = observeSupervisor({
    intervalMs: 5,
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 20
  })
  try {
    shutdown.supervisor.accept({ type: 'pi-desk.supervisor-ready' })
    shutdown.supervisor.accept({ type: 'pi-desk.shutting-down' })
    shutdown.supervisor.accept({ type: 'pi-desk.heartbeat' })
    await waitFor(() => shutdown.failures.length > 0, 'shutdown deadline', 500)
    assert.deepEqual(shutdown.failures, ['服务关闭未在截止时间内完成'])
  } finally {
    shutdown.supervisor.dispose()
  }
})

test('Supervisor遇到父进程计时跳变时延长截止期而不立即误杀', { timeout: 5_000 }, async () => {
  const originalNow = Date.now
  let fakeNow = 1_000
  Date.now = () => fakeNow
  const { failures, failureDetails, diagnostics, supervisor } = observeSupervisor({
    intervalMs: 10,
    startupTimeoutMs: 30
  })
  try {
    await delay(15)
    fakeNow += 60_000
    await delay(15)
    assert.deepEqual(failures, [])
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0].message, /计时跳变/)
    assert.equal(diagnostics[0].previousDeadlineAt, 1_030)
    assert.equal(diagnostics[0].deadlineAt, 61_030)

    fakeNow += 31
    await waitFor(() => failures.length > 0, 'jump grace deadline', 500)
    assert.deepEqual(failures, ['服务启动未在截止时间内就绪'])
    assert.equal(failureDetails[0].phase, 'starting')
  } finally {
    supervisor.dispose()
    Date.now = originalNow
  }
})

function runHeartbeatFixture(scenario) {
  const supervisorPath =
    require.resolve('../src/server/l4_foundation/process/l4-pi-desk-supervisor.js')
  const source = `
    const { mock } = require('node:test')
    const { performance } = require('node:perf_hooks')
    const { startManagedHeartbeat } = require(${JSON.stringify(supervisorPath)})
    const scenario = process.argv[1]
    const messages = []
    const warnings = []
    process.env.PI_DESK_MANAGED_RESTART = scenario === 'unmanaged' ? '' : '1'
    process.connected = true
    process.send = (message, callback) => {
      messages.push(message)
      if (scenario === 'delayed-error' && message.type !== 'pi-desk.supervisor-ready') {
        const error = Object.assign(new Error('fixture-send-failure'), { code: 'FIXTURE_SEND' })
        if (messages.length === 2) throw error
        callback(error)
      } else {
        callback(null)
      }
    }
    console.warn = (...args) => warnings.push(args)
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100000 })
    mock.method(performance, 'now', () => Date.now())
    const disconnectListeners = process.listenerCount('disconnect')
    const heartbeat = startManagedHeartbeat()
    heartbeat.ready()
    for (let index = 0; index < 6; index += 1) {
      mock.timers.tick(scenario === 'delayed-error' ? 6000 : 5000)
    }
    const warningsBeforeClosing = warnings.length
    heartbeat.closing('IPC')
    mock.timers.tick(6000)
    const warningsAfterClosing = warnings.length
    heartbeat.dispose()
    const messagesBeforeDispose = messages.length
    mock.timers.tick(60000)
    heartbeat.ready()
    heartbeat.closing('IPC')
    const listenersReleased = process.listenerCount('disconnect') === disconnectListeners
    mock.restoreAll()
    mock.timers.reset()
    process.stdout.write(JSON.stringify({
      messages,
      warnings,
      warningsBeforeClosing,
      warningsAfterClosing,
      messagesBeforeDispose,
      listenersReleased
    }))
  `
  const result = spawnSync(process.execPath, ['-e', source, scenario], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('服务端正常采样不刷日志，非托管入口不创建心跳，dispose释放资源', () => {
  for (const scenario of ['normal', 'unmanaged']) {
    const result = runHeartbeatFixture(scenario)
    assert.deepEqual(result.warnings, [])
    assert.equal(result.listenersReleased, true)
    assert.equal(result.messages.length, result.messagesBeforeDispose)
    if (scenario === 'unmanaged') assert.deepEqual(result.messages, [])
    else assert.ok(result.messages.some((message) => message.type === 'pi-desk.heartbeat'))
  }
})

test('服务端定时器延迟与两类发送失败分别限频，关闭阶段不记发送故障', () => {
  const result = runHeartbeatFixture('delayed-error')
  const delayWarnings = result.warnings.filter(([message]) => message.includes('定时器执行延迟'))
  const sendWarnings = result.warnings.filter(([message]) => message.includes('通知发送失败'))
  assert.equal(delayWarnings.length, 2)
  assert.equal(sendWarnings.length, 2)
  assert.equal(delayWarnings[0][1].timerDelayMs, 1_000)
  assert.equal(delayWarnings[0][1].intervalMs, 6_000)
  assert.ok(delayWarnings[0][1].servicePid > 0)
  assert.ok(delayWarnings[0][1].rssBytes > 0)
  assert.equal(sendWarnings[0][1].errorCode, 'FIXTURE_SEND')
  assert.equal(sendWarnings[0][1].errorMessage, 'fixture-send-failure')
  assert.equal(result.warningsBeforeClosing, result.warningsAfterClosing)
  assert.equal(result.listenersReleased, true)
  assert.equal(result.messages.length, result.messagesBeforeDispose)
})

test(
  'managed child在受控长请求无输出期间持续发送heartbeat',
  { timeout: 10_000 },
  async (context) => {
    const supervisorPath =
      require.resolve('../src/server/l4_foundation/process/l4-pi-desk-supervisor.js')
    const source = `
    const { startManagedHeartbeat } = require(${JSON.stringify(supervisorPath)})
    const disconnectListeners = process.listenerCount('disconnect')
    const heartbeat = startManagedHeartbeat()
    heartbeat.ready()
    const controlledLongRequest = new Promise((resolve) => setTimeout(resolve, 6500))
    void controlledLongRequest.then(() => {
      heartbeat.dispose()
      process.send(
        {
          type: 'fixture-disposed',
          listenersReleased: process.listenerCount('disconnect') === disconnectListeners
        },
        () => process.exit(0)
      )
    })
  `
    const child = spawn(process.execPath, ['-e', source], {
      cwd: projectRoot,
      env: { ...process.env, PI_DESK_MANAGED_RESTART: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true
    })
    const messages = []
    child.on('message', (message) => messages.push(message))
    const exit = once(child, 'exit')
    context.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await Promise.race([exit.catch(() => undefined), delay(2_000)])
    })

    await waitFor(
      () => messages.some((message) => message?.type === 'pi-desk.supervisor-ready'),
      'managed ready'
    )
    await waitFor(
      () => messages.some((message) => message?.type === 'pi-desk.heartbeat'),
      'periodic heartbeat',
      heartbeatIntervalMs + 2_000
    )
    const diagnostics = messages.find(
      (message) => message?.type === 'pi-desk.heartbeat'
    ).diagnostics
    assert.ok(Number.isFinite(diagnostics.sentAt))
    assert.ok(diagnostics.intervalMs > 0)
    assert.ok(diagnostics.timerDelayMs >= 0)
    assert.ok(diagnostics.cpuMs >= 0)
    assert.ok(diagnostics.rssBytes > 0)
    assert.ok(diagnostics.heapUsedBytes > 0)
    assert.equal(
      messages.some((message) => message?.type === 'pi-desk.shutting-down'),
      false
    )
    await Promise.race([
      exit,
      delay(2_000).then(() => {
        throw new Error('fixture child未退出')
      })
    ])
    assert.equal(
      messages.find((message) => message?.type === 'fixture-disposed').listenersReleased,
      true
    )
  }
)
