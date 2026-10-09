import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  stageNpm,
  prepareBatch,
  prepareWebsiteBatch
} from '../.github/scripts/release-main.mjs'
import { sha256 } from '../.github/scripts/release-github.mjs'
import { validateRecord, changeSections } from '../.github/scripts/release-record.mjs'
import { packageClient } from '../.github/scripts/pack-client.mjs'
import { readPublishedVersions } from '../.github/scripts/prepare-dev-release.mjs'
import { prepareCommitVersions, validateVersions } from '../.github/scripts/commit-versions.mjs'

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

test('macOS归档参数在无证书时也不展开空数组', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-apple.yml', import.meta.url),
    'utf8'
  )
  assert.match(workflow, /pack_args=\(macos "\$\{dmgs\[0\]\}" "\$CLIENT_OUTPUT"\)/)
  assert.match(workflow, /pack_args\+=\(--developer-id\)/)
  assert.match(workflow, /trap 'status=\$\?; trap - EXIT;.*exit "\$status"'/)
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
  const workflow = await readFile(
    new URL('../.github/workflows/release-npm.yml', import.meta.url),
    'utf8'
  )
  assert.match(workflow, /release-dev-reuse\.mjs restore/)
  assert.doesNotMatch(workflow, /RELEASE_RESUME:/)
  assert.doesNotMatch(workflow, /name: dev-manifests-.*github.run_attempt/)
})

test('桌面四份版本和Android构建号在提交准备时自动保持一致', async (t) => {
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
  await repo.save('apps/desktop/web/main.ts', 'export const feature=true')
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

test('客户端代码变更未升版和历史回退均被阻止', async (t) => {
  const repo = await fixture(t)
  const previous = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  await repo.save('apps/desktop/web/main.ts', 'export const changed = true')
  assert.throws(() => createReleasePlan(repo.root, { head: repo.commit(), previous }), /版本未递增/)
  await repo.save('apps/desktop/package.json', { version: '0.9.0' })
  assert.throws(() => createReleasePlan(repo.root, { head: repo.commit(), previous }), /递增/)
})

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
  const release = draft(plan.record)
  release.files.set('changes.json', Buffer.from(JSON.stringify(plan.record.changes)))
  const github = githubFixture([old, release])
  const record = await assembleBatch({
    github,
    release,
    plan,
    directory: repo.root,
    repository: 'fixture/project'
  })
  assert.equal(record.clients.length, 4)
  for (const item of record.clients) assert.equal(sha256(release.files.get(item.file)), item.sha256)
  assert.ok(release.files.has('release.json'))
  assert.ok(!release.files.has('release.md'))
  release.files.set(oldRecord.clients[0].file, Buffer.from('tampered'))
  await assert.rejects(
    assembleBatch({ github, release, plan, directory: repo.root, repository: 'fixture/project' })
  )
})

test('正式准备固定已提交版本，重跑不新增提交或推进失败基线', async (t) => {
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
  github.request = async (path, options) => {
    if (path !== '/releases') return request(path, options)
    assert.equal(options.body.name, options.body.tag_name)
    const release = {
      id: 10,
      draft: true,
      prerelease: false,
      tag_name: options.body.tag_name,
      target_commitish: options.body.target_commitish,
      assets: [],
      files: new Map()
    }
    releases.push(release)
    return release
  }
  const output = join(repo.root, 'temp/plan')
  const first = await prepareBatch(repo.root, {
    github,
    source,
    output
  })
  assert.equal(first.outputs.sha, source)
  assert.equal(first.outputs.docker, true)
  assert.equal(repo.git('rev-parse', 'origin/main'), first.outputs.sha)
  assert.equal(first.plan.record.source.base, null)
  assert.equal(
    first.plan.record.packages.find((item) => item.name === '@jetcrab/pi-desk').version,
    '1.1.0'
  )
  const again = await prepareBatch(repo.root, {
    github,
    source,
    output
  })
  assert.deepEqual(again.plan, first.plan)
  assert.equal(again.outputs.sha, first.outputs.sha)
  assert.equal(releases.length, 1)
})

