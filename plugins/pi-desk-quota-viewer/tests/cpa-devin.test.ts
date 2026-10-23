import assert from 'node:assert/strict'
import test from 'node:test'
import { cpaDevinAdapter } from '../src/adapters/cpa-devin.js'
import { QuotaHttpError } from '../src/adapters/http.js'
import { getQuotaAdapter } from '../src/adapters/registry.js'
import type { QuotaAdapterLoadResult } from '../src/adapters/types.js'

interface ApiCallPayload {
  auth_index: string | number
  method: string
  url: string
  header: Record<string, string>
  data: string
}

const config = {
  managementUrl: 'https://cpa.example.test',
  managementKey: 'management-key'
}
const account = { provider: 'devin', auth_index: 'auth-a', email: 'same@example.com' }

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers })
}

function usageResponse(planStatus: Record<string, unknown>): Response {
  return jsonResponse({
    status_code: 200,
    header: {},
    body: JSON.stringify({ userStatus: { planStatus } })
  })
}

async function loadDevin(
  respond: (payload: ApiCallPayload) => Response,
  files: Record<string, unknown>[] = [account]
): Promise<QuotaAdapterLoadResult> {
  return cpaDevinAdapter.load({
    config,
    signal: new AbortController().signal,
    now: 1_700_000_000_000,
    fetch: async (input, init) => {
      if (String(input).endsWith('/auth-files')) return jsonResponse({ files })
      assert.equal(String(input), `${config.managementUrl}/v0/management/api-call`)
      return respond(JSON.parse(String(init?.body)) as ApiCallPayload)
    }
  })
}

test('CPA Devin 注册独立渠道，按启用账号代发正文 Token 查询并映射日周额度', async () => {
  assert.equal(getQuotaAdapter('cpa-devin'), cpaDevinAdapter)
  const calls: Array<string | number> = []
  const signal = new AbortController().signal
  const result = await cpaDevinAdapter.load({
    config: cpaDevinAdapter.validateConfig({
      managementUrl: ' https://cpa.example.test/prefix/v0/management/?ignored=1#fragment ',
      managementKey: ' management-key '
    }),
    signal,
    now: 1_700_000_000_000,
    fetch: async (input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer management-key')
      assert.equal(init?.signal, signal)
      if (String(input).endsWith('/auth-files')) {
        assert.equal(String(input), 'https://cpa.example.test/prefix/v0/management/auth-files')
        return jsonResponse({
          files: [
            account,
            { type: 'Devin', authIndex: 0, email: account.email },
            { ...account, auth_index: 'disabled', disabled: true },
            { provider: 'codex', auth_index: 'codex' }
          ]
        })
      }
      assert.equal(String(input), 'https://cpa.example.test/prefix/v0/management/api-call')
      assert.equal(init?.method, 'POST')
      const payload = JSON.parse(String(init?.body)) as ApiCallPayload
      calls.push(payload.auth_index)
      assert.equal(payload.method, 'POST')
      assert.equal(
        payload.url,
        'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus'
      )
      assert.deepEqual(payload.header, {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1'
      })
      assert.deepEqual(JSON.parse(payload.data), {
        metadata: {
          ideName: 'chisel',
          ideVersion: '3000.10.21',
          apiKey: '$TOKEN$',
          locale: 'en',
          os: 'darwin',
          extensionVersion: '3000.10.21',
          clientName: 'chisel'
        }
      })
      return usageResponse({
        dailyQuotaRemainingPercent: payload.auth_index === 0 ? '100' : 25,
        weeklyQuotaRemainingPercent: '0',
        dailyQuotaResetAtUnix: 1_800_000_000,
        weeklyQuotaResetAtUnix: '1800500000',
        planInfo: { planName: 'Pro' }
      })
    }
  })

  assert.deepEqual(calls, ['auth-a', 0])
  assert.equal(result.warning, null)
  assert.equal(result.resources.length, 4)
  const daily = result.resources.find((resource) => resource.key === 'auth-a/devin/primary')
  assert.ok(daily?.kind === 'quota')
  assert.deepEqual(daily.scope, { account: account.email, plan: 'Pro' })
  assert.deepEqual(daily.unit, { kind: 'percentage' })
  assert.deepEqual(daily.values, {
    limit: { state: 'known', value: 100 },
    used: { state: 'known', value: 75 },
    remaining: { state: 'known', value: 25 }
  })
  assert.equal(daily.window.durationSeconds, 86400)
  assert.equal(daily.window.resetAt, 1_800_000_000_000)
  const weekly = result.resources.find((resource) => resource.key === 'auth-a/devin/secondary')
  assert.ok(weekly?.kind === 'quota')
  assert.deepEqual(weekly.values.remaining, { state: 'known', value: 0 })
  assert.equal(weekly.window.durationSeconds, 604800)
  assert.equal(weekly.window.resetAt, 1_800_500_000_000)
  const full = result.resources.find((resource) => resource.key === '0/devin/primary')
  assert.ok(full?.kind === 'quota')
  assert.deepEqual(full.values.used, { state: 'known', value: 0 })
  assert.equal(JSON.stringify(result).includes('management-key'), false)
  assert.equal(JSON.stringify(result).includes('$TOKEN$'), false)
})

