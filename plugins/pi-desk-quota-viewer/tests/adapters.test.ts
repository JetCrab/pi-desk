import assert from 'node:assert/strict'
import test from 'node:test'
import { QuotaHttpError, requestJson } from '../src/adapters/http.js'
import { commandCodeAdapter } from '../src/adapters/commandcode.js'
import { moonshotAdapter } from '../src/adapters/moonshot.js'
import { openCodeGoAdapter } from '../src/adapters/opencode-go.js'
import { openRouterAdapter } from '../src/adapters/openrouter.js'
import { siliconFlowAdapter } from '../src/adapters/siliconflow.js'
import { zhipuCodingPlanAdapter } from '../src/adapters/zhipu-coding-plan.js'

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers })
}

function fixtureFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return async (input, init) => handler(String(input), init)
}

const context = { signal: new AbortController().signal, now: 1_700_000_000_000 }

test('数值 Retry-After 从收到响应的时刻起算', async () => {
  const receivedAt = 1_700_000_020_000
  await assert.rejects(
    requestJson({
      fetch: fixtureFetch(() => jsonResponse({}, 429, { 'retry-after': '60' })),
      url: 'https://quota.example.test',
      signal: context.signal,
      label: 'Fixture 额度查询',
      clock: () => receivedAt
    }),
    (error: unknown) => error instanceof QuotaHttpError && error.retryAt === receivedAt + 60_000
  )
})

test('OpenRouter 部分成功保留余额、known 0 和 Retry-After', async () => {
  const calls: string[] = []
  const startedAt = Date.now()
  const result = await openRouterAdapter.load({
    ...context,
    config: { managementKey: 'mgmt', apiKey: 'key' },
    fetch: fixtureFetch((url, init) => {
      calls.push(url)
      assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Bearer /)
      return url.endsWith('/credits')
        ? jsonResponse({ data: { total_credits: 0, total_usage: 0 } })
        : jsonResponse({}, 429, { 'retry-after': '60' })
    })
  })
  assert.equal(result.accounts.length, 1)
  assert.equal(result.accounts[0].type, 'openrouter')
  const resources = result.accounts[0].resources
  assert.equal(resources.length, 1)
  assert.deepEqual(resources[0].kind === 'balance' ? resources[0].available : null, {
    state: 'known',
    value: 0
  })
  assert.match(result.warning ?? '', /HTTP 429/)
  assert.ok(
    result.retryAt && result.retryAt >= startedAt + 60_000 && result.retryAt <= Date.now() + 60_000
  )
  assert.equal(calls.length, 2)
})

test('OpenRouter 全部 429 保留最长 Retry-After', async () => {
  const startedAt = Date.now()
  await assert.rejects(
    openRouterAdapter.load({
      ...context,
      config: { managementKey: 'mgmt', apiKey: 'key' },
      fetch: fixtureFetch((url) =>
        jsonResponse({}, 429, { 'retry-after': url.endsWith('/credits') ? '30' : '90' })
      )
    }),
    (error: unknown) =>
      error instanceof QuotaHttpError &&
      error.status === 429 &&
      error.retryAt !== null &&
      error.retryAt >= startedAt + 90_000 &&
      error.retryAt <= Date.now() + 90_000
  )
})

test('OpenRouter Key 404 回退旧 endpoint 并保留 unknown', async () => {
  const calls: string[] = []
  const result = await openRouterAdapter.load({
    ...context,
    config: { managementKey: '', apiKey: 'key' },
    fetch: fixtureFetch((url) => {
      calls.push(new URL(url).pathname)
      return url.endsWith('/api/v1/key')
        ? jsonResponse({}, 404)
        : jsonResponse({ data: { limit: 100, usage: 0 } })
    })
  })
  assert.deepEqual(calls, ['/api/v1/key', '/api/v1/auth/key'])
  const resource = result.accounts[0].resources[0]
  assert.ok(resource.kind === 'quota')
  assert.deepEqual(resource.values.used, { state: 'known', value: 0 })
  assert.deepEqual(resource.values.remaining, { state: 'unknown' })
})

