import assert from 'node:assert/strict'
import test from 'node:test'
import { getQuotaAdapter, quotaAdapters } from '../src/adapters/registry.js'
import type { QuotaAdapterLoadResult } from '../src/adapters/types.js'

const config = { managementUrl: 'https://cpa.example.test', managementKey: 'management-key' }
const now = 1_700_000_000_000
interface Call {
  auth_index?: string | number
  authIndex?: string | number
  method: string
  url: string
  header: Record<string, string>
  data?: string
}
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status })
}
function usage(planStatus: Record<string, unknown>): Response {
  return response({ status_code: 200, body: JSON.stringify({ userStatus: { planStatus } }) })
}
async function load(
  files: Record<string, unknown>[],
  respond: (call: Call) => Response
): Promise<QuotaAdapterLoadResult> {
  const adapter = getQuotaAdapter('cpa')
  assert.ok(adapter)
  let discovered = 0
  const result = await adapter.load({
    config,
    now,
    signal: new AbortController().signal,
    fetch: async (input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer management-key')
      if (String(input).endsWith('/auth-files')) {
        discovered += 1
        return response({ files })
      }
      assert.equal(String(input), `${config.managementUrl}/v0/management/api-call`)
      return respond(JSON.parse(String(init?.body)) as Call)
    }
  })
  assert.equal(discovered, 1)
  return result
}

test('CPA 只有一个渠道，混合账号一次发现并保留停用与未知账号', async () => {
  assert.deepEqual(
    quotaAdapters
      .filter((a) => a.descriptor.adapter.startsWith('cpa'))
      .map((a) => a.descriptor.adapter),
    ['cpa']
  )
  const calls: Array<string | number> = []
  const result = await load(
    [
      {
        provider: 'codex',
        auth_index: 'codex-a',
        email: 'same@example.com',
        id_token: { chatgpt_account_id: 'chat-account' }
      },
      { type: 'Devin', authIndex: 0, email: 'same@example.com' },
      { provider: 'codex', auth_index: 'disabled', disabled: true },
      { provider: 'future-provider', auth_index: 'unknown' }
    ],
    (call) => {
      const id = call.auth_index ?? call.authIndex
      assert.ok(id !== undefined)
      calls.push(id)
      if (id === 'codex-a') {
        assert.equal(call.method, 'GET')
        assert.equal(call.header['Chatgpt-Account-Id'], 'chat-account')
        assert.equal(call.header.Authorization, 'Bearer $TOKEN$')
        return response({
          status_code: 200,
          body: {
            plan_type: 'pro',
            rate_limit: {
              primary_window: {
                used_percent: 25,
                limit_window_seconds: 18000,
                reset_at: 1_800_000_000
              },
              secondary_window: { used_percent: 0, limit_window_seconds: 604800 }
            },
            rate_limit_reset_credits: { available_count: 0, applicable_available_count: 4 }
          }
        })
      }
      assert.equal(id, 0)
      assert.equal(call.method, 'POST')
      assert.equal(
        call.url,
        'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus'
      )
      assert.equal(call.header['Connect-Protocol-Version'], '1')
      assert.equal(JSON.parse(call.data ?? '{}').metadata.apiKey, '$TOKEN$')
      return usage({
        dailyQuotaRemainingPercent: 100,
        weeklyQuotaRemainingPercent: '0',
        dailyQuotaResetAtUnix: 1_800_000_000,
        weeklyQuotaResetAtUnix: '1800500000',
        planInfo: { planName: 'Pro' }
      })
    }
  )
  assert.deepEqual(new Set(calls), new Set(['codex-a', 0]))
  assert.equal(result.accounts.length, 4)
  const codex = result.accounts.find((a) => a.key === 'codex-a')
  const devin = result.accounts.find((a) => a.key === '0')
  assert.ok(codex && devin)
  assert.equal(codex.type, 'codex')
  assert.equal(codex.plan, 'Pro 20X')
  assert.equal(devin.type, 'devin')
  assert.equal(codex.name, devin.name)
  const reset = codex.resources.find((r) => r.key === 'reset-credits')
  assert.deepEqual(reset?.kind === 'balance' ? reset.available : null, { state: 'known', value: 0 })
  const weekly = devin.resources.find((r) => r.key === 'weekly')
  assert.ok(weekly?.kind === 'quota')
  assert.deepEqual(weekly.values.remaining, { state: 'known', value: 0 })
  assert.equal(weekly.window.resetAt, 1_800_500_000_000)
  assert.equal(result.accounts.find((a) => a.key === 'disabled')?.status, 'disabled')
  assert.ok(result.accounts.find((a) => a.key === 'unknown')?.error)
  assert.equal(JSON.stringify(result).includes('management-key'), false)
  assert.equal(JSON.stringify(result).includes('$TOKEN$'), false)
})

