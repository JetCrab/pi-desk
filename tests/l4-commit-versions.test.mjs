import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  prepareCommitVersions,
  readVersions,
  validateVersions,
  chooseReleaseVersions
} from '../.github/scripts/commit-versions.mjs'
import { installGitHooks } from '../.github/scripts/install-git-hooks.mjs'
import { prepareDevelopmentVersions } from '../.github/scripts/release-version-model.mjs'

async function repository(t) {
  const parent = resolve('temp/tests/commit-versions/staged-release')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'repo-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${join(root, 'no-hooks')}`, ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
  git('init', '-b', 'dev')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  async function save(file, text) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), text)
  }
  async function manifest(name, version, dependencies = {}) {
    const file = name === 'pi-desk' ? 'package.json' : `plugins/${name}/package.json`
    await save(
      file,
      JSON.stringify(
        {
          name: `@jetcrab/${name}`,
          version,
          dependencies,
          publishConfig: { registry: 'https://registry.npmjs.org', access: 'public' }
        },
        null,
        2
      ) + '\n'
    )
  }
  await manifest('pi-desk', '1.0.0', { '@jetcrab/pi-desk-sdk': 'workspace:^' })
  await manifest('pi-desk-sdk', '1.0.0')
  await manifest('pi-desk-usage', '1.0.0', { '@jetcrab/pi-desk-sdk': 'workspace:^' })
  await save('src/feature.ts', 'export const value = 1\n')
  await save('plugins/pi-desk-sdk/src/index.ts', 'export const sdk = 1\n')
  await save('plugins/pi-desk-usage/src/index.ts', 'export const plugin = 1\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
  return {
    root,
    git,
    save,
    manifest,
    base: git('rev-parse', 'HEAD'),
    version: async (name) =>
      JSON.parse(
        await readFile(
          join(root, name === 'pi-desk' ? 'package.json' : `plugins/${name}/package.json`),
          'utf8'
        )
      ).version
  }
}

test('代码提交递增所属单元，失败后再次准备不重复递增', async (t) => {
  const repo = await repository(t)
  await repo.save('src/feature.ts', 'export const value = 2\n')
  repo.git('add', 'src/feature.ts')
  await prepareCommitVersions(repo.root)
  assert.equal(await repo.version('pi-desk'), '1.0.1')
  assert.equal(await repo.version('pi-desk-sdk'), '1.0.0')
  assert.equal(JSON.parse(repo.git('show', ':package.json')).version, '1.0.1')
  await prepareCommitVersions(repo.root)
  assert.equal(await repo.version('pi-desk'), '1.0.1')
  repo.git('commit', '-m', 'feat: 新功能')
  await repo.save('src/feature.ts', 'export const value = 3\n')
  repo.git('add', 'src/feature.ts')
  await prepareCommitVersions(repo.root)
  assert.equal(await repo.version('pi-desk'), '1.0.2')
})

test('SDK变更同步实际消费者，不修改独立组件', async (t) => {
  const repo = await repository(t)
  await repo.manifest('pi-desk-independent', '1.0.0')
  repo.git('add', '.')
  repo.git('commit', '-m', 'fixture: 独立插件')
  await repo.save('plugins/pi-desk-sdk/src/index.ts', 'export const sdk = 2\n')
  repo.git('add', 'plugins/pi-desk-sdk/src/index.ts')
  await prepareCommitVersions(repo.root)
  assert.equal(await repo.version('pi-desk-sdk'), '1.0.1')
  assert.equal(await repo.version('pi-desk'), '1.0.1')
  assert.equal(await repo.version('pi-desk-usage'), '1.0.1')
  assert.equal(await repo.version('pi-desk-independent'), '1.0.0')
})

test('显式更高版本保持不变，文档不消耗代码版本', async (t) => {
  const repo = await repository(t)
  await repo.manifest('pi-desk', '1.1.0', { '@jetcrab/pi-desk-sdk': 'workspace:^' })
  await repo.save('src/feature.ts', 'export const value = 2\n')
  repo.git('add', '.')
  await prepareCommitVersions(repo.root)
  assert.equal(await repo.version('pi-desk'), '1.1.0')
  repo.git('commit', '-m', 'feat: 显式版本')
  await repo.save('README.md', '# Fixture\n')
  repo.git('add', '.')
  await prepareCommitVersions(repo.root)
  assert.equal(await repo.version('pi-desk'), '1.1.0')
})

test('未暂存清单改动不得被升版夹带进提交', async (t) => {
  const repo = await repository(t)
  await repo.save('src/feature.ts', 'export const value = 2\n')
  repo.git('add', 'src/feature.ts')
  await repo.manifest('pi-desk', '9.0.0')
  await assert.rejects(prepareCommitVersions(repo.root), /暂存/)
  assert.equal(JSON.parse(repo.git('show', ':package.json')).version, '1.0.0')
  assert.equal(await repo.version('pi-desk'), '9.0.0')
})

