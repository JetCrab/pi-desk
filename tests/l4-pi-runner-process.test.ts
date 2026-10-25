import assert from 'node:assert/strict'
import childProcess, { execFile, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test, { beforeEach, type TestContext } from 'node:test'
import { createJiti } from 'jiti'

const require = createRequire(import.meta.url)
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
})
const { runL4PiRunnerProcess } = jiti(
  '../src/server/l4_foundation/pi/l4-pi-runner-process.ts'
) as typeof import('../src/server/l4_foundation/pi/l4-pi-runner-process')
const execFileAsync = promisify(execFile)
// 就绪轮询使用真实时间，不随 Runner 的模拟时钟暂停。
const pollDelay = delay
const testRoot = resolve('temp', 'pi', 'l4-pi-runner-process', `host-review-${process.pid}`)
const agentDir = join(testRoot, 'agent')
const runnerEnvironment = {
  PI_DESK_PI_PACKAGE_DIR: resolve('node_modules/@earendil-works/pi-coding-agent')
}

// Pi 引导由安装态测试覆盖；此处只验证真实子进程的输出、取消与清理。
beforeEach((hookContext) => {
  const context = hookContext as TestContext
  const spawn = childProcess.spawn
  const replacement = context.mock.method(
    childProcess,
    'spawn',
    (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      const actualArgs =
        args?.[0] === '--import' && args[1]?.endsWith('l4-pi-runtime-register.mjs')
          ? args.slice(2)
          : args
      return spawn(command, actualArgs, options)
    }
  )
  syncBuiltinESMExports()
  context.after(() => {
    replacement.mock.restore()
    syncBuiltinESMExports()
  })
})

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
      await pollDelay(20)
    }
  }
  throw new Error(`等待Runner fixture启动超时：${path}`)
}

async function processExists(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'stat=', '-p', String(pid)])
      return Boolean(stdout.trim()) && !stdout.trim().startsWith('Z')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 1) return false
      throw error
    }
  }

  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`
      ],
      { windowsHide: true, timeout: 5_000 }
    )
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return false
    throw error
  }
}

async function terminateRemaining(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5_000
    }).catch(() => undefined)
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

test('共享Runner保留有限输出、退出码与隔离Pi目录', async (context) => {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  context.after(() => rm(testRoot, { recursive: true, force: true }))
  const marker = join(testRoot, 'runner-env.json')
  const script = join(testRoot, 'success.mjs')
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_SESSION_DIR]))
process.stdout.write('abcdefghij')
process.stderr.write('warn')
`,
    'utf8'
  )

  const result = await runL4PiRunnerProcess({
    args: [script],
    agentDir,
    env: runnerEnvironment,
    maxOutputBytes: 8,
    timeoutMs: 5_000,
    timeoutError: () => new Error('Runner超时')
  })

  assert.deepEqual(result, { stdout: 'cdefghij', stderr: 'warn', code: 0 })
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), [
    agentDir,
    join(agentDir, 'sessions')
  ])
})

test('共享Runner保留失败退出码和stderr供上层分类', async (context) => {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  context.after(() => rm(testRoot, { recursive: true, force: true }))
  const script = join(testRoot, 'failure.mjs')
  await writeFile(
    script,
    `process.stderr.write('controlled failure')
process.exitCode = 17
`,
    'utf8'
  )

  const result = await runL4PiRunnerProcess({
    args: [script],
    agentDir,
    env: runnerEnvironment,
    maxOutputBytes: 1024,
    timeoutMs: 5_000,
    timeoutError: () => new Error('Runner超时')
  })

  assert.equal(result.code, 17)
  assert.equal(result.stderr, 'controlled failure')
})

test('共享Runner超时只返回一次并释放Windows完整进程树', { timeout: 20_000 }, async (context) => {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  context.after(async () => {
    try {
      const pids = JSON.parse(
        await readFile(join(testRoot, 'process-tree.json'), 'utf8')
      ) as number[]
      for (const pid of pids) await terminateRemaining(pid)
    } catch {}
    await rm(testRoot, { recursive: true, force: true })
  })
  const marker = join(testRoot, 'process-tree.json')
  const script = join(testRoot, 'timeout.mjs')
  await writeFile(
    script,
    `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
child.once('spawn', () => writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid])))
setInterval(() => {}, 1000)
`,
    'utf8'
  )

  context.mock.timers.enable({ apis: ['setTimeout'] })
  const running = runL4PiRunnerProcess({
    args: [script],
    agentDir,
    env: runnerEnvironment,
    maxOutputBytes: 1024,
    timeoutMs: 1_000,
    timeoutError: () => new Error('controlled timeout')
  })
  const rejected = assert.rejects(running, /controlled timeout/)
  const pids = JSON.parse(await waitForFile(marker)) as number[]
  context.mock.timers.tick(1_000)
  await rejected
  assert.ok(pids.length === 2)
  assert.equal(await processExists(pids[0]!), false)
  assert.equal(await processExists(pids[1]!), false)
})

test('取消并行准备会先释放完整进程树，预取消不启动进程', { timeout: 30_000 }, async (context) => {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  const marker = join(testRoot, 'canceled-process-tree.json')
  const script = join(testRoot, 'cancel.mjs')
  const controller = new AbortController()
  let pids: number[] = []
  context.after(async () => {
    controller.abort()
    for (const pid of pids) await terminateRemaining(pid)
    await rm(testRoot, { recursive: true, force: true })
  })
  await writeFile(
    script,
    `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
child.once('spawn', () => writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid])))
setInterval(() => {}, 1000)
`
  )
  const input = {
    args: [script],
    agentDir,
    env: runnerEnvironment,
    maxOutputBytes: 1024,
    timeoutMs: 20_000,
    signal: controller.signal,
    timeoutError: () => new Error('取消验证超时')
  }
  const running = runL4PiRunnerProcess(input)
  const rejected = assert.rejects(running, /操作已取消/)
  pids = JSON.parse(await waitForFile(marker)) as number[]
  controller.abort()
  await rejected
  assert.equal(pids.length, 2)
  for (const pid of pids) assert.equal(await processExists(pid), false)
  await rm(marker)
  await assert.rejects(runL4PiRunnerProcess(input), /操作已取消/)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('共享Runner清理失败保留业务退出结果并记录原始诊断', async (context) => {
  const runtime = require('../src/server/l4_foundation/process/l4-process-tree.js') as {
    terminateManagedTree: (child: import('node:child_process').ChildProcess) => Promise<void>
  }
  const failure = new Error('清理 Windows 孤儿进程失败：rootPid=123，超时终止=true', {
    cause: new Error('受控清理超时')
  })
  context.mock.method(runtime, 'terminateManagedTree', async (): Promise<void> => {
    throw failure
  })
  const diagnostic = context.mock.method(console, 'error', (): void => {})
  for (const code of [0, 17]) {
    const result = await runL4PiRunnerProcess({
      args: ['-e', `process.stderr.write('业务输出'); process.exitCode = ${code}`],
      agentDir,
      env: runnerEnvironment,
      maxOutputBytes: 1024,
      timeoutMs: 5_000,
      timeoutError: () => new Error('Runner超时')
    })
    assert.equal(result.code, code)
    assert.equal(result.stderr, '业务输出')
  }
  assert.equal(diagnostic.mock.calls.length, 2)
  assert.equal(diagnostic.mock.calls[0]!.arguments[1].reason, failure.message)
})

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})
