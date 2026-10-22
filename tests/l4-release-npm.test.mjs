import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import test, { beforeEach } from 'node:test'
import { format } from 'node:util'
import {
  selectPackages,
  assertPackedManifest,
  assertDevelopmentTags,
  waitForNpmTags,
  waitForRegistryPackage,
  pruneHostBuild,
  publish,
  run
} from '../.github/scripts/release-npm.mjs'

// Node 22 的测试 stdout 帧解析存在缺陷，诊断通道保留中文日志而不与报告混流。
beforeEach((context) => {
  context.mock.method(console, 'info', (...args) => context.diagnostic(format(...args)))
  context.mock.method(console, 'warn', (...args) => context.diagnostic(format(...args)))
})

function packageResponse(name, tags, versions = {}) {
  return Response.json({ name, 'dist-tags': tags, versions })
}

const publishConfig = { registry: 'https://registry.npmjs.org', access: 'public' }
async function fixture(context) {
  const parent = resolve('temp/tests/release-npm/selection')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'packages-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  for (const [directory, name] of [
    ['.', 'pi-desk'],
    ['plugins/pi-desk-usage', 'pi-desk-usage'],
    ['plugins/pi-desk-sdk', 'pi-desk-sdk']
  ]) {
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(
      join(root, directory, 'package.json'),
      JSON.stringify({ name: `@jetcrab/${name}`, version: '1.0.0', publishConfig })
    )
  }
  return root
}

test('主包发布排除追踪清单和构建类型但保留全部运行资源', async (context) => {
  const root = await fixture(context)
  const build = join(root, '.next')
  const files = [
    'BUILD_ID',
    'server/app/page.js',
    'server/chunks/runtime.js',
    'static/chunks/editor-worker.js',
    'static/media/font.woff2',
    'required-server-files.json',
    'server/app/page.js.nft.json',
    'next-server.js.nft.json',
    'trace',
    'types/routes.d.ts',
    'cache/webpack/cache.pack'
  ]
  for (const file of files) {
    const path = join(build, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `fixture:${file}`)
  }
  await pruneHostBuild(build)
  await pruneHostBuild(build)
  for (const file of files.slice(0, 6)) {
    assert.equal(await readFile(join(build, file), 'utf8'), `fixture:${file}`)
  }
  for (const file of files.slice(6)) {
    await assert.rejects(stat(join(build, file)), { code: 'ENOENT' })
  }
})

test('没有稳定latest的新包拒绝开发发布，发布后dev必须准确指向当前版本', () => {
  const name = '@jetcrab/pi-desk'
  for (const tags of [
    {},
    { dev: '1.0.1-dev.1' },
    { latest: '0.0.0-stage' },
    { latest: '1.0.1-dev.1' }
  ]) {
    assert.throws(() => assertDevelopmentTags(tags, name), /尚无稳定 latest/)
  }
  assert.doesNotThrow(() => assertDevelopmentTags({ latest: '1.0.0' }, name))
  assert.doesNotThrow(() =>
    assertDevelopmentTags({ latest: '1.0.0', dev: '1.0.1-dev.1' }, name, '1.0.1-dev.1')
  )
  assert.throws(() =>
    assertDevelopmentTags({ latest: '1.0.0', dev: '1.0.1-dev.1' }, name, '1.0.1-dev.2')
  )
})

test('部分发布后新运行只接纳完全相同的原包，不覆盖已有版本', async (t) => {
  const root = await fixture(t)
  const source = join(root, 'input')
  const output = join(root, 'archives')
  await mkdir(join(source, 'package/dist'), { recursive: true })
  await mkdir(output)
  const manifest = {
    name: '@jetcrab/pi-desk-usage',
    version: '1.2.3-dev',
    publishConfig,
    piDesk: { entry: './dist/index.js' }
  }
  await writeFile(join(source, 'package/package.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'package/LICENSE'), 'fixture')
  await writeFile(join(source, 'package/dist/index.js'), 'export default {}')
  const archive = join(output, 'jetcrab-pi-desk-usage-1.2.3-dev.tgz')
  const pack = () =>
    execFileSync(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-czf', relative(source, archive).replaceAll('\\', '/'), 'package'],
      { cwd: source, stdio: 'pipe' }
    )
  pack()
  const bytes = await readFile(archive)
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  let metadataReads = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'HEAD') return new Response(null, { status: 200 })
    const target = new URL(url)
    assert.equal(target.pathname, `/${encodeURIComponent(manifest.name)}`)
    metadataReads += 1
    return packageResponse(
      manifest.name,
      { latest: '1.2.2', dev: manifest.version },
      {
        [manifest.version]: {
          version: manifest.version,
          dist: { integrity, tarball: 'https://registry.npmjs.org/fixture.tgz' }
        }
      }
    )
  })
  const environment = {
    GITHUB_REF: 'refs/heads/dev',
    GITHUB_REPOSITORY: 'JetCrab/pi-desk',
    RUNNER_TEMP: root
  }
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  )
  try {
    Object.assign(process.env, environment)
    await publish([{ directory: source, manifest }], output)
    assert.equal(metadataReads, 3, '发布前的标签、版本与摘要共用一次元数据查询')
    await writeFile(join(source, 'package/dist/index.js'), 'export default { changed: true }')
    pack()
    await assert.rejects(publish([{ directory: source, manifest }], output), /已存在不同内容/)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('npm开发标签延迟同步时等待同一已上传版本而不是重复发布', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let reads = 0
  context.mock.method(globalThis, 'fetch', async () => {
    reads += 1
    return packageResponse('@jetcrab/pi-desk', {
      latest: '1.0.0',
      dev: reads === 1 ? '1.0.1-dev.9001' : '1.0.1-dev.9002'
    })
  })
  const waiting = waitForNpmTags('@jetcrab/pi-desk', '1.0.1-dev.9002', 'dev')
  await new Promise(setImmediate)
  assert.equal(reads, 1)
  context.mock.timers.tick(5_000)
  await waiting
  assert.equal(reads, 2)
})

