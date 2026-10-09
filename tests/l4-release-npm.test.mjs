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
  pruneHostBuild,
  publish,
  run
} from '../.github/scripts/release-npm.mjs'

// Node 22 的测试 stdout 帧解析存在缺陷，诊断通道保留中文日志而不与报告混流。
beforeEach((context) => {
  context.mock.method(console, 'info', (...args) => context.diagnostic(format(...args)))
})

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
  t.mock.method(globalThis, 'fetch', async (url) =>
    String(url).includes('dist-tags')
      ? Response.json({ latest: '1.2.2', dev: manifest.version })
      : String(url).endsWith('.tgz')
        ? new Response(null, { status: 200 })
        : Response.json({
            name: manifest.name,
            version: manifest.version,
            dist: { integrity, tarball: 'https://registry.npmjs.org/fixture.tgz' }
          })
  )
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
    return Response.json({
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
    Response.json({ latest: ++reads === 1 ? '1.0.0' : '1.1.0' })
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
    return Response.json({ latest: '1.0.0', dev: '1.0.1-dev.9002' })
  })
  await waitForNpmTags('@jetcrab/pi-desk', '1.0.1-dev.9002', 'dev')
  assert.equal(reads, 1)
})

test('npm开发标签长期不一致时有界失败而不是放宽版本校验', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  context.mock.method(globalThis, 'fetch', async () =>
    Response.json({ latest: '1.0.0', dev: '1.0.1-dev.9001' })
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
    Response.json({ latest: '1.0.1-dev.9002', dev: '1.0.1-dev.9001' })
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
