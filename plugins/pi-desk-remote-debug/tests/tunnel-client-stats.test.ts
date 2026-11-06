import assert from 'node:assert/strict'
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'
import type { RunLogger } from '../src/log.js'
import { startTunnelClient } from '../src/tunnel-client.js'

function fixture(context: TestContext) {
  const keys = ['PI_DESK_DESKTOP_EXECUTABLE', 'PI_DESK_DESKTOP_CONFIG'] as const
  const original = keys.map((key) => process.env[key])
  process.env.PI_DESK_DESKTOP_EXECUTABLE = process.execPath
  process.env.PI_DESK_DESKTOP_CONFIG = resolve('temp/fixture/desktop-config.json')
  context.after(() => {
    for (const [index, key] of keys.entries()) {
      if (original[index] === undefined) delete process.env[key]
      else process.env[key] = original[index]
    }
    context.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const child = Object.assign(new EventEmitter(), {
    pid: Number.MAX_SAFE_INTEGER,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false
  })
  context.mock.method(
    childProcess,
    'spawn',
    (_executable: string, args: string[], options: { detached: boolean }) => {
      assert.ok(args.includes('--stats'))
      assert.equal(options.detached, process.platform !== 'win32')
      return child as unknown as ChildProcessWithoutNullStreams
    }
  )
  syncBuiltinESMExports()
  const messages: string[] = []
  const logger = {
    line: (_scope: string, text: string): void => {
      messages.push(text)
    }
  } as RunLogger
  const client = startTunnelClient({ localPort: 39123, publicPort: 43333, logger })
  return {
    child,
    client,
    messages,
    event(value: unknown): void {
      child.stdout.write(JSON.stringify(value) + '\n')
    },
    close(code: number | null): void {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', code)
    }
  }
}

test('完整连接快照仅进入日志，实际路径变化和归零不改变就绪地址', async (context) => {
  const f = fixture(context)
  f.event({
    type: 'connections',
    rows: [{ peerId: 'gateway', localPort: 39123, source: 'public', path: 'unknown', activeTcp: 2 }]
  })
  f.event({ type: 'listening', publicAddr: 'tunnel.example:43333' })
  assert.equal(await f.client.ready, 'tunnel.example:43333')
  f.event({
    type: 'connections',
    rows: [{ peerId: 'gateway', localPort: 39123, source: 'public', path: 'direct', activeTcp: 2 }]
  })
  f.event({
    type: 'connections',
    rows: [{ peerId: 'gateway', localPort: 39123, source: 'public', path: 'relay', activeTcp: 1 }]
  })
  f.event({ type: 'recovering', detail: '正在恢复' })
  f.event({ type: 'listening', publicAddr: 'tunnel.example:43333' })
  const stopping = f.client.stop()
  f.event({ type: 'connections', rows: [] })
  f.event({ type: 'stopped' })
  f.close(0)
  assert.equal((await stopping).failed, false)
  assert.ok(
    f.messages.some(
      (line) => line.includes('公网网关→提供端 gateway') && line.includes('实际路径 direct TCP=2')
    )
  )
  assert.ok(f.messages.some((line) => line.includes('实际路径 relay TCP=1')))
  assert.ok(f.messages.includes('当前活动 TCP=0'))
})

for (const event of [
  { type: 'unexpected-event' },
  { type: 'connections' },
  {
    type: 'connections',
    rows: [{ peerId: 'peer', localPort: 39123, source: 'public', path: 'auto', activeTcp: 1 }]
  },
  {
    type: 'connections',
    rows: [{ peerId: 'peer', localPort: 39123, source: 'public', path: 'relay', activeTcp: -1 }]
  }
]) {
  test(`无效事件不能随后伪装就绪：${JSON.stringify(event)}`, async (context) => {
    const f = fixture(context)
    f.event(event)
    f.event({ type: 'listening', publicAddr: 'tunnel.example:43333' })
    await assert.rejects(f.client.ready, /未知事件|connections/)
    assert.equal(f.child.stdin.writableEnded, true)
    f.close(0)
    assert.equal((await f.client.completion).failed, true)
  })
}

for (const channel of ['stdout', 'stderr'] as const) {
  test(`旧桌面从 ${channel} 拒绝统计参数时明确要求升级`, async (context) => {
    const f = fixture(context)
    if (channel === 'stdout') f.event({ type: 'failed', detail: '隧道命令包含未知或重复参数' })
    else f.child.stderr.write("error: unexpected argument '--stats' found\n")
    await assert.rejects(f.client.ready, /同步升级 Pi Desk 桌面端/)
    f.close(1)
    assert.match((await f.client.completion).detail ?? '', /--stats/)
  })
}

test('stopped 事件仍等待真实进程退出，重复 stop 共享同一次清理', async (context) => {
  const f = fixture(context)
  f.event({ type: 'listening', publicAddr: 'tunnel.example:43333' })
  await f.client.ready
  const stop = f.client.stop()
  assert.equal(f.client.stop(), stop)
  let complete = false
  void stop.then(() => {
    complete = true
  })
  f.event({ type: 'stopped' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(complete, false)
  f.close(0)
  assert.equal((await stop).failed, false)
})

for (const code of [0, 1]) {
  test(`停止时退出码 ${code} 且没有释放确认不能当作清理成功`, async (context) => {
    const f = fixture(context)
    f.event({ type: 'listening', publicAddr: 'tunnel.example:43333' })
    await f.client.ready
    const stop = f.client.stop()
    f.close(code)
    const result = await stop
    assert.equal(result.failed, true)
    assert.match(result.detail ?? '', /退出码|未确认资源释放/)
  })
}

test('清理期间的 Worker 失败不会被 stop 请求掩盖', async (context) => {
  const f = fixture(context)
  f.event({ type: 'listening', publicAddr: 'tunnel.example:43333' })
  await f.client.ready
  const stop = f.client.stop()
  f.event({ type: 'failed', detail: '控制 close 失败' })
  f.event({ type: 'connections', rows: [] })
  f.event({ type: 'stopped' })
  f.close(1)
  const result = await stop
  assert.equal(result.failed, true)
  assert.equal(result.detail, '控制 close 失败')
  assert.ok(f.messages.includes('当前活动 TCP=0'))
  assert.ok(f.messages.includes('隧道资源已释放'))
})

test('停止超时强杀后不报告已确认释放', async (context) => {
  const f = fixture(context)
  context.mock.timers.enable({ apis: ['setTimeout'] })
  context.mock.method(childProcess, 'spawnSync', () => ({ status: 1 }))
  context.mock.method(f.child, 'kill', () => {
    f.close(null)
    return true
  })
  syncBuiltinESMExports()
  f.event({ type: 'listening', publicAddr: 'tunnel.example:43333' })
  await f.client.ready
  const stop = f.client.stop()
  context.mock.timers.tick(10_000)
  const result = await stop
  assert.equal(result.failed, true)
  assert.ok(f.messages.some((line) => line.includes('正在强制终止')))
})