test('CI拒绝绕过Hook的代码变更，但允许准备好的版本', async (t) => {
  const repo = await repository(t)
  await repo.save('src/feature.ts', 'export const value = 2\n')
  repo.git('add', '.')
  repo.git('commit', '-m', 'fix: 漏升版')
  const head = repo.git('rev-parse', 'HEAD')
  await assert.rejects(validateVersions(repo.root, { base: repo.base, head }), /版本/)
  await repo.manifest('pi-desk', '1.0.1', { '@jetcrab/pi-desk-sdk': 'workspace:^' })
  repo.git('add', '.')
  repo.git('commit', '-m', 'chore: 准备版本')
  await validateVersions(repo.root, { base: repo.base, head: repo.git('rev-parse', 'HEAD') })
  assert.equal((await readVersions(repo.root, 'HEAD'))['pi-desk'], '1.0.1')
})

test('普通git commit自动执行Hook，源码版本与代码进入同次提交', async (t) => {
  const repo = await repository(t)
  for (const file of [
    '.githooks/pre-commit',
    ...['commit-versions', 'release-version-model', 'release-dependencies', 'npm-channel'].map(
      (name) => `.github/scripts/${name}.mjs`
    )
  ]) {
    await mkdir(dirname(join(repo.root, file)), { recursive: true })
    await copyFile(new URL(`../${file}`, import.meta.url), join(repo.root, file))
  }
  repo.git('add', '.')
  repo.git('commit', '-m', 'fixture: Git Hook')
  await installGitHooks(repo.root, { ci: false })
  await repo.save('src/feature.ts', 'export const value = 2\n')
  repo.git('add', 'src/feature.ts')
  execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'feat: 自动版本'], {
    cwd: repo.root,
    stdio: 'pipe'
  })
  assert.equal(JSON.parse(repo.git('show', 'HEAD:package.json')).version, '1.0.1')
  assert.equal(repo.git('status', '--porcelain'), '')
})

test('消费者单独发布时继续引用已成功的SDK开发版本', async (t) => {
  const repo = await repository(t)
  await repo.manifest('pi-desk-sdk', '1.0.1')
  await repo.manifest('pi-desk', '1.0.2', { '@jetcrab/pi-desk-sdk': '^1.0.1' })
  repo.git('add', '.')
  repo.git('commit', '-m', 'fix: 消费者更新')
  const result = await prepareDevelopmentVersions(repo.root, {
    before: repo.base,
    selected: ['pi-desk'],
    versions: { 'pi-desk-sdk': '1.0.1-dev.7' },
    readVersions: async (name) => {
      assert.equal(name, '@jetcrab/pi-desk')
      return []
    }
  })
  assert.deepEqual(result.selected, ['pi-desk'])
  assert.equal(await repo.version('pi-desk-sdk'), '1.0.1-dev.7')
  const host = JSON.parse(await readFile(join(repo.root, 'package.json'), 'utf8'))
  assert.equal(host.dependencies['@jetcrab/pi-desk-sdk'], '^1.0.1-dev.7')
})

test('旧官网开发后缀可作为迁移基线，新提交清单必须完成归一化', async (t) => {
  const repo = await repository(t)
  await repo.save(
    'apps/website/package.json',
    JSON.stringify({ name: '@jetcrab/pi-desk-website', version: '1.0.1-dev.1' })
  )
  repo.git('add', '.')
  repo.git('commit', '-m', 'fixture: 历史官网版本')
  const base = repo.git('rev-parse', 'HEAD')
  await assert.rejects(validateVersions(repo.root, { base: null, head: base }), /未同步/)
  await repo.save('apps/website/src/page.ts', 'export const title = "new"\n')
  repo.git('add', '.')
  await prepareCommitVersions(repo.root, { base })
  assert.equal(readVersions(repo.root, ':').website, '1.0.2')
  repo.git('commit', '-m', 'chore: 迁移官网版本')
  await validateVersions(repo.root, { base, head: repo.git('rev-parse', 'HEAD') })
})

test('正式版本选择按当前、次版本、补丁准确执行', async (t) => {
  const repo = await repository(t)
  await repo.manifest('pi-desk', '1.0.8', { '@jetcrab/pi-desk-sdk': 'workspace:^' })
  repo.git('add', '.')
  repo.git('commit', '-m', 'fixture: 累计版本')
  await chooseReleaseVersions(repo.root, { targets: ['pi-desk'], mode: 'current' })
  assert.equal(await repo.version('pi-desk'), '1.0.8')
  await chooseReleaseVersions(repo.root, { targets: ['pi-desk'], mode: 'patch' })
  assert.equal(await repo.version('pi-desk'), '1.0.9')
  await chooseReleaseVersions(repo.root, { targets: ['pi-desk'], mode: 'minor' })
  assert.equal(await repo.version('pi-desk'), '1.1.0')
})
