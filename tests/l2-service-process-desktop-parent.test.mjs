import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { terminateManagedTree } = require('../src/server/l4_foundation/process/l4-process-tree.js')
const projectRoot = resolve('.')
const serviceProcessEntry =
  require.resolve('../src/server/l2_biz/service-process/l2-service-process.js')

// 只替换服务和维护入口；CLI stdin、IPC、进程树终止和 TCP 监听均使用真实 OS 资源。
const fixtureSource = String.raw`
const childProcess = require('node:child_process')
const fs = require('node:fs')
const { createServer } = require('node:http')
const kind = process.argv[2]
function record(type, details = {}) {
  fs.appendFileSync(process.env.PI_DESK_PARENT_TEST_EVENTS, JSON.stringify({
    type, kind, pid: process.pid,
    marker: process.env.PI_DESK_DESKTOP_PARENT_STDIN ?? null,
    ...details
  }) + '\n')
}
if (kind === 'cli') {
  process.once('uncaughtExceptionMonitor', (error) => record('cli-uncaught-error', {
    code: error.code, message: error.message
  }))
  const originalSpawn = childProcess.spawn
  childProcess.spawn = function (command, args, options) {
    const nextKind = args.some((arg) => arg.endsWith('l1-server.ts')) ? 'service'
      : args.some((arg) => arg.includes('l4-pi-package-maintenance-runner')) ? 'package'
      : args.some((arg) => arg.includes('l4-environment-maintenance-runner')) ? 'environment'
      : null
    if (!nextKind) return originalSpawn(command, args, options)
    const child = originalSpawn(command, [__filename, nextKind], options)
    record('spawn', { childKind: nextKind, childPid: child.pid })
    return child
  }
  const stdin = process.stdin
  function launch() {
    const originalEnd = stdin.listeners('end')
    const originalError = stdin.listeners('error')
    function snapshot() {
      return {
        destroyed: stdin.destroyed, flowing: stdin.readableFlowing,
        endListeners: stdin.listeners('end').filter((fn) => !originalEnd.includes(fn)).length,
        errorListeners: stdin.listeners('error').filter((fn) => !originalError.includes(fn)).length
      }
    }
    process.once('beforeExit', () => record('cli-finished', snapshot()))
    process.on('message', (message) => {
      if (message === 'fixture.snapshot') record('snapshot', snapshot())
      if (message === 'fixture.stdin-error') stdin.destroy(new Error('fixture-stdin-failure'))
    })
    const { runServiceProcess } = require(process.argv[3])
    runServiceProcess({ hostname: '127.0.0.1', port: '0', openBrowser: false, safeMode: false })
    record('cli-started', snapshot())
  }
  if (process.env.PI_DESK_PARENT_TEST_SCENARIO === 'drained-eof') {
    stdin.once('end', launch)
    stdin.resume()
  } else {
    launch()
  }
} else {
  let closing = false
  function close(code, source) {
    if (closing) return
    closing = true
    if (source) process.send({ type: 'pi-desk.shutting-down', source })
    server.close(() => {
      process.exitCode = code
      if (process.connected) process.disconnect()
    })
  }
  const server = createServer((request, response) => {
    response.setHeader('Connection', 'close')
    response.end(JSON.stringify({ pid: process.pid, marker: process.env.PI_DESK_DESKTOP_PARENT_STDIN ?? null }))
    if (kind !== 'service') return
    if (request.url === '/finish') close(0, 'FIXTURE')
    if (request.url.startsWith('/maintain/')) {
      if (request.url.endsWith('/package')) {
        process.send({ type: 'pi-desk.plugin-maintenance', maintenance: {
          action: 'install', source: 'npm:desktop-parent-fixture'
        } })
      } else {
        process.send({ type: 'pi-desk.environment-maintenance', request: {
          id: '12345678-1234-4234-8234-123456789abc', kind: 'export',
          agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd(),
          password: 'fixture-only-password'
        } })
      }
      close(75, 'RESTART')
    }
  })
  if (kind === 'service') {
    process.on('message', (message) => {
      if (message !== 'pi-desk.shutdown') return
      record('shutdown-received')
      close(0)
    })
  }
  server.listen(0, '127.0.0.1', () => {
    record('ready', { port: server.address().port })
    if (kind === 'service' && process.connected) process.send({ type: 'pi-desk.supervisor-ready' })
  })
}
`

