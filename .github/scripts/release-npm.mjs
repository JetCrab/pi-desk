import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { npmTagFor, versionParts } from './npm-channel.mjs'

const registry = 'https://registry.npmjs.org'
const sdkName = '@jetcrab/pi-desk-sdk'
const projectRoot = resolve(import.meta.dirname, '../..')

export async function selectPackages(root, target = 'all') {
  const plugins = await readdir(join(root, 'plugins'), { withFileTypes: true })
  const directories = [
    '.',
    ...plugins.filter((entry) => entry.isDirectory()).map((entry) => `plugins/${entry.name}`)
  ]
  const entries = []
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'))
    assert.match(manifest.name, /^@jetcrab\/pi-desk(?:-[a-z0-9-]+)?$/)
    assert.notEqual(manifest.private, true, `不可公开发布私有包：${manifest.name}`)
    versionParts(manifest.version)
    assert.equal(manifest.publishConfig?.registry, registry)
    assert.equal(manifest.publishConfig?.access, 'public')
    entries.push({ directory: join(root, directory), manifest })
  }
  entries.sort((a, b) =>
    a.manifest.name === sdkName
      ? -1
      : b.manifest.name === sdkName
        ? 1
        : a.manifest.name.localeCompare(b.manifest.name)
  )
  if (target === 'all') return entries
  const targets = Array.isArray(target) ? target : [target]
  assert.ok(
    targets.length > 0 && targets.every((name) => typeof name === 'string'),
    '发布目标列表不能为空'
  )
  assert.equal(new Set(targets).size, targets.length, '发布目标重复')
  const selected = entries.filter((entry) =>
    targets.includes(entry.manifest.name.slice('@jetcrab/'.length))
  )
  assert.equal(selected.length, targets.length, `未知公开包：${targets.join('、')}`)
  return selected
}

export function assertPackedManifest(packed, source) {
  assert.equal(packed.name, source.name)
  assert.equal(packed.version, source.version)
  assert.equal(packed.publishConfig?.registry, registry)
  assert.equal(packed.publishConfig?.access, 'public')
  assert.notEqual(packed.private, true)
  for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, value] of Object.entries(packed[group] ?? {})) {
      assert.ok(!name.startsWith('@jetcrab-private/'), `制品依赖私有包：${name}`)
      assert.doesNotMatch(value, /^(?:workspace:|file:|link:)/, `制品包含本地依赖：${name}`)
      if (versionParts(packed.version)[3] === null && name.startsWith('@jetcrab/')) {
        assert.doesNotMatch(value, /-dev\b/, `稳定包不得依赖开发包：${name}`)
      }
    }
  }
}

export function run(tool, args, { cwd = projectRoot, capture = false, env = process.env } = {}) {
  const windows = process.platform === 'win32' && ['npm', 'pnpm'].includes(tool)
  return execFileSync(
    windows ? 'cmd.exe' : tool,
    windows ? ['/d', '/s', '/c', `${tool} ${args.map((value) => `"${value}"`).join(' ')}`] : args,
    {
      cwd,
      env,
      windowsVerbatimArguments: windows,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    }
  )
}

export function runAsync(
  tool,
  args,
  { cwd = projectRoot, capture = false, env = process.env } = {}
) {
  const windows = process.platform === 'win32' && ['npm', 'pnpm'].includes(tool)
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(
      windows ? 'cmd.exe' : tool,
      windows ? ['/d', '/s', '/c', `${tool} ${args.map((value) => `"${value}"`).join(' ')}`] : args,
      {
        cwd,
        env,
        windowsHide: true,
        windowsVerbatimArguments: windows,
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
      }
    )
    const chunks = []
    let size = 0
    let overflow
    child.stdout?.on('data', (chunk) => {
      if (overflow) return
      size += chunk.length
      if (size > 16 * 1024 * 1024) {
        overflow = new Error(`命令输出超过 16MB：${tool}`)
        child.kill()
      } else {
        chunks.push(chunk)
      }
    })
    child.once('error', rejectCommand)
    child.once('close', (code, signal) => {
      if (overflow) rejectCommand(overflow)
      else if (code !== 0)
        rejectCommand(new Error(`命令执行失败：${tool}，退出码=${code}，信号=${signal ?? '无'}`))
      else resolveCommand(capture ? Buffer.concat(chunks).toString('utf8') : '')
    })
  })
}

