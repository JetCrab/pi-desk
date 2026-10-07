import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { startTunnelClient } from '../src/tunnel-client.js'
import type { RunLogger } from '../src/log.js'

for (const failed of [false, true]) {
  test(`桌面隧道事件${failed ? '失败' : '就绪与停止'}由插件正确处理`, async (context) => {
    const oldExecutable = process.env.PI_DESK_DESKTOP_EXECUTABLE
    const oldConfig = process.env.PI_DESK_DESKTOP_CONFIG
    const configPath = resolve('temp/fixture/desktop-config.json')
    process.env.PI_DESK_DESKTOP_EXECUTABLE = process.execPath
    process.env.PI_DESK_DESKTOP_CONFIG = configPath
    context.after(() => {
      if (oldExecutable === undefined) delete process.env.PI_DESK_DESKTOP_EXECUTABLE
      else process.env.PI_DESK_DESKTOP_EXECUTABLE = oldExecutable
      if (oldConfig === undefined) delete process.env.PI_DESK_DESKTOP_CONFIG
      else process.env.PI_DESK_DESKTOP_CONFIG = oldConfig
      context.mock.restoreAll()
      syncBuiltinESMExports()
    })
    const fake = Object.assign(new EventEmitter(), {
      pid: Number.MAX_SAFE_INTEGER,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => false
    })
    const finish = (code: number): void => {
      fake.stdout.end()
      fake.stderr.end()
      fake.emit('close', code)
    }
    fake.stdin.once('finish', () => finish(0))
    context.mock.method(
      childProcess,
      'spawn',
      (executable: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        assert.equal(executable, process.execPath)
        assert.deepEqual(args, [
          '--tunnel-client',
          '--local',
          '127.0.0.1:39123',
          '--public-port',
          '43333'
        ])
        assert.equal(options.env.PI_DESK_DESKTOP_CONFIG, configPath)
        queueMicrotask(() => {
          fake.stdout.write(
            JSON.stringify(
              failed
                ? { type: 'failed', detail: '配置未就绪' }
                : { type: 'listening', publicAddr: 'tunnel.example:43333' }
            ) + '\n'
          )
          if (failed) finish(1)
        })
        return fake as unknown as ChildProcessWithoutNullStreams
      }
    )
    syncBuiltinESMExports()
    const messages: string[] = []
    const logger = {
      line(_scope: string, text: string): void {
        messages.push(text)
      }
    } as RunLogger
    const client = startTunnelClient({ localPort: 39123, publicPort: 43333, logger })
    if (failed) {
      await assert.rejects(client.ready, /配置未就绪/)
      assert.equal((await client.completion).failed, true)
    } else {
      assert.equal(await client.ready, 'tunnel.example:43333')
      assert.equal((await client.stop()).failed, false)
      assert.ok(fake.stdin.writableEnded)
    }
    assert.ok(messages.length > 0)
  })
}
