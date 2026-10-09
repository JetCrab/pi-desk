import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

const projectRoot = resolve('.')
const testRoot = resolve(
  process.env.PI_DESK_RESTART_MODE_AGENT_DIR ??
    join('temp', 'pi', 'l4-restart-mode', String(process.pid), 'agent')
)
const preserveFixtures = process.env.PI_DESK_RESTART_MODE_KEEP_FIXTURES === '1'
const processControlEntry = resolve(projectRoot, 'bin/pi-desk.js')

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function withTimeout(promise, label, timeoutMs = 5_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}等待超时`)), timeoutMs)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  throw new Error(`${label}等待超时`)
}

async function readEvents(path) {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function readDiagnostics(path) {
  const marker = ' [Pi Desk][CLI] '
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.includes(marker) && line.includes(' {'))
    .map((line) => {
      const jsonAt = line.indexOf(' {')
      return {
        message: line.slice(line.indexOf(marker) + marker.length, jsonAt),
        details: JSON.parse(line.slice(jsonAt + 1))
      }
    })
}

async function startCliFixture(scenario, extraArgs = []) {
  const root = join(testRoot, scenario)
  await mkdir(root, { recursive: true })
  const fixtureLog = join(root, 'events.jsonl')
  const managedLog = join(root, 'Pi Desk.log')
  const preload = join(root, 'child-process-fixture.cjs')
  await writeFile(
    preload,
    `const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs')
