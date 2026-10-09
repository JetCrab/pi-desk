import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { lockDependencyContent } from '../.github/scripts/release-dependencies.mjs'
import { selectDevTargets } from '../.github/scripts/select-dev-targets.mjs'

const lock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      host-lib:
        specifier: ^1.0.0
        version: 1.0.0
  plugins/pi-desk-usage:
    dependencies:
      plugin-lib:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  host-lib@1.0.0:
    resolution: {integrity: host}
  plugin-lib@1.0.0:
    resolution: {integrity: plugin}
  nested@1.0.0:
    resolution: {integrity: nested}
snapshots:
  host-lib@1.0.0: {}
  plugin-lib@1.0.0:
    dependencies:
      nested: 1.0.0
  nested@1.0.0: {}
`

test('锁文件变化仅影响实际使用该依赖的包并包含传递依赖', () => {
  const changed = lock.replace('integrity: nested', 'integrity: new-nested')
  assert.deepEqual(lockDependencyContent(lock, '.'), lockDependencyContent(changed, '.'))
  assert.notDeepEqual(
    lockDependencyContent(lock, 'plugins/pi-desk-usage'),
    lockDependencyContent(changed, 'plugins/pi-desk-usage')
  )
  assert.deepEqual(lockDependencyContent(lock, 'plugins/missing'), null)
})

async function repository(context) {
  const parent = resolve('temp/tests/release-dev/targets')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'repository-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${join(root, 'no-hooks')}`, ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
  git('init', '-b', 'dev')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  async function save(path, content) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  await save('package.json', JSON.stringify({ name: '@jetcrab/pi-desk', version: '1.0.0' }))
  await save('apps/desktop/web/control.tsx', 'export const title = "Pi Desk"')
  await save(
    'apps/desktop/package.json',
    JSON.stringify({
      name: '@jetcrab/pi-desk-desktop',
      version: '1.0.0',
      scripts: { build: 'build' }
    })
  )
  await save('apps/android/app/build.gradle.kts', 'versionName = "1.0.0"\nversionCode = 1\n')
  await save('apps/tunnel/common/src/lib.rs', 'pub fn ready() -> bool { true }')
  await save('apps/tunnel/server/src/main.rs', 'fn main() {}')
  await save('apps/ios/project.yml', 'name: Pi Desk\n')
  const commit = () => {
    git('add', '.')
    git('commit', '-m', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  return { root, save, commit, before: commit() }
}

test('桌面文档和测试变化需要检查但不编译安装包', async (context) => {
  const repo = await repository(context)
  await repo.save('apps/desktop/README.md', 'Changed')
  await repo.save('apps/desktop/src-tauri/src/runtime_tests.rs', '#[test] fn fixture() {}')
  const result = await selectDevTargets(repo.root, { before: repo.before, head: repo.commit() })
  assert.equal(result.windows, false)
  assert.equal(result.macos, false)
  assert.equal(result.desktop_checks, true)
  assert.equal(result.android, false)
})

test('共享隧道变化影响桌面和服务，不影响Android或iOS', async (context) => {
  const repo = await repository(context)
  await repo.save('apps/tunnel/common/src/lib.rs', 'pub fn ready() -> bool { false }')
  const result = await selectDevTargets(repo.root, { before: repo.before, head: repo.commit() })
  assert.equal(result.windows, true)
  assert.equal(result.macos, true)
  assert.equal(result.tunnel, true)
  assert.equal(result.android, false)
  assert.equal(result.ios, false)
})

test('仅检查命令变化不重复编译桌面，生产桌面变化才构建', async (context) => {
  const repo = await repository(context)
  await repo.save('.github/scripts/check-desktop-tunnel.mjs', 'check()')
  const result = await selectDevTargets(repo.root, { before: repo.before, head: repo.commit() })
  assert.equal(result.windows, false)
  assert.equal(result.desktop_checks, true)
  await repo.save('apps/desktop/web/control.tsx', 'export const title = "Pi Desk v1.1.0"')
  const changed = await selectDevTargets(repo.root, { before: repo.before, head: repo.commit() })
  assert.equal(changed.windows, true)
  assert.equal(changed.macos, true)
})

test('仅客户端版本变化仍需要生成对应新版本的安装包', async (context) => {
  const repo = await repository(context)
  await repo.save(
    'apps/desktop/package.json',
    JSON.stringify({
      name: '@jetcrab/pi-desk-desktop',
      version: '1.1.0',
      scripts: { build: 'build' }
    })
  )
  const result = await selectDevTargets(repo.root, { before: repo.before, head: repo.commit() })
  assert.equal(result.windows, true)
  assert.equal(result.macos, true)
})

test('dev只保留统一入口，内部复用不取消连续批次', async () => {
  const read = (name) =>
    readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
  const dev = await read('release-dev')
  assert.match(dev, /branches: \[dev\]/)
  assert.match(dev, /cancel-in-progress: false/)
  assert.match(dev, /source_sha: \$\{\{ github.sha \}\}/)
  const checks = await read('check')
  assert.doesNotMatch(checks.split('\npermissions:')[0], /\n  push:/)
  assert.match(checks, /pull_request:/)
  const npm = await read('release-npm')
  assert.doesNotMatch(npm.split('\npermissions:')[0], /\n  push:|\n  workflow_dispatch:/)
  assert.match(npm, /matrix:\n\s+os: \[ubuntu-latest, windows-latest\]/)
  await assert.rejects(read('build-dev-clients'), { code: 'ENOENT' })
  await assert.rejects(read('release-clients'), { code: 'ENOENT' })
})