test('正式版本必须等待 latest 实际指向新版本，不能仅凭上传成功', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let reads = 0
  context.mock.method(globalThis, 'fetch', async () =>
    packageResponse('@jetcrab/pi-desk', { latest: ++reads === 1 ? '1.0.0' : '1.1.0' })
  )
  let completed = false
  const waiting = waitForNpmTags('@jetcrab/pi-desk', '1.1.0', 'latest').then(() => {
    completed = true
  })
  await new Promise(setImmediate)
  assert.equal(completed, false)
  context.mock.timers.tick(5000)
  await waiting
  assert.equal(reads, 2)
})

test('npm开发标签已同步时立即通过校验', async (context) => {
  let reads = 0
  context.mock.method(globalThis, 'fetch', async () => {
    reads += 1
    return packageResponse('@jetcrab/pi-desk', { latest: '1.0.0', dev: '1.0.1-dev.9002' })
  })
  await waitForNpmTags('@jetcrab/pi-desk', '1.0.1-dev.9002', 'dev')
  assert.equal(reads, 1)
})

test('npm开发标签长期不一致时有界失败而不是放宽版本校验', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  context.mock.method(globalThis, 'fetch', async () =>
    packageResponse('@jetcrab/pi-desk', { latest: '1.0.0', dev: '1.0.1-dev.9001' })
  )
  const rejected = assert.rejects(
    waitForNpmTags('@jetcrab/pi-desk', '1.0.1-dev.9002', 'dev'),
    /标签未指向|同步.*超时|等待.*超时/
  )
  await new Promise(setImmediate)
  context.mock.timers.tick(10 * 60_000)
  await rejected
})

test('npm稳定标签异常不能当作开发标签同步延迟', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    packageResponse('@jetcrab/pi-desk', { latest: '1.0.1-dev.9002', dev: '1.0.1-dev.9001' })
  )
  await assert.rejects(
    waitForNpmTags('@jetcrab/pi-desk', '1.0.1-dev.9002', 'dev'),
    /尚无稳定 latest/
  )
})

test('npm标签查询错误不被当作正常的同步延迟', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }))
  await assert.rejects(waitForNpmTags('@jetcrab/pi-desk', '1.0.1-dev.9002', 'dev'), /HTTP 401/)
})

test('Registry读取超时与服务端故障退避后继续验证同一版本', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const attempts = []
  context.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).pathname, '/%40jetcrab%2Fpi-desk')
    attempts.push(Date.now())
    if (attempts.length === 1) throw new DOMException('受控请求超时', 'TimeoutError')
    if (attempts.length === 2) return new Response('', { status: 503 })
    return packageResponse('@jetcrab/pi-desk', { latest: '1.0.0', dev: '1.0.1-dev' })
  })
  const waiting = waitForNpmTags('@jetcrab/pi-desk', '1.0.1-dev', 'dev')
  await new Promise(setImmediate)
  context.mock.timers.tick(2_000)
  await new Promise(setImmediate)
  context.mock.timers.tick(4_000)
  await waiting
  assert.deepEqual(attempts, [0, 2_000, 6_000])
})

