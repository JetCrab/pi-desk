import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { createJiti } from 'jiti'

function archive(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const header = Buffer.alloc(512)
    header.write(`package/${name}`)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.fill(32, 148, 156)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    const checksum = header.reduce((sum, value) => sum + value, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

test('本机源沿用npm配置，版本查询和隔离预检不被历史仓库覆盖', { timeout: 90_000 }, async (t) => {
  const root = resolve('temp/run/plugin-management', `local-source-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  const installRoot = join(agentDir, 'npm')
  const userConfig = join(root, 'user.npmrc')
  const saved = new Map<string, string | undefined>()
  const requests: Array<{ path: string; auth?: string }> = []
  let base = ''
  let succeeded = false
  const plugin = '@local-fixture/plugin'
  const utility = 'local-fixture-utility'
  const manifests = {
    [plugin]: {
      name: plugin,
      version: '1.1.0',
      type: 'module',
      pi: { extensions: ['./index.mjs'] },
      dependencies: { [utility]: '1.0.0' }
    },
    [utility]: { name: utility, version: '1.0.0', type: 'module', main: './index.mjs' }
  }
  const archives = new Map(
    Object.entries(manifests).map(([name, manifest]) => [
      name,
      archive({
        'package.json': JSON.stringify(manifest),
        'index.mjs':
          name === plugin ? 'export default function () {}\n' : 'export const value = 1\n'
      })
    ])
  )
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url!, base).pathname)
    requests.push({ path, auth: request.headers.authorization })
    const match = /^\/(scope|public|env)\/(.+)$/.exec(path)
    const name = match
      ? Object.keys(manifests).find(
          (value) => match[2] === value || match[2]!.startsWith(`${value}/`)
        )
      : undefined
    if (!match || !name) {
      response.writeHead(404).end('{}')
      return
    }
    if (match[1] === 'scope' && request.headers.authorization !== 'Bearer fixture-token') {
      response.writeHead(401).end('{}')
      return
    }
    const manifest = manifests[name as keyof typeof manifests]
    const tar = archives.get(name)!
    if (match[2] === `${name}/-/package.tgz`) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(tar)
      return
    }
    const detail = {
      ...manifest,
      dist: {
        tarball: `${base}/${match[1]}/${name}/-/package.tgz`,
        integrity: `sha512-${createHash('sha512').update(tar).digest('base64')}`
      }
    }
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(
        JSON.stringify(
          match[2] === name
            ? {
                name,
                'dist-tags': { latest: manifest.version, dev: manifest.version },
                versions: { [manifest.version]: detail }
              }
            : detail
        )
      )
  })
  try {
    await mkdir(join(installRoot, 'etc'), { recursive: true })
    await writeFile(userConfig, '')
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    base = `http://127.0.0.1:${address.port}`
    for (const [key, value] of Object.entries(process.env)) {
      if (/^npm_config_/i.test(key)) {
        saved.set(key, value)
        delete process.env[key]
      }
    }
    const env = {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
      PI_DESK_PI_PACKAGE_DIR: resolve('node_modules/@earendil-works/pi-coding-agent'),
      PI_OFFLINE: '1',
      npm_config_userconfig: userConfig,
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false'
    }
    for (const [key, value] of Object.entries(env)) {
      if (!saved.has(key)) saved.set(key, process.env[key])
      process.env[key] = value
    }
    const localText = `@local-fixture:registry=${base}/scope\n//127.0.0.1:${address.port}/scope/:_authToken=fixture-token\n`
    const globalText = `registry=${base}/public\n`
    await writeFile(join(installRoot, '.npmrc'), localText)
    await writeFile(join(installRoot, 'etc/npmrc'), globalText)
    const require = createRequire(import.meta.url)
    const jiti = createJiti(import.meta.url, {
      nativeModules: [
        '@earendil-works/pi-coding-agent',
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-ai'
      ],
      tsconfigPaths: resolve('tsconfig.json'),
      alias: { 'server-only': join(dirname(require.resolve('server-only')), 'empty.js') }
    })
    const registry = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-plugin-registry')
    >('../src/server/l4_foundation/pi/l4-pi-plugin-registry.ts')
    const preferences = await jiti.import<
      typeof import('../src/server/l4_foundation/pi/l4-pi-plugin-preferences')
    >('../src/server/l4_foundation/pi/l4-pi-plugin-preferences.ts')
    preferences.setL4PiPluginDownloadSource({ mode: 'local' }, agentDir)
    preferences.setL4PiPluginRegistry(`npm:${plugin}`, `${base}/stale`, agentDir)
    const preferencesBefore = await readFile(join(agentDir, 'pi-desk-plugins.json'), 'utf8')
    await t.test('本机scope与默认源优先，解析结果不向安装器注入源', async () => {
      assert.deepEqual(
        await registry.resolveL4PluginInstall(`npm:${plugin}`, {
          agentDir,
          registry: `${base}/catalog`,
          cache: false
        }),
        { source: `npm:${plugin}@1.1.0` }
      )
      assert.deepEqual(
        await registry.resolveL4PluginInstall(`npm:${utility}`, { agentDir, cache: false }),
        { source: `npm:${utility}@1.0.0` }
      )
      assert.ok(
        requests.some(
          (entry) => entry.path === `/scope/${plugin}` && entry.auth === 'Bearer fixture-token'
        )
      )
      assert.ok(requests.some((entry) => entry.path === `/public/${utility}` && !entry.auth))
      assert.ok(requests.every((entry) => !/stale|catalog/.test(entry.path)))
      assert.equal(
        await readFile(join(agentDir, 'pi-desk-plugins.json'), 'utf8'),
        preferencesBefore
      )
      await assert.rejects(
        registry.resolveL4PluginInstall(`npm:${plugin}@9.0.0`, { agentDir, cache: false }),
        /不存在/
      )
      assert.ok(
        requests.every(
          (entry) => entry.path.startsWith('/scope/') || entry.path.startsWith('/public/')
        )
      )
    })
    await t.test('本机详情不沿用目录仓库，读取设置不请求地区推荐', async () => {
      const { L2PluginCatalog } = await jiti.import<
        typeof import('../src/server/l2_biz/plugin-management/l2-plugin-catalog')
      >('../src/server/l2_biz/plugin-management/l2-plugin-catalog.ts')
      const catalog = new L2PluginCatalog()
      const detail = await catalog.get({
        name: plugin,
        version: '1.1.0',
        registry: `${base}/catalog`
      })
      assert.equal(detail.registry, `${base}/scope`)
      assert.equal(detail.version, '1.1.0')
      const originalFetch = globalThis.fetch
      let fetches = 0
      globalThis.fetch = async (): Promise<Response> => {
        fetches += 1
        throw new Error('读取本机源设置不应联网')
      }
      try {
        assert.equal((await catalog.getSettings()).downloadSource.mode, 'local')
        assert.equal(fetches, 0)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
    await t.test('隔离候选安装继承两层npmrc并清理副本', async () => {
      const { L2PluginManagement } = await jiti.import<
        typeof import('../src/server/l2_biz/plugin-management/l2-plugin-management')
      >('../src/server/l2_biz/plugin-management/l2-plugin-management.ts')
      // 只驱动安装前预检，避免创建正式运行态或真正应用插件。
      const stagingRoot = join(root, 'staging')
      const probe = Object.assign(Object.create(L2PluginManagement.prototype), {
        agentDir,
        stagingRoot,
        disposed: false
      }) as { probeCandidate: (source: string, activeSource: string) => Promise<void> }
      await probe.probeCandidate(`npm:${plugin}@1.1.0`, `npm:${plugin}`)
      assert.ok(requests.some((entry) => entry.path === `/public/${utility}/-/package.tgz`))
      assert.equal(await readFile(join(installRoot, '.npmrc'), 'utf8'), localText)
      assert.equal(await readFile(join(installRoot, 'etc/npmrc'), 'utf8'), globalText)
      assert.deepEqual(await readdir(stagingRoot), [])
      await assert.rejects(
        probe.probeCandidate('npm:missing-local-fixture@1.0.0', 'npm:missing-local-fixture')
      )
      assert.deepEqual(await readdir(stagingRoot), [])
      assert.equal(
        await readFile(join(agentDir, 'pi-desk-plugins.json'), 'utf8'),
        preferencesBefore
      )
    })
    await t.test('npm环境默认源优先于安装prefix配置', async () => {
      const other = join(root, 'other-agent')
      await mkdir(join(other, 'npm/etc'), { recursive: true })
      await writeFile(join(other, 'npm/etc/npmrc'), globalText)
      saved.set('npm_config_registry', process.env.npm_config_registry)
      process.env.npm_config_registry = `${base}/env`
      const result = await registry.readL4PluginInstallRegistry(utility, {
        agentDir: other,
        downloadSource: { mode: 'local' }
      })
      assert.equal(result.registry, `${base}/env`)
      assert.equal(result.fallback, false)
    })
    succeeded = true
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((done) => server.close(() => done()))
    if (succeeded) await rm(root, { recursive: true, force: true })
    else t.diagnostic(`失败现场：${root}`)
  }
})
