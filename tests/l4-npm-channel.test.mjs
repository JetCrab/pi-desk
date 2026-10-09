import assert from 'node:assert/strict'
import test from 'node:test'
import { npmTagFor, versionIncreased } from '../.github/scripts/npm-channel.mjs'

test('标签按分支隔离，版本按预发布编号数值递增', () => {
  assert.equal(npmTagFor('refs/heads/main', '1.0.8'), 'latest')
  assert.equal(npmTagFor('refs/heads/dev', '1.0.8-dev.1'), 'dev')
  assert.throws(() => npmTagFor('refs/heads/main', '1.0.8-dev.1'), /通道不匹配/)
  assert.throws(() => npmTagFor('refs/heads/dev', '1.0.8'), /通道不匹配/)
  assert.throws(() => npmTagFor('refs/heads/other', '1.0.8'))
  assert.equal(versionIncreased('1.0.8-dev.9', '1.0.8-dev.12', 'fixture'), true)
  assert.equal(versionIncreased('1.0.8-dev.12', '1.0.8', 'fixture'), true)
  assert.throws(() => versionIncreased('1.0.8', '1.0.8-dev.13', 'fixture'), /递增/)
})
