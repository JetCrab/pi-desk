import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  prepareDevelopmentVersions,
  nextDevelopmentVersion
} from '../.github/scripts/release-version-model.mjs'
import {
  createReleasePlan,
  latestSuccessfulRelease,
  nextReleaseTag
} from '../.github/scripts/release-plan.mjs'
import { loadReleaseRecord, saveReleaseRecord } from '../.github/scripts/release-metadata.mjs'
import {
  assembleBatch,
  publishBatch,
  prepareBatch,
  prepareResumeBatch,
  prepareWebsiteBatch,
  cleanupBatch
} from '../.github/scripts/release-main.mjs'
import { sha256 } from '../.github/scripts/release-github.mjs'
import {
  validateRecord,
  changeSections,
  clientPlatforms
} from '../.github/scripts/release-record.mjs'
import { packageClient } from '../.github/scripts/pack-client.mjs'
import { readPublishedVersions } from '../.github/scripts/prepare-dev-release.mjs'
import { prepareCommitVersions, validateVersions } from '../.github/scripts/commit-versions.mjs'
import { readWorkflow } from './fixtures/l4-workflow-test-runtime.mjs'

async function fixture(t) {
  const parent = resolve('temp/tests/release-main/batch-regression')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'repository-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', `core.hooksPath=${root}/no-hooks`, '-c', 'commit.gpgSign=false', ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  const save = async (path, value) => {
    await mkdir(resolve(root, path, '..'), { recursive: true })
    await writeFile(
      join(root, path),
      typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'
    )
  }
  const pkg = (name, version, extras = {}) =>
    save(name === 'pi-desk' ? 'package.json' : `plugins/${name}/package.json`, {
      name: `@jetcrab/${name}`,
      version,
      publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' },
      ...extras
    })
  await pkg('pi-desk', '1.0.0')
  await pkg('pi-desk-sdk', '1.0.0')
  await save('apps/desktop/package.json', { version: '1.0.0' })
  await save('apps/android/app/build.gradle.kts', 'versionName = "1.0.0"\nversionCode = 1\n')
  await save(
    'apps/tunnel/server/Cargo.toml',
    '[package]\nname="pi-desk-tunnel-server"\nversion="1.0.0"\n'
  )
  const commit = () => {
    git('add', '.')
    git('commit', '-m', 'fixture change')
    return git('rev-parse', 'HEAD')
  }
  return { root, git, save, pkg, commit, head: commit() }
}

test('开发锁文件的传递依赖变化只准备实际使用它的发布单元', async (context) => {
  const repo = await fixture(context)
  await repo.pkg('pi-desk', '1.0.0', { dependencies: { 'host-lib': '^1.0.0' } })
  await repo.pkg('pi-desk-usage', '1.0.0', { dependencies: { 'plugin-lib': '^1.0.0' } })
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
  await repo.save('pnpm-lock.yaml', lock)
  const before = repo.commit()
  await repo.save('pnpm-lock.yaml', lock.replace('integrity: nested', 'integrity: new-nested'))
  await repo.pkg('pi-desk-usage', '1.0.1', { dependencies: { 'plugin-lib': '^1.0.0' } })
  repo.commit()
  const result = await prepareDevelopmentVersions(repo.root, {
    before,
    readVersions: async () => []
  })
  assert.deepEqual(result.selected, ['pi-desk-usage'])
})

function completed(record) {
  return {
    ...record,
    clients: ['windows', 'macos', 'linux', 'android'].map((platform) => ({
      platform,
      version: '1.0.0',
      file: {
        windows: 'PiDesk-Windows-x86-Setup.exe',
        macos: 'PiDesk-macOS-universal.dmg',
        linux: 'PiDesk-Linux-x86_64.AppImage',
        android: 'PiDesk-Android.apk'
      }[platform],
      sha256: sha256(Buffer.from(platform))
    }))
  }
}

function githubFixture(releases) {
  const calls = []
  const records = new Map()
  let branch = false
  let pending
  const tags = new Map()
  return {
    calls,
    records,
    releases: async () => releases,
    asset: async (release, name) => {
      assert.ok(release.files.has(name), name)
      return release.files.get(name)
    },
    putAsset: async (release, name, data) => {
      const old = release.files.get(name)
      if (old) assert.equal(sha256(old), sha256(data), '不得覆盖已有附件')
      else {
        release.files.set(name, data)
        release.assets.push({ id: release.assets.length + 1, name })
      }
    },
    request: async (path, options = {}) => {
      calls.push({ path, ...options })
      if (path.startsWith('/actions/workflows/')) return { workflow_runs: [] }
      if (path.startsWith('/actions/runs/') && path.includes('/jobs?')) return { jobs: [] }
      if (path.startsWith('/actions/runs/')) return { artifacts: [] }
      if (path === '/releases' && options.method === 'POST') {
        const release = {
          ...draft({ tag: options.body.tag_name, source: { head: options.body.target_commitish } }),
          id: releases.reduce((id, item) => Math.max(id, item.id), 10) + 1
        }
        releases.push(release)
        return release
      }
      if (/^\/releases\/\d+$/.test(path)) {
        const release = releases.find((item) => item.id === Number(path.split('/').at(-1)))
        if (options.method === 'DELETE') releases.splice(releases.indexOf(release), 1)
        else if (options.method === 'PATCH') Object.assign(release, options.body)
        return release ?? null
      }
      if (path.startsWith('/git/ref/tags/')) {
        const tag = path.slice('/git/ref/tags/'.length)
        return tags.has(tag) ? { object: { sha: tags.get(tag) } } : null
      }
      if (path.startsWith('/commits/')) return { sha: tags.get(path.slice('/commits/'.length)) }
      if (path === '/git/refs' && options.body.ref.startsWith('refs/tags/'))
        tags.set(options.body.ref.slice('refs/tags/'.length), options.body.sha)
      if (path === '/git/ref/heads/release-data')
        return branch ? { object: { sha: 'data-head' } } : null
      if (path.startsWith('/contents/releases/')) {
        const tag = path.split('/').at(-1).split('.json')[0]
        if (options.method === 'PUT') {
          records.set(tag, JSON.parse(Buffer.from(options.body.content, 'base64')))
          return { content: { sha: 'file' } }
        }
        return records.has(tag)
          ? {
              encoding: 'base64',
              content: Buffer.from(JSON.stringify(records.get(tag))).toString('base64')
            }
          : null
      }
      if (path === '/git/trees') {
        pending = JSON.parse(options.body.tree[0].content)
        return { sha: 'tree' }
      }
      if (path === '/git/commits') return { sha: 'data-commit' }
      if (path === '/git/refs' && options.body.ref === 'refs/heads/release-data') {
        branch = true
        records.set(pending.tag, pending)
      }
      if (path.startsWith('/releases/assets/') && options.method === 'DELETE') {
        const id = Number(path.split('/').at(-1))
        for (const release of releases) {
          const asset = release.assets.find((item) => item.id === id)
          if (asset) release.files.delete(asset.name)
          release.assets = release.assets.filter((item) => item.id !== id)
        }
      }
      return null
    }
  }
}

