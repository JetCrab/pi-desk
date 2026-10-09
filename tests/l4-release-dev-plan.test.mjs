import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  developmentUnits,
  nativeCheckTargets,
  prepareDevBatch
} from '../.github/scripts/release-dev.mjs'
import { hasNpmArtifacts } from '../.github/scripts/reuse-npm-artifacts.mjs'

function githubFixture() {
  const files = new Map()
  let seq = 0
  return {
    releases: async () => [],
    request: async (path, options = {}) => {
      if (path === '/git/ref/heads/release-data') return { object: { sha: 'a'.repeat(40) } }
      assert.ok(path.startsWith('/contents/'), path)
      const key = path.split('?')[0]
      if (options.method === 'PUT') {
        assert.equal(options.body.sha, files.get(key)?.sha)
        const value = { encoding: 'base64', content: options.body.content, sha: String(++seq) }
        files.set(key, value)
        return { content: value }
      }
      return files.get(key) ?? null
    }
  }
}

test('同一失败批次重跑固定开发版本，不依赖新的Registry编号', async (t) => {
  const parent = resolve('temp/tests/release-dev-plan/fixed-versions')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'repo-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${root}/no-hooks`, ...args],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' }
    ).trim()
  git('init', '-b', 'dev')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  await mkdir(join(root, 'plugins'))
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@jetcrab/pi-desk',
      version: '1.0.8',
      publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' }
    })
  )
  git('add', '.')
  git('commit', '-m', 'fix: 准备1.0.8')
  const source = git('rev-parse', 'HEAD')
  const github = githubFixture()
  const first = await prepareDevBatch(root, {
    github,
    source,
    runId: '42',
    readPublished: async () => ['1.0.7', '1.0.7-dev.1']
  })
  assert.deepEqual(first.batch.selected, ['pi-desk'])
  assert.equal(first.batch.npmVersions['pi-desk'], '1.0.8-dev')
  git('restore', 'package.json')
  const retried = await prepareDevBatch(root, {
    github,
    source,
    runId: '42',
    readPublished: async () => {
      throw Error('重试不应重新分配版本')
    }
  })
  assert.deepEqual(retried.batch, first.batch)
  assert.equal(retried.prepared.packages[0].version, '1.0.8-dev')
})

test('重跑只有同批完整且未过期的制品才能复用', () => {
  const packages = { name: 'npm-packages-42', expired: false }
  const smoke = { name: 'npm-command-smoke-42', expired: false }
  assert.equal(hasNpmArtifacts([packages, smoke], '42', ['pi-desk']), true)
  assert.equal(hasNpmArtifacts([packages], '42', ['pi-desk']), false)
  assert.equal(hasNpmArtifacts([packages, { ...smoke, expired: true }], '42', ['pi-desk']), false)
  assert.equal(hasNpmArtifacts([packages, smoke], '43', ['pi-desk']), false)
})

test('桌面三平台共用产品版本但分别记录成功，检查与打包选择分开', () => {
  assert.deepEqual(developmentUnits({ desktop: '1.1.2', website: '1.0.1', 'pi-desk': '1.0.8' }), {
    windows: '1.1.2',
    macos: '1.1.2',
    linux: '1.1.2',
    'pi-desk': '1.0.8'
  })
  assert.deepEqual(
    nativeCheckTargets(['apps/desktop/src-tauri/src/runtime_tests.rs', 'apps/android/README.md']),
    { desktop_checks: true, android_checks: false, tunnel_checks: false }
  )
})
