import assert from 'node:assert/strict'
import test from 'node:test'
import { isCapabilityAllowed } from '../dist/capabilities.js'

test('能力规则支持精确、大小写、通配符、deny 优先和空 allowlist', () => {
  assert.equal(isCapabilityAllowed({ allow: ['read'] }, 'read'), true)
  assert.equal(isCapabilityAllowed({ allow: ['read'] }, 'Read'), false)
  assert.equal(isCapabilityAllowed({ allow: ['read*'], deny: ['read-secret'] }, 'read-file'), true)
  assert.equal(
    isCapabilityAllowed({ allow: ['read*'], deny: ['read-secret'] }, 'read-secret'),
    false
  )
  assert.equal(isCapabilityAllowed({ allow: [] }, 'read'), false)
  assert.equal(isCapabilityAllowed(undefined, 'unknown-tool'), true)
  assert.equal(isCapabilityAllowed({ deny: ['*'] }, 'anything'), false)
})