export async function runPackageTasks(entries, action) {
  const byName = new Map(entries.map((entry) => [entry.manifest.name, entry]))
  const tasks = new Map()
  const visiting = new Set()
  const start = (entry) => {
    const name = entry.manifest.name
    if (tasks.has(name)) return tasks.get(name)
    assert.ok(!visiting.has(name), `公开包存在循环依赖：${name}`)
    visiting.add(name)
    const dependencies = [
      ...new Set(
        ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((group) =>
          Object.keys(entry.manifest[group] ?? {})
        )
      )
    ].filter((dependency) => byName.has(dependency))
    const task = Promise.all(dependencies.map((dependency) => start(byName.get(dependency)))).then(
      () => action(entry)
    )
    visiting.delete(name)
    tasks.set(name, task)
    return task
  }
  const results = await Promise.allSettled(entries.map(start))
  const errors = [
    ...new Set(
      results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    )
  ]
  if (errors.length)
    throw new AggregateError(
      errors,
      `包任务失败：${errors.map((error) => error.message).join('；')}`
    )
}

function archivePath(entry, output) {
  return join(
    output,
    `${entry.manifest.name.slice(1).replace('/', '-')}-${entry.manifest.version}.tgz`
  )
}

export function readNpmArchiveManifest(archive) {
  return JSON.parse(
    run(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-xOzf', basename(archive), 'package/package.json'],
      { cwd: dirname(resolve(archive)), capture: true }
    )
  )
}

async function verifyArchive(entry, output) {
  const archive = archivePath(entry, output)
  const list = run('tar', ['-tzf', basename(archive)], { cwd: output, capture: true })
    .trim()
    .split(/\r?\n/)
  const packed = readNpmArchiveManifest(archive)
  assertPackedManifest(packed, entry.manifest)
  assert.ok(list.includes('package/LICENSE'), `${packed.name} 缺少许可证`)
  for (const file of list) {
    assert.doesNotMatch(
      file,
      /(?:^|\/)(?:\.git|\.pi|node_modules|secrets)(?:\/|$)|\.(?:p12|pfx|pem|key|jks|keystore)$/i
    )
    assert.doesNotMatch(file, /(?:^|\/)\.env(?:\.|$)/)
  }
  if (entry.manifest.name === '@jetcrab/pi-desk') {
    for (const file of list) {
      assert.doesNotMatch(
        file,
        /^package\/temp\/build\/pi-desk\/release\/\.next\/(?:.*\.nft\.json$|(?:cache|trace|types)(?:\/|$))/,
        `主程序包含多余构建文件：${file}`
      )
    }
    for (const file of [
      'bin/pi-desk.js',
      'bin/pi-desk-preflight.js',
      'src/server/l1_entry/node/l1-server.ts',
      'temp/build/pi-desk/release/.next/BUILD_ID'
    ]) {
      assert.ok(list.includes(`package/${file}`), `主程序缺少运行文件：${file}`)
    }
  } else {
    const paths = new Set(
      [packed.piDesk?.entry, packed.types, ...(packed.pi?.extensions ?? [])].filter(Boolean)
    )
    for (const value of Object.values(packed.exports ?? {})) {
      if (typeof value === 'object')
        for (const path of Object.values(value)) if (typeof path === 'string') paths.add(path)
    }
    for (const path of paths)
      assert.ok(
        list.includes(`package/${path.replace(/^\.\//, '')}`),
        `${packed.name} 缺少入口：${path}`
      )
  }
  console.info(`制品检查通过：${packed.name}@${packed.version}`)
  return packed
}

export async function pruneHostBuild(buildDir) {
  for (const name of ['cache', 'trace', 'types']) {
    await rm(join(buildDir, name), { recursive: true, force: true })
  }
  async function pruneTraces(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await pruneTraces(path)
      } else if (entry.isFile() && entry.name.endsWith('.nft.json')) {
        await rm(path)
      }
    }
  }
  await pruneTraces(buildDir)
}

export function npmValidationMode(ref) {
  assert.ok(['refs/heads/main', 'refs/heads/dev'].includes(ref), '请从 main 或 dev 分支执行')
  return ref === 'refs/heads/main' ? 'full' : 'lightweight'
}

async function stage(name, action) {
  const started = performance.now()
  console.info(`[${name}] 开始`)
  try {
    return await action()
  } finally {
    console.info(`[${name}] 耗时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`)
  }
}

