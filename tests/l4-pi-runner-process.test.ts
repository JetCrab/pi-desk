import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { runL4PiRunnerProcess } from '../src/server/l4_foundation/pi/l4-pi-runner-process'

const execFileAsync = promisify(execFile)
const testRoot = resolve('temp', 'pi', 'l4-pi-runner-process', `host-review-${process.pid}`)
const agentDir = join(testRoot, 'agent')

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  }
  throw new Error(`等待Runner fixture启动超时：${path}`)
}

async function processExists(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
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
    env: {},
    maxOutputBytes: 8,
    timeoutMs: 5_000,
    timeoutError: () => new Error('Runner超时'),
    cleanupError: () => new Error('Runner清理失败')
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
    env: {},
    maxOutputBytes: 1024,
    timeoutMs: 5_000,
    timeoutError: () => new Error('Runner超时'),
    cleanupError: () => new Error('Runner清理失败')
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

  const running = runL4PiRunnerProcess({
    args: [script],
    agentDir,
    env: {},
    maxOutputBytes: 1024,
    timeoutMs: 1_000,
    timeoutError: () => new Error('controlled timeout'),
    cleanupError: () => new Error('Runner清理失败')
  })
  const pids = JSON.parse(await waitForFile(marker)) as number[]
  await assert.rejects(running, /controlled timeout/)
  assert.ok(pids.length === 2)
  assert.equal(await processExists(pids[0]!), false)
  assert.equal(await processExists(pids[1]!), false)
})

test.after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})
