import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  prepareStableVersions,
  prepareDevelopmentVersions
} from '../.github/scripts/prepare-stable-release.mjs'
import { createReleasePlan, latestSuccessfulRelease } from '../.github/scripts/release-plan.mjs'
import {
  assembleBatch,
  publishBatch,
  stageNpm,
  prepareBatch
} from '../.github/scripts/release-main.mjs'
import { sha256 } from '../.github/scripts/release-github.mjs'
import { validateRecord, changeSections } from '../.github/scripts/release-record.mjs'
import { packageClient } from '../.github/scripts/pack-client.mjs'
import {
  developmentBaseline,
  manualDevelopmentTargets
} from '../.github/scripts/prepare-dev-release.mjs'

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

function completed(record) {
  return {
    ...record,
    clients: ['windows', 'macos', 'android'].map((platform) => ({
      platform,
      version: '1.0.0',
      file:
        platform === 'windows'
          ? 'pi-desk-windows-1.0.0-x86-setup.exe'
          : platform === 'macos'
            ? 'pi-desk-macos-1.0.0-universal-adhoc.dmg'
            : 'pi-desk-android-1.0.0.apk',
      sha256: sha256(Buffer.from(platform))
    }))
  }
}

function githubFixture(releases) {
  const calls = []
  return {
    calls,
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
    request: async (path, options) => {
      calls.push({ path, ...options })
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
    assets: [],
    files: new Map()
  }
}

test('正式版本准备去掉开发后缀并同步自有依赖，不改第三方和原生版本', async (t) => {
  const repo = await fixture(t)
  await repo.pkg('pi-desk', '1.2.0-dev.7', {
    dependencies: { '@jetcrab/pi-desk-sdk': '^1.1.0-dev.4', example: '2.0.0-dev.9' }
  })
  await repo.pkg('pi-desk-sdk', '1.1.0-dev.4')
  const result = await prepareStableVersions(repo.root)
  assert.equal(result.packages.find((item) => item.name === '@jetcrab/pi-desk').version, '1.2.0')
  const manifest = JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@jetcrab/pi-desk-sdk'], '^1.1.0')
  assert.equal(manifest.dependencies.example, '2.0.0-dev.9')
  assert.equal(
    JSON.parse(await readFile(join(repo.root, 'apps/desktop/package.json'), 'utf8')).version,
    '1.0.0'
  )
  assert.deepEqual((await prepareStableVersions(repo.root)).changedFiles, [])
})

test('main 根据运行内容自动升版，开发分支旧版号不会导致正式回退', async (t) => {
  const repo = await fixture(t)
  await repo.save('src/main.ts', 'export const value = 1')
  await prepareStableVersions(repo.root, { base: repo.head })
  assert.equal(
    JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8')).version,
    '1.0.0',
    '未跟踪文件不应进入发布版本计算'
  )
  const source = repo.commit()
  await prepareStableVersions(repo.root, { base: repo.head })
  assert.equal(JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8')).version, '1.0.1')
  const firstRelease = repo.commit()
  repo.git('checkout', '--detach', source)
  await repo.save('src/main.ts', 'export const value = 2')
  repo.commit()
  await prepareStableVersions(repo.root, { base: firstRelease })
  assert.equal(JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8')).version, '1.0.2')
})

test('新开发发布入口仅首次按完整快照准备，后续保留推送基线', async (t) => {
  const repo = await fixture(t)
  assert.equal(developmentBaseline(repo.root, repo.head), '0'.repeat(40))
  await repo.save('.github/scripts/prepare-dev-release.mjs', '// fixture entry')
  const activated = repo.commit()
  assert.equal(developmentBaseline(repo.root, activated), activated)
  assert.throws(() => developmentBaseline(repo.root, 'f'.repeat(40)))
})

test('指定开发包复验自动包含其SDK依赖，不选择无关包', async (t) => {
  const repo = await fixture(t)
  await repo.pkg('pi-desk', '1.0.1-dev.1', {
    dependencies: { '@jetcrab/pi-desk-sdk': 'workspace:^' }
  })
  await repo.pkg('pi-desk-usage', '1.0.0')
  assert.deepEqual(await manualDevelopmentTargets(repo.root, 'pi-desk'), ['pi-desk-sdk', 'pi-desk'])
  assert.deepEqual(await manualDevelopmentTargets(repo.root, 'pi-desk-sdk'), ['pi-desk-sdk'])
  await assert.rejects(manualDevelopmentTargets(repo.root, 'missing-package'))
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

test('dev普通源码推送自动生成测试版本，纯文档推送不发npm包', async (t) => {
  const repo = await fixture(t)
  await repo.save('src/main.ts', 'export const value = 1')
  const head = repo.commit()
  const result = await prepareDevelopmentVersions(repo.root, { before: repo.head, number: 12001 })
  assert.deepEqual(result.selected, ['pi-desk'])
  assert.equal(
    JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8')).version,
    '1.0.1-dev.12001'
  )
  repo.git('checkout', head, '--', 'package.json')
  await repo.save('README.md', '仅文档')
  repo.commit()
  assert.deepEqual(
    (await prepareDevelopmentVersions(repo.root, { before: head, number: 13001 })).selected,
    []
  )
})

test('dev未回合并版本提交时测试版本仍高于main已发布版本', async (t) => {
  const repo = await fixture(t)
  await repo.pkg('pi-desk', '1.2.0')
  const stableBase = repo.commit()
  repo.git('checkout', '--detach', repo.head)
  await repo.save('src/main.ts', 'export const changed = true')
  repo.commit()
  const result = await prepareDevelopmentVersions(repo.root, {
    before: repo.head,
    number: 15001,
    stableBase
  })
  assert.deepEqual(result.selected, ['pi-desk'])
  assert.equal(
    JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8')).version,
    '1.2.1-dev.15001'
  )
})

test('桌面四份版本和Android构建号在正式准备时自动保持一致', async (t) => {
  const repo = await fixture(t)
  await repo.save('apps/desktop/src-tauri/tauri.conf.json', { version: '1.0.0' })
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
  repo.commit()
  await prepareStableVersions(repo.root, { base })
  assert.equal(
    JSON.parse(await readFile(join(repo.root, 'apps/desktop/package.json'), 'utf8')).version,
    '1.0.1'
  )
  assert.equal(
    JSON.parse(await readFile(join(repo.root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'))
      .version,
    '1.0.1'
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

test('版本校验失败不得留下部分正式化清单', async (t) => {
  const repo = await fixture(t)
  await repo.pkg('pi-desk', '1.1.0-dev.1')
  await repo.pkg('pi-desk-sdk', 'not-a-version')
  const before = await readFile(join(repo.root, 'package.json'), 'utf8')
  await assert.rejects(prepareStableVersions(repo.root))
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
    tag_name: 'release-' + 'a'.repeat(12),
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

test('复用安装包需验证实际字节摘要，最终记录包含三个平台', async (t) => {
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
  assert.equal(record.clients.length, 3)
  for (const item of record.clients) assert.equal(sha256(release.files.get(item.file)), item.sha256)
  assert.ok(release.files.has('release.json'))
  assert.ok(release.files.has('release.md'))
  release.files.set(oldRecord.clients[0].file, Buffer.from('tampered'))
  await assert.rejects(
    assembleBatch({ github, release, plan, directory: repo.root, repository: 'fixture/project' })
  )
})

test('正式准备回写固定版本提交，重跑不新增提交或推进失败基线', async (t) => {
  const repo = await fixture(t)
  await repo.pkg('pi-desk', '1.1.0-dev.3')
  const source = repo.commit()
  const remote = `${repo.root}-remote.git`
  t.after(() => rm(remote, { recursive: true, force: true }))
  repo.git('clone', '--bare', repo.root, remote)
  repo.git('remote', 'add', 'origin', remote)
  repo.git('fetch', 'origin')
  const releases = []
  const github = githubFixture(releases)
  github.request = async (path, options) => {
    assert.equal(path, '/releases')
    const release = {
      id: 10,
      draft: true,
      prerelease: false,
      tag_name: options.body.tag_name,
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
    output,
    refreshLock: () => writeFile(join(repo.root, 'pnpm-lock.yaml'), 'lock fixture')
  })
  assert.notEqual(first.outputs.sha, source)
  assert.equal(repo.git('rev-parse', 'origin/main'), first.outputs.sha)
  assert.equal(first.plan.record.source.base, null)
  assert.equal(
    first.plan.record.packages.find((item) => item.name === '@jetcrab/pi-desk').version,
    '1.1.0'
  )
  const again = await prepareBatch(repo.root, {
    github,
    source,
    output,
    prepareVersions: () => {
      throw Error('重跑不应再次准备版本')
    }
  })
  assert.deepEqual(again.plan, first.plan)
  assert.equal(again.outputs.sha, first.outputs.sha)
  assert.equal(releases.length, 1)
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
  github.request = async (path) =>
    path.startsWith('/git/ref/') ? { object: { sha: 'b'.repeat(40) } } : { sha: 'b'.repeat(40) }
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