async function pack(entry, output) {
  if (process.env.GITHUB_REF === 'refs/heads/dev' && existsSync(archivePath(entry, output))) {
    await verifyArchive(entry, output)
    console.info(`保留原始制品：${entry.manifest.name}@${entry.manifest.version}`)
    return
  }
  await mkdir(output, { recursive: true })
  await stage(`pack ${entry.manifest.name}`, async () => {
    await runAsync('pnpm', ['--dir', entry.directory, 'pack', '--pack-destination', output], {
      env: { ...process.env, npm_config_ignore_scripts: 'true' }
    })
    await verifyArchive(entry, output)
  })
}

async function prepare(entries, output) {
  const mode = npmValidationMode(process.env.GITHUB_REF)
  const full = mode === 'full'
  console.info(`npm 验证模式：${mode}`)
  // main 发布回归测试会解析 SDK dist；dev 仅为选中的包补齐依赖底座。
  const needsSdk =
    full ||
    entries.some(
      ({ manifest }) =>
        manifest.name === sdkName ||
        [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].some(
          (dependencies) => dependencies?.[sdkName]
        )
    )
  const [sdk] = needsSdk ? await selectPackages(projectRoot, 'pi-desk-sdk') : []
  if (sdk) {
    const env = { ...process.env, TSX_TSCONFIG_PATH: join(sdk.directory, 'tsconfig.json') }
    await stage(`build ${sdkName}`, () =>
      runAsync('pnpm', ['--dir', sdk.directory, 'build'], { env })
    )
    if (full || entries.some(({ manifest }) => manifest.name === sdkName)) {
      // SDK test 脚本内含 build；直接执行同一测试集合，复用刚生成的产物。
      const tests = (await readdir(join(sdk.directory, 'tests')))
        .filter((file) => file.endsWith('.test.mjs'))
        .map((file) => join('tests', file))
      await stage(`test ${sdkName}`, () =>
        runAsync(process.execPath, ['--test', ...tests], { cwd: sdk.directory, env })
      )
    }
  }
  if (full) {
    await stage('test 发布边界', () =>
      runAsync(process.execPath, [
        '--test',
        'tests/l4-public-boundary.test.mjs',
        'tests/l4-release-npm.test.mjs'
      ])
    )
  }
  await runPackageTasks(
    entries.filter(({ manifest }) => manifest.name !== sdkName),
    async (entry) => {
      const agent = join(
        projectRoot,
        'temp/pi/npm-ci',
        basename(output),
        entry.manifest.name.slice('@jetcrab/'.length),
        'agent'
      )
      const env = {
        ...process.env,
        TSX_TSCONFIG_PATH: join(entry.directory, 'tsconfig.json'),
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: join(agent, 'sessions')
      }
      if (entry.directory === projectRoot) {
        await stage('test 宿主命令核心', () =>
          runAsync('pnpm', ['test:pidesk'], {
            env: {
              ...env,
              PI_OFFLINE: '1',
              PI_DESK_PI_PACKAGE_DIR: join(
                projectRoot,
                'node_modules/@earendil-works/pi-coding-agent'
              )
            }
          })
        )
        for (const command of ['typecheck', 'check:layers']) {
          await stage(`test ${command}`, () => runAsync('pnpm', [command]))
        }
        if (full) {
          await stage('test 制品内容', () => runAsync('pnpm', ['test:package']))
        }
        if (!full && existsSync(archivePath(entry, output))) {
          await pack(entry, output)
          return
        }
        const nextCache = join(projectRoot, 'temp/build/pi-desk/release/.next/cache')
        const savedCache = join(projectRoot, 'temp/cache/next/npm-dev')
        if (!full && existsSync(savedCache)) {
          await cp(savedCache, nextCache, { recursive: true })
        }
        // 主包 build 的前半段只重复 SDK build；这里执行同一 Next 构建入口。
        await stage(`build ${entry.manifest.name}`, () =>
          runAsync('pnpm', ['exec', 'next', 'build', '--webpack'])
        )
        if (!full && existsSync(nextCache)) {
          await mkdir(join(projectRoot, 'temp/cache/next'), { recursive: true })
          await rm(savedCache, { recursive: true, force: true })
          await rename(nextCache, savedCache)
        }
        await pruneHostBuild(join(projectRoot, 'temp/build/pi-desk/release/.next'))
      } else {
        await stage(`build ${entry.manifest.name}`, () =>
          runAsync('pnpm', ['--dir', entry.directory, 'build'], { env })
        )
        if (entry.manifest.scripts?.test) {
          await stage(`test ${entry.manifest.name}`, () =>
            runAsync('pnpm', ['--dir', entry.directory, 'test'], { env })
          )
        }
      }
      await pack(entry, output)
    }
  )
  if (entries.some(({ manifest }) => manifest.name === sdkName)) await pack(sdk, output)
  const host = entries.find((entry) => entry.directory === projectRoot)
  if (host) {
    const sdkSelected = entries.some((entry) => entry.manifest.name === sdkName)
    const verificationOutput = join(projectRoot, 'temp/package/npm-smoke', basename(output))
    const sdkOutput = sdkSelected ? output : verificationOutput
    try {
      if (!sdkSelected) await pack(sdk, sdkOutput)
      const smokeArtifacts = join(output, 'command-smoke')
      await mkdir(smokeArtifacts, { recursive: true })
      await Promise.all([
        cp(archivePath(sdk, sdkOutput), join(smokeArtifacts, 'sdk.tgz')),
        cp(archivePath(host, output), join(smokeArtifacts, 'host.tgz'))
      ])
    } finally {
      if (!sdkSelected) await rm(verificationOutput, { recursive: true, force: true })
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## 已验证 npm 制品\n\n${entries.map((entry) => `- ${entry.manifest.name}@${entry.manifest.version}`).join('\n')}\n`
    )
  }
}