function draft(record) {
  return {
    id: 10,
    draft: true,
    prerelease: false,
    tag_name: record.tag,
    target_commitish: record.source.head,
    assets: [],
    files: new Map()
  }
}

test('历史三平台记录可读取，下一批补建Linux且不重建未变化客户端', async (t) => {
  const repo = await fixture(t)
  const previous = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  previous.clients = previous.clients.filter((client) => client.platform !== 'linux')
  validateRecord(previous)
  await repo.save('README.md', '支持 Linux 下载')
  const plan = createReleasePlan(repo.root, { head: repo.commit(), previous, date: 2 })
  assert.deepEqual(
    plan.clients.filter((client) => client.build).map((client) => client.platform),
    ['linux']
  )
  assert.equal(plan.clients.find((client) => client.platform === 'linux').version, '1.0.0')
})

test('正式源码清单不得仍引用自有SDK开发版本', async (t) => {
  const repo = await fixture(t)
  await repo.pkg('pi-desk', '1.2.0', {
    dependencies: { '@jetcrab/pi-desk-sdk': '^1.1.0-dev.4', example: '2.0.0-dev.9' }
  })
  await repo.pkg('pi-desk-sdk', '1.1.0')
  await assert.rejects(validateVersions(repo.root, { base: null, head: repo.commit() }), /未同步/)
})

test('dev仅给已提交的新版本附加固定后缀，纯文档推送不发npm包', async (t) => {
  const repo = await fixture(t)
  await repo.save('src/main.ts', 'export const value = 1')
  await repo.pkg('pi-desk', '1.0.1')
  const head = repo.commit()
  const result = await prepareDevelopmentVersions(repo.root, {
    before: repo.head,
    readVersions: async () => ['1.0.0']
  })
  assert.deepEqual(result.selected, ['pi-desk'])
  assert.equal(
    JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8')).version,
    '1.0.1-dev'
  )
  repo.git('checkout', head, '--', 'package.json')
  await repo.save('README.md', '仅文档')
  repo.commit()
  assert.deepEqual(
    (
      await prepareDevelopmentVersions(repo.root, {
        before: head,
        readVersions: async () => {
          throw Error('文档改动不应查询版本')
        }
      })
    ).selected,
    []
  )
})

test('dev基础版本落后正式版本时明确拒绝，不在CI静默加号', async (t) => {
  const repo = await fixture(t)
  await repo.pkg('pi-desk', '1.2.0')
  const stableBase = repo.commit()
  repo.git('checkout', '--detach', repo.head)
  await repo.save('src/main.ts', 'export const changed = true')
  repo.commit()
  await assert.rejects(
    prepareDevelopmentVersions(repo.root, {
      before: repo.head,
      selected: ['pi-desk'],
      readVersions: async () => ['1.0.1-dev.9001'],
      stableBase
    }),
    /版本|正式/
  )
  assert.equal(JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8')).version, '1.0.0')
})

test('SDK和消费者使用固定开发后缀，并同步真实依赖范围', async (t) => {
  const repo = await fixture(t)
  await repo.pkg('pi-desk', '1.0.0', { dependencies: { '@jetcrab/pi-desk-sdk': '>=1.0.0 <2.0.0' } })
  await repo.pkg('pi-desk-usage', '1.0.0')
  const before = repo.commit()
  await repo.save('plugins/pi-desk-sdk/src/feature.ts', 'export const ready = true')
  await repo.pkg('pi-desk-sdk', '1.0.1')
  await repo.pkg('pi-desk', '1.0.1', { dependencies: { '@jetcrab/pi-desk-sdk': '>=1.0.1 <2.0.0' } })
  repo.commit()
  const queries = []
  const result = await prepareDevelopmentVersions(repo.root, {
    before,
    readVersions: async (name) => {
      queries.push(name)
      if (name === '@jetcrab/pi-desk-sdk') return ['1.0.0', '1.0.0-dev.7']
      assert.equal(name, '@jetcrab/pi-desk')
      return ['1.0.0', '1.0.0-dev.9001']
    }
  })
  assert.deepEqual(result.selected, ['pi-desk-sdk', 'pi-desk'])
  assert.deepEqual(queries.sort(), ['@jetcrab/pi-desk', '@jetcrab/pi-desk-sdk'])
  assert.equal(
    result.packages.find((item) => item.name === '@jetcrab/pi-desk-sdk').version,
    '1.0.1-dev'
  )
  assert.equal(
    result.packages.find((item) => item.name === '@jetcrab/pi-desk').version,
    '1.0.1-dev'
  )
  const main = JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8'))
  assert.equal(main.dependencies['@jetcrab/pi-desk-sdk'], '>=1.0.1-dev <2.0.0')
  assert.equal(
    result.packages.find((item) => item.name === '@jetcrab/pi-desk-usage').version,
    '1.0.0'
  )
})

test('开发版本查询失败时不写入任何清单', async (t) => {
  const repo = await fixture(t)
  await repo.save('src/feature.ts', 'export const ready = true')
  await repo.pkg('pi-desk', '1.0.1')
  repo.commit()
  const before = await readFile(join(repo.root, 'package.json'), 'utf8')
  await assert.rejects(
    prepareDevelopmentVersions(repo.root, {
      before: repo.head,
      readVersions: async () => {
        throw Error('registry unavailable')
      }
    }),
    /registry unavailable/
  )
  assert.equal(await readFile(join(repo.root, 'package.json'), 'utf8'), before)
})

test('官方Registry版本查询带去缓存参数，不以dev标签代替完整历史', async () => {
  const versions = await readPublishedVersions('@jetcrab/pi-desk', async (url, options) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://registry.npmjs.org')
    assert.equal(decodeURIComponent(parsed.pathname), '/@jetcrab/pi-desk')
    assert.ok(parsed.searchParams.has('devVersions'))
    assert.equal(options.headers['cache-control'], 'no-cache')
    assert.ok(options.signal instanceof AbortSignal)
    return new Response(
      JSON.stringify({
        'dist-tags': { dev: '1.0.1-dev.1' },
        versions: { '1.0.1-dev.1': {}, '1.0.1-dev.7': {} }
      })
    )
  })
  assert.deepEqual(versions, ['1.0.1-dev.1', '1.0.1-dev.7'])
  assert.equal(nextDevelopmentVersion('1.0.2', versions), '1.0.2-dev')
  assert.deepEqual(
    await readPublishedVersions('@jetcrab/pi-desk', async () => new Response('', { status: 404 })),
    []
  )
  await assert.rejects(
    readPublishedVersions('@jetcrab/pi-desk', async () => new Response('', { status: 503 })),
    /HTTP 503/
  )
  await assert.rejects(
    readPublishedVersions('@jetcrab/pi-desk', async () => new Response('{}')),
    /版本清单无效/
  )
  await assert.rejects(
    readPublishedVersions(
      '@jetcrab/pi-desk',
      async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1))
    ),
    /读取上限/
  )
})

