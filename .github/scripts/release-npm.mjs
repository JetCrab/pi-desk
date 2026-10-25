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
  { cwd = projectRoot, capture = false, env = process.env, timeout = 0 } = {}
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
        stdio: [capture ? 'ignore' : 'inherit', capture ? 'pipe' : 'inherit', 'pipe']
      }
    )
    let stderr = Buffer.alloc(0)
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      stderr = Buffer.concat([stderr, chunk]).subarray(-16 * 1024)
    })
    let timedOut = false
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeout)
      : undefined
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
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectCommand(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (overflow) rejectCommand(overflow)
      else if (timedOut || code !== 0)
        rejectCommand(
          new Error(
            `命令执行失败：${tool}，退出码=${code}，信号=${signal ?? '无'}${timedOut ? `，ETIMEDOUT（${timeout / 1000} 秒）` : ''}\n${stderr.toString('utf8').trim()}`
          )
        )
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

export async function preserveArchives(entries, output) {
  const verified = join(output, 'verified')
  await rm(verified, { recursive: true, force: true })
  await mkdir(verified, { recursive: true })
  const saved = []
  for (const entry of entries) {
    const archive = archivePath(entry, output)
    if (!existsSync(archive)) continue
    try {
      await verifyArchive(entry, output)
      const destination = join(verified, basename(archive))
      await cp(archive, `${destination}.copy`)
      await rename(`${destination}.copy`, destination)
      saved.push(entry.manifest.name.slice('@jetcrab/'.length))
    } catch (error) {
      console.warn(`原始制品未保存：${archive}；${error.message}`)
    }
  }
  return saved
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
    if (entries.some(({ manifest }) => manifest.name === sdkName)) await pack(sdk, output)
  }
  if (full) {
    await stage('test npm 发布回归', () =>
      runAsync(process.execPath, ['--test', 'tests/l4-release-npm.test.mjs'])
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
          try {
            await cp(savedCache, nextCache, { recursive: true })
          } catch (error) {
            console.warn(`Next 缓存复制失败：${savedCache} -> ${nextCache}；${error.message}`)
          }
        }
        // 主包 build 的前半段只重复 SDK build；这里执行同一 Next 构建入口。
        await stage(`build ${entry.manifest.name}`, () =>
          runAsync('pnpm', ['exec', 'next', 'build', '--webpack'])
        )
        if (!full && existsSync(nextCache)) {
          try {
            await mkdir(join(projectRoot, 'temp/cache/next'), { recursive: true })
            await rm(savedCache, { recursive: true, force: true })
            await rename(nextCache, savedCache)
          } catch (error) {
            console.warn(`Next 缓存保存失败：${nextCache} -> ${savedCache}；${error.message}`)
          }
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
      if (!sdkSelected) {
        try {
          await rm(verificationOutput, { recursive: true, force: true })
        } catch (error) {
          console.warn(`临时 smoke 目录清理失败：${verificationOutput}；${error.message}`)
        }
      }
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

async function readRegistry(url, { method = 'GET', deadline = Date.now() + 96_000 } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const remaining = deadline - Date.now()
    assert.ok(remaining > 0, `Registry 读取已超出总时限：${method} ${url}`)
    let retryable = false
    let retryAfterMs = 0
    try {
      const response = await fetch(url, {
        method,
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(Math.min(30_000, remaining))
      })
      retryable = [408, 429].includes(response.status) || response.status >= 500
      if (retryable) {
        const retryAfter = response.headers.get('retry-after')
        if (retryAfter) {
          const seconds = Number(retryAfter)
          const delay = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter) - Date.now()
          if (Number.isFinite(delay)) retryAfterMs = Math.max(0, delay)
        }
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }
      if (method === 'HEAD' || !response.ok || response.status === 202) {
        await response.body?.cancel()
        return { status: response.status, data: null }
      }
      return { status: response.status, data: await response.json() }
    } catch (error) {
      const code = error.cause?.code ?? error.code
      retryable ||=
        ['TimeoutError', 'AbortError'].includes(error.name) ||
        [
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'EAI_AGAIN',
          'ENOTFOUND',
          'ENETUNREACH',
          'UND_ERR_CONNECT_TIMEOUT',
          'UND_ERR_HEADERS_TIMEOUT',
          'UND_ERR_BODY_TIMEOUT',
          'UND_ERR_SOCKET'
        ].includes(code) ||
        (error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message))
      const detail = [error.message, error.cause?.message, code].filter(Boolean).join('；')
      const delayMs = Math.max(2_000 * 2 ** (attempt - 1), retryAfterMs)
      if (!retryable || attempt === 3 || Date.now() + delayMs >= deadline) {
        const limit = retryable && attempt < 3 ? '，重试将超出总时限' : ''
        throw new Error(`Registry ${method} ${url} 失败（${attempt}/3${limit}）：${detail}`, {
          cause: error
        })
      }
      console.warn(
        `Registry ${method} ${url} 第 ${attempt}/3 次失败：${detail}；${delayMs / 1000} 秒后重试`
      )
      await new Promise((done) => setTimeout(done, delayMs))
    }
  }
}

