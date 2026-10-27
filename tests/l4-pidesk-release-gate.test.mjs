import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { verifyNpmInstall } from '../.github/scripts/verify-npm-install.mjs'
import { waitForPortReleased } from './l4-browser-cdp-runtime.mjs'
import { selectCiChecks } from '../.github/scripts/select-ci-checks.mjs'
import { evaluateWorkflowCondition, readWorkflow } from './fixtures/l4-workflow-test-runtime.mjs'

const workflow = await readWorkflow('release-npm')
const execute = promisify(childProcess.execFile)

function canPublish({
  packages = ['pi-desk'],
  installed = 'success',
  phase = 'all',
  source = '',
  cancelled = false
} = {}) {
  return evaluateWorkflowCondition(workflow.jobs.publish.if, {
    needs: {
      plan: { result: 'success', outputs: { packages: JSON.stringify(packages) } },
      build: { result: 'success' },
      'installed-commands': { result: installed }
    },
    inputs: { phase, source_sha: source },
    cancelled: () => cancelled
  })
}

test('宿主发布等待双平台同批制品验收，失败、跳过和取消均阻断', () => {
  assert.equal(canPublish(), true)
  for (const installed of ['failure', 'cancelled', 'skipped'])
    assert.equal(canPublish({ installed }), false)
  assert.equal(canPublish({ cancelled: true }), false)
  const installed = workflow.jobs['installed-commands']
  for (const dependency of ['plan', 'build']) assert.ok(installed.needs.includes(dependency))
  for (const os of ['ubuntu-latest', 'windows-latest'])
    assert.ok(installed.strategy.matrix.os.includes(os))
  for (const dependency of ['plan', 'build', 'installed-commands'])
    assert.ok(workflow.jobs.publish.needs.includes(dependency))
})

test('纯插件批次可跳过宿主检查，正式构建与已验证制品复用保持原语义', () => {
  assert.equal(canPublish({ packages: ['pi-desk-usage'], installed: 'skipped' }), true)
  assert.equal(canPublish({ phase: 'build' }), false)
  assert.equal(canPublish({ phase: 'publish', source: 'fixed-source', installed: 'skipped' }), true)
  assert.equal(canPublish({ phase: 'publish', source: '', installed: 'skipped' }), false)
  const downloads = workflow.jobs.publish.steps.filter((step) =>
    step.uses?.startsWith('actions/download-artifact@')
  )
  assert.ok(downloads.some((step) => step.with.path === '${{ env.NPM_ARTIFACT_DIR }}'))
  const verification = workflow.jobs['installed-commands'].steps.find((step) =>
    step.run?.includes('verify-npm-install.mjs')
  )
  assert.ok(verification.run.includes('command-smoke/sdk.tgz'))
  assert.ok(verification.run.includes('command-smoke/host.tgz'))
})

test('安装态验收在 Job 超时前结束并为失败和取消保留现场', () => {
  const job = workflow.jobs['installed-commands']
  const verification = job.steps.find((step) => step.run?.includes('verify-npm-install.mjs'))
  const upload = job.steps.find((step) => step.with?.name?.startsWith('npm-install-failure-'))
  assert.ok(verification['timeout-minutes'] > 0)
  assert.ok(upload['timeout-minutes'] > 0)
  assert.ok(verification['timeout-minutes'] + upload['timeout-minutes'] < job['timeout-minutes'])
  for (const [failed, cancelled] of [
    [true, false],
    [false, true],
    [false, false]
  ]) {
    assert.equal(
      evaluateWorkflowCondition(upload.if, {
        failure: () => failed,
        cancelled: () => cancelled
      }),
      failed || cancelled
    )
  }
  assert.equal(upload.with['if-no-files-found'], 'ignore')
  assert.ok(upload.with.path.includes('temp/run/npm-release/'))
})