test('开发发布按原始制品恢复，不依赖同一次Actions重试编号', async () => {
  const workflow = await readWorkflow('release-npm')
  assert.ok(
    workflow.jobs.build.steps.some((step) =>
      /release-dev-reuse\.mjs\s+restore\b/.test(step.run ?? '')
    )
  )
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.env?.RELEASE_RESUME, undefined)
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/download-artifact@'))
        assert.ok(!step.with.name.includes('github.run_attempt'))
    }
  }
})

for (const desktopSource of [
  'apps/desktop/web/main.ts',
  'src/client/l4_foundation/desktop-window/l4-desktop-titlebar.tsx'
]) {
  test(`桌面四份版本和Android构建号在提交准备时自动保持一致：${desktopSource}`, async (t) => {
    const repo = await fixture(t)
    repo.git('switch', '-c', 'dev')
    await repo.save(
      'apps/desktop/src-tauri/tauri.conf.json',
      '{\n  "version": "1.0.0",\n  "bundle": { "targets": ["nsis"] }\n}\n'
    )
    await repo.save(
      'apps/desktop/src-tauri/Cargo.toml',
      '[package]\nname="pi-desk-desktop"\nversion="1.0.0"\n'
    )
    await repo.save(
      'apps/desktop/src-tauri/Cargo.lock',
      '[[package]]\nname="pi-desk-desktop"\nversion="1.0.0"\n'
    )
    const base = repo.commit()
    await repo.save(desktopSource, 'export const feature=true')
    await repo.save('apps/android/app/src/main.kt', 'fun feature() = true')
    repo.git('add', '.')
    await prepareCommitVersions(repo.root, { base })
    assert.equal(
      JSON.parse(await readFile(join(repo.root, 'apps/desktop/package.json'), 'utf8')).version,
      '1.0.1'
    )
    assert.equal(
      JSON.parse(await readFile(join(repo.root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'))
        .version,
      '1.0.1'
    )
    assert.match(
      await readFile(join(repo.root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
      /"targets": \["nsis"\]/
    )
    for (const file of ['Cargo.toml', 'Cargo.lock'])
      assert.match(
        await readFile(join(repo.root, 'apps/desktop/src-tauri', file), 'utf8'),
        /version="1\.0\.1"/
      )
    const android = await readFile(join(repo.root, 'apps/android/app/build.gradle.kts'), 'utf8')
    assert.match(android, /versionName = "1\.0\.1"/)
    assert.match(android, /versionCode = 2/)
  })
}

test('版本校验失败不得留下部分修改清单', async (t) => {
  const repo = await fixture(t)
  repo.git('switch', '-c', 'dev')
  await repo.pkg('pi-desk', '1.1.0')
  await repo.pkg('pi-desk-sdk', 'not-a-version')
  repo.git('add', '.')
  const before = await readFile(join(repo.root, 'package.json'), 'utf8')
  await assert.rejects(prepareCommitVersions(repo.root))
  assert.equal(await readFile(join(repo.root, 'package.json'), 'utf8'), before)
})

test('首次发布选择全部，后续按成功批次比较并复用未变化桌面包', async (t) => {
  const repo = await fixture(t)
  const first = createReleasePlan(repo.root, { head: repo.head, date: 1 })
  assert.deepEqual(first.npm, ['pi-desk-sdk', 'pi-desk'])
  assert.ok(first.clients.every((item) => item.build))
  const previous = completed(first.record)
  await repo.pkg('pi-desk', '1.0.1')
  await repo.save('src/feature.ts', 'export const feature = 1\n')
  repo.commit()
  await repo.save('README.md', '# Release fixture')
  const next = createReleasePlan(repo.root, { head: repo.commit(), previous, date: 2 })
  assert.deepEqual(next.npm, ['pi-desk'])
  assert.equal(next.record.source.base, repo.head)
  assert.ok(next.clients.every((item) => !item.build && item.reuse.tag === previous.tag))
  assert.equal(next.tunnel, false)
})

test('Docker运行配方属于主包版本，文档不单独升版', async (t) => {
  const repo = await fixture(t)
  repo.git('switch', '-c', 'dev')
  await repo.save('apps/docker/Dockerfile', 'FROM node:22-bookworm-slim\n')
  const before = repo.commit()
  const previous = completed(createReleasePlan(repo.root, { head: before }).record)
  await repo.save('apps/docker/Dockerfile', 'FROM node:22-bookworm-slim\nENV PORT=6233\n')
  repo.git('add', '.')
  await prepareCommitVersions(repo.root)
  const head = repo.commit()
  const development = await prepareDevelopmentVersions(repo.root, {
    before,
    readVersions: async () => []
  })
  assert.deepEqual(development.selected, ['pi-desk'])
  repo.git('restore', 'package.json')
  const plan = createReleasePlan(repo.root, { head, previous })
  assert.deepEqual(plan.npm, ['pi-desk'])
  assert.equal(
    plan.record.packages.find((item) => item.name === '@jetcrab/pi-desk').version,
    '1.0.1'
  )
  const released = completed(plan.record)
  await repo.save('apps/website/content/docs/docker.md', 'Docker使用说明')
  const docs = createReleasePlan(repo.root, { head: repo.commit(), previous: released })
  assert.deepEqual(docs.npm, [])
})

for (const desktopSource of [
  'apps/desktop/web/main.ts',
  'src/client/l4_foundation/desktop-window/l4-desktop-titlebar.tsx'
]) {
  test(`客户端代码变更未升版和历史回退均被阻止：${desktopSource}`, async (t) => {
    const repo = await fixture(t)
    const previous = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
    await repo.pkg('pi-desk', '1.0.1')
    await repo.save(desktopSource, 'export const changed = true')
    assert.throws(
      () => createReleasePlan(repo.root, { head: repo.commit(), previous }),
      /(?:windows|macos|linux) 运行内容变化但版本未递增/
    )
    await repo.save('apps/desktop/package.json', { version: '0.9.0' })
    assert.throws(() => createReleasePlan(repo.root, { head: repo.commit(), previous }), /递增/)
  })
}

test('草稿、开发版和平台Release不能推进正式变更基线', () => {
  const valid = {
    tag_name: 'v1.0.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T00:00:00Z'
  }
  assert.equal(
    latestSuccessfulRelease([
      valid,
      { ...valid, tag_name: 'desktop-v9.0.0', published_at: '2026-10-04T00:00:00Z' },
      { ...valid, draft: true, published_at: '2026-10-05T00:00:00Z' },
      { ...valid, prerelease: true, published_at: '2026-10-06T00:00:00Z' }
    ]),
    valid
  )
})

test('复用安装包需验证实际字节摘要，最终记录包含四个平台', async (t) => {
  const repo = await fixture(t)
  const oldRecord = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const old = { ...draft(oldRecord), draft: false }
  for (const item of oldRecord.clients) old.files.set(item.file, Buffer.from(item.platform))
  await repo.save('README.md', 'next release')
  const plan = createReleasePlan(repo.root, { head: repo.commit(), previous: oldRecord, date: 2 })
  const github = githubFixture([old])
  const input = {
    github,
    plan,
    directory: repo.root,
    output: join(repo.root, 'release'),
    changes: plan.record.changes
  }
  const record = await assembleBatch(input)
  assert.equal(record.clients.length, 4)
  for (const item of record.clients)
    assert.equal(sha256(await readFile(join(repo.root, 'release', item.file))), item.sha256)
  assert.ok(
    github.calls.every((call) => !call.method),
    '汇总阶段不能写入GitHub状态'
  )
  assert.ok(JSON.parse(await readFile(join(repo.root, 'release/release.json'))))
  old.files.set(oldRecord.clients[0].file, Buffer.from('tampered'))
  await assert.rejects(assembleBatch(input), /摘要/)
})

test('正式准备只保存固定计划，失败重跑不预建Release或推进成功基线', async (t) => {
  const repo = await fixture(t)
  await repo.pkg('pi-desk', '1.1.0')
  const source = repo.commit()
  const remote = `${repo.root}-remote.git`
  t.after(() => rm(remote, { recursive: true, force: true }))
  repo.git('clone', '--bare', repo.root, remote)
  repo.git('remote', 'add', 'origin', remote)
  repo.git('fetch', 'origin')
  const releases = []
  const github = githubFixture(releases)
  const request = github.request
  let storedPlan
  github.request = async (path, options) => {
    if (path.startsWith('/actions/runs/11/artifacts'))
      return { artifacts: storedPlan ? [{ name: 'release-plan-11', expired: false }] : [] }
    return request(path, options)
  }
  const download = async (_run, _name, directory) => {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'plan.json'), JSON.stringify(storedPlan))
  }
  const output = join(repo.root, 'temp/plan')
  const first = await prepareBatch(repo.root, {
    github,
    source,
    output,
    runId: '11',
    download
  })
  storedPlan = first.plan
  assert.equal(first.outputs.sha, source)
  assert.equal(first.outputs.docker, true)
  assert.equal(repo.git('rev-parse', 'origin/main'), first.outputs.sha)
  assert.equal(first.plan.record.source.base, null)
  assert.equal(first.outputs.check_base, '0'.repeat(40))
  assert.equal(
    first.plan.record.packages.find((item) => item.name === '@jetcrab/pi-desk').version,
    '1.1.0'
  )
  const again = await prepareBatch(repo.root, {
    github,
    source,
    output,
    runId: '11',
    download
  })
  assert.deepEqual(again.plan, first.plan)
  assert.equal(again.outputs.sha, first.outputs.sha)
  assert.equal(releases.length, 0)
  assert.ok(
    github.calls.every((call) => !call.method),
    '准备阶段只能读取GitHub状态'
  )
  const previous = completed(first.plan.record)
  await saveReleaseRecord(github, previous)
  releases.push({ ...draft(previous), draft: false, published_at: '2026-10-01T00:00:00Z' })
  await repo.pkg('pi-desk', '1.1.1')
  await repo.save('src/feature.ts', 'export const feature = true')
  storedPlan = undefined
  const next = await prepareBatch(repo.root, {
    github,
    source: repo.commit(),
    output,
    runId: '11',
    download
  })
  storedPlan = next.plan
  assert.equal(next.outputs.check_base, source)
  const retry = await prepareBatch(repo.root, {
    github,
    source: next.outputs.sha,
    output,
    runId: '11',
    download
  })
  assert.equal(retry.outputs.check_base, source, '重试继续原计划的成功基线')
  assert.deepEqual(retry.plan, next.plan)
})

test('新SHA调度与未完成批次使用同版本时，在准备写入前提示resume_tag', async (t) => {
  const repo = await fixture(t)
  const plan = createReleasePlan(repo.root, { head: repo.head, date: 1 })
  await repo.save('.github/workflows/release-main.yml', 'fixed scheduling')
  const source = repo.commit()
  for (const origin of ['draft', 'actions']) {
    const release = draft(plan.record)
    const github = githubFixture(origin === 'draft' ? [release] : [])
    if (origin === 'draft')
      await github.putAsset(release, 'plan.json', Buffer.from(JSON.stringify(plan)))
    else {
      const request = github.request
      github.request = async (path, options) => {
        if (path.startsWith('/actions/workflows/') && !path.includes('head_sha='))
          return { workflow_runs: [{ id: 11 }] }
        if (path.startsWith('/actions/runs/11/artifacts'))
          return { artifacts: [{ name: 'release-plan-11', expired: false }] }
        return request(path, options)
      }
    }
    const output = join(repo.root, `temp/conflict-${origin}`)
    await assert.rejects(
      prepareBatch(repo.root, {
        github,
        source,
        output,
        runId: '12',
        download: async (_run, _name, directory) => {
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'plan.json'), JSON.stringify(plan))
        }
      }),
      /resume_tag=v1\.0\.0/
    )
    assert.equal(existsSync(join(output, 'plan.json')), false)
    assert.ok(github.calls.every((call) => !call.method))
  }
})

test('主包升级后新批次可沿用旧失败批次尚未公开的客户端版本', async (t) => {
  const repo = await fixture(t)
  const previous = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  await repo.pkg('pi-desk', '1.0.1')
  await repo.save('apps/desktop/package.json', { version: '1.0.1' })
  const oldPlan = createReleasePlan(repo.root, { head: repo.commit(), previous, date: 2 })
  await repo.pkg('pi-desk', '1.0.2')
  await repo.save('src/repair.ts', 'export const repaired = true\n')
  const source = repo.commit()
  for (const origin of ['draft', 'actions']) {
    const release = draft(oldPlan.record)
    const published = { ...draft(previous), draft: false, published_at: '2026-10-01T00:00:00Z' }
    const github = githubFixture(origin === 'draft' ? [published, release] : [published])
    github.records.set(previous.tag, previous)
    if (origin === 'draft')
      await github.putAsset(release, 'plan.json', Buffer.from(JSON.stringify(oldPlan)))
    else {
      const request = github.request
      github.request = async (path, options) => {
        if (path.startsWith('/actions/workflows/') && !path.includes('head_sha='))
          return { workflow_runs: [{ id: 11 }] }
        if (path.startsWith('/actions/runs/11/artifacts'))
          return { artifacts: [{ name: 'release-plan-11', expired: false }] }
        return request(path, options)
      }
    }
    const output = join(repo.root, `temp/new-product-${origin}`)
    const result = await prepareBatch(repo.root, {
      github,
      source,
      output,
      runId: '12',
      download: async (_run, _name, directory) => {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'plan.json'), JSON.stringify(oldPlan))
      }
    })
    assert.deepEqual(result.plan.npm, ['pi-desk'])
    assert.equal(
      result.plan.record.packages.find((item) => item.name === '@jetcrab/pi-desk').version,
      '1.0.2'
    )
    assert.deepEqual(result.plan.clients, oldPlan.clients)
    assert.ok(result.plan.clients.some((item) => item.build && item.version === '1.0.1'))
    assert.ok(existsSync(join(output, 'plan.json')))
    assert.ok(github.calls.every((call) => !call.method))
  }
})