test('正式tag独立递增且不复用失败批次占用的版本', () => {
  assert.equal(nextReleaseTag('1.0.0', null), 'v1.0.0')
  assert.equal(nextReleaseTag('1.0.0', 'v1.0.0'), 'v1.0.1')
  assert.equal(nextReleaseTag('1.1.0', 'v1.0.3'), 'v1.1.0')
  assert.equal(nextReleaseTag('1.0.0', 'v1.0.0', ['v1.0.2', 'v1.0.1']), 'v1.0.3')
})

test('正式记录持久保存后才移除内部附件，公开失败仍可重试', async (t) => {
  const repo = await fixture(t)
  const record = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const release = draft(record)
  const github = githubFixture([release])
  await github.putAsset(release, 'release.json', Buffer.from(JSON.stringify(record)))
  await github.putAsset(release, 'release.md', Buffer.from('old presentation'))
  await github.putAsset(release, 'plan.json', Buffer.from('{}'))
  await github.putAsset(release, 'docker-image.json', Buffer.from('{}'))
  await github.putAsset(release, 'pi-desk-docker.tar.gz', Buffer.from('verified image'))
  for (const client of record.clients)
    await github.putAsset(release, client.file, Buffer.from(client.platform))
  const request = github.request
  let failed = false
  github.request = async (path, options) => {
    if (path === `/releases/${release.id}` && options?.method === 'PATCH' && !failed) {
      failed = true
      throw Error('临时公开失败')
    }
    return request(path, options)
  }
  await assert.rejects(
    publishBatch({ github, release, repository: 'fixture/project' }),
    /临时公开失败/
  )
  assert.deepEqual(await loadReleaseRecord(github, record.tag), record)
  assert.deepEqual(
    release.assets.map((item) => item.name).sort(),
    record.clients.map((item) => item.file).sort()
  )
  await publishBatch({ github, release, repository: 'fixture/project' })
  assert.ok(github.calls.some((call) => call.method === 'PATCH' && call.body.name === 'v1.0.0'))
  await assert.rejects(saveReleaseRecord(github, { ...record, date: 2 }), /拒绝覆盖/)
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

test('发布自动创建固定提交tag，不移动已有不同提交的tag', async (t) => {
  const repo = await fixture(t)
  const record = completed(createReleasePlan(repo.root, { head: repo.head, date: 1 }).record)
  const release = draft(record)
  release.files.set('release.json', Buffer.from(JSON.stringify(record)))
  const github = githubFixture([release])
  await publishBatch({ github, release, repository: 'fixture/project' })
  assert.ok(github.calls.some((call) => call.path === '/git/refs' && call.body.sha === repo.head))
  assert.ok(github.calls.some((call) => call.method === 'PATCH' && call.body.draft === false))
  const request = github.request
  github.request = async (path, options) => {
    if (path.startsWith('/git/ref/tags/')) return { object: { sha: 'b'.repeat(40) } }
    if (path.startsWith('/commits/')) return { sha: 'b'.repeat(40) }
    return request(path, options)
  }
  await assert.rejects(publishBatch({ github, release, repository: 'fixture/project' }), /拒绝移动/)
})

test('npm重试从草稿恢复原已验证tarball，不采用重新构建的不同内容', async (t) => {
  const repo = await fixture(t)
  const plan = createReleasePlan(repo.root, { head: repo.head })
  plan.npm = ['pi-desk']
  const release = draft(plan.record)
  const name = 'jetcrab-pi-desk-1.0.0.tgz'
  release.files.set(name, Buffer.from('verified package'))
  release.assets.push({ id: 1, name })
  await writeFile(join(repo.root, name), 'rebuilt package')
  await stageNpm({ github: githubFixture([release]), release, plan, directory: repo.root })
  assert.equal(await readFile(join(repo.root, name), 'utf8'), 'verified package')
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
