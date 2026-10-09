import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { npmTagFor, versionIncreased, versionParts } from '../.github/scripts/npm-channel.mjs'
import {
  nextDevelopmentVersion,
  prepareDevelopmentVersions
} from '../.github/scripts/release-version-model.mjs'

test('新开发版本只附加-dev，同版本重试不产生第二套编号', () => {
  assert.equal(nextDevelopmentVersion('1.2.3', ['1.2.2', '1.2.2-dev.7']), '1.2.3-dev')
  assert.equal(nextDevelopmentVersion('1.2.3', ['1.2.2', '1.2.3-dev']), '1.2.3-dev')
  assert.throws(() => nextDevelopmentVersion('1.2.3', ['1.2.3']), /正式版本/)
  assert.throws(() => nextDevelopmentVersion('1.2.3', ['1.2.4-dev']), /低于|递增/)
  assert.throws(() => nextDevelopmentVersion('1.2.3', ['1.2.3-dev.2']), /历史|旧|递增/)
})

test('新旧预发布版本均可读取，但正式与开发标签保持隔离', () => {
  assert.equal(npmTagFor('refs/heads/dev', '1.2.3-dev'), 'dev')
  assert.equal(npmTagFor('refs/heads/dev', '1.2.3-dev.7'), 'dev')
  assert.equal(npmTagFor('refs/heads/main', '1.2.3'), 'latest')
  assert.throws(() => npmTagFor('refs/heads/main', '1.2.3-dev'), /通道不匹配/)
  assert.notEqual(versionParts('1.2.3-dev')[3], null)
  assert.equal(versionIncreased('1.2.2-dev.9002', '1.2.3-dev', 'fixture'), true)
  assert.equal(versionIncreased('1.2.3-dev', '1.2.3', 'fixture'), true)
  assert.throws(() => versionIncreased('1.2.3-dev.7', '1.2.3-dev', 'fixture'), /递增/)
})

test('SDK新后缀同步到消费者，同时能够恢复旧编号批次', async (t) => {
  const parent = resolve('temp/tests/development-suffix/fixed-plan')
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
  await mkdir(join(root, 'plugins/pi-desk-sdk'), { recursive: true })
  const publishConfig = { registry: 'https://registry.npmjs.org', access: 'public' }
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@jetcrab/pi-desk',
      version: '1.2.3',
      publishConfig,
      dependencies: { '@jetcrab/pi-desk-sdk': '^1.2.3' }
    })
  )
  await writeFile(
    join(root, 'plugins/pi-desk-sdk/package.json'),
    JSON.stringify({ name: '@jetcrab/pi-desk-sdk', version: '1.2.3', publishConfig })
  )
  git('add', '.')
  git('commit', '-m', 'fixture')
  const base = git('rev-parse', 'HEAD')
  for (const suffix of ['dev', 'dev.7']) {
    const version = `1.2.3-${suffix}`
    await prepareDevelopmentVersions(root, {
      before: base,
      selected: ['pi-desk-sdk', 'pi-desk'],
      versions: { 'pi-desk-sdk': version, 'pi-desk': version },
      readVersions: async () => {
        throw Error('固定批次不重新分配版本')
      }
    })
    const host = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    assert.equal(host.version, version)
    assert.equal(host.dependencies['@jetcrab/pi-desk-sdk'], '^' + version)
    git('restore', 'package.json', 'plugins/pi-desk-sdk/package.json')
  }
})