test('CPA Devin 缺失或非法百分比保留未知，空响应不伪造零额度', async () => {
  for (const value of [undefined, null, '', -1, 101, 'NaN', '0x10']) {
    const result = await loadDevin(() =>
      usageResponse({
        dailyQuotaRemainingPercent: value,
        dailyQuotaResetAtUnix: 1_800_000_000,
        weeklyQuotaRemainingPercent: 0
      })
    )
    const daily = result.resources.find((resource) => resource.label === '日额度')
    assert.ok(daily?.kind === 'quota')
    assert.deepEqual(daily.values.remaining, { state: 'unknown' })
    assert.deepEqual(daily.values.used, { state: 'unknown' })
  }
  const partial = await loadDevin(() => usageResponse({ weeklyQuotaRemainingPercent: 60 }))
  assert.deepEqual(
    partial.resources.map((resource) => resource.key),
    ['auth-a/devin/secondary']
  )
  await assert.rejects(
    loadDevin(() => usageResponse({})),
    /未返回可识别额度/
  )
  await assert.rejects(
    loadDevin(() => jsonResponse({ status_code: 200, body: 'not json' })),
    /不是有效 JSON/
  )
})

test('CPA Devin 检查代理内层状态，部分失败保留成功账号和限流冷却', async () => {
  const startedAt = Date.now()
  const result = await loadDevin(
    (payload) =>
      payload.auth_index === 'auth-a'
        ? usageResponse({ dailyQuotaRemainingPercent: 80 })
        : jsonResponse({
            status_code: 429,
            header: { 'Retry-After': ['90'] },
            body: JSON.stringify({ error: 'rate limited' })
          }),
    [account, { ...account, auth_index: 'auth-b' }]
  )
  assert.equal(result.resources.length, 1)
  assert.match(result.warning ?? '', /HTTP 429/)
  assert.ok(result.retryAt && result.retryAt >= startedAt + 90_000)
  assert.ok(result.retryAt <= Date.now() + 90_000)
  await assert.rejects(
    loadDevin(() => jsonResponse({ status_code: 401, body: '{}' })),
    /HTTP 401/
  )
  const retryAt = Date.now() + 120_000
  await assert.rejects(
    loadDevin(() =>
      jsonResponse({
        status_code: 429,
        header: { 'retry-after': [new Date(retryAt).toUTCString()] },
        body: '{}'
      })
    ),
    (error: unknown) =>
      error instanceof QuotaHttpError &&
      error.status === 429 &&
      error.retryAt === Math.floor(retryAt / 1000) * 1000
  )
})

test('CPA Devin 不查询停用账号或缺少索引的凭据，不回退认证刷新', async () => {
  const unexpectedRequest = (): Response => assert.fail('不应发起上游请求或认证刷新')
  await assert.rejects(
    loadDevin(unexpectedRequest, [{ ...account, disabled: true }]),
    /未发现启用的 Devin 账号/
  )
  for (const missingIndex of [
    { provider: 'devin', name: 'devin-example.json' },
    { ...account, auth_index: '' },
    { ...account, auth_index: '  ' }
  ]) {
    await assert.rejects(loadDevin(unexpectedRequest, [missingIndex]), /缺少 authIndex/)
  }
})
