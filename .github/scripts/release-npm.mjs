import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
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
  const selected = entries.filter((entry) => entry.manifest.name === `@jetcrab/${target}`)
  assert.equal(selected.length, 1, `未知公开包：${target}`)
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

function archivePath(entry, output) {
  return join(
    output,
    `${entry.manifest.name.slice(1).replace('/', '-')}-${entry.manifest.version}.tgz`
  )
}

async function verifyArchive(entry, output) {
  const archive = archivePath(entry, output)
  const list = run('tar', ['-tzf', basename(archive)], { cwd: output, capture: true })
    .trim()
    .split(/\r?\n/)
  const packed = JSON.parse(
    run('tar', ['-xOzf', basename(archive), 'package/package.json'], { cwd: output, capture: true })
  )
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

async function prepare(entries, output) {
  await mkdir(output, { recursive: true })
  const [sdk] = await selectPackages(projectRoot, 'pi-desk-sdk')
  run('pnpm', ['--dir', sdk.directory, 'test'], {
    env: { ...process.env, TSX_TSCONFIG_PATH: join(sdk.directory, 'tsconfig.json') }
  })
  run(process.execPath, [
    '--test',
    'tests/l4-public-boundary.test.mjs',
    'tests/l4-release-npm.test.mjs'
  ])
  for (const entry of entries) {
    if (entry.manifest.name === sdkName) continue
    console.info(`构建与测试：${entry.manifest.name}@${entry.manifest.version}`)
    if (entry.directory === projectRoot) {
      run('pnpm', ['typecheck'])
      run('pnpm', ['lint:production'])
      run('pnpm', ['check:layers'])
      run('pnpm', ['test:package'])
      run('pnpm', ['build'])
      await rm(join(projectRoot, 'temp/build/pi-desk/release/.next/cache'), {
        recursive: true,
        force: true
      })
    } else {
      const env = { ...process.env, TSX_TSCONFIG_PATH: join(entry.directory, 'tsconfig.json') }
      run('pnpm', ['--dir', entry.directory, 'build'], { env })
      run('pnpm', ['--dir', entry.directory, 'test'], { env })
    }
  }
  const packed = entries.some((entry) => entry.manifest.name === sdkName)
    ? entries
    : [sdk, ...entries]
  for (const entry of packed) {
    run('pnpm', ['--dir', entry.directory, 'pack', '--pack-destination', output], {
      env: { ...process.env, npm_config_ignore_scripts: 'true' }
    })
    await verifyArchive(entry, output)
  }
  const host = entries.find((entry) => entry.directory === projectRoot)
  if (host) {
    const { verifyNpmInstall } = await import('./verify-npm-install.mjs')
    await verifyNpmInstall({
      root: projectRoot,
      sdkArchive: archivePath(sdk, output),
      hostArchive: archivePath(host, output),
      version: host.manifest.version,
      run
    })
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## 已验证 npm 制品\n\n${entries.map((entry) => `- ${entry.manifest.name}@${entry.manifest.version}`).join('\n')}\n`
    )
  }
}

async function publish(entries, output) {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', '正式发布只允许 main 分支')
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
    for (const entry of entries) {
      const packed = await verifyArchive(entry, output)
      const response = await fetch(
        `${registry}/${encodeURIComponent(packed.name)}/${packed.version}`,
        { signal: AbortSignal.timeout(30_000) }
      )
      assert.equal(
        response.status,
        404,
        response.ok
          ? `${packed.name}@${packed.version} 已发布，不覆盖；请选择尚未发布的包`
          : `Registry 查询失败：HTTP ${response.status}`
      )
      for (const [name, version] of Object.entries(packed.dependencies ?? {})) {
        if (name.startsWith('@jetcrab/') && !selected.has(name)) {
          run(
            'npm',
            ['view', `${name}@${version}`, 'version', '--json', `--registry=${registry}`],
            { env }
          )
        }
      }
    }
    for (const entry of entries) {
      console.info(`发布：${entry.manifest.name}@${entry.manifest.version}`)
      run(
        'npm',
        [
          'publish',
          archivePath(entry, output),
          '--ignore-scripts',
          '--access=public',
          '--tag=latest',
          `--registry=${registry}`
        ],
        { env }
      )
    }
  } finally {
    await rm(config, { force: true })
  }
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', '正式构建与发布仅在 GitHub Actions 中执行')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', '请从 main 分支执行')
  const [command] = process.argv.slice(2)
  assert.ok(command === 'prepare' || command === 'publish', '请指定 prepare 或 publish')
  const output = resolve(process.env.NPM_ARTIFACT_DIR)
  const entries = await selectPackages(projectRoot, process.env.RELEASE_PACKAGE ?? 'all')
  if (command === 'prepare') await prepare(entries, output)
  else await publish(entries, output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
