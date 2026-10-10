import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { clientPlatforms } from '../.github/scripts/release-record.mjs'
import { selectCiChecks, selectPluginChecks } from '../.github/scripts/select-ci-checks.mjs'
import { transferRustCache } from '../.github/scripts/rust-cache.mjs'
import { npmValidationMode } from '../.github/scripts/release-npm.mjs'

test('双渠道只检查相关组件，无基线时保留完整功能检查', () => {
  assert.deepEqual(selectCiChecks(['README.md'], false), {
    full: false,
    web: false,
    pidesk: false,
    website: false,
    agent: false,
    automation: false
  })
  const website = selectCiChecks(['apps/website/src/app/page.tsx'], false)
  assert.equal(website.website, true)
  assert.equal(website.web, false)
  assert.equal(website.agent, false)
  const plugin = selectCiChecks(['plugins/pi-desk-subagent/src/index.ts'], false)
  assert.equal(plugin.web, false)
  assert.equal(plugin.website, false)
  assert.ok(Object.values(selectCiChecks([], true)).every(Boolean))
  assert.equal(selectCiChecks(['tests/l2-chat-state.test.ts'], false).web, true)
  assert.equal(
    selectCiChecks(['docs/pi-desk/examples/local-application/pi-desk.ts'], false).pidesk,
    true
  )
  assert.deepEqual(selectPluginChecks(['plugins/pi-desk-usage/README.md']), [])
  assert.deepEqual(selectPluginChecks(['plugins/pi-desk-usage/src/index.ts']), ['pi-desk-usage'])
  assert.deepEqual(
    selectPluginChecks(['plugins/pi-desk-sdk/src/browser.ts'], false, ['pi-desk-usage']),
    ['pi-desk-sdk', 'pi-desk-usage']
  )
})

test('main和dev不按分支强制全仓库检查，已打包插件不再安排重复任务', async (t) => {
  const parent = resolve('temp/run/release-checks')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'check-selection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  git('init', '-b', 'dev')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'core.hooksPath', 'no-hooks')
  git('config', 'commit.gpgSign', 'false')
  for (const [name, dependencies] of [
    ['pi-desk-sdk', {}],
    ['pi-desk-usage', { '@jetcrab/pi-desk-sdk': '^1.0.0' }],
    ['pi-desk-independent', {}]
  ]) {
    const directory = join(root, 'plugins', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, dependencies }))
  }
  git('add', '.')
  git('commit', '-m', 'fixture baseline')
  const base = git('rev-parse', 'HEAD')
  await writeFile(join(root, 'plugins/pi-desk-sdk/feature.ts'), 'export const feature = true\n')
  git('add', '.')
  git('commit', '-m', 'fixture SDK change')
  const head = git('rev-parse', 'HEAD')
  const command = resolve('.github/scripts/select-ci-checks.mjs')
  for (const ref of ['refs/heads/dev', 'refs/heads/main', 'refs/pull/1/merge']) {
    const output = join(root, 'selection.txt')
    await writeFile(output, '')
    execFileSync(process.execPath, [command], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GITHUB_REF: ref,
        GITHUB_BASE_REF: 'main',
        CHECK_BASE: base,
        CHECK_HEAD: head,
        CHECK_BUILT_PACKAGES: '["pi-desk-sdk"]',
        GITHUB_OUTPUT: output
      }
    })
    const values = Object.fromEntries(
      (await readFile(output, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    )
    assert.equal(values.full, 'false')
    assert.equal(values.web, 'true')
    assert.equal(values.website, 'false')
    assert.equal(values.agent, 'false')
    assert.deepEqual(JSON.parse(values.plugins), ['pi-desk-usage'])
  }
})