test('Registry只对临时HTTP错误重试，认证与格式错误立即失败', async (context) => {
  for (const [status, retryAfter, delayMs] of [
    [408, null, 2_000],
    [429, '3', 3_000],
    [429, new Date(3_000).toUTCString(), 3_000],
    [500, null, 2_000]
  ]) {
    await context.test(`HTTP ${status} ${retryAfter ?? ''}`, async (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
      let attempts = 0
      const transient = new Response('', {
        status,
        headers: retryAfter ? { 'retry-after': retryAfter } : {}
      })
      const cancel = t.mock.method(transient.body, 'cancel')
      t.mock.method(globalThis, 'fetch', async () => {
        if (++attempts === 1) return transient
        return packageResponse('@jetcrab/pi-desk', { latest: '1.0.0' })
      })
      const waiting = waitForNpmTags('@jetcrab/pi-desk', '1.0.0', 'latest')
      await new Promise(setImmediate)
      t.mock.timers.tick(2_000)
      if (delayMs > 2_000) {
        assert.equal(attempts, 1, '遵循 Registry 的 Retry-After')
        t.mock.timers.tick(delayMs - 2_000)
      }
      await waiting
      assert.equal(attempts, 2)
      assert.equal(cancel.mock.calls.length, 1)
    })
  }
  for (const [label, response, pattern] of [
    ['401', new Response('', { status: 401 }), /HTTP 401/],
    ['403', new Response('', { status: 403 }), /HTTP 403/],
    ['格式错误', new Response('{invalid'), /JSON|Unexpected|property/],
    ['元数据缺失', Response.json({ name: '@jetcrab/pi-desk' }), /元数据/]
  ]) {
    await context.test(label, async (t) => {
      const fetch = t.mock.method(globalThis, 'fetch', async () => response)
      await assert.rejects(waitForNpmTags('@jetcrab/pi-desk', '1.0.0', 'latest'), pattern)
      assert.equal(fetch.mock.calls.length, 1)
    })
  }
})

test('Registry连接持续中断只尝试三次并保留地址和底层原因', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const failure = new TypeError('fetch failed', {
    cause: Object.assign(new Error('连接重置'), { code: 'ECONNRESET' })
  })
  const fetch = context.mock.method(globalThis, 'fetch', async () => {
    throw failure
  })
  const rejected = assert.rejects(
    waitForNpmTags('@jetcrab/pi-desk', '1.0.0', 'latest'),
    (error) => {
      assert.equal(error.cause, failure)
      assert.match(error.message, /registry\.npmjs\.org/)
      assert.match(error.message, /3\/3/)
      assert.match(error.message, /ECONNRESET|连接重置/)
      return true
    }
  )
  await new Promise(setImmediate)
  context.mock.timers.tick(2_000)
  await new Promise(setImmediate)
  context.mock.timers.tick(4_000)
  await rejected
  assert.equal(fetch.mock.calls.length, 3)
})

test('Registry元数据响应体中断与tarball HEAD也可有限重试', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let metadataReads = 0
  let archiveReads = 0
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'HEAD') {
      if (++archiveReads === 1) return new Response('', { status: 502 })
      return new Response(null, { status: 200 })
    }
    if (++metadataReads === 1) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              new TypeError('terminated', {
                cause: Object.assign(new Error('响应体中断'), { code: 'ECONNRESET' })
              })
            )
          }
        })
      )
    }
    return packageResponse(
      '@jetcrab/pi-desk-sdk',
      { latest: '1.0.0' },
      {
        '1.0.1-dev': {
          version: '1.0.1-dev',
          dist: { tarball: 'https://registry.npmjs.org/fixture.tgz' }
        }
      }
    )
  })
  const waiting = waitForRegistryPackage('@jetcrab/pi-desk-sdk', '1.0.1-dev')
  await new Promise(setImmediate)
  context.mock.timers.tick(2_000)
  await new Promise(setImmediate)
  context.mock.timers.tick(2_000)
  await waiting
  assert.equal(metadataReads, 2)
  assert.equal(archiveReads, 2)
})

test('Registry重试与轮询共用十分钟预算且缩短最后请求超时', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const timeouts = []
  context.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    timeouts.push(milliseconds)
    return new AbortController().signal
  })
  let reads = 0
  context.mock.method(globalThis, 'fetch', async () => {
    if (++reads === 2) throw new DOMException('受控请求超时', 'TimeoutError')
    return packageResponse('@jetcrab/pi-desk', { latest: '1.0.0' })
  })
  const rejected = assert.rejects(
    waitForNpmTags('@jetcrab/pi-desk', '1.0.1', 'latest'),
    /时限|超时/
  )
  await new Promise(setImmediate)
  context.mock.timers.tick(599_000)
  await rejected
  assert.deepEqual(timeouts, [30_000, 1_000])
  assert.equal(reads, 2)
  assert.ok(Date.now() <= 600_000)
})

