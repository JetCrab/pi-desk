import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { evaluateWorkflowCondition, readWorkflow } from './fixtures/l4-workflow-test-runtime.mjs'
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
  assert.equal(selectCiChecks(['docs/examples/local-application/pi-desk.ts'], false).pidesk, true)
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

test('发布源码检查不执行排版或Lint，已打包主包不重复类型检查', async () => {
  const checks = await readWorkflow('check')
  const steps = Object.values(checks.jobs).flatMap((job) => job.steps ?? [])
  assert.ok(steps.every((step) => !/format:check|typecheck:tests/.test(step.run ?? '')))
  for (const step of steps.filter((step) => /\b(?:lint|eslint)\b/.test(step.run ?? ''))) {
    for (const event_name of ['push', 'workflow_dispatch', 'pull_request']) {
      assert.equal(
        evaluateWorkflowCondition(step.if, {
          github: { event_name },
          needs: { changes: { outputs: { automation: 'true' } } }
        }),
        event_name === 'pull_request'
      )
    }
  }
  const production = checks.jobs.web.steps.find((step) => step.run?.includes('pnpm typecheck'))
  for (const built_packages of ['[]', '["pi-desk"]']) {
    assert.equal(
      evaluateWorkflowCondition(production.if, { inputs: { built_packages } }),
      built_packages === '[]'
    )
  }
  assert.match(production.run, /check:layers/)
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
  const workflow = await readWorkflow('release-main')
  assert.deepEqual([].concat(workflow.jobs.notes.needs), ['prepare'])
  const required = ['prepare', 'checks', 'notes', 'npm-build', 'tunnel-build', ...clientPlatforms]
  const assemble = workflow.jobs.assemble
  for (const job of required) assert.ok(assemble.needs.includes(job), `正式汇总必须等待 ${job}`)
  const needs = Object.fromEntries(required.map((name) => [name, { result: 'success' }]))
  needs.prepare.outputs = { published: 'false' }
  assert.equal(evaluateWorkflowCondition(assemble.if, { needs }), true)
  for (const job of required) {
    for (const result of ['failure', 'cancelled']) {
      assert.equal(
        evaluateWorkflowCondition(assemble.if, {
          needs: { ...needs, [job]: { ...needs[job], result } }
        }),
        false,
        `${job} ${result} 必须阻止正式汇总`
      )
    }
  }
})

test('隧道并行构建后复用已验证镜像，推送仍等待正式汇合', async () => {
  const workflow = await readWorkflow('release-main')
  const build = workflow.jobs['tunnel-build']
  assert.deepEqual([].concat(build.needs), ['prepare'])
  assert.equal(build.with.phase, 'build')
  for (const tunnel of ['true', 'false']) {
    assert.equal(
      evaluateWorkflowCondition(build.if, {
        needs: { prepare: { outputs: { published: 'false', tunnel } } }
      }),
      tunnel === 'true'
    )
  }
  const publish = workflow.jobs.tunnel
  for (const dependency of ['prepare', 'assemble', 'docker-build'])
    assert.ok(publish.needs.includes(dependency))
  assert.equal(publish.with.phase, 'publish')
  const tunnel = await readWorkflow('release-tunnel')
  assert.equal(tunnel.jobs.publish.concurrency.group, 'release-tunnel-version-push')
  const needs = {
    plan: { result: 'success', outputs: { changed: 'true' } },
    build: { result: 'success' }
  }
  for (const phase of ['build', 'publish']) {
    const context = {
      needs,
      inputs: { phase, check_only: false, source_sha: 'a'.repeat(40) },
      github: { ref: 'refs/heads/main' }
    }
    assert.equal(evaluateWorkflowCondition(tunnel.jobs.build.if, context), phase === 'build')
    assert.equal(evaluateWorkflowCondition(tunnel.jobs.publish.if, context), phase === 'publish')
  }
  assert.ok(tunnel.jobs.publish.steps.some((step) => /\bdocker\s+load\b/.test(step.run ?? '')))
})

