import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createJiti } from 'jiti'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

test('scoped插件使用指定源，公共SDK和普通依赖保留默认源', { timeout: 90_000 }, async (t) => {
  const runId = `mixed-registry-${randomUUID()}`
  const root = resolve('temp/run/pidesk-maintenance', runId)
  const artifacts = resolve('temp/package/pidesk-maintenance', runId)
  const agentDir = join(root, 'agent')
  const pluginName = '@fixture-private/maintenance-plugin'
  const sdkName = '@fixture-public/maintenance-sdk'
  const utilityName = 'maintenance-utils'
  const definitions = [
    {
      name: pluginName,
      registry: 'private',
      manifest: {
        pi: { extensions: ['./index.js'] },
        dependencies: { [sdkName]: '1.0.0', [utilityName]: '1.0.0' }
      },
      source: `export { sdkMarker } from '${sdkName}'\nexport { utilityMarker } from '${utilityName}'\nexport default function () {}\n`
    },
    {
      name: sdkName,
      registry: 'public',
      manifest: {},
      source: "export const sdkMarker = 'public-sdk'\n"
    },
    {
      name: utilityName,
      registry: 'public',
      manifest: {},
      source: "export const utilityMarker = 'public-utility'\n"
    }
  ] as const
  const archives = new Map<string, Buffer>()
  const requests = { private: new Set<string>(), public: new Set<string>() }
  const servers = ['private', 'public'].map((registry) => {
    const server = createServer((request, response) => {
      const path = decodeURIComponent((request.url ?? '').split('?')[0])
      requests[registry as keyof typeof requests].add(path)
      const definition = definitions.find(
        (item) => item.registry === registry && path.startsWith(`/${item.name}`)
      )
      const archive = definition ? archives.get(definition.name) : undefined
      if (definition && archive) {
        if (path === `/${definition.name}/-/1.0.0.tgz`) {
          response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
          response.end(archive)
          return
        }
        if (path === `/${definition.name}`) {
          const address = server.address()
          assert.ok(address && typeof address !== 'string')
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(
            JSON.stringify({
              name: definition.name,
              'dist-tags': { latest: '1.0.0' },
              versions: {
                '1.0.0': {
                  name: definition.name,
                  version: '1.0.0',
                  type: 'module',
                  main: './index.js',
                  ...definition.manifest,
                  dist: {
                    tarball: `http://127.0.0.1:${address.port}${path}/-/1.0.0.tgz`,
                    integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`
                  }
                }
              }
            })
          )
          return
        }
      }
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: `测试源不提供此包：${path}` }))
    })
    return server
  })
  const saved = new Map<string, string | undefined>()
  let succeeded = false
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(artifacts, { recursive: true })])
  try {
    for (const [index, definition] of definitions.entries()) {
      const packageRoot = join(root, `fixture-${index}`, 'package')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: definition.name,
          version: '1.0.0',
          type: 'module',
          main: './index.js',
          ...definition.manifest
        })
      )
      await writeFile(join(packageRoot, 'index.js'), definition.source)
      const archive = join(artifacts, `fixture-${index}.tgz`)
      await execFileAsync(
        process.platform === 'win32' ? 'tar.exe' : 'tar',
        ['-czf', basename(archive), '-C', dirname(packageRoot), 'package'],
        { cwd: artifacts, timeout: 10_000, windowsHide: true }
      )
      archives.set(definition.name, await readFile(archive))
    }
    for (const server of servers) {
      server.listen(0, '127.0.0.1')
      await new Promise<void>((resolveListen) => server.once('listening', resolveListen))
    }
    const urls = servers.map((server) => {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      return `http://127.0.0.1:${address.port}`
    })
    const npmrc = join(root, 'npmrc')
    await writeFile(npmrc, '')
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [] }))
    for (const key of Object.keys(process.env)) {
      if (/^npm_config_/i.test(key)) {
        saved.set(key, process.env[key])
        delete process.env[key]
      }
    }
    const environment = {
      PI_DESK_PI_PACKAGE_DIR: resolve('node_modules/@earendil-works/pi-coding-agent'),
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
      PI_OFFLINE: '1',
      NPM_CONFIG_REGISTRY: urls[1]!,
      'NPM_CONFIG_@FIXTURE-PRIVATE:REGISTRY': 'http://127.0.0.1:1',
      npm_config_userconfig: npmrc,
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false'
    }
    for (const [key, value] of Object.entries(environment)) {
      if (!saved.has(key)) saved.set(key, process.env[key])
      process.env[key] = value
    }
    const jiti = createJiti(import.meta.url, {
      tsconfigPaths: join(process.cwd(), 'tsconfig.json'),
      alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
    })
    const { runL4PiPackageMaintenance: run } = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-package-maintenance')
    >('../src/server/l4_foundation/pi/l4-pi-package-maintenance.ts')
    await run({
      maintenance: { action: 'install', source: `npm:${pluginName}@1.0.0`, registry: urls[0]! },
      agentDir,
      cwd: root
    })
    const installed = join(agentDir, 'npm', 'node_modules', pluginName)
    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    assert.equal(installedManifest.version, '1.0.0')
    const entry = await import(pathToFileURL(join(installed, 'index.js')).href)
    assert.equal(entry.sdkMarker, 'public-sdk')
    assert.equal(entry.utilityMarker, 'public-utility')
    assert.ok(requests.private.has(`/${pluginName}`))
    assert.ok(requests.public.has(`/${sdkName}`))
    assert.ok(requests.public.has(`/${utilityName}`))
    assert.equal(requests.private.has(`/${sdkName}`), false)
    assert.equal(requests.private.has(`/${utilityName}`), false)
    succeeded = true
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const server of servers) {
      server.closeAllConnections()
      if (server.listening)
        await new Promise<void>((resolveClose, rejectClose) =>
          server.close((error) => (error ? rejectClose(error) : resolveClose()))
        )
    }
    if (succeeded) {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(artifacts, { recursive: true, force: true })
      ])
    } else {
      t.diagnostic(`失败现场：${root}`)
    }
  }
})
