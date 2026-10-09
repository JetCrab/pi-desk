import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from '../../tests/l4-e2e-server-runtime.mjs'
import { reservePort } from '../../tests/l4-browser-cdp-runtime.mjs'
import { createPiDeskCommandFixture } from '../../tests/l4-pidesk-command-smoke.mjs'
import { run } from './release-npm.mjs'

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
  throw new Error('最终 npm 安装包未在截止时间内就绪')
}

export async function verifyNpmInstall({
  root,
  sdkArchive,
  hostArchive,
  version,
  run: execute = run
}) {
  const parent = join(root, 'temp/run/npm-release')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'installed-'))
  const agentRoot = join(root, 'temp/pi/npm-release', basename(directory))
  const agentDir = join(agentRoot, 'agent')
  const piRoot = join(directory, 'pi-runtime')
  let runtime
  let fixture
  let output = ''
  let success = false
  let failure
  try {
    const installStarted = performance.now()
    console.info('[smoke:install] 开始隔离安装宿主与 Pi 运行时')
    await writeFile(join(directory, 'package.json'), '{"private":true}\n')
    execute('npm', [
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
    const installed = join(directory, 'node_modules/@jetcrab/pi-desk')
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    assert.equal(manifest.version, version)
    const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'))
    assert.ok(
      !Object.keys(lock.packages).some((path) => /node_modules\/@earendil-works\/pi-/.test(path)),
      '宿主不应安装另一份 Pi 核心'
    )
    execute('npm', [
      'install',
      '--prefix',
      piRoot,
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
      `@earendil-works/pi-coding-agent@${manifest.devDependencies['@earendil-works/pi-coding-agent']}`
    ])
    console.info(
      `[smoke:install] 耗时 ${((performance.now() - installStarted) / 1000).toFixed(1)} 秒`
    )
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
        onOutput: (chunk) => {
          output = `${output}${chunk}`.slice(-2 * 1024 * 1024)
          process.stdout.write(chunk)
        }
      })
    console.info('[smoke:health] 开始验证基础模式')
    runtime = start(true)
    await waitForHealth(runtime, version)
    await stopE2eServerTree(runtime)
    runtime = undefined
    fixture = await createPiDeskCommandFixture(join(directory, 'commands'), agentDir)
    console.info('[smoke:pidesk] 开始验证实际安装包的正常模式命令')
    runtime = start(false)
    await waitForHealth(runtime, version)
    await fixture.verify({ port, version })
    success = true
    console.info(
      `独立 npm 安装、基础模式、关键命令及浏览器模块检查通过：${manifest.name}@${version}`
    )
  } catch (error) {
    failure = error
    await writeFile(join(directory, 'failure.log'), String(error.stack ?? error))
    throw error
  } finally {
    const cleanup = await Promise.allSettled([
      runtime ? stopE2eServerTree(runtime) : Promise.resolve(),
      fixture ? fixture.close() : Promise.resolve()
    ])
    const errors = cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason)
    await writeFile(join(directory, 'server.log'), output)
    if (errors.length) {
      await writeFile(join(directory, 'cleanup.log'), errors.map(String).join('\n'))
      if (!failure) throw new AggregateError(errors, '安装验收资源未确认释放')
      console.error('安装验收清理失败', errors)
    } else if (success) {
      await rm(directory, { recursive: true, force: true })
      await rm(agentRoot, { recursive: true, force: true })
    }
    if (!success || errors.length) console.error(`安装态命令验收失败现场：${directory}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [sdkArchive, hostArchive] = process.argv.slice(2)
  assert.ok(
    sdkArchive && hostArchive && process.argv.length === 4,
    '用法：verify-npm-install.mjs <sdk.tgz> <host.tgz>'
  )
  const manifest = JSON.parse(
    run(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-xOf', hostArchive, 'package/package.json'],
      { capture: true }
    )
  )
  assert.equal(manifest.name, '@jetcrab/pi-desk')
  verifyNpmInstall({
    root: resolve(import.meta.dirname, '../..'),
    sdkArchive: resolve(sdkArchive),
    hostArchive: resolve(hostArchive),
    version: manifest.version
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