test('正式批次去重源码命令验收，但保留同批安装态两平台与Windows核心回归', async () => {
  const main = await readWorkflow('release-main')
  const checks = await readWorkflow('check')
  const npm = await readWorkflow('release-npm')
  assert.equal(main.jobs.checks.with.built_packages, '${{ needs.prepare.outputs.npm }}')
  assert.equal(main.jobs.checks.with.base_sha, '${{ needs.prepare.outputs.check_base }}')
  assert.equal(main.jobs.prepare.permissions.actions, 'read')
  assert.equal(main.jobs.assemble.steps[0].with.ref, '${{ github.sha }}')
  assert.equal(checks.jobs.changes.steps[0].with.ref, '${{ github.sha }}')
  assert.equal(checks.jobs.core.steps[0].with.ref, '${{ github.sha }}')
  assert.equal(checks.jobs.web.steps[0].with.ref, '${{ inputs.source_sha || github.sha }}')
  const dev = await readWorkflow('release-dev')
  assert.equal(dev.jobs.checks.with.base_sha, '${{ needs.plan.outputs.check_base }}')
  assert.equal(dev.jobs.checks.with.built_packages, '${{ needs.plan.outputs.packages }}')
  const needs = { changes: { outputs: { pidesk: 'true' } } }
  for (const built_packages of ['[]', '["pi-desk"]']) {
    assert.equal(
      evaluateWorkflowCondition(checks.jobs.pidesk.if, { needs, inputs: { built_packages } }),
      built_packages === '[]'
    )
  }
  for (const os of ['ubuntu-latest', 'windows-latest'])
    assert.ok(npm.jobs['installed-commands'].strategy.matrix.os.includes(os))
  const windows = npm.jobs['installed-commands'].steps.find((step) =>
    /\bpnpm\s+test:pidesk\b/.test(step.run ?? '')
  )
  assert.ok(windows)
  for (const os of ['Windows', 'Linux']) {
    assert.equal(evaluateWorkflowCondition(windows.if, { runner: { os } }), os === 'Windows')
  }
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
    const workflow = await readWorkflow(name)
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
    for (const step of steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'))) {
      assert.ok(!step.with.name.includes('github.run_attempt'), `${name} 重试不得改变制品身份`)
      if (name === 'release-docker' && step.with.name.startsWith('docker-image-')) {
        assert.notEqual(step.with.overwrite, true, '已验证镜像不能被重跑覆盖')
        assert.equal(step.if, "steps.image.outputs.reused != 'true'", '已恢复镜像不重复上传')
      } else assert.equal(step.with.overwrite, true, `${name} 重跑上传须替换本run同源制品`)
    }
    const env = [
      workflow.env ?? {},
      ...Object.values(workflow.jobs).map((job) => job.env ?? {})
    ].flatMap((values) => Object.entries(values))
    assert.ok(
      env.some(
        ([key, value]) =>
          /(?:TARGET_DIR|OUTPUT|_ROOT|ARTIFACT_DIR|PACKAGE_DIR)$/.test(key) &&
          typeof value === 'string' &&
          value.includes('temp/') &&
          value.includes('github.run_attempt')
      ),
      `${name} 构建数据必须按重试隔离`
    )
  }
})

test('dev共享进程清理变更进入统一入口的宿主检查而非无关客户端编译', () => {
  assert.equal(
    selectCiChecks(['src/server/l4_foundation/process/l4-process-tree.js'], false).pidesk,
    true
  )
})

test('客户端dev执行受影响回归，覆盖安装仍仅在main', async () => {
  const clients = await readWorkflow('build-clients')
  const apple = await readWorkflow('release-apple')
  for (const job of [clients.jobs.windows, apple.jobs.macos]) {
    assert.equal(job.env.BUILD_PROFILE, 'release')
    assert.ok(job.env.RUST_CACHE_STAGE.endsWith('-release'))
  }
  const windows = clients.jobs.windows
  assert.ok(windows.steps.some((step) => step.run?.includes('check-desktop-tunnel.mjs')))
  const installation = windows.steps.find((step) =>
    step.run?.includes('test-installer-overwrite.mjs')
  )
  assert.ok(installation)
  for (const ref of ['refs/heads/main', 'refs/heads/dev']) {
    for (const check_only of [false, true]) {
      assert.equal(
        evaluateWorkflowCondition(installation.if, { github: { ref }, inputs: { check_only } }),
        ref === 'refs/heads/main' && !check_only
      )
    }
  }
  const main = await readWorkflow('release-main')
  assert.equal(main.jobs.checks.uses, './.github/workflows/check.yml')
  for (const platform of clientPlatforms) {
    assert.ok(main.jobs[platform]?.uses, `缺少 ${platform} 的构建入口`)
    assert.ok(main.jobs.assemble.needs.includes(platform), `${platform} 未纳入发布门禁`)
  }
})
