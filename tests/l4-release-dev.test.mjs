import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
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
  const read = (name) =>
    readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
  const dev = await read('release-dev')
  assert.match(dev, /branches: \[dev\]/)
  assert.match(dev, /cancel-in-progress: false/)
  assert.match(dev, /source_sha: \$\{\{ github.sha \}\}/)
  assert.match(dev, /release-dev\.mjs prepare/)
  assert.match(dev, /release-dev\.mjs complete/)
  const checks = await read('check')
  assert.doesNotMatch(checks.split('\npermissions:')[0], /\n  push:/)
  assert.match(checks, /pull_request:/)
  const npm = await read('release-npm')
  assert.doesNotMatch(npm.split('\npermissions:')[0], /\n  push:|\n  workflow_dispatch:/)
  assert.match(npm, /matrix:\n\s+os: \[ubuntu-latest, windows-latest\]/)
  await assert.rejects(read('build-dev-clients'), { code: 'ENOENT' })
  await assert.rejects(read('release-clients'), { code: 'ENOENT' })
})
