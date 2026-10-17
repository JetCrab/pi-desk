import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { terminateManagedTree } from '../../src/server/l4_foundation/process/l4-process-tree.js'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from '../../tests/l4-e2e-server-runtime.mjs'
import { reservePort } from '../../tests/l4-browser-cdp-runtime.mjs'
import { createPiDeskCommandFixture } from '../../tests/l4-pidesk-command-smoke.mjs'
import { run, readNpmArchiveManifest } from './release-npm.mjs'

const execute = promisify(execFile)
const phases = {
  prepare: ['准备验收', 60_000],
  'install-host': ['安装宿主', 4 * 60_000],
  'install-pi': ['安装 Pi 运行时', 4 * 60_000],
  'health-safe': ['基础模式启动', 2 * 60_000],
  'prepare-commands': ['准备命令夹具', 60_000],
  'health-normal': ['正常模式启动', 2 * 60_000],
  commands: ['验证安装态命令与浏览器模块', 5 * 60_000],
  cleanup: ['释放验收资源', 90_000]
}

async function phase(name, action) {
  process.send?.({ phase: name })
  const started = performance.now()
  console.info(`[smoke:${name}] ${phases[name][0]}开始，时限 ${phases[name][1] / 1000} 秒`)
  try {
    const result = await action()
    process.send?.({ phase: name, status: 'complete' })
    console.info(
      `[smoke:${name}] 完成，耗时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`
    )
    return result
  } catch (error) {
    process.send?.({
      phase: name,
      status: 'failed',
      recoverable:
        error.code === 'ETIMEDOUT' ||
        error.name === 'TimeoutError' ||
        (error.name === 'AbortError' && error.cause?.name === 'TimeoutError')
    })
    throw error
  }
}

async function stopVerificationTree(child) {
  if (!child.pid) return
  try {
    if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) {
      // 服务和浏览器各自创建进程组，必须在父进程退出、后代被重新托管前取得所属关系。
      const { stdout } = await execute('ps', ['-eo', 'pid=,ppid=,pgid='], { timeout: 5_000 })
      const processes = stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
      const descendants = new Set([child.pid])
      let previousSize
      do {
        previousSize = descendants.size
        for (const [pid, ppid] of processes) if (descendants.has(ppid)) descendants.add(pid)
      } while (descendants.size !== previousSize)
      for (const [pid, , group] of processes) {
        if (pid !== child.pid && pid === group && descendants.has(pid))
          await terminateManagedTree({ pid })
      }
    }
  } finally {
    await terminateManagedTree(child)
  }
}

async function verifyAttempt({
  root,
  directory,
  attemptDirectory,
  agentDir,
  sdkArchive,
  hostArchive,
  version,
  completed,
  signal,
  output
}) {
  let tail = ''
  const publish = (chunk, stream) => {
    tail = `${tail}${chunk}`.slice(-64 * 1024)
    output(chunk, stream)
  }
  // 同步安装卡住时，父进程仍可终止本次尝试及其浏览器、服务等后代。
  const child = spawn(
    process.execPath,
    [
      import.meta.filename,
      '--worker',
      directory,
      sdkArchive,
      hostArchive,
      version,
      attemptDirectory,
      JSON.stringify([...completed])
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
        npm_config_cache: join(directory, 'npm-cache')
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    }
  )
  child.stdout.on('data', (chunk) => publish(chunk, process.stdout))
  child.stderr.on('data', (chunk) => publish(chunk, process.stderr))
  const closed = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose)
    child.once('close', (code, signal) => resolveClose({ code, signal }))
  })
  let current = 'prepare'
  let failure
  let phaseTimer
  let rejectDeadline
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject
  })
  const arm = (name) => {
    current = name
    clearTimeout(phaseTimer)
    phaseTimer = setTimeout(
      () =>
        rejectDeadline(
          Object.assign(
            new Error(`验收阶段超时：${phases[name][0]}（${phases[name][1] / 1000} 秒）`),
            { code: 'ETIMEDOUT' }
          )
        ),
      phases[name][1]
    )
  }
  arm('prepare')
  child.on('message', (message) => {
    if (message.status === 'complete') {
      if (['install-host', 'install-pi'].includes(message.phase)) completed.add(message.phase)
    } else if (message.status === 'failed') {
      failure ??= message
    } else {
      arm(message.phase)
    }
  })
  const interrupt = () => rejectDeadline(signal.reason)
  signal.addEventListener('abort', interrupt, { once: true })
  try {
    signal.throwIfAborted()
    const result = await Promise.race([closed, deadline])
    assert.equal(
      result.code,
      0,
      `验收子进程失败：退出码=${result.code}，信号=${result.signal ?? '无'}`
    )
  } catch (error) {
    const failedPhase = failure?.phase ?? current
    const networkFailure =
      ['install-host', 'install-pi'].includes(failedPhase) &&
      /npm (?:error|ERR!) (?:code )?(?:EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|E50[0234])\b/i.test(
        tail
      )
    error.recoverable =
      !signal.aborted &&
      (failure ? failure.recoverable || networkFailure : error.code === 'ETIMEDOUT')
    output(`${error.stack ?? error}\n`, process.stderr)
    appendFileSync(join(attemptDirectory, 'failure.log'), `\n${error.stack ?? error}\n`)
    let cleanupTimer
    try {
      await stopVerificationTree(child)
      await Promise.race([
        closed.catch(() => undefined),
        new Promise((_, reject) => {
          cleanupTimer = setTimeout(
            () => reject(new Error('验收进程树未在 5 秒内关闭输出通道')),
            5_000
          )
        })
      ])
      output('[smoke:cleanup] 本次验收进程树已终止\n')
    } catch (cleanupError) {
      error.recoverable = false
      appendFileSync(
        join(attemptDirectory, 'cleanup.log'),
        `${cleanupError.stack ?? cleanupError}\n`
      )
      output(`验收进程树清理失败：${cleanupError.stack ?? cleanupError}\n`, process.stderr)
    } finally {
      clearTimeout(cleanupTimer)
    }
    throw error
  } finally {
    clearTimeout(phaseTimer)
    signal.removeEventListener('abort', interrupt)
    child.stdout.removeAllListeners('data')
    child.stderr.removeAllListeners('data')
  }
}