async function withTimeout(promise, label, timeoutMs = 20_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}等待超时`)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await delay(10)
  }
  throw new Error(`${label}等待超时`)
}

async function readEvents(runtime) {
  try {
    return (await readFile(runtime.events, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function waitEvent(runtime, type, kind) {
  return waitFor(
    async () =>
      (await readEvents(runtime)).find(
        (event) => event.type === type && (!kind || event.kind === kind)
      ),
    `${kind ?? 'CLI'} ${type}`
  )
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function assertPortReleased(port) {
  const listener = createServer()
  try {
    listener.listen(port, '127.0.0.1')
    await once(listener, 'listening')
  } finally {
    if (listener.listening) await new Promise((resolveClose) => listener.close(resolveClose))
  }
}

async function request(port, path = '/') {
  return withTimeout(
    new Promise((resolveRequest, rejectRequest) => {
      const outgoing = get(`http://127.0.0.1:${port}${path}`, { agent: false }, (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.once('error', rejectRequest)
        response.once('end', () => resolveRequest(JSON.parse(body)))
      })
      outgoing.once('error', rejectRequest)
      outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('fixture HTTP 请求超时')))
    }),
    'fixture HTTP 请求'
  )
}

async function assertStopped(runtime, marked = true) {
  const [code, signal] = await withTimeout(runtime.closed, 'CLI自然退出')
  assert.equal(code, 0, `${runtime.output}\n${JSON.stringify(await readEvents(runtime))}`)
  assert.equal(signal, null, runtime.output)
  assert.equal(processExists(runtime.child.pid), false)
  const events = await readEvents(runtime)
  for (const event of events.filter((item) => item.type === 'spawn')) {
    assert.equal(processExists(event.childPid), false, `子进程 ${event.childPid} 未退出`)
  }
  for (const event of events.filter((item) => item.type === 'ready')) {
    await assertPortReleased(event.port)
  }
  assert.doesNotMatch(runtime.output, /正在以基础模式恢复/)
  const finished = events.find((event) => event.type === 'cli-finished')
  assert.ok(finished, runtime.output)
  assert.equal(finished.destroyed, marked)
  assert.equal(finished.endListeners, 0)
  assert.equal(finished.errorListeners, 0)
  return events
}

async function cleanup(runtime) {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    if (runtime.child.connected) runtime.child.send('pi-desk.shutdown', () => {})
    runtime.child.stdin.destroy()
    try {
      await withTimeout(runtime.closed, '测试CLI清理')
    } catch {
      await terminateManagedTree(runtime.child)
      await withTimeout(runtime.closed, '测试CLI强制清理')
    }
  }
  const events = await readEvents(runtime)
  for (const event of events.filter((item) => item.type === 'spawn')) {
    if (!processExists(event.childPid)) continue
    if (process.platform === 'win32') process.kill(event.childPid, 'SIGKILL')
    else process.kill(-event.childPid, 'SIGKILL')
    await waitFor(() => !processExists(event.childPid), 'fixture子进程清理')
  }
  for (const event of events.filter((item) => item.type === 'ready')) {
    await assertPortReleased(event.port)
  }
}

async function withFixture(context, scenario, run, marker = '1') {
  const taskId = `${scenario}-${randomUUID()}`
  const root = join(projectRoot, 'temp/run/service-process-desktop-parent', taskId)
  const agentRoot = join(projectRoot, 'temp/pi/l2-service-process-desktop-parent', taskId, 'agent')
  await mkdir(root, { recursive: true })
  await mkdir(agentRoot, { recursive: true })
  const fixture = join(root, 'fixture.cjs')
  await writeFile(fixture, fixtureSource)
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    PI_DESK_E2E: '0',
    PI_DESK_LOG_FILE: join(root, 'managed.log'),
    PI_DESK_PARENT_TEST_EVENTS: join(root, 'events.jsonl'),
    PI_DESK_PARENT_TEST_SCENARIO: scenario,
    PI_CODING_AGENT_DIR: agentRoot,
    PI_CODING_AGENT_SESSION_DIR: join(agentRoot, 'sessions')
  }
  if (marker === null) delete env.PI_DESK_DESKTOP_PARENT_STDIN
  else env.PI_DESK_DESKTOP_PARENT_STDIN = marker
  const child = spawn(process.execPath, [fixture, 'cli', serviceProcessEntry], {
    cwd: projectRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
    windowsHide: true
  })
  const runtime = {
    child,
    closed: once(child, 'close'),
    events: env.PI_DESK_PARENT_TEST_EVENTS,
    output: ''
  }
  child.stdin.on('error', () => {})
  child.stdout.on('data', (chunk) => {
    runtime.output += chunk
  })
  child.stderr.on('data', (chunk) => {
    runtime.output += chunk
  })
  let failure
  try {
    await run(runtime)
  } catch (error) {
    failure = error
  } finally {
    try {
      await cleanup(runtime)
    } catch (error) {
      if (!failure) failure = error
      else context.diagnostic(`清理失败：${error.message}`)
    }
    if (failure) {
      await writeFile(join(root, 'cli-output.log'), runtime.output)
      context.diagnostic(`失败现场：${root}`)
    } else {
      await rm(root, { recursive: true, force: true })
      await rm(resolve(agentRoot, '..'), { recursive: true, force: true })
    }
  }
  if (failure) throw failure
}