async function withVerificationWorker(t, scenarios, check, modes = ['--worker']) {
  const parent = resolve(import.meta.dirname, '../temp/run/npm-release')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'recovery-'))
  await mkdir(join(root, 'package'), { recursive: true })
  await writeFile(
    join(root, 'package/package.json'),
    JSON.stringify({ name: '@jetcrab/pi-desk', version: '1.0.0' })
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ devDependencies: { '@earendil-works/pi-coding-agent': '1.2.0' } })
  )
  const archive = join(root, 'host.tgz')
  await execute(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', 'host.tgz', 'package'], {
    cwd: root,
    timeout: 5_000
  })
  const spawn = childProcess.spawn
  const launches = []
  const pending = []
  const waiting = []
  const next = () =>
    pending.length ? Promise.resolve(pending.shift()) : new Promise((done) => waiting.push(done))
  let passed = false
  const replacement = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (!modes.includes(args[1])) return spawn(command, args, options)
    const scenario = scenarios[launches.length]
    assert.ok(scenario, '不得超出授权的自动恢复次数')
    const script = `
      const { spawn, execFileSync } = require('node:child_process')
      const { mkdirSync, writeFileSync } = require('node:fs')
      const { join } = require('node:path')
      const directory = process.argv[1]
      mkdirSync(directory, { recursive: true })
      const [kind, phase] = process.argv[2].split(':')
      if (phase === 'install-pi' || phase === 'commands') process.send({ phase: 'install-host', status: 'complete' })
      if (phase === 'commands') process.send({ phase: 'install-pi', status: 'complete' })
      if (kind === 'success') {
        mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true })
        process.send({ phase: 'cleanup' })
        console.log('验收成功输出')
        process.disconnect()
      } else if (kind === 'network' || kind === 'assertion') {
        process.send({ phase })
        console.log(kind === 'network' ? 'npm error code ECONNRESET' : '版本断言失败')
        process.send({ phase, status: 'failed', recoverable: false })
        process.exitCode = 1
        process.disconnect()
      } else {
        const child = spawn(process.execPath, ['-e', \`
          const server = require('node:http').createServer()
          server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))
        \`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: process.platform !== 'win32' })
        child.once('message', ({ port }) => {
          writeFileSync(join(directory, 'state.json'), JSON.stringify({ pid: child.pid, port }))
          if (kind === 'verified') {
            process.send({ phase: 'commands', status: 'complete' })
          } else if (phase === 'cleanup') {
            writeFileSync(join(directory, 'failure.log'), '最初的验收错误\\n')
            process.send({ phase: 'commands', status: 'failed', recoverable: false, error: '最初的验收错误' })
          }
          process.send({ phase })
          console.log('阻塞前的命令输出')
          execFileSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
        })
      }
    `
    const worker = spawn(command, ['-e', script, args[6], scenario], options)
    const phaseStarted = new Promise((done) =>
      worker.on('message', (message) => {
        if (!message.status) done()
      })
    )
    const ready = Promise.all([phaseStarted, once(worker.stdout, 'data')])
    const launch = {
      worker,
      ready,
      closed: once(worker, 'close'),
      directory: args[2],
      attemptDirectory: args[6],
      reused: JSON.parse(args[7]),
      agentDir: options.env.PI_CODING_AGENT_DIR,
      piVersion: args[8]
    }
    launches.push(launch)
    if (waiting.length) waiting.shift()(launch)
    else pending.push(launch)
    return worker
  })
  syncBuiltinESMExports()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const verification = verifyNpmInstall({
      root,
      sdkArchive: archive,
      hostArchive: archive,
      version: '1.0.0'
    })
    verification.catch(() => undefined)
    await check({ verification, next, root, launches })
    passed = true
  } finally {
    replacement.mock.restore()
    syncBuiltinESMExports()
    t.mock.timers.reset()
    const { terminateManagedTree } =
      await import('../src/server/l4_foundation/process/l4-process-tree.js')
    for (const { worker } of launches) {
      if (worker.exitCode === null && worker.signalCode === null) await terminateManagedTree(worker)
    }
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`验收自动恢复测试现场：${root}`)
  }
}

async function assertWorkerReleased(launch, state) {
  await launch.closed
  assert.ok(launch.worker.exitCode !== null || launch.worker.signalCode !== null)
  await waitForPortReleased(state.port)
  if (process.platform === 'win32') {
    assert.throws(() => process.kill(state.pid, 0), { code: 'ESRCH' })
  } else {
    const status = await execute('ps', ['-o', 'stat=', '-p', String(state.pid)]).catch((error) => {
      if (error.code === 1) return { stdout: '' }
      throw error
    })
    assert.ok(!status.stdout.trim() || status.stdout.trim().startsWith('Z'), '后代不能继续运行')
  }
}