test('Moonshot 输出可用、现金和代金券余额', async () => {
  const result = await moonshotAdapter.load({
    ...context,
    config: { apiKey: 'moonshot-key' },
    fetch: fixtureFetch((url, init) => {
      assert.equal(url, 'https://api.moonshot.cn/v1/users/me/balance')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer moonshot-key')
      return jsonResponse({
        data: { available_balance: 49.5, cash_balance: 3, voucher_balance: 46.5 }
      })
    })
  })
  assert.equal(result.accounts[0].type, 'moonshot')
  assert.deepEqual(
    result.accounts[0].resources.map((r) => r.key),
    ['available-balance', 'cash-balance', 'voucher-balance']
  )
  assert.ok(result.accounts[0].resources.every((r) => r.unit.kind === 'currency'))
})

test('SiliconFlow 根据区域选择 endpoint 且不猜币种', async () => {
  const result = await siliconFlowAdapter.load({
    ...context,
    config: { region: 'global', apiKey: 'sf-key' },
    fetch: fixtureFetch((url) => {
      assert.equal(url, 'https://api.siliconflow.com/v1/user/info')
      return jsonResponse({ data: { balance: '0', chargeBalance: '2.5', totalBalance: '2.5' } })
    })
  })
  const resources = result.accounts[0].resources
  assert.equal(resources.length, 3)
  assert.ok(resources.every((r) => r.unit.kind === 'custom'))
  const resource = resources.find((r) => r.key === 'balance')
  assert.deepEqual(resource?.kind === 'balance' ? resource.available : null, {
    state: 'known',
    value: 0
  })
})

