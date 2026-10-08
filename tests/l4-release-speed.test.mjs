import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { selectCiChecks } from '../.github/scripts/select-ci-checks.mjs'
import { transferRustCache } from '../.github/scripts/rust-cache.mjs'
import { npmValidationMode } from '../.github/scripts/release-npm.mjs'

test('dev只检查相关组件，README不触发构建类检查，main保留完整检查', () => {
  assert.deepEqual(selectCiChecks(['README.md'], false), {
    full: false,
    web: false,
    website: false,
    agent: false,
    automation: false
  })
  const website = selectCiChecks(['apps/website/src/app/page.tsx'], false)
  assert.equal(website.website, true)
  assert.equal(website.web, false)
  assert.equal(website.agent, false)
  const plugin = selectCiChecks(['plugins/pi-desk-subagent/src/index.ts'], false)
  assert.equal(plugin.web, true)
  assert.equal(plugin.website, false)
  assert.ok(Object.values(selectCiChecks([], true)).every(Boolean))
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

test('客户端dev保留产物和核心运行检查，完整回归只在main', async () => {
  const windows = await readFile(
    new URL('../.github/workflows/build-clients.yml', import.meta.url),
    'utf8'
  )
  assert.match(windows, /BUILD_PROFILE:.*'debug'.*'release'/)
  assert.match(windows, /name: 正式发布桌面 Rust 回归\n\s+if: github.ref == 'refs\/heads\/main'/)
  assert.match(
    windows,
    /name: 隔离验证覆盖安装与正常退出\n\s+if: github.ref == 'refs\/heads\/main'/
  )
  assert.match(windows, /check-desktop-tunnel\.mjs/)
  assert.match(
    windows,
    /if \[\[ "\$GITHUB_REF" == refs\/heads\/main \]\]; then test_tasks=\(:app:testDebugUnitTest\)/
  )
  const main = await readFile(
    new URL('../.github/workflows/release-main.yml', import.meta.url),
    'utf8'
  )
  assert.match(main, /uses: \.\/.github\/workflows\/check.yml/)
  assert.match(main, /needs: \[prepare, checks, notes, npm-build, windows, macos, android\]/)
})