test('已公开旧批次重跑读取原记录，不校验较新baseline或回退官网', async (t) => {
  const repo = await fixture(t)
  const first = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  await repo.pkg('pi-desk', '1.0.1')
  const source = repo.commit()
  const second = completed(
    createReleasePlan(repo.root, { head: source, previous: first, date: 2 }).record
  )
  const github = githubFixture([
    { ...draft(first), draft: false, published_at: '2026-10-01T00:00:00Z' },
    { ...draft(second), draft: false, published_at: '2026-10-02T00:00:00Z' }
  ])
  await saveReleaseRecord(github, first)
  await saveReleaseRecord(github, second)
  const before = github.calls.length
  const old = await prepareBatch(repo.root, {
    github,
    source: repo.head,
    output: join(repo.root, 'temp/old')
  })
  assert.deepEqual(old.plan.record, first)
  assert.equal(old.outputs.published, true)
  assert.equal(old.outputs.deploy, false)
  assert.equal(old.outputs.npm, '[]')
  const latest = await prepareBatch(repo.root, {
    github,
    source,
    output: join(repo.root, 'temp/latest')
  })
  assert.equal(latest.outputs.deploy, true)
  assert.ok(github.calls.slice(before).every((call) => !call.method))
})

test('正式tag独立递增且不复用失败批次占用的版本', () => {
  assert.equal(nextReleaseTag('1.0.0', null), 'v1.0.0')
  assert.equal(nextReleaseTag('1.0.0', 'v1.0.0'), 'v1.0.1')
  assert.equal(nextReleaseTag('1.1.0', 'v1.0.3'), 'v1.1.0')
  assert.equal(nextReleaseTag('1.0.0', 'v1.0.0', ['v1.0.2', 'v1.0.1']), 'v1.0.3')
})

