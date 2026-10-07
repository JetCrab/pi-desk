import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createJiti } from 'jiti'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

test('真实官方 CLI 首次安装、同版本重装、latest、降级和卸载', { timeout: 150_000 }, async () => {
  const runId = `official-reinstall-${randomUUID()}`
  const root = resolve('temp/run/pidesk-maintenance', runId)
  const artifacts = resolve('temp/package/pidesk-maintenance', runId)
  const agentDir = join(root, 'agent')
  const packageName = 'pidesk-install-fixture'
  const archives = new Map<string, Buffer>()
  const saved = new Map<string, string | undefined>()
  const settingsPath = join(agentDir, 'settings.json')
  const installed = join(agentDir, 'npm', 'node_modules', packageName)
  let succeeded = false
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '').split('?')[0])
    const file = archives.get(path)
    if (file) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      response.end(file)
      return
    }
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    if (path === `/${packageName}`) {
      const versions = Object.fromEntries(
        ['1.0.0', '2.0.0'].map((version) => {
          const archive = archives.get(`/${packageName}/-/${version}.tgz`)
          assert.ok(archive)
          return [
            version,
            {
              name: packageName,
              version,
              pi: { extensions: ['./index.ts'] },
              dist: {
                tarball: `http://127.0.0.1:${address.port}/${packageName}/-/${version}.tgz`,
                integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`
              }
            }
          ]
        })
      )
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({ name: packageName, 'dist-tags': { latest: '2.0.0' }, versions })
      )
      return
    }
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: `未声明的测试 registry 路径：${path}` }))
  })
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(artifacts, { recursive: true })])
  try {
    for (const version of ['1.0.0', '2.0.0']) {
      const packageRoot = join(root, version, 'package')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: packageName, version, pi: { extensions: ['./index.ts'] } })
      )
      await writeFile(
        join(packageRoot, 'index.ts'),
        `export const marker = '${version}'\nexport default function () {}\n`
      )
      const archive = join(artifacts, `${version}.tgz`)
      await execFileAsync(
        process.platform === 'win32' ? 'tar.exe' : 'tar',
        ['-czf', basename(archive), '-C', dirname(packageRoot), 'package'],
        { cwd: artifacts, timeout: 10_000, windowsHide: true }
      )
      archives.set(`/${packageName}/-/${version}.tgz`, await readFile(archive))
    }
    server.listen(0, '127.0.0.1')
    await new Promise<void>((resolveListen) => server.once('listening', resolveListen))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const npmrc = join(root, 'npmrc')
    await writeFile(npmrc, '')
    await writeFile(settingsPath, JSON.stringify({ packages: [] }))
    const environment = {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
      PI_OFFLINE: '1',
      npm_config_registry: `http://127.0.0.1:${address.port}`,
      npm_config_userconfig: npmrc,
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false'
    }
    for (const [key, value] of Object.entries(environment)) {
      saved.set(key, process.env[key])
      process.env[key] = value
    }
    const jiti = createJiti(import.meta.url, {
      tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
      alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
    })
    const { runL4PiPackageMaintenance: run } = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-package-maintenance')
    >('../src/server/l4_foundation/pi/l4-pi-package-maintenance.ts')
    const execute = async (
      source: string,
      action: 'reinstall' | 'remove' = 'reinstall'
    ): Promise<void> => {
      await run({ maintenance: { action, source }, agentDir, cwd: root })
    }
    const version = async (): Promise<string> =>
      JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version as string
    await execute(`npm:${packageName}@1.0.0`)
    assert.equal(await version(), '1.0.0')
    await writeFile(join(installed, 'index.ts'), 'tampered\n')
    await execute(`npm:${packageName}@1.0.0`)
    assert.match(await readFile(join(installed, 'index.ts'), 'utf8'), /marker = '1.0.0'/)
    await execute(`npm:${packageName}`)
    assert.equal(await version(), '2.0.0')
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).packages, [
      `npm:${packageName}`
    ])
    await execute(`npm:${packageName}@1.0.0`)
    assert.equal(await version(), '1.0.0')
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).packages, [
      `npm:${packageName}@1.0.0`
    ])
    await execute(`npm:${packageName}@1.0.0`, 'remove')
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).packages, [])
    await assert.rejects(() => readFile(join(installed, 'package.json')), { code: 'ENOENT' })
    succeeded = true
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    server.closeAllConnections()
    if (server.listening)
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      )
    if (succeeded)
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(artifacts, { recursive: true, force: true })
      ])
  }
})
