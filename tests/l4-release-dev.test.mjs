import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parse } from 'yaml'
import { lockDependencyContent } from '../.github/scripts/release-dependencies.mjs'

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
  assert.equal(lockDependencyContent(lock, 'plugins/missing'), null)
})

test('dev只保留统一入口，内部复用不取消连续批次', async () => {
  const read = async (name) =>
    parse(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
  const dev = await read('release-dev')
  assert.deepEqual(dev.on.push.branches, ['dev'])
  assert.equal(dev.concurrency['cancel-in-progress'], false)
  assert.equal(dev.jobs['npm-build'].with.source_sha, '${{ github.sha }}')
  for (const command of ['prepare', 'complete']) {
    assert.ok(
      Object.values(dev.jobs).some((job) =>
        job.steps?.some((step) =>
          new RegExp(`release-dev\\.mjs\\s+${command}\\b`).test(step.run ?? '')
        )
      )
    )
  }
  const checks = await read('check')
  assert.equal(Object.hasOwn(checks.on, 'push'), false)
  assert.ok(Object.hasOwn(checks.on, 'pull_request'))
  const npm = await read('release-npm')
  assert.equal(Object.hasOwn(npm.on, 'push'), false)
  assert.equal(Object.hasOwn(npm.on, 'workflow_dispatch'), false)
  for (const os of ['ubuntu-latest', 'windows-latest'])
    assert.ok(npm.jobs['installed-commands'].strategy.matrix.os.includes(os))
})