test('末端公开失败清理本次草稿，原始制品和固定记录仍可重试', async (t) => {
  const repo = await fixture(t)
  const record = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const releases = []
  const github = githubFixture(releases)
  for (const client of record.clients)
    await writeFile(join(repo.root, client.file), Buffer.from(client.platform))
  const request = github.request
  let failed = false
  github.request = async (path, options) => {
    if (/^\/releases\/\d+$/.test(path) && options?.method === 'PATCH' && !failed) {
      failed = true
      throw Error('临时公开失败')
    }
    return request(path, options)
  }
  const input = { github, record, directory: repo.root, repository: 'fixture/project' }
  await assert.rejects(publishBatch(input), /临时公开失败/)
  assert.equal(releases.length, 0, '末端失败不能留下本次新建草稿')
  assert.deepEqual(await loadReleaseRecord(github, record.tag), record)
  for (const client of record.clients)
    assert.equal(sha256(await readFile(join(repo.root, client.file))), client.sha256)
  await publishBatch(input)
  assert.equal(releases.length, 1)
  assert.equal(releases[0].draft, false)
  assert.deepEqual(
    releases[0].assets.map((item) => item.name).sort(),
    record.clients.map((item) => item.file).sort()
  )
  await cleanupBatch({ github, plan: { record }, directory: repo.root })
  assert.equal(releases.length, 1, '清理步骤不能删除已公开版本')
  await assert.rejects(saveReleaseRecord(github, { ...record, date: 2 }), /拒绝覆盖/)
})