for (const [phase, timeout, label] of [
  ['install-host', 240_000, '安装宿主'],
  ['install-pi', 240_000, '安装 Pi 运行时'],
  ['commands', 300_000, '验证安装态命令与浏览器模块']
]) {
  test(`${label}连续超时只自动恢复一次，保留两次现场并释放进程`, { timeout: 30_000 }, async (t) => {
    await withVerificationWorker(
      t,
      [`hang:${phase}`, `hang:${phase}`],
      async ({ verification, next }) => {
        const releases = []
        for (let attempt = 1; attempt <= 2; attempt++) {
          const launch = await next()
          await launch.ready
          const state = JSON.parse(
            await readFile(join(launch.attemptDirectory, 'state.json'), 'utf8')
          )
          releases.push([launch, state])
          assert.match(
            await readFile(join(launch.directory, 'smoke.log'), 'utf8'),
            /阻塞前的命令输出/
          )
          t.mock.timers.tick(timeout)
          if (attempt === 2)
            await assert.rejects(verification, new RegExp(`验收阶段超时：${label}`))
          await launch.closed
          assert.match(
            await readFile(join(launch.attemptDirectory, 'failure.log'), 'utf8'),
            new RegExp(`验收阶段超时：${label}`)
          )
        }
        t.mock.timers.reset()
        for (const [launch, state] of releases) await assertWorkerReleased(launch, state)
      }
    )
  })
}

test(
  '首次命令验收卡住后复用安装和缓存，在新隔离环境恢复并最终通过',
  { timeout: 30_000 },
  async (t) => {
    await withVerificationWorker(
      t,
      ['hang:commands', 'success'],
      async ({ verification, next, root }) => {
        const first = await next()
        await first.ready
        const state = JSON.parse(await readFile(join(first.attemptDirectory, 'state.json'), 'utf8'))
        t.mock.timers.tick(300_000)
        const second = await next()
        await second.ready
        assert.deepEqual(second.reused, ['install-host', 'install-pi'])
        assert.equal(second.piVersion, '1.2.0', 'Pi 输入取本次源码的精确 devDependency')
        assert.equal(second.directory, first.directory)
        assert.notEqual(second.agentDir, first.agentDir)
        assert.notEqual(second.attemptDirectory, first.attemptDirectory)
        await verification
        t.mock.timers.reset()
        await assertWorkerReleased(first, state)
        assert.deepEqual(await readdir(join(root, 'temp/run/npm-release')), [])
        assert.deepEqual(await readdir(join(root, 'temp/pi/npm-release')), [])
      }
    )
  }
)

test('Pi 下载临时断网后复用宿主安装，自动恢复成功', { timeout: 30_000 }, async (t) => {
  await withVerificationWorker(
    t,
    ['network:install-pi', 'success'],
    async ({ verification, next }) => {
      const first = await next()
      await first.ready
      const second = await next()
      await second.ready
      assert.deepEqual(second.reused, ['install-host'])
      await verification
    }
  )
})

test('确定性的校验失败不重试，也不能因清理超时掩盖原始错误', { timeout: 30_000 }, async (t) => {
  await withVerificationWorker(t, ['hang:cleanup'], async ({ verification, next, launches }) => {
    const first = await next()
    await first.ready
    const state = JSON.parse(await readFile(join(first.attemptDirectory, 'state.json'), 'utf8'))
    t.mock.timers.tick(90_000)
    await assert.rejects(verification, /最初的验收错误/)
    t.mock.timers.reset()
    await assertWorkerReleased(first, state)
    assert.equal(launches.length, 1)
    assert.ok(
      (await readFile(join(first.attemptDirectory, 'failure.log'), 'utf8')).startsWith(
        '最初的验收错误\n'
      )
    )
  })
})

test('功能验收通过后收尾卡住，强制释放成功就保留验收结果', { timeout: 30_000 }, async (t) => {
  await withVerificationWorker(
    t,
    ['verified:cleanup'],
    async ({ verification, next, launches }) => {
      const first = await next()
      await first.ready
      const state = JSON.parse(await readFile(join(first.attemptDirectory, 'state.json'), 'utf8'))
      t.mock.timers.tick(90_000)
      await verification
      t.mock.timers.reset()
      await assertWorkerReleased(first, state)
      assert.equal(launches.length, 1, '已完成的功能验收不重做')
    }
  )
})

test('验收成功后临时目录删除失败只告警，不推翻验收', { timeout: 30_000 }, async (t) => {
  const warning = t.mock.method(console, 'warn', () => {})
  await withVerificationWorker(
    t,
    ['success', 'assertion:remove'],
    async ({ verification }) => {
      await verification
    },
    ['--worker', '--remove']
  )
  assert.equal(warning.mock.calls.length, 1)
  assert.ok(
    warning.mock.calls.every(({ arguments: args }) => args[0].includes('临时目录清理未完成'))
  )
})

test('明确的版本断言失败直接阻断，不盲目重试', { timeout: 30_000 }, async (t) => {
  await withVerificationWorker(
    t,
    ['assertion:install-host'],
    async ({ verification, next, launches }) => {
      await (
        await next()
      ).ready
      await assert.rejects(verification, /验收子进程失败/)
      assert.equal(launches.length, 1)
    }
  )
})