export async function verifyNpmInstall({ root, sdkArchive, hostArchive, version }) {
  const parent = join(root, 'temp/run/npm-release')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'installed-'))
  const agentRoot = join(root, 'temp/pi/npm-release', basename(directory))
  const log = openSync(join(directory, 'smoke.log'), 'w')
  let logBytes = 0
  let truncated = false
  const output = (chunk, stream = process.stdout) => {
    const bytes = Buffer.from(chunk)
    const available = Math.max(0, 8 * 1024 * 1024 - logBytes)
    if (available) logBytes += writeSync(log, bytes.subarray(0, available))
    if (bytes.length > available && !truncated) {
      writeSync(log, '\n日志已达到 8 MiB 上限；最终错误另存于各次尝试的 failure.log。\n')
      truncated = true
    }
    stream.write(chunk)
  }
  const controller = new AbortController()
  const overallTimer = setTimeout(
    () => controller.abort(new Error('安装态验收及自动恢复超过总时限 18 分钟')),
    18 * 60_000
  )
  const interrupt = () => controller.abort(new Error('安装态验收被中断'))
  process.once('SIGTERM', interrupt)
  process.once('SIGINT', interrupt)
  const completed = new Set()
  let success = false
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      controller.signal.throwIfAborted()
      const name = `attempt-${attempt}`
      const attemptDirectory = join(directory, name)
      await mkdir(attemptDirectory)
      output(`[smoke:attempt] 开始第 ${attempt} 次验收\n`)
      try {
        await verifyAttempt({
          root,
          directory,
          attemptDirectory,
          agentDir: join(agentRoot, name, 'agent'),
          sdkArchive,
          hostArchive,
          version,
          completed,
          signal: controller.signal,
          output
        })
        if (attempt > 1) output('[smoke:recovery] 自动恢复成功，继续后续发布步骤\n')
        success = true
        return
      } catch (error) {
        if (attempt === 2 || !error.recoverable) throw error
        output('[smoke:recovery] 临时故障已清理；复用已完成的安装，重建隔离环境自动恢复一次\n')
      }
    }
  } finally {
    clearTimeout(overallTimer)
    process.off('SIGTERM', interrupt)
    process.off('SIGINT', interrupt)
    closeSync(log)
    if (success) {
      await rm(directory, { recursive: true, force: true })
      await rm(agentRoot, { recursive: true, force: true })
    } else {
      console.error(`安装态命令验收失败现场：${directory}`)
    }
  }
}