test('安装包摘要错误在创建Release之前失败', async (t) => {
  const repo = await fixture(t)
  const record = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const github = githubFixture([])
  for (const client of record.clients) await writeFile(join(repo.root, client.file), 'tampered')
  await assert.rejects(
    publishBatch({ github, record, directory: repo.root, repository: 'fixture/project' }),
    /摘要/
  )
  assert.ok(!github.calls.some((call) => call.path === '/releases' && call.method === 'POST'))
})

test('公开请求成功但响应丢失时不能清理已公开版本', async (t) => {
  const repo = await fixture(t)
  const record = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const releases = []
  const github = githubFixture(releases)
  for (const client of record.clients)
    await writeFile(join(repo.root, client.file), Buffer.from(client.platform))
  const request = github.request
  github.request = async (path, options) => {
    const result = await request(path, options)
    if (/^\/releases\/\d+$/.test(path) && options?.method === 'PATCH') throw Error('公开响应丢失')
    return result
  }
  await assert.rejects(
    publishBatch({ github, record, directory: repo.root, repository: 'fixture/project' }),
    /公开响应丢失/
  )
  assert.equal(releases.length, 1)
  assert.equal(releases[0].draft, false)
  assert.ok(!github.calls.some((call) => call.method === 'DELETE'))
})

test('安装包上传失败只清理本次草稿，不影响已公开版本', async (t) => {
  const repo = await fixture(t)
  const previous = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const published = { ...draft(previous), draft: false, published_at: '2026-10-01T00:00:00Z' }
  const releases = [published]
  const github = githubFixture(releases)
  await saveReleaseRecord(github, previous)
  const record = {
    ...previous,
    tag: 'v1.0.1',
    date: 2,
    source: { base: repo.head, head: 'b'.repeat(40) }
  }
  for (const client of record.clients)
    await writeFile(join(repo.root, client.file), Buffer.from(client.platform))
  github.putAsset = async () => {
    throw Error('安装包上传中断')
  }
  await assert.rejects(
    publishBatch({ github, record, directory: repo.root, repository: 'fixture/project' }),
    /安装包上传中断/
  )
  assert.deepEqual(releases, [published])
  assert.equal(await loadReleaseRecord(github, record.tag, { optional: true }), null)
})

test('清理失败保留原始发布错误并报告草稿残留', async (t) => {
  const repo = await fixture(t)
  const record = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const releases = []
  const github = githubFixture(releases)
  for (const client of record.clients)
    await writeFile(join(repo.root, client.file), Buffer.from(client.platform))
  github.putAsset = async () => {
    throw Error('原始上传失败')
  }
  const request = github.request
  github.request = async (path, options) => {
    if (/^\/releases\/\d+$/.test(path) && options?.method === 'DELETE') throw Error('清理网络失败')
    return request(path, options)
  }
  const messages = []
  t.mock.method(console, 'error', (message) => messages.push(message))
  await assert.rejects(
    publishBatch({ github, record, directory: repo.root, repository: 'fixture/project' }),
    /原始上传失败/
  )
  assert.equal(releases.length, 1)
  assert.ok(
    messages.some((message) => message.includes('清理网络失败') && message.includes(record.tag))
  )
})

test('工作流只在末端写Release，内部发布包支持失败重试', async () => {
  const workflow = await readWorkflow('release-main')
  for (const name of ['prepare', 'notes', 'assemble'])
    assert.equal(workflow.jobs[name].permissions.contents, 'read')
  assert.equal(workflow.jobs.publish.permissions.contents, 'write')
  const bundle = workflow.jobs.assemble.steps.find((step) =>
    step.with?.name?.startsWith('release-bundle-')
  )
  assert.equal(bundle.uses, 'actions/upload-artifact@v4')
  assert.ok(
    workflow.jobs.publish.steps.some(
      (step) => step.uses === 'actions/download-artifact@v4' && step.with.name === bundle.with.name
    )
  )
  const cleanup = workflow.jobs.publish.steps.find((step) =>
    step.run?.endsWith('release-main.mjs cleanup')
  )
  assert.equal(cleanup.if, 'failure() || cancelled()')
  const notes = workflow.jobs.notes.steps.find((step) =>
    step.with?.name?.startsWith('release-review-')
  )
  assert.ok(notes.with.path.split('\n').some((path) => path.endsWith('/changes.json')))
  assert.ok(
    workflow.jobs.prepare.steps.some(
      (step) =>
        step.uses === 'actions/upload-artifact@v4' &&
        step.with.name === 'npm-command-smoke-${{ github.run_id }}' &&
        step.with.path.endsWith('/restored/npm-command-smoke/*.tgz')
    )
  )
  const inputs = workflow.jobs.prepare.steps.find(
    (step) => step.with?.name === 'docker-inputs-${{ github.run_id }}'
  )
  assert.ok(inputs.with.path.endsWith('/restored/docker-inputs/'))
  assert.equal(inputs.with['include-hidden-files'], true)
  assert.equal(inputs.with['retention-days'], 7)
})

