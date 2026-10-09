import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
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

test('插件仓库按目标版本读取且搜索不下载所有候选详情', { timeout: 45_000 }, async (t) => {
  const root = resolve('temp/run/plugin-management', `registry-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  const requests: Array<{ path: string; auth?: string }> = []
  const tar = archive({ 'README.md': '# Version 1', 'README.zh-CN.md': '# 中文说明' })
  let base = ''
  const manifest = (name: string, version: string): Record<string, unknown> => ({
    name,
    version,
    description: 'Background tasks',
    keywords: ['pi-package', 'pi-desk-plugin'],
    piDesk: {
      entry: './entry.js',
      i18n: { 'zh-CN': { description: '后台任务', readme: './README.zh-CN.md' } }
    },
    dist: {
      tarball: `${base}/archive.tgz`,
      integrity: `sha512-${createHash('sha512').update(tar).digest('base64')}`
    }
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url!, base)
    requests.push({ path: url.pathname + url.search, auth: request.headers.authorization })
    if (url.pathname === '/archive.tgz') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(tar)
      return
    }
    response.setHeader('Content-Type', 'application/json')
    if (url.pathname.endsWith('/-/v1/search')) {
      const desk = url.searchParams.get('text')?.includes('keywords:pi-desk-plugin')
      const from = Number(url.searchParams.get('from') ?? 0)
      const size = Number(url.searchParams.get('size'))
      const objects = Array.from({ length: Math.min(size, 50 - from) }, (_, index) => ({
        package: {
          name: `@fixture/${desk ? 'desk' : 'pi'}-${from + index}`,
          version: '1.0.0',
          description: 'Fixture plugin',
          keywords: desk ? ['pi-desk-plugin', 'pi-package'] : ['pi-package']
        }
      }))
      response.end(JSON.stringify({ objects, total: 50 }))
      return
    }
    const path = decodeURIComponent(url.pathname.replace(/^\/(?:npm|private)\//, ''))
    if (path.startsWith('missing')) {
      response.writeHead(404).end('{}')
      return
    }
    const match = /^(@[^/]+\/[^/]+|[^/]+)(?:\/(.+))?$/.exec(path)
    if (!match) {
      response.writeHead(404).end('{}')
      return
    }
    const name = match[1]!
    if (match[2]) {
      const version = match[2] === 'latest' ? '2.0.0' : match[2]
      if (!['1.0.0', '2.0.0'].includes(version)) response.writeHead(404).end('{}')
      else
        response.end(
          JSON.stringify(
            name === 'git'
              ? { name, version, description: 'General Git library' }
              : manifest(name, version)
          )
        )
    } else {
      response.end(
        JSON.stringify({
          name,
          'dist-tags': { latest: '2.0.0' },
          versions: {
            '1.0.0': manifest(name, '1.0.0'),
            '2.0.0': manifest(name, '2.0.0')
          }
        })
      )
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  base = `http://127.0.0.1:${address.port}`
  const userConfig = join(root, 'npmrc')
  const globalConfig = join(root, 'global-npmrc')
  await writeFile(
    userConfig,
    `@private:registry=${base}/private\n//127.0.0.1:${address.port}/private/:_authToken=fixture-token\n`
  )
  await writeFile(globalConfig, '')
  const saved = {
    user: process.env.NPM_CONFIG_USERCONFIG,
    global: process.env.NPM_CONFIG_GLOBALCONFIG,
    agent: process.env.PI_CODING_AGENT_DIR
  }
  process.env.NPM_CONFIG_USERCONFIG = userConfig
  process.env.NPM_CONFIG_GLOBALCONFIG = globalConfig
  process.env.PI_CODING_AGENT_DIR = root
  t.after(async () => {
    for (const [key, value] of [
      ['NPM_CONFIG_USERCONFIG', saved.user],
      ['NPM_CONFIG_GLOBALCONFIG', saved.global],
      ['PI_CODING_AGENT_DIR', saved.agent]
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => done())
    })
    await rm(root, { recursive: true, force: true })
  })
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
  const { L2PluginCatalog } = await jiti.import<
    typeof import('../src/server/l2_biz/plugin-management/l2-plugin-catalog')
  >('../src/server/l2_biz/plugin-management/l2-plugin-catalog.ts')
  const catalog = new L2PluginCatalog()
  await t.test('自定义源保持目标版本，缺失时不回退其他源', async () => {
    assert.deepEqual(
      await registry.resolveL4PluginInstall('npm:@fixture/tool@1.0.0', {
        registry: `${base}/npm`,
        agentDir: root
      }),
      { source: 'npm:@fixture/tool@1.0.0', registry: `${base}/npm` }
    )
    await assert.rejects(
      registry.resolveL4PluginInstall('npm:@fixture/tool@9.0.0', {
        registry: `${base}/npm`,
        agentDir: root
      }),
      /不存在/
    )
    assert.deepEqual(
      await registry.resolveL4PluginInstall('npm:@fixture/tool', {
        registry: `${base}/npm`,
        agentDir: root
      }),
      { source: 'npm:@fixture/tool@2.0.0', registry: `${base}/npm` }
    )
  })
  await t.test('私有scope不被国内镜像覆盖，鉴权仅发给配置路径', async () => {
    const resolved = await registry.resolveL4PluginInstall('npm:@private/tool@1.0.0', {
      downloadSource: { mode: 'domestic' },
      agentDir: root
    })
    assert.equal(resolved.registry, `${base}/private`)
    assert.equal(
      requests.find((item) => item.path.startsWith('/private/'))?.auth,
      'Bearer fixture-token'
    )
    assert.ok(
      requests
        .filter((item) => item.path.startsWith('/npm/'))
        .every((item) => item.auth === undefined)
    )
  })
  await t.test('公共搜索结果不覆盖国内下载选择，固定镜像缺版不偷偷换源', async () => {
    const realFetch = globalThis.fetch
    const origins: string[] = []
    globalThis.fetch = async (input, init): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (['registry.npmjs.org', 'mirrors.cloud.tencent.com'].includes(url.hostname)) {
        origins.push(url.origin)
        const path = url.pathname.replace(/^\/npm\//, '/')
        return realFetch(`${base}/npm${path}`, init)
      }
      return realFetch(input, init)
    }
    try {
      const selected = await registry.resolveL4PluginInstall('npm:@public/tool@1.0.0', {
        registry: 'https://registry.npmjs.org',
        downloadSource: { mode: 'domestic' },
        agentDir: root
      })
      assert.equal(selected.registry, 'https://mirrors.cloud.tencent.com/npm')
      assert.equal(selected.source, 'npm:@public/tool@1.0.0')
      await assert.rejects(
        registry.resolveL4PluginInstall('npm:@public/tool@9.0.0', {
          downloadSource: { mode: 'domestic' },
          agentDir: root
        }),
        /不存在/
      )
      assert.ok(origins.length > 0)
      assert.ok(origins.every((origin) => origin === 'https://mirrors.cloud.tencent.com'))
    } finally {
      globalThis.fetch = realFetch
    }
  })
  await t.test('普通搜索词命中同名npm依赖时仍返回相关插件', async () => {
    const result = await catalog.search({
      query: 'git',
      page: 1,
      kind: 'all',
      registry: `${base}/npm`
    })
    assert.ok(result.items.some((item) => item.name.startsWith('@fixture/desk-')))
    assert.ok(result.items.every((item) => item.name !== 'git'))
  })
  await t.test('一页只读取搜索概要，后续分页不从第一页重扫', async () => {
    const begin = requests.length
    const first = await catalog.search({ query: '', page: 1, kind: 'all', registry: `${base}/npm` })
    const second = await catalog.search({
      query: '',
      page: 2,
      kind: 'all',
      registry: `${base}/npm`
    })
    assert.ok(first.items.length > 0 && first.hasMore)
    assert.ok(second.items.length > 0)
    assert.ok(
      second.items.every((item) => !first.items.some((previous) => previous.name === item.name))
    )
    const read = requests.slice(begin)
    assert.ok(read.length <= 4, `分页不应批量读取包详情：${read.length}次请求`)
    assert.ok(read.every((item) => item.path.includes('/-/v1/search')))
    assert.equal(first.items[0]?.kind, 'desk')
    assert.ok(first.items.every((item) => !item.official))
  })
  await t.test('指定版本从同版本压缩包读中英文README', async () => {
    const detail = await catalog.get({
      name: '@fixture/tool',
      version: '1.0.0',
      registry: `${base}/npm`
    })
    assert.equal(detail.version, '1.0.0')
    assert.deepEqual(detail.description, {
      default: 'Background tasks',
      translations: { 'zh-CN': '后台任务' }
    })
    assert.deepEqual(detail.readme, {
      default: '# Version 1',
      translations: { 'zh-CN': '# 中文说明' }
    })
  })
  await t.test('本地翻译路径和符号链接不能读取包外文件', async () => {
    const plugin = join(root, 'local')
    await mkdir(plugin)
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'outside.md'), 'outside')
    await writeFile(join(plugin, 'README.md'), 'Default')
    await symlink(join(root, 'outside'), join(plugin, 'linked'), 'junction')
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({
        piDesk: {
          i18n: {
            'zh-CN': { readme: '../outside/outside.md' },
            en: { readme: 'linked/outside.md' }
          }
        }
      })
    )
    assert.equal(await registry.readL4PluginReadme(plugin), 'Default')
  })
})