for (const scenario of ['running-eof', 'startup-eof', 'drained-eof', 'stdin-error']) {
  test(`桌面生命线 ${scenario} 停止服务和CLI且不恢复`, { timeout: 60_000 }, async (context) => {
    await withFixture(context, scenario, async (runtime) => {
      if (scenario === 'running-eof' || scenario === 'stdin-error') {
        const ready = await waitEvent(runtime, 'ready', 'service')
        assert.deepEqual(await request(ready.port), { pid: ready.pid, marker: null })
        assert.equal(processExists(ready.pid), true)
      }
      if (scenario === 'stdin-error') runtime.child.send('fixture.stdin-error')
      else runtime.child.stdin.end()
      const events = await assertStopped(runtime)
      const services = events.filter(
        (event) => event.type === 'spawn' && event.childKind === 'service'
      )
      if (scenario === 'startup-eof') assert.ok(services.length <= 1)
      else assert.equal(services.length, scenario === 'drained-eof' ? 0 : 1)
      assert.equal((runtime.output.match(/桌面父进程生命线已断开/g) ?? []).length, 1)
      assert.match(runtime.output, new RegExp(`"cliPid":${runtime.child.pid}`))
      if (scenario === 'stdin-error') assert.match(runtime.output, /fixture-stdin-failure/)
      if (scenario === 'running-eof') {
        assert.equal(events.filter((event) => event.type === 'shutdown-received').length, 1)
      }
    })
  })
}

test('桌面异常消失且日志读端同时关闭时仍完成服务清理', { timeout: 60_000 }, async (context) => {
  await withFixture(context, 'all-desktop-pipes-closed', async (runtime) => {
    await waitEvent(runtime, 'ready', 'service')
    runtime.child.stdout.destroy()
    runtime.child.stderr.destroy()
    runtime.child.stdin.end()
    const events = await assertStopped(runtime)
    assert.equal(events.filter((event) => event.type === 'shutdown-received').length, 1)
    assert.equal(events.filter((event) => event.type === 'spawn').length, 1)
  })
})

test('父写端仍开时服务正常完成也能释放stdin并退出CLI', { timeout: 60_000 }, async (context) => {
  await withFixture(context, 'normal-finish', async (runtime) => {
    const ready = await waitEvent(runtime, 'ready', 'service')
    const started = await waitEvent(runtime, 'cli-started')
    assert.equal(started.marker, null)
    assert.equal(started.endListeners, 1)
    assert.equal(started.errorListeners, 1)
    assert.equal(runtime.child.stdin.writableEnded, false)
    await request(ready.port, '/finish')
    await assertStopped(runtime)
    assert.equal(runtime.child.stdin.writableEnded, false)
    assert.doesNotMatch(runtime.output, /桌面父进程生命线已断开/)
  })
})

for (const marker of [undefined, '0', 'true']) {
  test(`独立CLI标记${marker ?? '缺省'}保持stdin行为`, { timeout: 60_000 }, async (context) => {
    await withFixture(
      context,
      `standalone-${marker ?? 'unset'}`,
      async (runtime) => {
        const ready = await waitEvent(runtime, 'ready', 'service')
        const started = await waitEvent(runtime, 'cli-started')
        assert.equal(started.destroyed, false)
        assert.equal(started.flowing, null)
        assert.equal(started.endListeners, 0)
        assert.equal(started.errorListeners, 0)
        runtime.child.stdin.end()
        runtime.child.send('fixture.snapshot')
        const snapshot = await waitEvent(runtime, 'snapshot')
        assert.equal(snapshot.destroyed, false)
        assert.equal(snapshot.flowing, null)
        assert.equal(snapshot.marker, marker ?? null)
        assert.deepEqual(await request(ready.port), { pid: ready.pid, marker: marker ?? null })
        assert.equal(runtime.child.exitCode, null)
        runtime.child.send('pi-desk.shutdown')
        await assertStopped(runtime, false)
        assert.doesNotMatch(runtime.output, /桌面父进程生命线已断开/)
      },
      marker ?? null
    )
  })
}

for (const kind of ['package', 'environment']) {
  test(`${kind}维护不继承生命线且EOF终止维护后不恢复`, { timeout: 60_000 }, async (context) => {
    await withFixture(context, `maintenance-${kind}`, async (runtime) => {
      const service = await waitEvent(runtime, 'ready', 'service')
      assert.equal(service.marker, null)
      await request(service.port, `/maintain/${kind}`)
      const maintenance = await waitEvent(runtime, 'ready', kind)
      assert.deepEqual(await request(maintenance.port), { pid: maintenance.pid, marker: null })
      assert.equal(processExists(service.pid), false)
      assert.equal(processExists(maintenance.pid), true)
      runtime.child.stdin.end()
      const events = await assertStopped(runtime)
      assert.deepEqual(
        events.filter((event) => event.type === 'spawn').map((event) => event.childKind),
        ['service', kind]
      )
    })
  })
}