test('安装态验收正常结束时清理本次日志与隔离 Agent 目录', { timeout: 30_000 }, async (t) => {
  await withVerificationWorker(t, ['success'], async ({ verification, next, root }) => {
    await (
      await next()
    ).ready
    await verification
    assert.deepEqual(await readdir(join(root, 'temp/run/npm-release')), [])
    assert.deepEqual(await readdir(join(root, 'temp/pi/npm-release')), [])
  })
})

test('读取入口阻塞也在监督截止内终止，保留阶段和后代释放证据', { timeout: 30_000 }, async (t) => {
  await withVerificationWorker(
    t,
    ['hang:prepare'],
    async ({ verification, next, launches }) => {
      const launch = await next()
      await launch.ready
      const state = JSON.parse(await readFile(join(launch.attemptDirectory, 'state.json'), 'utf8'))
      t.mock.timers.tick(60_000)
      await assert.rejects(verification, /验收阶段超时：准备验收/)
      t.mock.timers.reset()
      await assertWorkerReleased(launch, state)
      assert.equal(launches.length, 1)
    },
    ['--prepare']
  )
})

test('总预算耗尽终止正在执行的尝试，不再恢复', { timeout: 30_000 }, async (t) => {
  await withVerificationWorker(t, ['hang:commands'], async ({ verification, next, launches }) => {
    const launch = await next()
    await launch.ready
    const state = JSON.parse(await readFile(join(launch.attemptDirectory, 'state.json'), 'utf8'))
    for (let index = 0; index < 4; index++) {
      launch.worker.emit('message', { phase: 'install-host' })
      t.mock.timers.tick(239_000)
    }
    launch.worker.emit('message', { phase: 'commands' })
    t.mock.timers.tick(64_000)
    await assert.rejects(verification, /完整生命周期上限 18 分钟/)
    t.mock.timers.reset()
    await assertWorkerReleased(launch, state)
    assert.equal(launches.length, 1)
  })
})

test('目录删除阻塞有独立截止，底层命令和端口释放后才返回', { timeout: 30_000 }, async (t) => {
  const warning = t.mock.method(console, 'warn', () => {})
  await withVerificationWorker(
    t,
    ['success', 'hang:remove'],
    async ({ verification, next }) => {
      await (
        await next()
      ).ready
      const launch = await next()
      await launch.ready
      const state = JSON.parse(await readFile(join(launch.attemptDirectory, 'state.json'), 'utf8'))
      t.mock.timers.tick(10_000)
      await verification
      t.mock.timers.reset()
      await assertWorkerReleased(launch, state)
      assert.match(warning.mock.calls[0].arguments[0], /删除验收临时目录/)
    },
    ['--worker', '--remove']
  )
})

