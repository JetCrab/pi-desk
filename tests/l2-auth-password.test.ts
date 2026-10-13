import assert from 'node:assert/strict'
import test from 'node:test'
import { generateL2AuthPassword } from '../src/client/l2_biz/settings/l2-auth-settings-biz'

test('生成16位随机密码且每次包含四类字符', () => {
  const passwords = new Set<string>()
  for (let index = 0; index < 100; index += 1) {
    const password = generateL2AuthPassword()
    assert.equal(password.length, 16)
    assert.match(password, /[A-Z]/)
    assert.match(password, /[a-z]/)
    assert.match(password, /[0-9]/)
    assert.match(password, /[^A-Za-z0-9]/)
    assert.equal(passwords.has(password), false)
    passwords.add(password)
  }
})