test('发布不执行排版或Lint，功能与制品检查在两条渠道均保留', async () => {
  const checks = parse(await readFile('.github/workflows/check.yml', 'utf8'))
  const source = await readFile('.github/scripts/release-npm.mjs', 'utf8')
  const steps = Object.values(checks.jobs).flatMap((job) => job.steps ?? [])
  assert.ok(steps.every((step) => !/format:check|typecheck:tests/.test(step.run ?? '')))
  for (const step of steps.filter((step) => /\b(?:lint|eslint)\b/.test(step.run ?? ''))) {
    assert.ok(step.if.includes("github.event_name == 'pull_request'"))
  }
  const production = checks.jobs.web.steps.find((step) => step.run?.includes('pnpm typecheck'))
  assert.match(production.if, /!contains\(fromJSON\(inputs.built_packages/)
  assert.match(production.run, /check:layers/)
  const host = source.slice(
    source.indexOf('if (entry.directory === projectRoot) {'),
    source.indexOf('const host = entries.find')
  )
  assert.doesNotMatch(host, /lint|format|typecheck:tests/)
  assert.match(host, /\['typecheck', 'check:layers'\]/)
  assert.ok(
    host.indexOf("['typecheck', 'check:layers']") < host.indexOf('if (full)'),
    'dev也必须执行主程序类型和依赖分层检查'
  )
  assert.match(host, /\['test:package'\]/)
  assert.ok(checks.jobs.web.steps.some((step) => step.run?.includes('tests/l2-chat-state.test.ts')))
})

test('npm验证模式仅由受信任分支决定', () => {
  assert.equal(npmValidationMode('refs/heads/dev'), 'lightweight')
  assert.equal(npmValidationMode('refs/heads/main'), 'full')
  assert.throws(() => npmValidationMode('refs/pull/1/merge'))
})

test('Rust缓存复制保留编译依赖但不覆盖本次配置或安装包', async (t) => {
  const parent = resolve('temp/tests/release-speed/rust-cache')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'cache')
  const target = join(root, 'build')
  await mkdir(join(source, 'debug/deps'), { recursive: true })
  await mkdir(join(source, 'debug/bundle'), { recursive: true })
  await mkdir(join(source, 'web'), { recursive: true })
  await mkdir(target, { recursive: true })
  await writeFile(join(source, 'debug/deps/library.rlib'), 'dependency')
  await writeFile(join(source, 'debug/bundle/setup.exe'), 'old installer')
  await writeFile(join(source, 'tauri-ci.json'), 'old config')
  await writeFile(join(source, 'web/index.html'), 'old frontend')
  await writeFile(join(target, 'tauri-ci.json'), 'current config')
  assert.equal(await transferRustCache(source, target), 1)
  assert.equal(await readFile(join(target, 'debug/deps/library.rlib'), 'utf8'), 'dependency')
  assert.equal(await readFile(join(target, 'tauri-ci.json'), 'utf8'), 'current config')
  await assert.rejects(access(join(target, 'debug/bundle/setup.exe')))
  await assert.rejects(access(join(target, 'web')))
})

test('跨任务恢复后重新生成Cargo依赖的绝对路径元数据', async (t) => {
  const parent = resolve('temp/tests/release-speed/cargo-metadata')
  const builds = resolve('temp/build/release-speed/cargo-metadata')
  await mkdir(parent, { recursive: true })
  await mkdir(builds, { recursive: true })
  const root = await mkdtemp(join(parent, 'fixture-'))
  const target = await mkdtemp(join(builds, 'fixture-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  })
  await mkdir(join(root, 'src'))
  await mkdir(join(root, '.cargo'))
  const dependency = join(root, 'vendor/cache-metadata')
  await mkdir(join(dependency, 'src'), { recursive: true })
  await writeFile(
    join(root, '.cargo/config.toml'),
    '[source.crates-io]\nreplace-with="fixture-vendor"\n[source.fixture-vendor]\ndirectory="vendor"\n'
  )
  await writeFile(
    join(root, 'Cargo.toml'),
    '[package]\nname="cache-consumer"\nversion="1.0.0"\nedition="2021"\n[dependencies]\ncache-metadata="1.0.0"\n[workspace]\n'
  )
  await writeFile(join(root, 'src/lib.rs'), 'pub fn ready() -> bool { true }\n')
  await writeFile(
    join(root, 'build.rs'),
    `fn main() {
    let index = std::env::var("DEP_CACHE_METADATA_FILE").unwrap();
    let path = std::fs::read_to_string(index).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "current metadata");
}
`
  )
  await writeFile(
    join(dependency, 'Cargo.toml'),
    '[package]\nname="cache-metadata"\nversion="1.0.0"\nedition="2021"\nlinks="cache_metadata"\n'
  )
  await writeFile(join(dependency, 'src/lib.rs'), 'pub fn metadata() {}\n')
  await writeFile(
    join(dependency, 'build.rs'),
    `fn main() {
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let path = out.join("permission.txt");
    let index = out.join("permission-path.txt");
    std::fs::write(&path, "current metadata").unwrap();
    std::fs::write(&index, path.to_string_lossy().as_bytes()).unwrap();
    println!("cargo:file={}", index.display());
}
`
  )
  const files = {}
  for (const file of ['Cargo.toml', 'src/lib.rs', 'build.rs']) {
    files[file] = createHash('sha256')
      .update(await readFile(join(dependency, file)))
      .digest('hex')
  }
  await writeFile(
    join(dependency, '.cargo-checksum.json'),
    JSON.stringify({ files, package: null })
  )
  const first = join(target, 'first-run')
  const restored = join(target, 'next-run')
  const stale = join(target, 'unchanged-cache')
  const cargo = (output, ...args) =>
    execFileSync('cargo', args, {
      cwd: root,
      env: { ...process.env, CARGO_TARGET_DIR: output, CARGO_INCREMENTAL: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 90_000
    })
  cargo(first, 'build', '--offline')
  await cp(first, stale, { recursive: true, preserveTimestamps: true })
  await transferRustCache(first, restored)
  await rm(first, { recursive: true, force: true })
  cargo(stale, 'clean', '-p', 'cache-consumer')
  assert.throws(() => cargo(stale, 'build', '--offline'), '直接复用旧路径元数据应复现构建失败')
  cargo(restored, 'clean', '-p', 'cache-consumer')
  cargo(restored, 'build', '--offline')
  assert.ok(
    (await readdir(join(restored, 'debug/build'))).some((name) =>
      name.startsWith('cache-metadata-')
    )
  )
})

test('正式审查只等待固定提交，发布仍等待审查和所有构建', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-main.yml', import.meta.url),
    'utf8'
  )
  const notes = workflow.slice(workflow.indexOf('\n  notes:'), workflow.indexOf('\n  npm-build:'))
  assert.match(notes, /needs: prepare\n/)
  assert.doesNotMatch(notes, /BUILD_RESULTS|plan\.tests|needs:\s*\[/)
  const assemble = workflow.slice(
    workflow.indexOf('\n  assemble:'),
    workflow.indexOf('\n  npm-publish:')
  )
  const required = ['prepare', 'checks', 'notes', 'npm-build', 'tunnel-build', ...clientPlatforms]
  const dependencies = parse(workflow).jobs.assemble.needs
  for (const job of required) assert.ok(dependencies.includes(job), `正式汇总必须等待 ${job}`)
  assert.match(assemble, /!contains\(needs\.\*\.result, 'failure'\)/)
  assert.match(assemble, /!contains\(needs\.\*\.result, 'cancelled'\)/)
})

test('隧道并行构建后复用已验证镜像，推送仍等待正式汇合', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-main.yml', import.meta.url),
    'utf8'
  )
  const build = workflow.slice(
    workflow.indexOf('\n  tunnel-build:'),
    workflow.indexOf('\n  assemble:')
  )
  assert.match(build, /needs: prepare\n/)
  assert.match(build, /outputs\.tunnel == 'true'/)
  assert.match(build, /phase: build/)
  const publish = workflow.slice(workflow.indexOf('\n  tunnel:'), workflow.indexOf('\n  publish:'))
  assert.match(publish, /needs: \[prepare, assemble, docker-build\]/)
  assert.match(publish, /!contains\(needs\.\*\.result, 'failure'\)/)
  assert.match(publish, /phase: publish/)
  const tunnel = await readFile(
    new URL('../.github/workflows/release-tunnel.yml', import.meta.url),
    'utf8'
  )
  assert.match(tunnel, /apps\/tunnel\/server\/Cargo\.toml/)
  assert.match(tunnel, /inputs.phase != 'publish'/)
  assert.match(tunnel, /inputs.phase != 'build'/)
  assert.match(tunnel, /group: release-tunnel-version-push/)
  assert.match(tunnel, /加载同一镜像并核对源码/)
})

test('正式批次去重源码命令验收，但保留同批安装态两平台与Windows核心回归', async () => {
  const read = async (name) =>
    parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
  const main = await read('release-main')
  const checks = await read('check')
  const npm = await read('release-npm')
  assert.equal(main.jobs.checks.with.built_packages, '${{ needs.prepare.outputs.npm }}')
  assert.equal(main.jobs.checks.with.base_sha, '${{ needs.prepare.outputs.check_base }}')
  assert.equal(main.jobs.prepare.permissions.actions, 'read')
  assert.equal(main.jobs.assemble.steps[0].with.ref, '${{ github.sha }}')
  assert.equal(checks.jobs.changes.steps[0].with.ref, '${{ github.sha }}')
  assert.equal(checks.jobs.core.steps[0].with.ref, '${{ github.sha }}')
  assert.equal(checks.jobs.web.steps[0].with.ref, '${{ inputs.source_sha || github.sha }}')
  const dev = await read('release-dev')
  assert.equal(dev.jobs.checks.with.base_sha, '${{ needs.plan.outputs.check_base }}')
  assert.equal(dev.jobs.checks.with.built_packages, '${{ needs.plan.outputs.packages }}')
  assert.match(checks.jobs.pidesk.if, /!contains\(fromJSON\(inputs.built_packages/)
  assert.deepEqual(npm.jobs['installed-commands'].strategy.matrix.os, [
    'ubuntu-latest',
    'windows-latest'
  ])
  const windows = npm.jobs['installed-commands'].steps.find(
    (step) => step.name === 'Windows 核心回归复用同批 SDK 产物'
  )
  assert.equal(windows.if, "runner.os == 'Windows'")
  assert.match(windows.run, /pnpm test:pidesk/)
})

test('同一运行的制品名称跨重试稳定，构建数据仍按attempt隔离', async () => {
  for (const name of [
    'release-main',
    'release-npm',
    'build-clients',
    'build-linux',
    'release-apple',
    'release-tunnel',
    'release-docker'
  ]) {
    const workflow = await readFile(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      'utf8'
    )
    assert.doesNotMatch(
      workflow,
      /name: [^\n]*github\.run_attempt/,
      `${name} 不得让成功制品随重试失联`
    )
    assert.match(
      workflow,
      /(?:path:|TARGET_DIR:|OUTPUT:|_ROOT:|ARTIFACT_DIR:|PACKAGE_DIR:)[^\n]*temp\/[^\n]*github\.run_(?:id|attempt)/
    )
    for (const upload of workflow.matchAll(
      /uses: actions\/upload-artifact@v4([\s\S]*?)(?=\n      -|\n  [a-z][\w-]*:|$)/g
    )) {
      assert.match(upload[1], /overwrite: true/, `${name} 重跑上传须替换本run同源制品`)
    }
  }
})

test('dev共享进程清理变更进入统一入口的宿主检查而非无关客户端编译', () => {
  assert.equal(
    selectCiChecks(['src/server/l4_foundation/process/l4-process-tree.js'], false).pidesk,
    true
  )
})

test('客户端dev执行受影响回归，覆盖安装仍仅在main', async () => {
  const windows = await readFile(
    new URL('../.github/workflows/build-clients.yml', import.meta.url),
    'utf8'
  )
  assert.match(windows, /BUILD_PROFILE: release\n/)
  assert.match(windows, /RUST_CACHE_STAGE:.*windows-release/)
  assert.doesNotMatch(windows, /--debug/)
  const macos = await readFile(
    new URL('../.github/workflows/release-apple.yml', import.meta.url),
    'utf8'
  )
  assert.match(macos, /BUILD_PROFILE: release\n/)
  assert.match(macos, /RUST_CACHE_STAGE:.*macos-release/)
  assert.doesNotMatch(macos, /--debug/)
  assert.match(windows, /name: 受影响桌面 Rust 回归/)
  assert.match(
    windows,
    /name: 隔离验证覆盖安装与正常退出\n\s+if: github.ref == 'refs\/heads\/main'/
  )
  assert.match(windows, /check-desktop-tunnel\.mjs/)
  assert.match(windows, /build_tasks=\(:app:testDebugUnitTest\)/)
  assert.match(
    windows,
    /if \[\[ "\$CHECK_ONLY" != true \]\]; then build_tasks\+=\(:app:assembleRelease\)/
  )
  const main = await readFile(
    new URL('../.github/workflows/release-main.yml', import.meta.url),
    'utf8'
  )
  assert.match(main, /uses: \.\/.github\/workflows\/check.yml/)
  const jobs = parse(main).jobs
  for (const platform of clientPlatforms) {
    assert.ok(jobs[platform]?.uses, `缺少 ${platform} 的构建入口`)
    assert.ok(jobs.assemble.needs.includes(platform), `${platform} 未纳入发布门禁`)
  }
})