test('无Release草稿也能从Actions固定计划续跑原源码', async (t) => {
  const repo = await fixture(t)
  const plan = createReleasePlan(repo.root, { head: repo.head, date: 1 })
  await repo.save('.github/workflows/release-main.yml', 'fixed scheduling')
  const current = repo.commit()
  const github = githubFixture([])
  const request = github.request
  github.request = async (path, options) => {
    if (path.startsWith('/actions/workflows/')) return { workflow_runs: [{ id: 11 }] }
    if (path.includes('/artifacts?'))
      return { artifacts: [{ name: 'release-plan-11', expired: false }] }
    return request(path, options)
  }
  const result = await prepareResumeBatch(repo.root, {
    github,
    tag: plan.record.tag,
    source: current,
    output: join(repo.root, 'temp/resume'),
    runId: '12',
    download: async (_run, _name, directory) => {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'plan.json'), JSON.stringify(plan))
    }
  })
  assert.deepEqual(result.plan, plan)
  assert.equal(result.outputs.sha, repo.head)
  assert.equal(result.outputs.tag, plan.record.tag)
  assert.equal(result.outputs.published, false)
  assert.ok(
    github.calls.every((call) => !call.method),
    '续跑准备不能创建或修改Release'
  )
})

test('旧草稿缺少固定计划时停止，不重新分配批次', async (t) => {
  const repo = await fixture(t)
  const plan = createReleasePlan(repo.root, { head: repo.head, date: 1 })
  const github = githubFixture([draft(plan.record)])
  await assert.rejects(
    prepareBatch(repo.root, { github, source: repo.head, output: join(repo.root, 'temp/plan') }),
    /固定计划/
  )
  assert.ok(github.calls.every((call) => !call.method))
})

test('修复调度后续跑原草稿，源码和版本不变且不接受已公开记录', async (t) => {
  const repo = await fixture(t)
  const plan = createReleasePlan(repo.root, { head: repo.head })
  const release = draft(plan.record)
  const github = githubFixture([release])
  await github.putAsset(release, 'plan.json', Buffer.from(JSON.stringify(plan)))
  await repo.save('.github/workflows/release-main.yml', 'fixed scheduling')
  const current = repo.commit()
  const result = await prepareResumeBatch(repo.root, {
    github,
    tag: plan.record.tag,
    source: current,
    output: join(repo.root, 'temp/resume')
  })
  assert.equal(result.outputs.sha, repo.head)
  assert.equal(repo.git('rev-parse', 'HEAD'), current, '调度保持当前修复源码，产品源码仍由计划固定')
  assert.equal(result.outputs.tag, plan.record.tag)
  assert.deepEqual(result.plan, plan)
  assert.equal(
    github.calls.filter((call) => call.path === '/releases' && call.method === 'POST').length,
    0
  )
  release.draft = false
  await assert.rejects(
    prepareResumeBatch(repo.root, {
      github,
      tag: plan.record.tag,
      source: current,
      output: join(repo.root, 'temp/resume')
    }),
    /尚未公开/
  )
})

test('只重部署最新官网，不创建新Release或重发产品', async (t) => {
  const repo = await fixture(t)
  const record = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const release = { ...draft(record), draft: false, published_at: '2026-10-08T00:00:00Z' }
  const github = githubFixture([release])
  await saveReleaseRecord(github, record)
  const before = github.calls.length
  const result = await prepareWebsiteBatch({
    github,
    tag: 'v1.0.0',
    source: 'b'.repeat(40),
    output: join(repo.root, 'temp/website')
  })
  assert.equal(result.outputs.sha, 'b'.repeat(40))
  assert.equal(result.plan.record.source.head, repo.head)
  assert.equal(result.outputs.npm, '[]')
  assert.equal(result.outputs.published, true)
  for (const platform of ['windows', 'macos', 'linux', 'android', 'tunnel', 'docker'])
    assert.equal(result.outputs[platform], false)
  assert.ok(github.calls.slice(before).every((call) => !call.method))
  await assert.rejects(
    prepareWebsiteBatch({ github, tag: 'v0.9.0', source: repo.head, output: repo.root }),
    /不能回退/
  )
})

test('旧草稿客户端恢复至工作流内部，汇总核对原字节而不重新构建', async (t) => {
  const repo = await fixture(t)
  const plan = createReleasePlan(repo.root, { head: repo.head })
  const release = draft(plan.record)
  const github = githubFixture([release])
  await github.putAsset(release, 'plan.json', Buffer.from(JSON.stringify(plan)))
  await github.putAsset(release, 'changes.json', Buffer.from(JSON.stringify(plan.record.changes)))
  for (const item of plan.clients) {
    const names = {
      windows: 'PiDesk-Windows-x86-Setup.exe',
      macos: 'PiDesk-macOS-universal.dmg',
      linux: 'PiDesk-Linux-x86_64.AppImage',
      android: 'PiDesk-Android.apk'
    }
    await github.putAsset(release, names[item.platform], Buffer.from(item.platform))
  }
  const prepared = await prepareBatch(repo.root, {
    github,
    source: repo.head,
    output: join(repo.root, 'temp/plan')
  })
  for (const platform of clientPlatforms) assert.equal(prepared.outputs[platform], false)
  const record = await assembleBatch({
    github,
    plan,
    directory: join(repo.root, 'temp/plan/restored/clients'),
    output: join(repo.root, 'release'),
    changes: JSON.parse(await readFile(join(repo.root, 'temp/plan/restored/notes/changes.json')))
  })
  assert.equal(record.clients.length, 4)
  for (const client of record.clients)
    assert.equal(client.sha256, sha256(Buffer.from(client.platform)))
})

