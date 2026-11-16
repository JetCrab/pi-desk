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
import { assertPortReleased } from './l4-e2e-server-runtime.mjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

test(
  '重载真实补装缺包，保持版本、渠道、资源筛选与停用；失败项不阻断后续恢复',
  { timeout: 180_000 },
  async (t) => {
    const runId = `missing-packages-${randomUUID()}`
    const root = resolve('temp/run/plugin-reload', runId)
    const agentRoot = resolve('temp/pi/plugin-reload', runId)
    const agentDir = join(agentRoot, 'agent')
    const archives = new Map<string, Buffer>()
    const requests: string[] = []
    const names = ['reload-enabled', 'reload-disabled']
    const version = '1.0.0'
    let origin = ''
    const registry = createServer((request, response) => {
      const path = decodeURIComponent((request.url ?? '').split('?')[0])
      requests.push(path)
      const name = names.find((name) => path.startsWith(`/${name}`))
      const archive = name ? archives.get(name) : undefined
      if (!name || !archive) {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end('{"error":"fixture package unavailable"}')
        return
      }
      if (path.endsWith('.tgz')) {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        response.end(archive)
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          name,
          'dist-tags': { latest: '2.0.0', dev: '2.0.0' },
          versions: Object.fromEntries(
            [version, '2.0.0'].map((value) => [
              value,
              {
                name,
                version: value,
                type: 'module',
                piDesk: { entry: './entry.mjs' },
                dist: {
                  tarball: `${origin}/${name}/-/${value}.tgz`,
                  integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`
                }
              }
            ])
          )
        })
      )
    })
    const saved = new Map<string, string | undefined>()
    let succeeded = false
    let management:
      | import('../src/server/l2_biz/plugin-management/l2-plugin-management').L2PluginManagement
      | undefined
    let runtime:
      | import('../src/server/l4_foundation/pi/l4-pi-global-plugin-runtime').L4PiGlobalPluginRuntime
      | undefined
    const previousRuntime = globalThis.__piDeskGlobalPluginRuntime
    let port = 0
    try {
      await mkdir(agentDir, { recursive: true })
      await mkdir(root, { recursive: true })
      for (const name of names) {
        const packageRoot = join(root, name, 'package')
        await mkdir(packageRoot, { recursive: true })
        await writeFile(
          join(packageRoot, 'package.json'),
          JSON.stringify({
            name,
            version,
            type: 'module',
            piDesk: { entry: './entry.mjs' }
          })
        )
        await writeFile(
          join(packageRoot, 'entry.mjs'),
          `import { ok } from './helper.mjs'; export default { name: '${name}', setup(plugin) { plugin.registerMethod('ping', async () => ({ ok })) } }`
        )
        await writeFile(join(packageRoot, 'helper.mjs'), 'export const ok = true')
        const archive = join(root, `${name}.tgz`)
        await execFileAsync(
          process.platform === 'win32' ? 'tar.exe' : 'tar',
          ['-czf', basename(archive), '-C', dirname(packageRoot), 'package'],
          { cwd: root, timeout: 10_000, windowsHide: true }
        )
        archives.set(name, await readFile(archive))
      }
      await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done))
      const address = registry.address()
      assert.ok(address && typeof address !== 'string')
      port = address.port
      origin = `http://127.0.0.1:${port}`
      const npmrc = join(root, 'npmrc')
      const globalNpmrc = join(root, 'global-npmrc')
      await writeFile(npmrc, '')
      await writeFile(globalNpmrc, '')
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
        PI_DESK_SAFE_MODE: '',
        npm_config_registry: origin,
        npm_config_userconfig: npmrc,
        npm_config_globalconfig: globalNpmrc,
        npm_config_cache: join(root, 'npm-cache'),
        NPM_CONFIG_AUDIT: 'true',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false'
      }
      for (const [key, value] of Object.entries(environment)) {
        if (!saved.has(key)) saved.set(key, process.env[key])
        process.env[key] = value
      }
      const jiti = createJiti(import.meta.url, {
        nativeModules: [
          '@earendil-works/pi-coding-agent',
          '@earendil-works/pi-agent-core',
          '@earendil-works/pi-ai'
        ],
        tsconfigPaths: resolve('tsconfig.json'),
        alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
      })
      const preferences = await jiti.import<
        typeof import('../src/server/l4_foundation/pi/l4-pi-plugin-preferences')
      >('../src/server/l4_foundation/pi/l4-pi-plugin-preferences.ts')
      const { L2PluginManagement } = await jiti.import<
        typeof import('../src/server/l2_biz/plugin-management/l2-plugin-management')
      >('../src/server/l2_biz/plugin-management/l2-plugin-management.ts')
      const { L4PiGlobalPluginRuntime } = await jiti.import<
        typeof import('../src/server/l4_foundation/pi/l4-pi-global-plugin-runtime')
      >('../src/server/l4_foundation/pi/l4-pi-global-plugin-runtime.ts')
      const enabled = `npm:${names[0]}@${version}`
      const disabled = `npm:${names[1]}@${version}`
      const unavailable = 'npm:reload-unavailable@1.0.0'
      const packages = [{ source: enabled, skills: [], prompts: [] }, disabled, unavailable]
      await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages }))
      await preferences.setL4PiPluginDownloadSource({ mode: 'custom', registry: origin }, agentDir)
      await preferences.setL4PiPluginUpdateTag(enabled, 'dev', agentDir)
      await preferences.setL4PiPluginEnabled(disabled, false, agentDir)
      runtime = new L4PiGlobalPluginRuntime(root, agentDir)
      globalThis.__piDeskGlobalPluginRuntime = runtime
      management = new L2PluginManagement(
        { runPluginRestart: (operation) => operation() },
        root,
        agentDir
      )
      const before = await management.list(true)
      assert.equal(before.plugins.length, 3)
      assert.ok(
        before.plugins.every(
          (item) => item.error && item.version === null && item.updateError === null
        )
      )
      assert.equal(requests.length, 0, '缺包列表和检查更新不下载，也不要求已安装版本')
      const accepted = await management.batch({
        action: 'apply',
        sources: [unavailable, enabled, disabled]
      })
      assert.ok(accepted.results.every((result) => result.error === null))
      await management.waitForOperations([enabled, disabled], AbortSignal.timeout(120_000))
      await assert.rejects(
        management.waitForOperations([unavailable], AbortSignal.timeout(5_000)),
        /HTTP 404/
      )
      const after = await management.list()
      const enabledItem = after.plugins.find((item) => item.source === enabled)!
      const disabledItem = after.plugins.find((item) => item.source === disabled)!
      assert.equal(enabledItem.status, 'ready')
      assert.equal(enabledItem.version, version)
      assert.equal(enabledItem.updateTag, 'dev')
      assert.equal(enabledItem.error, null)
      assert.equal(disabledItem.status, 'disabled')
      assert.equal(disabledItem.version, version)
      assert.equal(disabledItem.error, null)
      assert.deepEqual(
        JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).packages,
        packages
      )
      assert.equal(
        runtime.readDiagnostics().packages.some((item) => item.pluginName === names[1]),
        false
      )
      assert.equal(
        requests.some((path) => path.endsWith('/2.0.0.tgz')),
        false
      )

      const healthyRequests = requests.length
      await management.apply([enabled])
      await management.waitForOperations([enabled], AbortSignal.timeout(30_000))
      assert.equal(requests.length, healthyRequests, '健康包重载不联网或重装')

      await rm(join(agentDir, 'npm/node_modules', names[0], 'entry.mjs'))
      await management.apply([enabled])
      await management.waitForOperations([enabled], AbortSignal.timeout(60_000))
      assert.match(
        await readFile(join(agentDir, 'npm/node_modules', names[0], 'entry.mjs'), 'utf8'),
        /registerMethod/
      )
      assert.equal(
        (await management.list()).plugins.find((item) => item.source === enabled)?.status,
        'ready'
      )

      await rm(join(agentDir, 'npm/node_modules', names[0], 'helper.mjs'))
      await management.apply([enabled])
      await management.waitForOperations([enabled], AbortSignal.timeout(60_000))
      assert.equal(
        await readFile(join(agentDir, 'npm/node_modules', names[0], 'helper.mjs'), 'utf8'),
        'export const ok = true'
      )

      await management.del(unavailable)
      await management.waitForOperations([unavailable], AbortSignal.timeout(30_000))
      const final = await management.list()
      assert.equal(final.loadError, null, '补装和移除后根目录不一致诊断应消失')
      assert.equal(final.plugins.length, 2)
      assert.equal(
        requests.some((path) => path.startsWith('/-/npm/v1/security/')),
        false,
        '维护进程应关闭自动审计，不受继承的 npm 配置大小写影响'
      )
      succeeded = true
    } finally {
      management?.dispose()
      if (management) await Reflect.get(management, 'operationTail')
      await runtime?.dispose()
      globalThis.__piDeskGlobalPluginRuntime = previousRuntime
      registry.closeAllConnections()
      if (registry.listening) await new Promise<void>((done) => registry.close(() => done()))
      if (port) await assertPortReleased(port)
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (succeeded)
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(agentRoot, { recursive: true, force: true })
        ])
      else t.diagnostic(`失败现场：${root}；${agentRoot}`)
    }
  }
)
