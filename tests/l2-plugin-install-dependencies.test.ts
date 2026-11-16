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

const execute = promisify(execFile)
const require = createRequire(import.meta.url)

test(
  '隔离预检和正式安装保留依赖版本、复用下载缓存并分别使用公共源和私有源',
  { timeout: 180_000 },
  async (t) => {
    const runId = `locked-dependencies-${randomUUID()}`
    const root = resolve('temp/run/plugin-install', runId)
    const agentRoot = resolve('temp/pi/plugin-install', runId)
    const agentDir = join(agentRoot, 'agent')
    const plugin = '@fixture-public/install-plugin'
    const privatePlugin = '@fixture-private/install-plugin'
    const sdk = '@jetcrab/install-sdk'
    const utility = 'install-utility'
    const requests: string[] = []
    const archives = new Map<string, { manifest: Record<string, unknown>; archive: Buffer }>()
    let publishedNewDependencies = false
    let origin = ''
    const registry = createServer((request, response) => {
      const path = decodeURIComponent((request.url ?? '').split('?')[0])
      requests.push(path)
      const prefix = path.startsWith('/private/') ? '/private/' : '/public/'
      const resource = path.slice(prefix.length)
      const tarballMatch = /^(.*)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/.exec(resource)
      const tarball = tarballMatch
        ? archives.get(`${tarballMatch[1]}@${tarballMatch[2]}`)
        : undefined
      if (tarball) {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(tarball.archive)
        return
      }
      const versions = [...archives.values()].filter(
        ({ manifest }) =>
          manifest.name === resource &&
          (resource === privatePlugin ? prefix === '/private/' : prefix === '/public/') &&
          (publishedNewDependencies ||
            ![`${sdk}@1.1.0`, `${sdk}@2.0.0`, `${utility}@4.6.7`].includes(
              `${resource}@${manifest.version}`
            ))
      )
      response.setHeader('Content-Type', 'application/json')
      if (!versions.length) {
        response.writeHead(404).end('{"error":"fixture unavailable"}')
        return
      }
      response.end(
        JSON.stringify({
          name: resource,
          'dist-tags': { latest: versions.at(-1)!.manifest.version },
          versions: Object.fromEntries(
            versions.map(({ manifest, archive }) => [
              manifest.version,
              {
                ...manifest,
                dist: {
                  tarball: `${[sdk, utility].includes(resource) ? 'https://registry.npmjs.org' : `${origin}${prefix.slice(0, -1)}`}/${manifest.name}/-/${String(manifest.name).split('/').at(-1)}-${manifest.version}.tgz`,
                  integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`
                }
              }
            ])
          )
        })
      )
    })
    const saved = new Map<string, string | undefined>()
    const previousRuntime = globalThis.__piDeskGlobalPluginRuntime
    let management:
      | import('../src/server/l2_biz/plugin-management/l2-plugin-management').L2PluginManagement
      | undefined
    let runtime:
      | import('../src/server/l4_foundation/pi/l4-pi-global-plugin-runtime').L4PiGlobalPluginRuntime
      | undefined
    let port = 0
    let succeeded = false
    try {
      await mkdir(agentDir, { recursive: true })
      await mkdir(root, { recursive: true })
      const definitions = [
        { name: utility, version: '4.4.3', source: "export const version = '4.4.3'" },
        { name: utility, version: '4.6.7', source: "export const version = '4.6.7'" },
        {
          name: sdk,
          version: '1.0.0',
          dependencies: { [utility]: '^4.4.3' },
          source: `export { version } from '${utility}'`
        },
        {
          name: sdk,
          version: '1.1.0',
          dependencies: { [utility]: '^4.4.3' },
          source: `export { version } from '${utility}'`
        },
        {
          name: sdk,
          version: '2.0.0',
          dependencies: { [utility]: '^4.6.7' },
          source: `export { version } from '${utility}'`
        },
        ...['1.0.0', '1.0.1', '2.0.0', '3.0.0'].map((version) => ({
          name: plugin,
          version,
          dependencies: { [sdk]: version.startsWith('1.') ? '^1.0.0' : '^2.0.0' },
          piDesk: { entry: './index.js' },
          source: `import { version } from '${sdk}'; export default { name: 'install-fixture', setup() {
          if (version !== '${version.startsWith('1.') ? '4.4.3' : '4.6.7'}') throw new Error('依赖版本发生漂移：' + version)
          ${version === '3.0.0' ? "throw new Error('候选预检主动失败')" : ''}
        } }`
        })),
        {
          name: privatePlugin,
          version: '1.0.0',
          dependencies: { [sdk]: '^2.0.0' },
          piDesk: { entry: './index.js' },
          source: `import { version } from '${sdk}'; export default { name: 'private-install-fixture', setup() { if (version !== '4.6.7') throw new Error(version) } }`
        }
      ]
      for (const [index, definition] of definitions.entries()) {
        const { source, ...fields } = definition
        const manifest = { type: 'module', main: './index.js', ...fields }
        const packageRoot = join(root, `fixture-${index}`, 'package')
        await mkdir(packageRoot, { recursive: true })
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
        await writeFile(join(packageRoot, 'index.js'), source)
        const archivePath = join(root, `fixture-${index}.tgz`)
        await execute(
          process.platform === 'win32' ? 'tar.exe' : 'tar',
          ['-czf', basename(archivePath), '-C', dirname(packageRoot), 'package'],
          { cwd: root, timeout: 10_000, windowsHide: true }
        )
        archives.set(`${definition.name}@${definition.version}`, {
          manifest,
          archive: await readFile(archivePath)
        })
      }
      await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done))
      const address = registry.address()
      assert.ok(address && typeof address !== 'string')
      port = address.port
      origin = `http://127.0.0.1:${port}`
      const publicRegistry = `${origin}/public`
      const privateRegistry = `${origin}/private`
      await writeFile(join(root, 'npmrc'), '')
      await writeFile(join(root, 'global-npmrc'), '')
      await mkdir(join(agentDir, 'npm'), { recursive: true })
      await writeFile(
        join(agentDir, 'npm/.npmrc'),
        `@fixture-private:registry=${privateRegistry}\n@jetcrab:registry=http://127.0.0.1:1\n`
      )
      await writeFile(join(agentDir, 'settings.json'), '{"packages":[]}')
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
        NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1',
        npm_config_userconfig: join(root, 'npmrc'),
        npm_config_globalconfig: join(root, 'global-npmrc'),
        npm_config_cache: join(root, 'npm-cache'),
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
      await preferences.setL4PiPluginDownloadSource(
        { mode: 'custom', registry: publicRegistry },
        agentDir
      )
      runtime = new L4PiGlobalPluginRuntime(root, agentDir)
      globalThis.__piDeskGlobalPluginRuntime = runtime
      management = new L2PluginManagement(
        { runPluginRestart: (operation) => operation() },
        root,
        agentDir
      )
      const install = async (name: string, version: string): Promise<void> => {
        const source = `npm:${name}@${version}`
        const previous = (await management!.list()).plugins.find((item) =>
          item.source.startsWith(`npm:${name}@`)
        )?.source
        await management!.reinstall(source)
        await management!.waitForOperations(
          [...new Set([source, previous ?? source])],
          AbortSignal.timeout(60_000)
        )
      }
      const installedVersion = async (name: string): Promise<string> =>
        JSON.parse(await readFile(join(agentDir, 'npm/node_modules', name, 'package.json'), 'utf8'))
          .version as string
      const downloads = (): string[] => requests.filter((path) => path.endsWith('.tgz'))

      await install(plugin, '1.0.0')
      assert.equal(await installedVersion(utility), '4.4.3')
      assert.equal(downloads().length, 3, '首次预检下载3个包，正式安装应复用缓存')
      publishedNewDependencies = true
      const beforeReinstall = downloads().length
      await install(plugin, '1.0.0')
      assert.equal(await installedVersion(utility), '4.4.3')
      assert.equal(downloads().length, beforeReinstall, '同版本重装不重复下载tarball')
      await install(plugin, '1.0.1')
      assert.equal(await installedVersion(utility), '4.4.3')
      assert.equal(await installedVersion(sdk), '1.0.0')
      assert.equal(
        downloads().length,
        beforeReinstall + 1,
        '只下载升级的插件，不下载已有SDK和基础依赖'
      )
      await install(plugin, '2.0.0')
      assert.equal(await installedVersion(utility), '4.6.7')
      assert.equal(await installedVersion(sdk), '2.0.0')
      assert.equal(downloads().length, beforeReinstall + 4, '明确升级SDK和依赖后允许各下载一次')

      const officialFiles = [
        'settings.json',
        'npm/package.json',
        'npm/package-lock.json',
        `npm/node_modules/${plugin}/index.js`
      ]
      const beforeFailure = await Promise.all(
        officialFiles.map((path) => readFile(join(agentDir, path), 'utf8'))
      )
      await assert.rejects(install(plugin, '3.0.0'), /候选预检主动失败/)
      assert.deepEqual(
        await Promise.all(officialFiles.map((path) => readFile(join(agentDir, path), 'utf8'))),
        beforeFailure,
        '候选失败不能改写正式清单、锁、配置或插件代码'
      )
      assert.equal(
        (await management.list()).plugins.find((item) => item.source === `npm:${plugin}@2.0.0`)
          ?.status,
        'ready'
      )
      await install(privatePlugin, '1.0.0')
      assert.equal(await installedVersion(privatePlugin), '1.0.0')
      assert.equal(
        requests.some((path) => path === `/private/${privatePlugin}`),
        true
      )
      assert.equal(
        requests.some((path) => path === `/public/${sdk}`),
        true
      )
      assert.equal(
        requests.some((path) => path === `/public/${utility}`),
        true
      )
      assert.equal(
        requests.some(
          (path) => path.startsWith(`/private/${sdk}`) || path.startsWith(`/private/${utility}`)
        ),
        false
      )
      assert.equal(
        downloads().filter((path) => path.endsWith('/install-utility-4.4.3.tgz')).length,
        1
      )
      assert.equal(
        downloads().filter((path) => path.endsWith('/install-utility-4.6.7.tgz')).length,
        1
      )
      t.diagnostic(`实际tarball请求：${JSON.stringify(downloads())}`)
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