test('智谱 Coding Plan 转换已用百分比及秒时间戳', async () => {
  const result = await zhipuCodingPlanAdapter.load({
    ...context,
    config: { endpoint: 'bigmodel', apiKey: 'zhipu-key' },
    fetch: fixtureFetch((url, init) => {
      assert.equal(url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
      assert.equal(new Headers(init?.headers).get('authorization'), 'zhipu-key')
      return jsonResponse({
        success: true,
        data: {
          limits: [
            {
              type: 'TOKENS_LIMIT',
              percentage: 25,
              unit: 3,
              number: 5,
              nextResetTime: 1_800_000_000
            },
            { type: 'OTHER_LIMIT', percentage: 90 }
          ]
        }
      })
    })
  })
  const resource = result.accounts[0].resources[0]
  assert.ok(resource.kind === 'quota')
  assert.deepEqual(resource.values.used, { state: 'known', value: 25 })
  assert.deepEqual(resource.values.remaining, { state: 'known', value: 75 })
  assert.equal(resource.window.durationSeconds, 18000)
  assert.equal(resource.window.resetAt, 1_800_000_000_000)
})

test('OpenCode Go 三窗口百分比、ISO 时间和限流提示', async () => {
  const result = await openCodeGoAdapter.load({
    ...context,
    config: { apiKey: 'opencode-key' },
    fetch: fixtureFetch((url, init) => {
      assert.equal(url, 'https://opencode.ai/zen/go/v1/usage')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer opencode-key')
      assert.equal(new Headers(init?.headers).get('accept'), 'application/json')
      return jsonResponse({
        usage: {
          rolling: { percent: 25, resetsAt: '2027-01-02T03:04:05.000Z', status: 'rate-limited' },
          weekly: { percent: 40, resetsAt: '2027-01-09T03:04:05.000Z' },
          monthly: { percent: 75, resetsAt: '2027-02-01T03:04:05.000Z' }
        }
      })
    })
  })
  assert.match(result.warning ?? '', /5 小时额度已达上限/)
  assert.deepEqual(
    result.accounts[0].resources.map((r) => r.key),
    ['five-hour-quota', 'weekly-quota', 'monthly-quota']
  )
  for (const [key, used, reset] of [
    ['five-hour-quota', 25, '2027-01-02T03:04:05.000Z'],
    ['weekly-quota', 40, '2027-01-09T03:04:05.000Z'],
    ['monthly-quota', 75, '2027-02-01T03:04:05.000Z']
  ] as const) {
    const resource = result.accounts[0].resources.find((r) => r.key === key)
    assert.ok(resource?.kind === 'quota')
    assert.deepEqual(resource.values, {
      limit: { state: 'known', value: 100 },
      used: { state: 'known', value: used },
      remaining: { state: 'known', value: 100 - used }
    })
    assert.equal(resource.window.resetAt, Date.parse(reset))
  }
})

test('OpenCode Go 401 返回 API Key 错误', async () => {
  await assert.rejects(
    openCodeGoAdapter.load({
      ...context,
      config: { apiKey: 'invalid' },
      fetch: fixtureFetch(() => jsonResponse({}, 401))
    }),
    /OpenCode Go API Key 无效/
  )
})

test('CommandCode 保留账号套餐、Credits、滚动额度及组织范围', async () => {
  const calls: string[] = []
  const result = await commandCodeAdapter.load({
    ...context,
    config: { apiKey: 'commandcode-key' },
    fetch: fixtureFetch((url, init) => {
      calls.push(url)
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer commandcode-key')
      assert.equal(headers.get('accept'), 'application/json')
      assert.equal(headers.get('x-command-code-version'), '1.0.0')
      assert.equal(headers.get('x-cli-environment'), 'production')
      if (url.endsWith('/whoami'))
        return jsonResponse({
          success: true,
          user: { userName: 'alice' },
          org: { id: 'org-123', name: 'Acme' }
        })
      if (url.endsWith('/credits'))
        return jsonResponse({
          success: true,
          credits: { monthlyCredits: 0, purchasedCredits: 12.5, freeCredits: 3 },
          windowLimits: {
            fiveHour: { used: 1.25, cap: 5, resetAt: 1_800_000_000 },
            weekly: { used: '2', cap: '20', resetAt: 1_800_003_600 }
          }
        })
      assert.equal(url, 'https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-123')
      return jsonResponse({
        success: true,
        data: { planId: 'individual-pro', currentPeriodEnd: 1_800_010_000 }
      })
    })
  })
  assert.equal(calls.length, 3)
  assert.equal(result.warning, null)
  const account = result.accounts[0]
  assert.equal(account.name, 'alice')
  assert.equal(account.plan, 'Pro')
  assert.equal(account.type, 'commandcode')
  for (const [key, value] of [
    ['monthly-credits', 0],
    ['purchased-credits', 12.5],
    ['free-credits', 3]
  ] as const) {
    const resource = account.resources.find((r) => r.key === key)
    assert.ok(resource?.kind === 'balance')
    assert.deepEqual(resource.available, { state: 'known', value })
    assert.deepEqual(resource.scope, { organization: 'Acme' })
    assert.equal(resource.expiresAt, key === 'monthly-credits' ? 1_800_010_000_000 : null)
  }
  for (const [key, used, limit, reset] of [
    ['five-hour-quota', 1.25, 5, 1_800_000_000_000],
    ['weekly-quota', 2, 20, 1_800_003_600_000]
  ] as const) {
    const resource = account.resources.find((r) => r.key === key)
    assert.ok(resource?.kind === 'quota')
    assert.deepEqual(resource.values, {
      used: { state: 'known', value: used },
      limit: { state: 'known', value: limit },
      remaining: { state: 'known', value: limit - used }
    })
    assert.equal(resource.window.resetAt, reset)
    assert.deepEqual(resource.scope, { organization: 'Acme' })
  }
})

test('CommandCode 订阅失败仍保留 Credits 和账号名', async () => {
  const result = await commandCodeAdapter.load({
    ...context,
    config: { apiKey: 'commandcode-key' },
    fetch: fixtureFetch((url) => {
      if (url.endsWith('/whoami'))
        return jsonResponse({ success: true, user: { email: 'fallback@example.com' } })
      if (url.endsWith('/credits'))
        return jsonResponse({
          success: true,
          credits: { monthlyCredits: 0 },
          windowLimits: { fiveHour: { used: 0, cap: 1, resetAt: 1_800_000_000 } }
        })
      return jsonResponse({}, 503)
    })
  })
  assert.ok(result.accounts[0].resources.some((r) => r.key === 'monthly-credits'))
  assert.ok(result.accounts[0].resources.some((r) => r.key === 'five-hour-quota'))
  assert.match(result.warning ?? '', /HTTP 503/)
  assert.equal(result.accounts[0].name, 'fallback@example.com')
})

test('CommandCode Credits 429 保留 Retry-After', async () => {
  const startedAt = Date.now()
  await assert.rejects(
    commandCodeAdapter.load({
      ...context,
      config: { apiKey: 'commandcode-key' },
      fetch: fixtureFetch((url) => {
        if (url.endsWith('/whoami')) return jsonResponse({ success: true })
        if (url.endsWith('/credits')) return jsonResponse({}, 429, { 'retry-after': '45' })
        return jsonResponse({ success: true, data: { planId: 'individual-go' } })
      })
    }),
    (error: unknown) =>
      error instanceof QuotaHttpError &&
      error.status === 429 &&
      error.retryAt !== null &&
      error.retryAt >= startedAt + 45000 &&
      error.retryAt <= Date.now() + 45000
  )
})