const originalSpawn = childProcess.spawn
let serviceIndex = 0
function record(event) {
  fs.appendFileSync(process.env.PI_DESK_CLI_FIXTURE_LOG, JSON.stringify(event) + '\\n')
}
function restartWithMaintenance(child, maintenance, mode, code = 75) {
  child.emit('message', { type: 'pi-desk.plugin-maintenance', maintenance })
  if (mode) child.emit('message', { type: 'pi-desk.restart-mode', mode })
  if (code === 75) child.emit('message', { type: 'pi-desk.shutting-down', source: 'RESTART' })
  child.finish(code)
}
class FixtureChild extends EventEmitter {
  constructor(kind, options) {
    super()
    this.kind = kind
    this.options = options
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.connected = true
    this.exitCode = null
    this.signalCode = null
    this.pid = undefined
    if (kind === 'service') {
      this.index = ++serviceIndex
      record({
        kind: 'service-start',
        index: this.index,
        safeMode: options.env.PI_DESK_SAFE_MODE,
        standby: options.env.PI_DESK_STANDBY,
        maintenanceError: options.env.PI_DESK_PLUGIN_MAINTENANCE_ERROR
      })
      setImmediate(() => {
        this.emit('message', { type: 'pi-desk.supervisor-ready' })
        if (options.env.PI_DESK_STANDBY === '1') {
          this.emit('message', { type: 'pi-desk.standby-ready' })
        }
      })
    }
  }
  send(message, callback) {
    if (callback) setImmediate(() => callback(null))
    if (this.exitCode !== null) return
    if (message === 'pi-desk.shutdown') {
      setImmediate(() => this.finish(0))
      return
    }
    if (message !== 'pi-desk.restart') return
    setImmediate(() => {
      const scenario = process.env.PI_DESK_CLI_FIXTURE_SCENARIO
      if (scenario === 'pending-maintenance-failure' && this.index === 1) {
        this.emit('message', {
          type: 'pi-desk.plugin-maintenance',
          maintenance: { action: 'install', source: 'npm:must-not-run-fixture' }
        })
        this.finish(1)
      } else if (scenario === 'code75-restart' && this.index === 1) {
        this.emit('message', { type: 'pi-desk.shutting-down', source: 'RESTART' })
        this.finish(75)
      } else if (scenario === 'basic-to-normal-code75' && this.index === 1) {
        this.emit('message', { type: 'pi-desk.restart-mode', mode: 'normal' })
        this.emit('message', { type: 'pi-desk.shutting-down', source: 'RESTART' })
        this.finish(75)
      } else if (scenario === 'normal-to-basic-code75' && this.index === 1) {
        this.emit('message', {
          type: 'pi-desk.plugin-maintenance',
          maintenance: { action: 'install', source: 'npm:must-not-run-fixture' }
        })
        this.emit('message', { type: 'pi-desk.restart-mode', mode: 'basic' })
        this.emit('message', { type: 'pi-desk.shutting-down', source: 'RESTART' })
        this.finish(75)
      } else if (scenario === 'basic-normal-unexpected-exit' && this.index === 1) {
        this.emit('message', { type: 'pi-desk.restart-mode', mode: 'normal' })
        this.finish(1)
      } else if (scenario === 'maintenance-batch-success' && this.index === 1) {
        restartWithMaintenance(this, [
          { action: 'install', source: 'npm:batch-first' },
          { action: 'update', source: 'npm:batch-second' },
          { action: 'remove', source: 'npm:batch-third' }
        ])
      } else if (scenario === 'maintenance-single-success' && this.index === 1) {
        restartWithMaintenance(this, { action: 'update', source: 'npm:legacy-single' })
      } else if (scenario === 'maintenance-batch-failure' && this.index === 1) {
        restartWithMaintenance(this, [
          { action: 'install', source: 'npm:batch-first' },
          { action: 'update', source: 'npm:batch-fail-second' },
          { action: 'remove', source: 'npm:batch-third' }
        ])
      } else if (scenario === 'maintenance-batch-basic' && this.index === 1) {
        restartWithMaintenance(
          this,
          [{ action: 'install', source: 'npm:must-not-run-basic' }],
          'basic'
        )
      } else if (scenario === 'maintenance-batch-non75' && this.index === 1) {
        restartWithMaintenance(
          this,
          [{ action: 'install', source: 'npm:must-not-run-failure' }],
          null,
          1
        )
      } else if (scenario === 'maintenance-invalid-inputs' && this.index === 1) {
        for (const maintenance of [
          [],
          Array.from({ length: 33 }, (_, index) => ({
            action: 'install',
            source: 'npm:too-many-' + index
          })),
          [
            { action: 'install', source: 'npm:duplicate' },
            { action: 'update', source: 'npm:duplicate' }
          ],
          [{ action: 'apply', source: 'npm:invalid-action' }]
        ]) {
          this.emit('message', { type: 'pi-desk.plugin-maintenance', maintenance })
        }
        this.emit('message', { type: 'pi-desk.shutting-down', source: 'RESTART' })
        this.finish(75)
      } else if (
        (scenario === 'safe-mode-failure' || scenario === 'standby-failure') &&
        this.index === 1
      ) {
        this.finish(1)
      }
    })
  }
  finish(code) {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.connected = false
    this.emit('exit', code, null)
    this.emit('close', code, null)
    this.stdout.end()
    this.stderr.end()
  }
}
childProcess.spawn = function (command, args, options) {
  const argv = Array.isArray(args) ? args : []
  if (argv.some((argument) => String(argument).includes('l1-server.ts'))) {
    return new FixtureChild('service', options)
  }
  if (argv.some((argument) => String(argument).includes('l4-pi-package-maintenance-runner'))) {
    const action = argv.at(-2)
    const source = argv.at(-1)
    record({ kind: 'maintenance-runner-start', action, source })
    const child = new FixtureChild('maintenance', options)
    const exitCode =
      process.env.PI_DESK_CLI_FIXTURE_SCENARIO === 'maintenance-batch-failure' &&
      source === 'npm:batch-fail-second'
        ? 1
        : 0
    setImmediate(() => child.finish(exitCode))
    return child
  }
  return originalSpawn.call(this, command, args, options)
}
`,
    'utf8'
  )
  const child = spawn(
    process.execPath,
    [
      '--require',
      preload,
      processControlEntry,
      '--no-open',
      '--hostname',
      '127.0.0.1',
      '--port',
      '63271',
      ...extraArgs
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PI_DESK_CLI_FIXTURE_LOG: fixtureLog,
        PI_DESK_CLI_FIXTURE_SCENARIO: scenario,
        PI_DESK_LOG_FILE: managedLog
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    }
  )
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  const exit = once(child, 'exit')
  return { child, exit, output: () => output, fixtureLog, managedLog, root }
}

async function stopCliFixture(runtime) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return
  if (runtime.child.connected) runtime.child.send('pi-desk.shutdown')
  await withTimeout(runtime.exit, 'fixture CLI graceful stop').catch(() => {
    runtime.child.kill()
  })
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill()
    await withTimeout(runtime.exit, 'fixture CLI process exit')
  }
}

test(
  'CLI故障fallback丢弃pending maintenance且code75保持normal重启',
  { timeout: 25_000 },
  async (context) => {
    const pending = await startCliFixture('pending-maintenance-failure')
    const code75 = await startCliFixture('code75-restart')
    context.after(async () => {
      await Promise.all([stopCliFixture(pending), stopCliFixture(code75)])
      if (!preserveFixtures) {
        await Promise.all([
          rm(pending.root, { recursive: true, force: true }),
          rm(code75.root, { recursive: true, force: true })
        ])
      }
    })

    await waitFor(
      async () =>
        (await readEvents(pending.fixtureLog)).some((event) => event.kind === 'service-start'),
      'pending fixture startup'
    )
    assert.equal(pending.child.send('pi-desk.restart'), true)
    await waitFor(
      async () =>
        (await readEvents(pending.fixtureLog)).filter((event) => event.kind === 'service-start')
          .length === 2,
      'safe fallback second service'
    )
    const pendingEvents = await readEvents(pending.fixtureLog)
    assert.equal(
      pendingEvents.some((event) => event.kind === 'maintenance-runner-start'),
      false
    )
    assert.equal(pendingEvents[1]?.safeMode, '1')
    assert.match(pending.output(), /不重放消息、工具或插件维护操作/)
    await waitFor(
      async () =>
        (await readDiagnostics(pending.managedLog)).filter(
          (entry) => entry.message === '托管服务已创建'
        ).length === 2,
      'fallback creation diagnostics'
    )
    const pendingDiagnostics = await readDiagnostics(pending.managedLog)
    assert.deepEqual(
      pendingDiagnostics
        .filter((entry) => entry.message === '托管服务已创建')
        .map((entry) => entry.details.mode),
      ['normal', 'basic']
    )
    assert.ok(pendingDiagnostics.every((entry) => entry.details.parentPid === pending.child.pid))
    const released = pendingDiagnostics.find((entry) => entry.message === '托管服务进程树已释放')
    assert.ok(released.details.terminationMs >= 0)
    assert.equal(released.details.exitCode, 1)
    assert.equal(released.details.signal, null)
    const recovery = pendingDiagnostics.find((entry) =>
      entry.message.includes('正在以基础模式恢复')
    )
    assert.equal(recovery.details.reason, '服务未声明关闭却退出')
    assert.equal(recovery.details.mode, 'normal')
    pending.child.send('pi-desk.shutdown')
    const [pendingExitCode] = await withTimeout(pending.exit, 'pending fallback CLI shutdown')
    assert.equal(pendingExitCode, 0)

    await waitFor(
      async () => (await readEvents(code75.fixtureLog)).length > 0,
      'code75 fixture startup'
    )
    assert.equal(code75.child.send('pi-desk.restart'), true)
    await waitFor(
      async () =>
        (await readEvents(code75.fixtureLog)).filter((event) => event.kind === 'service-start')
          .length === 2,
      'code75 service restart'
    )
    await waitFor(
      async () =>
        (await readDiagnostics(code75.managedLog)).filter(
          (entry) => entry.message === '托管服务已创建'
        ).length === 2,
      'restart creation diagnostics'
    )
    const code75Events = await readEvents(code75.fixtureLog)
    assert.equal(code75Events[1]?.safeMode, '')
    assert.match(await readFile(code75.managedLog, 'utf8'), /正在应用插件变化并重新启动/)
    const restart = (await readDiagnostics(code75.managedLog)).find((entry) =>
      entry.message.includes('正在应用插件变化并重新启动')
    )
    assert.equal(restart.details.nextMode, 'normal')
    code75.child.send('pi-desk.shutdown')
    const [code75ExitCode] = await withTimeout(code75.exit, 'code75 fixture CLI shutdown')
    assert.equal(code75ExitCode, 0)
  }
)

test('托管重启仅在code75时应用child模式选择', { timeout: 45_000 }, async (context) => {
  const recoverNormal = await startCliFixture('basic-to-normal-code75', ['--safe-mode'])
  const switchBasic = await startCliFixture('normal-to-basic-code75')
  const rejectUncommittedMode = await startCliFixture('basic-normal-unexpected-exit', [
    '--safe-mode'
  ])
  const fixtures = [recoverNormal, switchBasic, rejectUncommittedMode]
  context.after(async () => {
    await Promise.all(fixtures.map(stopCliFixture))
    if (!preserveFixtures) {
      await Promise.all(
        fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true }))
      )
    }
  })

  await Promise.all(
    fixtures.map((fixture) =>
      waitFor(
        async () =>
          (await readEvents(fixture.fixtureLog)).some((event) => event.kind === 'service-start'),
        `${fixture.root} startup`
      )
    )
  )
  for (const fixture of fixtures) assert.equal(fixture.child.send('pi-desk.restart'), true)

  const [unexpectedExitCode] = await withTimeout(
    rejectUncommittedMode.exit,
    'basic mode unexpected exit'
  )
  assert.notEqual(unexpectedExitCode, 0)
  assert.equal(
    (await readEvents(rejectUncommittedMode.fixtureLog)).filter(
      (event) => event.kind === 'service-start'
    ).length,
    1
  )

  await Promise.all(
    [recoverNormal, switchBasic].map((fixture) =>
      waitFor(
        async () =>
          (await readEvents(fixture.fixtureLog)).filter((event) => event.kind === 'service-start')
            .length === 2,
        `${fixture.root} code75 restart`
      )
    )
  )
  const normalEvents = await readEvents(recoverNormal.fixtureLog)
  assert.equal(normalEvents[0]?.safeMode, '1')
  assert.equal(normalEvents[1]?.safeMode, '')

  const basicEvents = await readEvents(switchBasic.fixtureLog)
  assert.equal(basicEvents[0]?.safeMode, '')
  assert.equal(basicEvents[1]?.safeMode, '1')
  assert.equal(
    basicEvents.some((event) => event.kind === 'maintenance-runner-start'),
    false
  )

  for (const fixture of [recoverNormal, switchBasic]) {
    fixture.child.send('pi-desk.shutdown')
    const [exitCode] = await withTimeout(fixture.exit, 'mode fixture graceful shutdown')
    assert.equal(exitCode, 0)
  }
})

test('CLI按顺序执行维护批次并兼容旧single请求', { timeout: 45_000 }, async (context) => {
  const batch = await startCliFixture('maintenance-batch-success')
  const legacy = await startCliFixture('maintenance-single-success')
  const fixtures = [batch, legacy]
  context.after(async () => {
    await Promise.all(fixtures.map(stopCliFixture))
    if (!preserveFixtures) {
      await Promise.all(
        fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true }))
      )
    }
  })

  await Promise.all(
    fixtures.map((fixture) =>
      waitFor(
        async () =>
          (await readEvents(fixture.fixtureLog)).some((event) => event.kind === 'service-start'),
        `${fixture.root} startup`
      )
    )
  )
  for (const fixture of fixtures) assert.equal(fixture.child.send('pi-desk.restart'), true)
  await Promise.all(
    fixtures.map((fixture) =>
      waitFor(
        async () =>
          (await readEvents(fixture.fixtureLog)).filter((event) => event.kind === 'service-start')
            .length === 2,
        `${fixture.root} maintenance handoff`
      )
    )
  )

  const batchEvents = await readEvents(batch.fixtureLog)
  assert.deepEqual(
    batchEvents
      .filter((event) => event.kind === 'maintenance-runner-start')
      .map(({ action, source }) => ({ action, source })),
    [
      { action: 'install', source: 'npm:batch-first' },
      { action: 'update', source: 'npm:batch-second' },
      { action: 'remove', source: 'npm:batch-third' }
    ]
  )
  const batchServices = batchEvents.filter((event) => event.kind === 'service-start')
  assert.equal(batchServices.length, 2)
  assert.equal(batchServices[1]?.safeMode, '')

  const legacyEvents = await readEvents(legacy.fixtureLog)
  assert.deepEqual(
    legacyEvents
      .filter((event) => event.kind === 'maintenance-runner-start')
      .map(({ action, source }) => ({ action, source })),
    [{ action: 'update', source: 'npm:legacy-single' }]
  )
  for (const fixture of fixtures) {
    fixture.child.send('pi-desk.shutdown')
    const [exitCode] = await withTimeout(fixture.exit, 'maintenance fixture graceful shutdown')
    assert.equal(exitCode, 0)
  }
})

test('CLI批次失败停止后续操作并隔离basic与非75重启', { timeout: 45_000 }, async (context) => {
  const failed = await startCliFixture('maintenance-batch-failure')
  const basic = await startCliFixture('maintenance-batch-basic')
  const unexpected = await startCliFixture('maintenance-batch-non75')
  const fixtures = [failed, basic, unexpected]
  context.after(async () => {
    await Promise.all(fixtures.map(stopCliFixture))
    if (!preserveFixtures) {
      await Promise.all(
        fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true }))
      )
    }
  })

  await Promise.all(
    fixtures.map((fixture) =>
      waitFor(
        async () =>
          (await readEvents(fixture.fixtureLog)).some((event) => event.kind === 'service-start'),
        `${fixture.root} startup`
      )
    )
  )
  for (const fixture of fixtures) assert.equal(fixture.child.send('pi-desk.restart'), true)
  await Promise.all(
    fixtures.map((fixture) =>
      waitFor(
        async () =>
          (await readEvents(fixture.fixtureLog)).filter((event) => event.kind === 'service-start')
            .length === 2,
        `${fixture.root} recovery`
      )
    )
  )

  const failedEvents = await readEvents(failed.fixtureLog)
  assert.deepEqual(
    failedEvents
      .filter((event) => event.kind === 'maintenance-runner-start')
      .map(({ action, source }) => ({ action, source })),
    [
      { action: 'install', source: 'npm:batch-first' },
      { action: 'update', source: 'npm:batch-fail-second' }
    ]
  )
  assert.equal(failedEvents[failedEvents.length - 1]?.safeMode, '1')
  assert.match(failedEvents[failedEvents.length - 1]?.maintenanceError, /第 2\/3 项失败/)
  assert.match(await readFile(failed.managedLog, 'utf8'), /第 2\/3 项失败/)

  for (const fixture of [basic, unexpected]) {
    const events = await readEvents(fixture.fixtureLog)
    assert.equal(
      events.some((event) => event.kind === 'maintenance-runner-start'),
      false
    )
    assert.equal(events.filter((event) => event.kind === 'service-start')[1]?.safeMode, '1')
  }

  for (const fixture of fixtures) {
    fixture.child.send('pi-desk.shutdown')
    const [exitCode] = await withTimeout(fixture.exit, 'maintenance recovery graceful shutdown')
    assert.equal(exitCode, 0)
  }
})

test('CLI拒绝空批次、超限、重复来源和非法action', { timeout: 25_000 }, async (context) => {
  const fixture = await startCliFixture('maintenance-invalid-inputs')
  context.after(async () => {
    await stopCliFixture(fixture)
    if (!preserveFixtures) await rm(fixture.root, { recursive: true, force: true })
  })

  await waitFor(
    async () =>
      (await readEvents(fixture.fixtureLog)).some((event) => event.kind === 'service-start'),
    'invalid maintenance fixture startup'
  )
  assert.equal(fixture.child.send('pi-desk.restart'), true)
  await waitFor(
    async () =>
      (await readEvents(fixture.fixtureLog)).filter((event) => event.kind === 'service-start')
        .length === 2,
    'invalid maintenance restart'
  )
  const events = await readEvents(fixture.fixtureLog)
  assert.equal(
    events.some((event) => event.kind === 'maintenance-runner-start'),
    false
  )
  assert.equal(events[1]?.safeMode, '')
  assert.equal((fixture.output().match(/忽略了无效的服务 IPC 消息/g) ?? []).length, 4)

  fixture.child.send('pi-desk.shutdown')
  const [exitCode] = await withTimeout(fixture.exit, 'invalid fixture graceful shutdown')
  assert.equal(exitCode, 0)
})

test('safe mode故障与未激活standby故障均停止而不循环重启', { timeout: 25_000 }, async (context) => {
  const safe = await startCliFixture('safe-mode-failure', ['--safe-mode'])
  const standbyRoot = join(testRoot, 'standby-failure')
  await mkdir(standbyRoot, { recursive: true })
  const readyFile = join(standbyRoot, 'ready')
  const activateFile = join(standbyRoot, 'activate')
  const standby = await startCliFixture('standby-failure', [
    '--standby-ready-file',
    readyFile,
    '--standby-activate-file',
    activateFile
  ])
  context.after(async () => {
    await Promise.all([stopCliFixture(safe), stopCliFixture(standby)])
    if (!preserveFixtures) {
      await Promise.all([
        rm(safe.root, { recursive: true, force: true }),
        rm(standby.root, { recursive: true, force: true })
      ])
    }
  })

  await waitFor(
    async () => (await readEvents(safe.fixtureLog)).length > 0,
    'safe mode fixture startup'
  )
  assert.equal(safe.child.send('pi-desk.restart'), true)
  const [safeExitCode] = await withTimeout(safe.exit, 'safe mode failure stop')
  assert.notEqual(safeExitCode, 0)
  assert.equal(
    (await readEvents(safe.fixtureLog)).filter((event) => event.kind === 'service-start').length,
    1
  )

  await waitFor(() => existsSync(readyFile), 'standby ready file')
  assert.equal(standby.child.send('pi-desk.restart'), true)
  const [standbyExitCode] = await withTimeout(standby.exit, 'unactivated standby failure stop')
  assert.notEqual(standbyExitCode, 0)
  assert.equal(
    (await readEvents(standby.fixtureLog)).filter((event) => event.kind === 'service-start').length,
    1
  )
})

test.after(async () => {
  if (!preserveFixtures) await rm(testRoot, { recursive: true, force: true })
})
