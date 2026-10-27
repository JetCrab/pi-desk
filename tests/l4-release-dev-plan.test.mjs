import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  developmentUnits,
  nativeCheckTargets,
  prepareDevBatch
} from '../.github/scripts/release-dev.mjs'
import { hasNpmArtifacts } from '../.github/scripts/reuse-npm-artifacts.mjs'

function githubFixture(record = null) {
  const files = new Map()
  if (record) {
    files.set(`/contents/releases/${record.tag}.json`, {
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(record)).toString('base64'),
      sha: 'stable'
    })
  }
  let seq = 0
  return {
    releases: async () =>
      record ? [{ tag_name: record.tag, draft: false, prerelease: false }] : [],
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

async function repository(t) {
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
  return { root, git, source }
}

test('同一失败批次重跑固定开发版本，不依赖新的Registry编号', async (t) => {
  const { root, git, source } = await repository(t)
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
    readPublished: async () => ['1.0.7', '1.0.8-dev', '1.0.9-dev']
  })
  assert.deepEqual(retried.batch, first.batch)
  assert.equal(retried.prepared.packages[0].version, '1.0.8-dev')
})

test('手动仅构建可重编当前稳定基础号，自动选择仍跳过且目标范围有效', async (t) => {
  const { root, git, source } = await repository(t)
  const github = githubFixture({
    tag: 'v1.0.8',
    date: 1,
    source: { base: null, head: source },
    packages: [{ name: '@jetcrab/pi-desk', version: '1.0.8' }],
    clients: [],
    changes: { breaking: [], features: [], added: [], changed: [], fixed: [], removed: [] }
  })
  const readPublished = async () => {
    throw Error('仅构建不分配发布版本，也不读取Registry')
  }
  const automatic = await prepareDevBatch(root, { github, source, runId: '43', readPublished })
  assert.deepEqual(automatic.batch.selected, [])
  const manual = await prepareDevBatch(root, {
    github,
    source,
    runId: '44',
    rebuildOnly: true,
    readPublished
  })
  assert.deepEqual(manual.batch.selected, ['pi-desk'])
  assert.equal(manual.batch.npmVersions['pi-desk'], '1.0.8-dev')
  git('restore', 'package.json')
  const retried = await prepareDevBatch(root, {
    github,
    source,
    runId: '44',
    rebuildOnly: true,
    readPublished
  })
  assert.deepEqual(retried.batch, manual.batch)
  git('restore', 'package.json')
  const windows = await prepareDevBatch(root, {
    github,
    source,
    runId: '45',
    target: 'windows',
    rebuildOnly: true,
    readPublished
  })
  assert.deepEqual(windows.batch.selected, [])
})

test('开发发布在保存批次前检查稳定latest，不为新包执行构建准备', async (t) => {
  const { root, source } = await repository(t)
  const github = githubFixture()
  const original = await readFile(join(root, 'package.json'), 'utf8')
  const requests = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
  await assert.rejects(
    prepareDevBatch(root, { github, source, runId: '46' }),
    /尚无稳定 latest.*首次正式发布/
  )
  assert.equal(requests.mock.calls.length, 1)
  assert.equal(await github.request('/contents/dev/batches/46.json?ref=release-data'), null)
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), original)
  const manual = await prepareDevBatch(root, { github, source, runId: '49', rebuildOnly: true })
  assert.equal(manual.batch.npmVersions['pi-desk'], '1.0.8-dev')
  assert.equal(requests.mock.calls.length, 1, '仅构建不查询Registry首次发布条件')
})

test('开发发布前置检查拒绝预发布latest，并复用同次查询选择版本', async (t) => {
  const { root, source } = await repository(t)
  const github = githubFixture()
  let latest = '1.0.7-dev'
  const requests = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      name: '@jetcrab/pi-desk',
      versions: { '1.0.7': {}, '1.0.8-dev': {} },
      'dist-tags': { latest }
    })
  )
  await assert.rejects(prepareDevBatch(root, { github, source, runId: '47' }), /尚无稳定 latest/)
  latest = '1.0.7'
  const prepared = await prepareDevBatch(root, { github, source, runId: '47' })
  assert.equal(prepared.batch.npmVersions['pi-desk'], '1.0.8-dev')
  assert.equal(requests.mock.calls.length, 2, '每次准备只读取一次包元数据')
})

test('正式发布已取代固定dev批次时明确停止，不覆盖计划或回退标签', async (t) => {
  const { root, git, source } = await repository(t)
  const github = githubFixture()
  const first = await prepareDevBatch(root, {
    github,
    source,
    runId: '48',
    readPublished: async () => ['1.0.7']
  })
  git('restore', 'package.json')
  const original = await readFile(join(root, 'package.json'), 'utf8')
  const stable = githubFixture({
    tag: 'v1.0.8',
    date: 1,
    source: { base: null, head: source },
    packages: [{ name: '@jetcrab/pi-desk', version: '1.0.8' }],
    clients: [],
    changes: { breaking: [], features: [], added: [], changed: [], fixed: [], removed: [] }
  })
  github.releases = stable.releases
  const request = github.request
  github.request = (path, options) =>
    path.startsWith('/contents/releases/') ? stable.request(path, options) : request(path, options)
  await assert.rejects(
    prepareDevBatch(root, {
      github,
      source,
      runId: '48',
      readPublished: async () => {
        assert.fail('已被取代的批次不再进入Registry预检')
      }
    }),
    /已被正式版 1\.0\.8 取代.*不回退 dev 标签/
  )
  const saved = await request('/contents/dev/batches/48.json?ref=release-data')
  assert.deepEqual(JSON.parse(Buffer.from(saved.content, 'base64').toString()), first.batch)
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), original)
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