async function waitForHealth(runtime, version) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    assert.equal(runtime.child.exitCode, null, '安装后的正式服务提前退出')
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/api/health`, {
        signal: AbortSignal.timeout(2000)
      })
      const body = await response.json()
      if (
        response.ok &&
        body.code === 0 &&
        body.data?.status === 'ready' &&
        body.data?.version === version
      )
        return
    } catch {}
    await delay(250)
  }
  throw Object.assign(new Error('最终 npm 安装包未在截止时间内就绪'), { code: 'ETIMEDOUT' })
}

async function verifyInstalledPackage({
  directory,
  sdkArchive,
  hostArchive,
  version,
  attemptDirectory,
  reused
}) {
  const agentDir = process.env.PI_CODING_AGENT_DIR
  const piRoot = join(directory, 'pi-runtime')
  let runtime
  let fixture
  let failure
  try {
    const installed = join(directory, 'node_modules/@jetcrab/pi-desk')
    const manifest = await phase('install-host', async () => {
      if (reused.includes('install-host')) {
        console.info('[smoke:install-host] 复用本批已验证的安装')
      } else {
        await rm(join(directory, 'node_modules'), { recursive: true, force: true })
        await rm(join(directory, 'package-lock.json'), { force: true })
        await writeFile(join(directory, 'package.json'), '{"private":true}\n')
        run('npm', [
          'install',
          '--prefix',
          directory,
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--package-lock=true',
          '--registry=https://registry.npmjs.org',
          sdkArchive,
          hostArchive
        ])
      }
      const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
      assert.equal(manifest.version, version)
      const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'))
      assert.ok(
        !Object.keys(lock.packages).some((path) => /node_modules\/@earendil-works\/pi-/.test(path)),
        '宿主不应安装另一份 Pi 核心'
      )
      return manifest
    })
    await phase('install-pi', async () => {
      if (reused.includes('install-pi')) {
        console.info('[smoke:install-pi] 复用本批已安装的 Pi 运行时')
      } else {
        await rm(piRoot, { recursive: true, force: true })
        run('npm', [
          'install',
          '--prefix',
          piRoot,
          '--ignore-scripts',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--registry=https://registry.npmjs.org',
          '@earendil-works/pi-coding-agent@latest'
        ])
      }
    })
    await prepareIsolatedPiDirectory(agentDir)
    const port = await reservePort()
    const start = (safeMode) =>
      spawnE2eServer({
        projectRoot: installed,
        agentDir,
        port,
        managed: true,
        safeMode,
        piPackageDir: join(piRoot, 'node_modules/@earendil-works/pi-coding-agent'),
        environment: {
          PI_OFFLINE: '1',
          npm_config_cache: join(directory, 'npm-cache'),
          npm_config_audit: 'false',
          npm_config_fund: 'false'
        },
        onOutput: (chunk) => process.stdout.write(chunk)
      })
    await phase('health-safe', async () => {
      runtime = start(true)
      await waitForHealth(runtime, version)
    })
    await phase('cleanup', () => stopE2eServerTree(runtime))
    runtime = undefined
    fixture = await phase('prepare-commands', () =>
      createPiDeskCommandFixture(join(attemptDirectory, 'commands'), agentDir)
    )
    await phase('health-normal', async () => {
      runtime = start(false)
      await waitForHealth(runtime, version)
    })
    await phase('commands', () => fixture.verify({ port, version }))
    console.info(
      `独立 npm 安装、基础模式、关键命令及浏览器模块检查通过：${manifest.name}@${version}`
    )
  } catch (error) {
    failure = error
    await writeFile(join(attemptDirectory, 'failure.log'), String(error.stack ?? error))
    throw error
  } finally {
    const cleanup = await phase('cleanup', () =>
      Promise.allSettled([
        runtime ? stopE2eServerTree(runtime) : Promise.resolve(),
        fixture ? fixture.close() : Promise.resolve()
      ])
    )
    const errors = cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason)
    if (errors.length) {
      await writeFile(join(attemptDirectory, 'cleanup.log'), errors.map(String).join('\n'))
      if (!failure) throw new AggregateError(errors, '安装验收资源未确认释放')
      console.error('安装验收清理失败', errors)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const worker = process.argv[2] === '--worker'
  const [directory, sdk, host, version, attemptDirectory, reused] = process.argv.slice(3)
  const action = worker
    ? verifyInstalledPackage({
        directory,
        sdkArchive: sdk,
        hostArchive: host,
        version,
        attemptDirectory,
        reused: JSON.parse(reused)
      })
    : (async () => {
        const [sdkArchive, hostArchive] = process.argv.slice(2)
        assert.ok(
          sdkArchive && hostArchive && process.argv.length === 4,
          '用法：verify-npm-install.mjs <sdk.tgz> <host.tgz>'
        )
        const manifest = readNpmArchiveManifest(hostArchive)
        assert.equal(manifest.name, '@jetcrab/pi-desk')
        await verifyNpmInstall({
          root: resolve(import.meta.dirname, '../..'),
          sdkArchive: resolve(sdkArchive),
          hostArchive: resolve(hostArchive),
          version: manifest.version
        })
      })()
  action.catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
