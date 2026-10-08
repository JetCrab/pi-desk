import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  prepareIsolatedPiDirectory,
  spawnE2eServer,
  stopE2eServerTree
} from '../../tests/l4-e2e-server-runtime.mjs'

export async function verifyNpmInstall({ root, sdkArchive, hostArchive, version, run }) {
  const parent = join(root, 'temp/run/npm-release')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'installed-'))
  const agentRoot = join(root, 'temp/pi/npm-release', basename(directory))
  const agentDir = join(agentRoot, 'agent')
  const piRoot = join(directory, 'pi-runtime')
  let runtime
  let success = false
  try {
    const installStarted = performance.now()
    console.info('[smoke:install] 开始隔离安装宿主与 Pi 运行时')
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
    const installed = join(directory, 'node_modules/@jetcrab/pi-desk')
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    assert.equal(manifest.version, version)
    const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'))
    assert.ok(
      !Object.keys(lock.packages).some((path) => /node_modules\/@earendil-works\/pi-/.test(path)),
      '宿主不应安装另一份Pi核心'
    )
    run('npm', [
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
    const startupStarted = performance.now()
    console.info('[smoke:health] 开始启动正式安装包')
    await prepareIsolatedPiDirectory(agentDir)
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise((done, reject) =>
      reservation.close((error) => (error ? reject(error) : done()))
    )
    runtime = spawnE2eServer({
      projectRoot: installed,
      agentDir,
      port,
      managed: true,
      safeMode: true,
      piPackageDir: join(piRoot, 'node_modules/@earendil-works/pi-coding-agent'),
      onOutput: (text) => process.stdout.write(text)
    })
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      assert.equal(runtime.child.exitCode, null, '安装后的正式服务提前退出')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2000)
        })
        const body = await response.json()
        if (
          response.ok &&
          body.code === 0 &&
          body.data?.status === 'ready' &&
          body.data?.version === version
        ) {
          success = true
          break
        }
      } catch {}
      await delay(250)
    }
    console.info(
      `[smoke:health] 耗时 ${((performance.now() - startupStarted) / 1000).toFixed(1)} 秒`
    )
    assert.ok(success, '最终npm安装包未在截止时间内就绪')
    console.info(`独立npm安装及健康检查通过：${manifest.name}@${version}`)
  } finally {
    if (runtime) await stopE2eServerTree(runtime)
    if (success) {
      await rm(directory, { recursive: true, force: true })
      await rm(agentRoot, { recursive: true, force: true })
    }
  }
}