test('CPA 内层401和429隔离到账号并保留成功结果与冷却', async () => {
  const startedAt = Date.now()
  const result = await load(
    ['ok', 'unauthorized', 'limited'].map((key) => ({ provider: 'devin', auth_index: key })),
    (call) => {
      const key = call.auth_index ?? call.authIndex
      if (key === 'ok') return usage({ dailyQuotaRemainingPercent: 80 })
      return response({
        status_code: key === 'limited' ? 429 : 401,
        header: { 'Retry-After': ['90'] },
        body: '{}'
      })
    }
  )
  assert.equal(result.accounts.find((a) => a.key === 'ok')?.resources.length, 1)
  assert.match(result.accounts.find((a) => a.key === 'unauthorized')?.error ?? '', /401/)
  assert.match(result.accounts.find((a) => a.key === 'limited')?.error ?? '', /429/)
  assert.ok(
    result.retryAt && result.retryAt >= startedAt + 90_000 && result.retryAt <= Date.now() + 90_000
  )
  assert.ok(result.warning)
})

test('Devin 无效百分比保持未知，缺索引和空响应保留失败账号', async () => {
  for (const value of [undefined, null, '', -1, 101, 'NaN', '0x10']) {
    const result = await load([{ provider: 'devin', auth_index: 'a' }], () =>
      usage({ dailyQuotaRemainingPercent: value, dailyQuotaResetAtUnix: 1_800_000_000 })
    )
    const daily = result.accounts[0].resources.find((r) => r.key === 'daily')
    assert.ok(daily?.kind === 'quota')
    assert.deepEqual(daily.values.remaining, { state: 'unknown' })
  }
  const missing = await load([{ provider: 'devin', name: 'credential.json' }], () =>
    assert.fail('缺索引不应代发')
  )
  assert.equal(missing.accounts.length, 1)
  assert.match(missing.accounts[0].error ?? '', /authIndex|索引/)
  const empty = await load([{ provider: 'devin', auth_index: 'empty' }], () => usage({}))
  assert.ok(empty.accounts[0].error)
  assert.deepEqual(empty.accounts[0].resources, [])
  const invalid = await load([{ provider: 'devin', auth_index: 'invalid' }], () =>
    response({ status_code: 200, body: 'not json' })
  )
  assert.match(invalid.accounts[0].error ?? '', /JSON/)
})

test('Codex 套餐fallback、附加额度和相对重置时间保持完整', async () => {
  const result = await load(
    [
      { provider: 'codex', auth_index: 'plus' },
      { provider: 'codex', auth_index: 'lite', id_token: { plan_type: 'pro_lite' } }
    ],
    (call) =>
      response({
        status_code: 200,
        body: {
          ...((call.auth_index ?? call.authIndex) === 'plus' ? { plan_type: 'plus' } : {}),
          rate_limit: {
            primary_window: {
              used_percent: 20,
              limit_window_seconds: 18000,
              reset_after_seconds: 1200
            }
          },
          code_review_rate_limit: {
            primary_window: { used_percent: 40, reset_after_seconds: 7200 }
          },
          additional_rate_limits: [
            {
              limit_name: 'Search',
              rate_limit: { secondary_window: { used_percent: 50, reset_after_seconds: 900 } }
            }
          ]
        }
      })
  )
  assert.deepEqual(
    result.accounts.map((a) => a.plan),
    ['Plus', 'Pro 5X']
  )
  for (const account of result.accounts) {
    assert.equal(account.resources.length, 3)
    const primary = account.resources.find((r) => r.key === 'codex/primary')
    assert.ok(primary?.kind === 'quota')
    assert.equal(primary.window.resetAt, now + 1_200_000)
    const search = account.resources.find((r) => r.scope.feature === 'Search')
    assert.ok(search?.kind === 'quota')
    assert.equal(search.window.resetAt, now + 900_000)
    assert.equal(primary.scope.account, undefined)
    assert.equal(primary.scope.plan, undefined)
  }
})