test('Registry版本轮询和tarball检查共用剩余预算', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const timeouts = []
  context.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    timeouts.push(milliseconds)
    return new AbortController().signal
  })
  let reads = 0
  let archiveReads = 0
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'HEAD') {
      archiveReads += 1
      throw new DOMException('受控 tarball 超时', 'TimeoutError')
    }
    const versions =
      ++reads === 1
        ? {}
        : {
            '1.0.1-dev': {
              version: '1.0.1-dev',
              dist: { tarball: 'https://registry.npmjs.org/fixture.tgz' }
            }
          }
    return packageResponse('@jetcrab/pi-desk-sdk', { latest: '1.0.0' }, versions)
  })
  const rejected = assert.rejects(
    waitForRegistryPackage('@jetcrab/pi-desk-sdk', '1.0.1-dev'),
    /时限|超时/
  )
  await new Promise(setImmediate)
  context.mock.timers.tick(599_000)
  await rejected
  assert.deepEqual(timeouts, [30_000, 1_000, 1_000])
  assert.equal(archiveReads, 1)
  assert.ok(Date.now() <= 600_000)
})

test('包管理命令保留参数与带空格路径而不被Shell二次转义', async (context) => {
  const root = await fixture(context)
  const directory = join(root, 'command fixture')
  await mkdir(directory)
  await writeFile(join(directory, 'package.json'), '{"private":true}')
  const script = join(directory, 'arguments.cjs')
  await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const output = run(
    'pnpm',
    ['--dir', directory, 'exec', process.execPath, script, 'value with spaces'],
    { capture: true }
  )
  assert.deepEqual(JSON.parse(output), ['value with spaces'])
})

test('插件独立配置解析SDK发布入口而非宿主源码别名', () => {
  const directory = resolve('plugins/pi-desk-tibo-monitor')
  const output = run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      'console.log(import.meta.resolve("@jetcrab/pi-desk-sdk/host-runtime/base.js"))'
    ],
    {
      cwd: directory,
      capture: true,
      env: { ...process.env, TSX_TSCONFIG_PATH: join(directory, 'tsconfig.json') }
    }
  )
  assert.match(output.trim(), /\/dist\/host-runtime\/base\.js$/)
})

test('公开包发布先SDK，允许单独选择包但不接受未知目标', async (context) => {
  const root = await fixture(context)
  const all = await selectPackages(root, 'all')
  assert.equal(all.length, 3)
  assert.equal(all[0].manifest.name, '@jetcrab/pi-desk-sdk')
  assert.equal(
    (await selectPackages(root, 'pi-desk-usage'))[0].manifest.name,
    '@jetcrab/pi-desk-usage'
  )
  await assert.rejects(selectPackages(root, '../private'))
  assert.deepEqual(
    (await selectPackages(root, ['pi-desk-usage', 'pi-desk-sdk'])).map(
      (entry) => entry.manifest.name
    ),
    ['@jetcrab/pi-desk-sdk', '@jetcrab/pi-desk-usage']
  )
  await assert.rejects(selectPackages(root, []))
  await assert.rejects(selectPackages(root, ['pi-desk-usage', 'pi-desk-usage']))
})

test('拒绝把私有包或私有Registry纳入公开发布', async (context) => {
  const root = await fixture(context)
  await writeFile(
    join(root, 'plugins/pi-desk-usage/package.json'),
    JSON.stringify({ name: '@jetcrab-private/pi-desk-usage', version: '1.0.0', publishConfig })
  )
  await assert.rejects(selectPackages(root, 'all'))
})

test('验证tarball身份与普通版本依赖，不允许workspace或文件路径泄入制品', () => {
  const source = { name: '@jetcrab/pi-desk', version: '1.0.0' }
  const packed = { ...source, publishConfig, dependencies: { '@jetcrab/pi-desk-sdk': '^1.0.0' } }
  assert.doesNotThrow(() => assertPackedManifest(packed, source))
  const developmentSource = { ...source, version: '1.0.1-dev.1' }
  const development = {
    ...packed,
    ...developmentSource,
    dependencies: { '@jetcrab/pi-desk-sdk': '^1.0.1-dev.1' }
  }
  assert.doesNotThrow(() => assertPackedManifest(development, developmentSource))
  assert.throws(
    () => assertPackedManifest({ ...packed, dependencies: development.dependencies }, source),
    /稳定包不得依赖开发包/
  )
  for (const version of ['workspace:^', 'file:../sdk', 'link:../sdk']) {
    assert.throws(() =>
      assertPackedManifest({ ...packed, dependencies: { '@jetcrab/pi-desk-sdk': version } }, source)
    )
  }
  assert.throws(() => assertPackedManifest({ ...packed, version: '2.0.0' }, source))
  assert.throws(() =>
    assertPackedManifest(
      { ...packed, publishConfig: { registry: 'https://registry.example', access: 'public' } },
      source
    )
  )
})
