import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, openSync, writeSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  'project-search': ['验证安装态项目搜索', 60_000],
  commands: ['验证安装态命令与浏览器模块', 5 * 60_000],
  cleanup: ['释放验收资源', 90_000],
  remove: ['删除验收临时目录', 10_000]
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
    console.error(
      `[smoke:${name}] 失败，耗时 ${((performance.now() - started) / 1000).toFixed(1)} 秒：${error.stack ?? error}`
    )
    process.send?.({
      phase: name,
      status: 'failed',
      error: error.stack ?? String(error),
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
  console.info(
    `[smoke:cleanup] 终止验收进程树：ownerPid=${process.pid}，rootPid=${child.pid}，exitCode=${child.exitCode}，signal=${child.signalCode}`
  )
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
      await Promise.all(
        processes
          .filter(([pid, , group]) => pid !== child.pid && pid === group && descendants.has(pid))
          .map(([pid]) => terminateManagedTree({ pid }))
      )
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
  output,
  mode = '--worker',
  piVersion
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
      mode,
      directory,
      sdkArchive ?? '',
      hostArchive ?? '',
      version ?? '',
      attemptDirectory,
      JSON.stringify([...completed]),
      piVersion ?? ''
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
  let current = mode === '--remove' ? 'remove' : 'prepare'
  let prepared
  let verified = false
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
  arm(current)
  child.on('message', (message) => {
    if (message.prepared) {
      prepared = message.prepared
    } else if (message.status === 'complete') {
      if (message.phase === 'commands') verified = true
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
    return prepared
  } catch (caught) {
    const error = failure?.error ? new Error(failure.error, { cause: caught }) : caught
    const failedPhase = failure?.phase ?? current
    const networkFailure =
      ['install-host', 'install-pi'].includes(failedPhase) &&
      /npm (?:error|ERR!) (?:code )?(?:EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|E50[0234])\b/i.test(
        tail
      )
    error.recoverable =
      mode === '--worker' &&
      !signal.aborted &&
      (failure ? failure.recoverable || networkFailure : error.code === 'ETIMEDOUT')
    output(`${error.stack ?? error}\n`, process.stderr)
    const record = (name, error) => {
      try {
        appendFileSync(join(attemptDirectory, name), `\n${error.stack ?? error}\n`)
      } catch (logError) {
        output(`无法保存 ${name}：${logError.message}\n`, process.stderr)
      }
    }
    record('failure.log', error)
    if (error !== caught) {
      output(`[smoke:${current}] 终止原因：${caught.stack ?? caught}\n`, process.stderr)
      record('failure.log', caught)
    }
    let cleanupTimer
    let cleaned = false
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
      cleaned = true
      output('[smoke:cleanup] 本次验收进程树已终止\n')
    } catch (cleanupError) {
      error.recoverable = false
      error.cleanupError = cleanupError
      record('cleanup.log', cleanupError)
      output(`验收进程树清理失败：${cleanupError.stack ?? cleanupError}\n`, process.stderr)
    } finally {
      clearTimeout(cleanupTimer)
    }
    if (verified && !failure && current === 'cleanup' && cleaned && !signal.aborted) {
      output('[smoke:cleanup] 功能验收已通过，收尾异常经强制清理恢复\n')
      return
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
  const directory = join(root, 'temp/run/npm-release', `installed-${randomUUID()}`)
  console.info(
    `[smoke:supervisor] pid=${process.pid}，parentPid=${process.ppid}，目录=${directory}`
  )
  const agentRoot = join(root, 'temp/pi/npm-release', basename(directory))
  let log
  let pendingOutput = ''
  let logBytes = 0
  let truncated = false
  const output = (chunk, stream = process.stdout) => {
    const bytes = Buffer.from(chunk)
    if (log === undefined) pendingOutput = `${pendingOutput}${chunk}`.slice(-64 * 1024)
    const available = Math.max(0, 8 * 1024 * 1024 - logBytes)
    if (log !== undefined && available) logBytes += writeSync(log, bytes.subarray(0, available))
    if (log !== undefined && bytes.length > available && !truncated) {
      writeSync(log, '\n日志已达到 8 MiB 上限；最终错误另存于各次尝试的 failure.log。\n')
      truncated = true
    }
    stream.write(chunk)
  }
  const controller = new AbortController()
  // 18 分钟包含最终释放：保留 1 分钟供原生终止（最多 30 秒）、通道关闭及目录删除。
  const overallTimer = setTimeout(
    () =>
      controller.abort(
        new Error('安装态验收工作预算耗尽（完整生命周期上限 18 分钟，预留 1 分钟收尾）')
      ),
    17 * 60_000
  )
  const interrupt = () => controller.abort(new Error('安装态验收被中断'))
  process.once('SIGTERM', interrupt)
  process.once('SIGINT', interrupt)
  const completed = new Set()
  let success = false
  try {
    const prepared = await verifyAttempt({
      root,
      directory,
      attemptDirectory: join(directory, 'prepare'),
      agentDir: join(agentRoot, 'prepare', 'agent'),
      sdkArchive,
      hostArchive,
      version,
      completed,
      signal: controller.signal,
      output,
      mode: '--prepare'
    })
    log = openSync(join(directory, 'smoke.log'), 'a')
    logBytes += writeSync(log, pendingOutput)
    pendingOutput = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      controller.signal.throwIfAborted()
      const name = `attempt-${attempt}`
      const attemptDirectory = join(directory, name)
      output(`[smoke:attempt] 开始第 ${attempt} 次验收\n`)
      try {
        await verifyAttempt({
          root,
          directory,
          attemptDirectory,
          agentDir: join(agentRoot, name, 'agent'),
          sdkArchive,
          hostArchive,
          version: prepared.version,
          piVersion: prepared.piVersion,
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
    if (!success && log === undefined && pendingOutput) {
      try {
        log = openSync(join(directory, 'smoke.log'), 'a')
        writeSync(log, pendingOutput)
      } catch (error) {
        console.error(`无法保存准备阶段日志：${error.message}`)
      }
    }
    if (log !== undefined) closeSync(log)
    log = undefined
    try {
      if (success) {
        await verifyAttempt({
          root,
          directory,
          attemptDirectory: directory,
          agentDir: agentRoot,
          completed,
          signal: controller.signal,
          output,
          mode: '--remove'
        }).catch((error) => {
          if (error.cleanupError) throw error
          console.warn(
            `验收已通过，临时目录清理未完成：${directory}、${agentRoot}；${error.message}`
          )
        })
      } else {
        console.error(`安装态命令验收失败现场：${directory}`)
      }
    } finally {
      clearTimeout(overallTimer)
      process.off('SIGTERM', interrupt)
      process.off('SIGINT', interrupt)
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
  reused,
  piVersion
}) {
  const agentDir = process.env.PI_CODING_AGENT_DIR
  const piRoot = join(directory, 'pi-runtime')
  let runtime
  let fixture
  let failure
  try {
    await phase('prepare', () => mkdir(attemptDirectory, { recursive: true }))
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
          `@earendil-works/pi-coding-agent@${piVersion}`
        ])
      }
      const installedPi = JSON.parse(
        await readFile(
          join(piRoot, 'node_modules/@earendil-works/pi-coding-agent/package.json'),
          'utf8'
        )
      )
      assert.equal(installedPi.version, piVersion, '安装的 Pi 版本必须与源码 devDependency 一致')
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
    await phase('project-search', async () => {
      const installedRequire = createRequire(join(installed, 'package.json'))
      const ripgrepModule = installedRequire.resolve('@vscode/ripgrep')
      const { rgPath } = installedRequire('@vscode/ripgrep')
      assert.equal(typeof rgPath, 'string', '安装后的 ripgrep 必须导出可执行路径')
      const modulesRoot = await realpath(join(directory, 'node_modules'))
      for (const path of [ripgrepModule, rgPath]) {
        const location = relative(modulesRoot, await realpath(path))
        assert.ok(
          !isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`),
          `搜索依赖必须来自本次独立 npm 安装：${path}`
        )
      }
      const project = join(attemptDirectory, 'project-search')
      const query = 'installed-search-check'
      const filename = `${query}.txt`
      await mkdir(project)
      const options = { cwd: project, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }
      // 独立仓库使夹具不受外层验收目录的 Git 忽略规则影响。
      await execute('git', ['init', '--quiet'], options)
      await writeFile(join(project, filename), `header\n${query}\n`)
      const { stdout: engineVersion } = await execute(rgPath, ['--version'], options)
      assert.match(engineVersion, /^ripgrep \d+/)
      const { stdout } = await execute(
        rgPath,
        [
          '--no-config',
          '--fixed-strings',
          '--no-filename',
          '--line-number',
          '-e',
          query,
          '--',
          filename
        ],
        options
      )
      assert.equal(stdout.trim(), `2:${query}`)
      const response = await fetch(`http://127.0.0.1:${port}/api/project-files/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Desk-Client-Id': randomUUID() },
        body: JSON.stringify({
          cwd: project,
          query,
          scope: 'all',
          caseSensitive: true,
          wholeWord: false,
          regex: false
        }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error'
      })
      const body = await response.json()
      assert.equal(response.status, 200, body.msg)
      assert.equal(body.code, 0, body.msg)
      const ranges = [{ start: 0, end: query.length }]
      assert.deepEqual(body.data, {
        fileMatches: [{ path: filename, ranges }],
        contentMatches: [{ path: filename, line: 2, text: query, ranges }],
        truncated: false
      })
      console.info(
        `[smoke:project-search] ${engineVersion.trim().split('\n')[0]}，二进制及安装态 HTTP 搜索通过`
      )
    })
    await phase('commands', () => fixture.verify({ port, version }))
    console.info(
      `独立 npm 安装、基础模式、项目搜索、关键命令及浏览器模块检查通过：${manifest.name}@${version}`
    )
  } catch (error) {
    failure = error
    process.send?.({ status: 'failed', recoverable: false, error: error.stack ?? String(error) })
    await writeFile(join(attemptDirectory, 'failure.log'), String(error.stack ?? error)).catch(
      (logError) => console.error('无法保存验收原始错误', logError)
    )
    throw error
  } finally {
    try {
      await phase('cleanup', async () => {
        const cleanup = await Promise.allSettled([
          runtime ? stopE2eServerTree(runtime) : Promise.resolve(),
          fixture ? fixture.close() : Promise.resolve()
        ])
        const errors = cleanup
          .filter((item) => item.status === 'rejected')
          .map((item) => item.reason)
        if (errors.length) {
          await writeFile(
            join(attemptDirectory, 'cleanup.log'),
            errors.map((error) => error.stack ?? String(error)).join('\n')
          ).catch((logError) => console.error('无法保存收尾错误', logError))
          throw new AggregateError(errors, '安装验收最终收尾未完成')
        }
      })
    } catch (cleanupError) {
      if (!failure) throw cleanupError
      console.error('安装验收收尾失败，保留原始错误', cleanupError)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2]
  const [directory, sdk, host, version, attemptDirectory, reused, piVersion] = process.argv.slice(3)
  const action =
    mode === '--prepare'
      ? phase('prepare', async () => {
          await mkdir(attemptDirectory, { recursive: true })
          // 归档和源码输入只在受监督的子进程读取，tar 同步阻塞不影响父进程截止。
          const manifest = readNpmArchiveManifest(host)
          assert.equal(manifest.name, '@jetcrab/pi-desk')
          if (version) assert.equal(manifest.version, version)
          const source = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
          const piVersion = source.devDependencies?.['@earendil-works/pi-coding-agent']
          assert.match(
            piVersion ?? '',
            /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
            'Pi devDependency 必须为精确版本'
          )
          process.send({ prepared: { version: manifest.version, piVersion } })
        })
      : mode === '--remove'
        ? phase('remove', async () => {
            for (const path of [directory, process.env.PI_CODING_AGENT_DIR]) {
              await rm(path, { recursive: true, force: true })
            }
          })
        : mode === '--worker'
          ? verifyInstalledPackage({
              directory,
              sdkArchive: sdk,
              hostArchive: host,
              version,
              attemptDirectory,
              reused: JSON.parse(reused),
              piVersion
            })
          : (async () => {
              const [sdkArchive, hostArchive] = process.argv.slice(2)
              assert.ok(
                sdkArchive && hostArchive && process.argv.length === 4,
                '用法：verify-npm-install.mjs <sdk.tgz> <host.tgz>'
              )
              await verifyNpmInstall({
                root: resolve(import.meta.dirname, '../..'),
                sdkArchive: resolve(sdkArchive),
                hostArchive: resolve(hostArchive)
              })
            })()
  action.catch((error) => {
    process.send?.({ status: 'failed', recoverable: false, error: error.stack ?? String(error) })
    console.error(error)
    process.exitCode = 1
  })
}
