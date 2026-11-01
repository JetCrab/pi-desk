import assert from 'node:assert/strict'
import test from 'node:test'
import { getQuotaAdapter } from '../src/adapters/registry.js'
import type { QuotaAdapterLoadResult } from '../src/adapters/types.js'

async function load(accounts: unknown[], status = 200): Promise<QuotaAdapterLoadResult> {
  const adapter = getQuotaAdapter('antigravity-manager')
  assert.ok(adapter)
  let requests = 0
  const result = await adapter.load({
    config: adapter.validateConfig({
      managementUrl: 'https://manager.example.test/prefix/',
      managementPassword: 'test-admin-password'
    }),
    signal: new AbortController().signal,
    now: 1_900_000_000_000,
    fetch: async (input, init) => {
      requests += 1
      assert.equal(String(input), 'https://manager.example.test/prefix/api/accounts')
      assert.equal(init?.method ?? 'GET', 'GET')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-admin-password')
      return new Response(JSON.stringify({ accounts, current_account_id: null }), { status })
    }
  })
  assert.equal(requests, 1)
  return result
}

const groupedQuota = {
  last_updated: 1_800_000_000,
  subscription_tier: 'PRO',
  models: [{ name: 'gemini-example', percentage: 99, reset_time: '2027-01-01T00:00:00Z' }],
  quota_groups: [
    {
      display_name: 'Gemini Models',
      buckets: [
        {
          bucket_id: 'gemini-weekly',
          window: 'weekly',
          remaining_fraction: 0.75,
          reset_time: '2027-01-08T00:00:00Z',
          cycle_tokens: 999999
        },
        {
          bucket_id: 'gemini-5h',
          window: '5h',
          remaining_fraction: 0,
          reset_time: '2027-01-01T05:00:00Z'
        }
      ]
    },
    {
      display_name: 'Independent Group',
      buckets: [
        {
          bucket_id: 'independent-window',
          window: 'future-window',
          remaining_fraction: 1,
          reset_time: ''
        }
      ]
    }
  ]
}

test('Manager 只读取一次账号缓存，优先真实分组且不复制模型或推算token', async () => {
  const result = await load([
    {
      id: 'grouped',
      email: 'sample@example.com',
      disabled: false,
      proxy_disabled: false,
      quota: groupedQuota
    }
  ])
  const account = result.accounts[0]
  assert.equal(account.key, 'grouped')
  assert.equal(account.type, 'antigravity')
  assert.equal(account.plan, 'PRO')
  assert.equal(account.observedAt, 1_800_000_000_000)
  assert.equal(account.resources.length, 3)
  assert.equal(
    account.resources.some((r) => r.key.startsWith('model/')),
    false
  )
  const weekly = account.resources.find((r) => r.key === 'bucket/gemini-weekly')
  assert.ok(weekly?.kind === 'quota')
  assert.equal(weekly.scope.feature, 'Gemini Models')
  assert.deepEqual(weekly.values.remaining, { state: 'known', value: 75 })
  assert.equal(weekly.window.durationSeconds, 604800)
  assert.equal(weekly.window.resetAt, Date.parse('2027-01-08T00:00:00Z'))
  const fiveHour = account.resources.find((r) => r.key === 'bucket/gemini-5h')
  assert.ok(fiveHour?.kind === 'quota')
  assert.deepEqual(fiveHour.values.remaining, { state: 'known', value: 0 })
  assert.equal(fiveHour.window.durationSeconds, 18000)
  const future = account.resources.find((r) => r.key === 'bucket/independent-window')
  assert.ok(future?.kind === 'quota')
  assert.equal(future.window.durationSeconds, null)
  assert.equal(future.window.resetAt, null)
  assert.equal(JSON.stringify(result).includes('999999'), false)
  assert.equal(JSON.stringify(result).includes('test-admin-password'), false)
})

test('Manager 无组按模型保留，暂停、禁用、无额度账号均不丢失', async () => {
  const models = [
    { name: 'model-a', percentage: 0, reset_time: '2027-01-01T00:00:00Z' },
    { name: 'model-b', percentage: 100, reset_time: '' }
  ]
  const result = await load([
    {
      id: 'paused',
      email: 'same@example.com',
      proxy_disabled: true,
      quota: { models, last_updated: 1_800_000_001 }
    },
    { id: 'disabled', email: 'same@example.com', disabled: true, quota: null },
    { id: 'blocked', validation_blocked: true, quota: { models: [], is_forbidden: true } }
  ])
  assert.equal(result.accounts.length, 3)
  const paused = result.accounts.find((a) => a.key === 'paused')
  assert.ok(paused)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.resources.length, 2)
  assert.deepEqual(
    paused.resources.map((r) => r.scope.model),
    ['model-a', 'model-b']
  )
  assert.equal(result.accounts.find((a) => a.key === 'disabled')?.status, 'disabled')
  assert.equal(result.accounts.find((a) => a.key === 'disabled')?.observedAt, null)
  assert.equal(result.accounts.find((a) => a.key === 'blocked')?.status, 'blocked')
})

test('Manager 缺失或越界比例保持未知，不把未知当0或100', async () => {
  const result = await load([
    {
      id: 'invalid',
      quota: {
        models: [
          { name: 'missing' },
          { name: 'negative', percentage: -1 },
          { name: 'large', percentage: 101 }
        ]
      }
    }
  ])
  assert.equal(result.accounts[0].observedAt, null)
  assert.equal(result.accounts[0].resources.length, 3)
  for (const resource of result.accounts[0].resources) {
    assert.ok(resource.kind === 'quota')
    assert.deepEqual(resource.values.remaining, { state: 'unknown' })
  }
})

test('Manager 认证错误显式失败，不调用其他接口兜底', async () => {
  await assert.rejects(load([], 401), /401/)
})