async function readPackageMetadata(name, deadline) {
  const result = await readRegistry(
    `${registry}/${encodeURIComponent(name)}?validation=${Date.now()}`,
    { deadline }
  )
  assert.ok(
    [200, 202, 404].includes(result.status),
    `无法核对 ${name} 元数据：HTTP ${result.status}`
  )
  if (result.status === 200) {
    assert.equal(result.data?.name, name, `Registry 包元数据身份不符：${name}`)
    for (const field of ['dist-tags', 'versions']) {
      assert.ok(
        result.data[field] &&
          typeof result.data[field] === 'object' &&
          !Array.isArray(result.data[field]),
        `Registry 包元数据缺少 ${field}：${name}`
      )
    }
  }
  return result
}

export async function waitForNpmTags(name, version, tag) {
  const deadline = Date.now() + 10 * 60_000
  let nextLogAt = 0
  while (Date.now() < deadline) {
    const { status, data } = await readPackageMetadata(name, deadline)
    const tags = data?.['dist-tags'] ?? {}
    if (tag === 'dev' && status !== 202) assertDevelopmentTags(tags, name)
    if (tags[tag] === version) {
      console.info(`${tag} 标签校验通过：${name}@${version}`)
      return
    }
    const now = Date.now()
    if (now >= deadline) break
    if (now >= nextLogAt) {
      console.info(
        `等待 ${tag} 标签同步：${name}@${version}，当前值=${tags[tag] ?? '未设置'}；每 5 秒检查，最多等待 10 分钟`
      )
      nextLogAt = now + 60_000
    }
    await new Promise((done) => setTimeout(done, Math.min(5_000, deadline - now)))
  }
  throw new Error(`等待 ${tag} 标签同步超时（10 分钟）：${name}@${version}`)
}

export async function waitForRegistryPackage(name, version) {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const { data } = await readPackageMetadata(name, deadline)
    const metadata = data?.versions?.[version]
    if (metadata) {
      assert.equal(metadata.version, version, 'Registry 版本与本批不一致')
      assert.ok(
        typeof metadata.dist?.tarball === 'string' &&
          metadata.dist.tarball.startsWith(`${registry}/`),
        'Registry 未提供有效 tarball'
      )
      const archive = await readRegistry(metadata.dist.tarball, { method: 'HEAD', deadline })
      if (archive.status >= 200 && archive.status < 300 && archive.status !== 202) {
        console.info(`Registry 版本和安装包已就绪：${name}@${version}`)
        return
      }
      assert.ok(
        [404, 202].includes(archive.status),
        `无法核对 ${name} tarball：HTTP ${archive.status}`
      )
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    console.info(`等待 Registry 可安装状态：${name}@${version}`)
    await new Promise((done) => setTimeout(done, Math.min(5_000, remaining)))
  }
  throw new Error(`等待 Registry 可安装状态超时（10 分钟）：${name}@${version}`)
}

