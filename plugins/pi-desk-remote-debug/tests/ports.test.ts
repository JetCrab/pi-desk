import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import test, { type TestContext } from 'node:test'
import { isLocalPortAvailable, prepareLocalPorts } from '../src/l4-remote-debug-ports.js'

interface TestListener {
  child: ChildProcess
  port: number
  exited: Promise<unknown[]>
}

const listeners = new WeakMap<TestContext, TestListener[]>()

async function listener(t: TestContext, port = 0): Promise<TestListener> {
  let owned = listeners.get(t)
  if (!owned) {
    owned = []
    listeners.set(t, owned)
    const resources = owned
    t.after(async () => {
      for (const { child } of resources) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
      await Promise.all(resources.map((resource) => resource.exited))
      for (const boundPort of new Set(resources.map((resource) => resource.port))) {
        assert.equal(await isLocalPortAvailable(boundPort), true, '测试监听端口必须释放')
      }
    })
  }
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const server = require('node:net').createServer()
    server.listen(${port}, '127.0.0.1', () => process.send(server.address().port))
  `
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }
  )
  const exited = once(child, 'exit')
  const [boundPort] = await once(child, 'message')
  assert.equal(typeof boundPort, 'number')
  const resource = { child, port: boundPort, exited }
  owned.push(resource)
  return resource
}

test('端口占用仅返回进程清单，未确认时不停止真实监听', { timeout: 20_000 }, async (t) => {
  const service = await listener(t)
  const conflicts = await prepareLocalPorts([service.port, service.port])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]?.port, service.port)
  assert.equal(conflicts[0]?.pid, service.child.pid)
  assert.match(conflicts[0]!.processName, /node/i)
  assert.equal(await isLocalPortAvailable(service.port), false)
  assert.equal(service.child.exitCode, null)
})

test('明确确认后结束真实占用者并释放端口，不结束清单外的进程', { timeout: 30_000 }, async (t) => {
  const service = await listener(t)
  const unrelated = await listener(t)
  const conflicts = await prepareLocalPorts([service.port])
  const allConflicts = await prepareLocalPorts(
    [service.port, unrelated.port],
    conflicts.map(({ port, pid }) => ({ port, pid }))
  )
  assert.equal(allConflicts.length, 2, '必须先确认全部占用者')
  assert.equal(await isLocalPortAvailable(service.port), false, '不能先结束已确认的部分进程')
  assert.equal(await isLocalPortAvailable(unrelated.port), false)
  assert.deepEqual(
    await prepareLocalPorts(
      [service.port],
      [
        ...conflicts.map(({ port, pid }) => ({ port, pid })),
        { port: unrelated.port, pid: unrelated.child.pid! }
      ]
    ),
    []
  )
  await service.exited
  assert.equal(await isLocalPortAvailable(service.port), true)
  assert.equal(await isLocalPortAvailable(unrelated.port), false)
})

test('确认期间占用PID变化则重新确认，不结束新占用者', { timeout: 30_000 }, async (t) => {
  const previous = await listener(t)
  const conflicts = await prepareLocalPorts([previous.port])
  previous.child.kill('SIGKILL')
  await previous.exited
  const current = await listener(t, previous.port)
  assert.notEqual(current.child.pid, previous.child.pid)
  const changed = await prepareLocalPorts(
    [current.port],
    conflicts.map(({ port, pid }) => ({ port, pid }))
  )
  assert.equal(changed[0]?.pid, current.child.pid)
  assert.equal(await isLocalPortAvailable(current.port), false)
})

test('Pi Desk自身占用的端口不能进入强杀确认', { timeout: 20_000 }, async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await assert.rejects(
      prepareLocalPorts([address.port], [{ port: address.port, pid: process.pid }]),
      /自身或系统进程/
    )
    assert.equal(server.listening, true)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
