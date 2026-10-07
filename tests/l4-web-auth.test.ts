import assert from 'node:assert/strict'
import test from 'node:test'
import {
  L2AuthLoginRequestSchema,
  L2AuthLogoutRequestSchema,
  L2AuthSettingsGetRequestSchema,
  L2AuthSettingsReplaceRequestSchema
} from '../src/common/l2_biz/auth/l2-auth-contract'
import {
  areL4WebAuthSecretsEqual,
  createL4WebAuthCookieHeader,
  createL4WebAuthSessionToken,
  isValidL4WebAuthSessionToken,
  readL4WebAuthCookie,
  shouldUseL4SecureWebCookie
} from '../src/server/l4_foundation/auth/l4-web-auth'

const PASSWORD = 'Test-only password 42!'

test('登录与设置仅接收密码并拒绝用户名及额外字段', () => {
  assert.equal(L2AuthLoginRequestSchema.safeParse({ password: PASSWORD }).success, true)
  assert.equal(L2AuthLoginRequestSchema.safeParse({ password: '' }).success, false)
  assert.equal(
    L2AuthLoginRequestSchema.safeParse({ username: 'legacy', password: PASSWORD }).success,
    false
  )
  assert.equal(L2AuthLoginRequestSchema.safeParse({ password: PASSWORD, remember: true }).success, false)
  assert.equal(L2AuthLogoutRequestSchema.safeParse({}).success, true)
  assert.equal(L2AuthLogoutRequestSchema.safeParse({ clientId: 'other' }).success, false)
  assert.equal(L2AuthSettingsGetRequestSchema.safeParse({}).success, true)
  assert.equal(L2AuthSettingsReplaceRequestSchema.safeParse({ password: PASSWORD }).success, true)
  assert.equal(L2AuthSettingsReplaceRequestSchema.safeParse({ password: 'short' }).success, false)
  assert.equal(L2AuthSettingsReplaceRequestSchema.safeParse({ password: null }).success, true)
  assert.equal(L2AuthSettingsReplaceRequestSchema.safeParse({ username: null }).success, false)
})

test('签名会话绑定密钥、校验过期时间并安全解析 Cookie', () => {
  const now = 1_700_000_000_000
  const token = createL4WebAuthSessionToken('secret', 60, now)

  assert.equal(areL4WebAuthSecretsEqual('账号', '账号'), true)
  assert.equal(areL4WebAuthSecretsEqual('账号', '其他'), false)
  assert.equal(isValidL4WebAuthSessionToken(token, 'secret', now), true)
  assert.equal(isValidL4WebAuthSessionToken(token, 'changed', now), false)
  assert.equal(isValidL4WebAuthSessionToken(token, 'secret', now + 60_001), false)
  assert.equal(isValidL4WebAuthSessionToken(`${token}0`, 'secret', now), false)
  assert.equal(readL4WebAuthCookie(`other=1; pi-desk-session=${token}`, 'pi-desk-session'), token)

  assert.equal(shouldUseL4SecureWebCookie('https://pi-desk.test/login', null), true)
  assert.equal(shouldUseL4SecureWebCookie('http://pi-desk.test/login', 'https'), true)
  assert.equal(shouldUseL4SecureWebCookie('http://pi-desk.test/login', 'http, https'), false)
  assert.equal(
    createL4WebAuthCookieHeader('pi-desk-session', token, 60, true),
    `pi-desk-session=${token}; Path=/; Max-Age=60; HttpOnly; SameSite=Strict; Secure`
  )
  assert.equal(
    createL4WebAuthCookieHeader('pi-desk-session', '', 0, true),
    'pi-desk-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure'
  )
})