test('发布自动创建固定提交tag，不移动已有不同提交的tag', async (t) => {
  const repo = await fixture(t)
  const record = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const github = githubFixture([])
  for (const client of record.clients)
    await writeFile(join(repo.root, client.file), Buffer.from(client.platform))
  const input = { github, record, directory: repo.root, repository: 'fixture/project' }
  await publishBatch(input)
  assert.ok(github.calls.some((call) => call.path === '/git/refs' && call.body.sha === repo.head))
  assert.ok(github.calls.some((call) => call.method === 'PATCH' && call.body.draft === false))
  const request = github.request
  github.request = async (path, options) => {
    if (path.startsWith('/git/ref/tags/')) return { object: { sha: 'b'.repeat(40) } }
    if (path.startsWith('/commits/')) return { sha: 'b'.repeat(40) }
    return request(path, options)
  }
  await assert.rejects(publishBatch(input), /拒绝移动/)
})

test('npm重试从草稿恢复原已验证tarball，不采用重新构建的不同内容', async (t) => {
  const repo = await fixture(t)
  const plan = createReleasePlan(repo.root, { head: repo.head })
  plan.npm = ['pi-desk']
  const release = draft(plan.record)
  const name = 'jetcrab-pi-desk-1.0.0.tgz'
  const github = githubFixture([release])
  await github.putAsset(release, 'plan.json', Buffer.from(JSON.stringify(plan)))
  await github.putAsset(release, name, Buffer.from('verified package'))
  const output = join(repo.root, 'temp/plan')
  const result = await prepareBatch(repo.root, { github, source: repo.head, output })
  assert.equal(result.outputs.npm_ready, true)
  assert.equal(await readFile(join(output, 'restored/npm', name), 'utf8'), 'verified package')
})

test('未通过安装态验收的原包恢复后npm_ready为false，不重新打包', async (t) => {
  const repo = await fixture(t)
  const plan = createReleasePlan(repo.root, { head: repo.head })
  plan.npm = ['pi-desk']
  plan.clients = []
  const archives = join(repo.root, 'archives')
  await mkdir(join(archives, 'package'), { recursive: true })
  await writeFile(
    join(archives, 'package/package.json'),
    JSON.stringify({
      name: '@jetcrab/pi-desk',
      version: '1.0.0',
      publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' }
    })
  )
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', 'host.tgz', 'package'], {
    cwd: archives
  })
  const bytes = await readFile(join(archives, 'host.tgz'))
  const github = githubFixture([])
  const request = github.request
  github.request = async (path, options) => {
    if (path.startsWith('/actions/runs/11/artifacts'))
      return {
        artifacts: ['release-plan', 'npm-packages', 'npm-command-smoke'].map((name) => ({
          name: `${name}-11`,
          expired: false,
          created_at: '2026-10-27T00:02:00Z'
        }))
      }
    if (path.startsWith('/actions/runs/11/jobs'))
      return {
        jobs: [
          {
            id: 1,
            name: 'npm-build / build',
            run_attempt: 1,
            conclusion: 'success',
            started_at: '2026-10-27T00:01:00Z',
            completed_at: '2026-10-27T00:03:00Z'
          }
        ]
      }
    return request(path, options)
  }
  const output = join(repo.root, 'temp/unverified')
  const result = await prepareBatch(repo.root, {
    github,
    source: repo.head,
    output,
    plan,
    runId: '11',
    download: async (_run, name, directory) => {
      await mkdir(directory, { recursive: true })
      if (name.startsWith('release-plan'))
        await writeFile(join(directory, 'plan.json'), JSON.stringify(plan))
      else if (name.startsWith('npm-packages'))
        await writeFile(join(directory, 'jetcrab-pi-desk-1.0.0.tgz'), bytes)
      else {
        await writeFile(join(directory, 'host.tgz'), bytes)
        await writeFile(join(directory, 'sdk.tgz'), bytes)
      }
    }
  })
  assert.equal(result.outputs.npm_ready, false)
  assert.deepEqual(await readFile(join(output, 'restored/npm/jetcrab-pi-desk-1.0.0.tgz')), bytes)
  assert.deepEqual(await readFile(join(output, 'restored/npm-command-smoke/host.tgz')), bytes)
})

test('发布记录拒绝路径逃逸、未签名Android包和重复平台', async (t) => {
  const repo = await fixture(t)
  const record = completed(createReleasePlan(repo.root, { head: repo.head }).record)
  for (const file of ['../key.pem', 'pi-desk-android-1.0.0-unsigned.apk']) {
    assert.throws(() => validateRecord({ ...record, clients: [{ ...record.clients[2], file }] }))
  }
  assert.throws(() =>
    validateRecord({ ...record, clients: [record.clients[0], record.clients[0]] })
  )
  assert.deepEqual(Object.keys(record.changes), changeSections)
})

test('macOS归档保留签名类型和内容校验摘要', async (t) => {
  const repo = await fixture(t)
  const source = join(repo.root, 'fixture.dmg')
  await writeFile(source, 'dmg fixture')
  for (const developerId of [false, true]) {
    const output = join(repo.root, developerId ? 'signed' : 'adhoc')
    await packageClient({ platform: 'macos', version: '1.2.3', source, output, developerId })
    const manifest = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'))
    assert.equal(manifest.sha256, sha256(Buffer.from('dmg fixture')))
    assert.equal(
      await readFile(
        join(output, `pi-desk-macos-1.2.3-universal-${developerId ? 'developer-id' : 'adhoc'}.dmg`),
        'utf8'
      ),
      'dmg fixture'
    )
  }
})