async function assertPublishedArchive(entry, output, metadata) {
  assert.equal(metadata.version, entry.manifest.version, 'Registry 版本与本批不一致')
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(archivePath(entry, output)))
    .digest('base64')}`
  assert.equal(
    metadata.dist?.integrity,
    integrity,
    `${entry.manifest.name}@${entry.manifest.version} 已存在不同内容，拒绝覆盖`
  )
}

async function upload(entry, output, env) {
  const { name, version } = entry.manifest
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await runAsync(
        'npm',
        [
          'publish',
          archivePath(entry, output),
          '--ignore-scripts',
          '--access=public',
          `--tag=${npmTagFor(process.env.GITHUB_REF, version)}`,
          `--registry=${registry}`,
          '--fetch-retries=0',
          '--fetch-timeout=90000'
        ],
        { env, timeout: 120_000 }
      )
      return
    } catch (error) {
      if (
        !/\b(?:E(?:408|429|5\d\d)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EPIPE)\b/.test(
          error.message
        ) ||
        /\b(?:E401|E403|ENEEDAUTH|EJSONPARSE|EINVALIDPACKAGENAME)\b/.test(error.message)
      ) {
        throw error
      }
      console.warn(`npm 上传临时失败（${attempt}/3）：${name}@${version}；${error.message}`)
      const { status, data } = await readPackageMetadata(name)
      assert.notEqual(status, 202, `Registry 包元数据尚未就绪，停止重传：${name}@${version}`)
      const metadata = data?.versions?.[version]
      if (metadata) {
        await assertPublishedArchive(entry, output, metadata)
        console.info(`Registry 已接受相同制品，继续发布检查：${name}@${version}`)
        return
      }
      if (attempt === 3) throw error
      const delay = 2_000 * attempt
      console.warn(`Registry 当前无本版本，${delay / 1000} 秒后重传：${name}@${version}`)
      await new Promise((done) => setTimeout(done, delay))
    }
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
  const published = []
  try {
    await writeFile(config, npmrc, { mode: 0o600 })
    const selected = new Set(entries.map((entry) => entry.manifest.name))
    const existing = new Set()
    await runPackageTasks(entries, async (entry) => {
      const packed = await verifyArchive(entry, output)
      const { status, data } = await readPackageMetadata(packed.name)
      assert.notEqual(status, 202, `Registry 包元数据尚未就绪：${packed.name}`)
      if (npmTagFor(process.env.GITHUB_REF, packed.version) === 'dev') {
        // npm 首次发布可能补充 latest；发布授权不一定允许随后删除标签。
        assertDevelopmentTags(data?.['dist-tags'] ?? {}, packed.name)
      }
      const metadata = data?.versions?.[packed.version]
      if (metadata) {
        await assertPublishedArchive(entry, output, metadata)
        existing.add(packed.name)
        return
      }
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
        await upload(entry, output, env)
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
      published.push(entry.manifest.name.slice('@jetcrab/'.length))
    })
  } finally {
    try {
      await writeFile(join(output, 'published.json'), JSON.stringify(published) + '\n')
    } finally {
      try {
        await rm(config, { force: true })
      } catch (error) {
        console.warn(`发布临时配置清理失败：${config}；${error.message}`)
      }
    }
  }
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', '正式构建与发布仅在 GitHub Actions 中执行')
  npmValidationMode(process.env.GITHUB_REF)
  const [command] = process.argv.slice(2)
  assert.ok(
    ['prepare', 'publish', 'preserve'].includes(command),
    '请指定 prepare、publish 或 preserve'
  )
  const output = resolve(process.env.NPM_ARTIFACT_DIR)
  const targets = process.env.RELEASE_PACKAGES_JSON
    ? JSON.parse(process.env.RELEASE_PACKAGES_JSON)
    : (process.env.RELEASE_PACKAGE ?? 'all')
  const entries = await selectPackages(projectRoot, targets)
  for (const entry of entries) npmTagFor(process.env.GITHUB_REF, entry.manifest.version)
  if (command === 'prepare') await prepare(entries, output)
  else if (command === 'publish') await publish(entries, output)
  else {
    const saved = await preserveArchives(entries, output)
    await appendFile(process.env.GITHUB_OUTPUT, `packages=${JSON.stringify(saved)}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