export function assertDevelopmentTags(tags, name, version) {
  assert.ok(
    typeof tags.latest === 'string' && /^\d+\.\d+\.\d+$/.test(tags.latest),
    `${name} 尚无稳定 latest，开发制品已构建但不能发布；请先完成首次正式发布`
  )
  if (version) assert.equal(tags.dev, version, `${name} 的 dev 标签未指向本次版本`)
}

async function readTags(name) {
  const response = await fetch(
    `${registry}/-/package/${encodeURIComponent(name)}/dist-tags?validation=${Date.now()}`,
    {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(30_000)
    }
  )
  if (response.status === 404) return {}
  assert.ok(response.ok, `无法核对 ${name} 标签：HTTP ${response.status}`)
  return response.json()
}

export async function waitForNpmTags(name, version, tag) {
  const deadline = Date.now() + 10 * 60_000
  let nextLogAt = 0
  while (true) {
    const tags = await readTags(name)
    if (tag === 'dev') assertDevelopmentTags(tags, name)
    if (tags[tag] === version) {
      console.info(`${tag} 标签校验通过：${name}@${version}`)
      return
    }
    const now = Date.now()
    if (now >= deadline) {
      assert.equal(tags[tag], version, `等待 ${tag} 标签同步超时（10 分钟）：${name}@${version}`)
    }
    if (now >= nextLogAt) {
      console.info(
        `等待 ${tag} 标签同步：${name}@${version}，当前值=${tags[tag] ?? '未设置'}；每 5 秒检查，最多等待 10 分钟`
      )
      nextLogAt = now + 60_000
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
}

export async function waitForRegistryPackage(name, version) {
  const deadline = Date.now() + 10 * 60_000
  while (true) {
    const response = await fetch(
      `${registry}/${encodeURIComponent(name)}/${version}?validation=${Date.now()}`,
      { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) }
    )
    if (response.status === 404 || response.status === 202) {
      await response.body?.cancel()
    } else {
      assert.ok(response.ok, `无法核对 ${name}@${version}：HTTP ${response.status}`)
      const metadata = await response.json()
      assert.equal(metadata.version, version, 'Registry 版本与本批不一致')
      assert.ok(
        typeof metadata.dist?.tarball === 'string' &&
          metadata.dist.tarball.startsWith(`${registry}/`),
        'Registry 未提供有效 tarball'
      )
      const archive = await fetch(metadata.dist.tarball, {
        method: 'HEAD',
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(30_000)
      })
      await archive.body?.cancel()
      if (archive.ok && archive.status !== 202) {
        console.info(`Registry 版本和安装包已就绪：${name}@${version}`)
        return
      }
      assert.ok(
        [404, 202].includes(archive.status),
        `无法核对 ${name} tarball：HTTP ${archive.status}`
      )
    }
    assert.ok(Date.now() < deadline, `等待 Registry 可安装状态超时：${name}@${version}`)
    console.info(`等待 Registry 可安装状态：${name}@${version}`)
    await new Promise((done) => setTimeout(done, 5_000))
  }
}

export async function publish(entries, output) {
  for (const entry of entries) npmTagFor(process.env.GITHUB_REF, entry.manifest.version)
  assert.equal(process.env.GITHUB_REPOSITORY, 'JetCrab/pi-desk', '仓库与 npm 授权不匹配')
  const config = join(process.env.RUNNER_TEMP, 'pi-desk-publish.npmrc')
  const env = { ...process.env, NPM_CONFIG_USERCONFIG: config }
  delete env.NODE_AUTH_TOKEN
  let npmrc = `registry=${registry}\n`
  if (process.env.NPM_TOKEN) {
    env.NODE_AUTH_TOKEN = process.env.NPM_TOKEN
    npmrc += '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n'
  }
  await writeFile(config, npmrc, { mode: 0o600 })
  try {
    const selected = new Set(entries.map((entry) => entry.manifest.name))
    const existing = new Set()
    await runPackageTasks(entries, async (entry) => {
      const packed = await verifyArchive(entry, output)
      if (npmTagFor(process.env.GITHUB_REF, packed.version) === 'dev') {
        // npm 首次发布可能补充 latest；发布授权不一定允许随后删除标签。
        assertDevelopmentTags(await readTags(packed.name), packed.name)
      }
      const response = await fetch(
        `${registry}/${encodeURIComponent(packed.name)}/${packed.version}`,
        { signal: AbortSignal.timeout(30_000) }
      )
      if (response.ok) {
        const metadata = await response.json()
        const integrity = `sha512-${createHash('sha512')
          .update(await readFile(archivePath(entry, output)))
          .digest('base64')}`
        assert.equal(
          metadata.dist?.integrity,
          integrity,
          `${packed.name}@${packed.version} 已存在不同内容，拒绝覆盖`
        )
        existing.add(packed.name)
        return
      }
      assert.equal(
        response.status,
        404,
        response.ok
          ? `${packed.name}@${packed.version} 已发布，不覆盖；请选择尚未发布的包`
          : `Registry 查询失败：HTTP ${response.status}`
      )
      for (const [name, version] of Object.entries(packed.dependencies ?? {})) {
        if (name.startsWith('@jetcrab/') && !selected.has(name)) {
          await runAsync(
            'npm',
            ['view', `${name}@${version}`, 'version', '--json', `--registry=${registry}`],
            { env }
          )
        }
      }
    })
    await runPackageTasks(entries, async (entry) => {
      if (existing.has(entry.manifest.name)) {
        console.info(`复用已验证发布：${entry.manifest.name}@${entry.manifest.version}`)
      } else {
        console.info(`发布：${entry.manifest.name}@${entry.manifest.version}`)
        await runAsync(
          'npm',
          [
            'publish',
            archivePath(entry, output),
            '--ignore-scripts',
            '--access=public',
            `--tag=${npmTagFor(process.env.GITHUB_REF, entry.manifest.version)}`,
            `--registry=${registry}`
          ],
          { env }
        )
      }
      const checks = await Promise.allSettled([
        waitForNpmTags(
          entry.manifest.name,
          entry.manifest.version,
          npmTagFor(process.env.GITHUB_REF, entry.manifest.version)
        ),
        waitForRegistryPackage(entry.manifest.name, entry.manifest.version)
      ])
      const failure = checks.find((check) => check.status === 'rejected')
      if (failure) throw failure.reason
    })
  } finally {
    await rm(config, { force: true })
  }
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', '正式构建与发布仅在 GitHub Actions 中执行')
  npmValidationMode(process.env.GITHUB_REF)
  const [command] = process.argv.slice(2)
  assert.ok(command === 'prepare' || command === 'publish', '请指定 prepare 或 publish')
  const output = resolve(process.env.NPM_ARTIFACT_DIR)
  const targets = process.env.RELEASE_PACKAGES_JSON
    ? JSON.parse(process.env.RELEASE_PACKAGES_JSON)
    : (process.env.RELEASE_PACKAGE ?? 'all')
  const entries = await selectPackages(projectRoot, targets)
  for (const entry of entries) npmTagFor(process.env.GITHUB_REF, entry.manifest.version)
  if (command === 'prepare') await prepare(entries, output)
  else await publish(entries, output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