test('Pi 安装只使用源码精确版本，并在实际安装版本不符时阻断', { timeout: 30_000 }, async (t) => {
  const parent = resolve(import.meta.dirname, '../temp/run/npm-release')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'pi-input-'))
  let passed = false
  const spawn = childProcess.spawn
  const preload = join(root, 'controlled-install.mjs')
  await writeFile(
    preload,
    `
    import childProcess from 'node:child_process'
    import fs from 'node:fs'
    import promises from 'node:fs/promises'
    import { join } from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const directory = process.argv[3]
    const original = childProcess.execFileSync
    childProcess.execFileSync = (file, args, options) => {
      if (!['npm', 'cmd.exe'].includes(file)) return original(file, args, options)
      fs.appendFileSync(${JSON.stringify(join(root, 'commands.log'))}, JSON.stringify([file, args]) + '\\n')
      const pi = args.join(' ').includes('@earendil-works/pi-coding-agent@')
      const target = pi ? join(directory, 'pi-runtime/node_modules/@earendil-works/pi-coding-agent') : join(directory, 'node_modules/@jetcrab/pi-desk')
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(join(target, 'package.json'), JSON.stringify({ name: pi ? '@earendil-works/pi-coding-agent' : '@jetcrab/pi-desk', version: pi ? process.env.CONTROLLED_PI_VERSION : '1.0.0-dev' }))
      if (!pi) fs.writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: {} }))
      return ''
    }
    const mkdir = promises.mkdir
    promises.mkdir = (path, options) => {
      if (String(path) === join(process.env.PI_CODING_AGENT_DIR, 'sessions')) throw new Error('受控运行前停止')
      return mkdir(path, options)
    }
    const settle = Promise.allSettled
    if (process.env.CONTROLLED_PI_VERSION === '1.2.0') {
      Promise.allSettled = async (operations) => [
        ...await settle.call(Promise, operations),
        { status: 'rejected', reason: new Error('受控收尾失败') }
      ]
    }
    syncBuiltinESMExports()
  `
  )
  let firstAttemptDirectory
  let installedVersion
  const replacement = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (args[1] !== '--worker') return spawn(command, args, options)
    firstAttemptDirectory ??= args[6]
    return spawn(command, ['--import', pathToFileURL(preload).href, ...args], {
      ...options,
      env: { ...options.env, CONTROLLED_PI_VERSION: installedVersion }
    })
  })
  syncBuiltinESMExports()
  try {
    await mkdir(join(root, 'package'))
    await writeFile(
      join(root, 'package/package.json'),
      JSON.stringify({ name: '@jetcrab/pi-desk', version: '1.0.0-dev' })
    )
    await execute(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-czf', 'host.tgz', 'package'],
      { cwd: root, timeout: 5_000 }
    )
    for (const [declared, installed, expected] of [
      ['1.2.0', '1.2.0', /受控运行前停止/],
      ['1.2.0', '9.9.9', /安装的 Pi 版本必须与源码 devDependency 一致/],
      ['^1.2.0', '1.2.0', /Pi devDependency 必须为精确版本/]
    ]) {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          version: '1.0.0',
          devDependencies: { '@earendil-works/pi-coding-agent': declared }
        })
      )
      installedVersion = installed
      await assert.rejects(
        verifyNpmInstall({
          root,
          sdkArchive: join(root, 'host.tgz'),
          hostArchive: join(root, 'host.tgz')
        }),
        expected
      )
    }
    assert.match(
      await readFile(join(firstAttemptDirectory, 'failure.log'), 'utf8'),
      /受控运行前停止/
    )
    assert.match(await readFile(join(firstAttemptDirectory, 'cleanup.log'), 'utf8'), /受控收尾失败/)
    const commands = (await readFile(join(root, 'commands.log'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.equal(commands.length, 4, '范围版本在调用 npm 前就失败')
    const piCommands = commands.filter(([, args]) =>
      args.join(' ').includes('@earendil-works/pi-coding-agent@')
    )
    assert.equal(piCommands.length, 2)
    for (const [, args] of piCommands) {
      assert.match(args.join(' '), /@earendil-works\/pi-coding-agent@1\.2\.0/)
      assert.doesNotMatch(args.join(' '), /@latest/)
    }
    passed = true
  } finally {
    replacement.mock.restore()
    syncBuiltinESMExports()
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`Pi 安装输入测试现场：${root}`)
  }
})

test('Source checks 在两个平台执行核心与真实命令验收', async () => {
  const checks = await readWorkflow('check')
  const job = checks.jobs.pidesk
  for (const os of ['ubuntu-latest', 'windows-latest'])
    assert.ok(job.strategy.matrix.os.includes(os))
  assert.ok(job.steps.some((step) => /\bpnpm\s+test:pidesk\b/.test(step.run ?? '')))
  assert.ok(job.steps.some((step) => step.run?.includes('tests/l1-pidesk.e2e.mjs')))
})

test('源码公开边界只由独立检查负责且不因业务选择而跳过', async () => {
  const checks = await readWorkflow('check')
  const owners = Object.values(checks.jobs).filter((job) =>
    job.steps?.some((step) => step.run?.includes('l4-public-boundary.test.mjs'))
  )
  assert.equal(owners.length, 1)
  assert.equal(owners[0].if, undefined)
  const checkout = owners[0].steps.find((step) => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.ref, '${{ inputs.source_sha || github.sha }}')
  const boundary = owners[0].steps.find((step) => step.run?.includes('l4-public-boundary.test.mjs'))
  assert.equal(boundary.if, undefined)
})

test('关键命令实现、回归及验收入口变化触发检查，无关文档和官网不触发', () => {
  for (const path of [
    'src/server/l4_foundation/pi/l4-pi-runtime-register.mjs',
    'plugins/pi-desk-sdk/src/browser.ts',
    'tests/l1-pidesk.e2e.mjs',
    'tests/l4-pidesk-command-smoke.mjs',
    'tests/l4-pidesk-installed-runners.test.mjs',
    'tests/l4-browser-cdp-runtime.mjs',
    '.github/scripts/verify-npm-install.mjs'
  ])
    assert.equal(selectCiChecks([path], false).pidesk, true, path)
  for (const path of [
    'README.md',
    'apps/website/src/app/page.tsx',
    'plugins/pi-desk-usage/README.md'
  ])
    assert.equal(selectCiChecks([path], false).pidesk, false, path)
})
