import assert from 'node:assert/strict'
import test from 'node:test'
import { cpaCodexAdapter } from '../src/adapters/cpa-codex.js'
import { QuotaHttpError, requestJson } from '../src/adapters/http.js'
import { commandCodeAdapter } from '../src/adapters/commandcode.js'
import { moonshotAdapter } from '../src/adapters/moonshot.js'
import { openCodeGoAdapter } from '../src/adapters/opencode-go.js'
import { openRouterAdapter } from '../src/adapters/openrouter.js'
import { siliconFlowAdapter } from '../src/adapters/siliconflow.js'
import { zhipuCodingPlanAdapter } from '../src/adapters/zhipu-coding-plan.js'

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function fixtureFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>
): typeof fetch {
  return async (input, init) => handler(String(input), init)
}

test('数值 Retry-After 从收到响应的时刻起算', async () => {
  const receivedAt = 1_700_000_020_000
  await assert.rejects(
    requestJson({
      fetch: fixtureFetch(() => jsonResponse({}, 429, { 'retry-after': '60' })),
      url: 'https://quota.example.test',
      signal: new AbortController().signal,
      label: 'Fixture 额度查询',
      clock: () => receivedAt
    }),
    (error: unknown) => error instanceof QuotaHttpError && error.retryAt === receivedAt + 60_000
  )
})

test('OpenRouter 部分成功保留余额、known 0 和 Retry-After', async () => {
  const calls: string[] = []
  const now = 1_700_000_000_000
  const requestStartedAt = Date.now()
  const result = await openRouterAdapter.load({
    config: openRouterAdapter.validateConfig({ managementKey: 'mgmt', apiKey: 'key' }),
    signal: new AbortController().signal,
    now,
    fetch: fixtureFetch((url, init) => {
      calls.push(url)
      assert.match(String(new Headers(init?.headers).get('authorization')), /^Bearer /)
      if (url.endsWith('/credits')) {
        return jsonResponse({ data: { total_credits: 0, total_usage: 0 } })
      }
      return jsonResponse({}, 429, { 'retry-after': '60' })
    })
  })
  assert.equal(result.resources.length, 1)
  assert.equal(result.resources[0]?.kind, 'balance')
  assert.deepEqual(result.resources[0]?.kind === 'balance' ? result.resources[0].available : null, {
    state: 'known',
    value: 0
  })
  assert.match(result.warning ?? '', /HTTP 429/)
  assert.ok(
    result.retryAt !== null &&
      result.retryAt !== undefined &&
      result.retryAt >= requestStartedAt + 60_000 &&
      result.retryAt <= Date.now() + 60_000
  )
  assert.equal(calls.length, 2)
})

test('OpenRouter 全部 429 保留最长 Retry-After', async () => {
  const now = 1_700_000_000_000
  const requestStartedAt = Date.now()
  await assert.rejects(
    openRouterAdapter.load({
      config: openRouterAdapter.validateConfig({ managementKey: 'mgmt', apiKey: 'key' }),
      signal: new AbortController().signal,
      now,
      fetch: fixtureFetch((url) =>
        jsonResponse({}, 429, { 'retry-after': url.endsWith('/credits') ? '30' : '90' })
      )
    }),
    (error: unknown) =>
      error instanceof QuotaHttpError &&
      error.status === 429 &&
      error.retryAt !== null &&
      error.retryAt >= requestStartedAt + 90_000 &&
      error.retryAt <= Date.now() + 90_000
  )
})

test('OpenRouter Key 404 回退旧 endpoint 并保留 unknown', async () => {
  const calls: string[] = []
  const result = await openRouterAdapter.load({
    config: openRouterAdapter.validateConfig({ managementKey: '', apiKey: 'key' }),
    signal: new AbortController().signal,
    now: 1_700_000_000_000,
    fetch: fixtureFetch((url) => {
      calls.push(url)
      if (url.endsWith('/api/v1/key')) return jsonResponse({}, 404)
      return jsonResponse({ data: { limit: 100, usage: 0 } })
    })
  })
  assert.deepEqual(
    calls.map((url) => new URL(url).pathname),
    ['/api/v1/key', '/api/v1/auth/key']
  )
  const quota = result.resources[0]
  assert.equal(quota?.kind, 'quota')
  if (quota?.kind !== 'quota') return
  assert.deepEqual(quota.values.used, { state: 'known', value: 0 })
  assert.deepEqual(quota.values.remaining, { state: 'unknown' })
})

test('Moonshot 输出可用、现金和代金券余额', async () => {
  const result = await moonshotAdapter.load({
    config: moonshotAdapter.validateConfig({ apiKey: 'moonshot-key' }),
    signal: new AbortController().signal,
    now: Date.now(),
    fetch: fixtureFetch((url, init) => {
      assert.equal(url, 'https://api.moonshot.cn/v1/users/me/balance')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer moonshot-key')
      return jsonResponse({
        data: {
          available_balance: 49.5,
          cash_balance: 3,
          voucher_balance: 46.5
        }
      })
    })
  })
  assert.deepEqual(
    result.resources.map((resource) => resource.key),
    ['available-balance', 'cash-balance', 'voucher-balance']
  )
  assert.ok(result.resources.every((resource) => resource.unit.kind === 'currency'))
})

test('SiliconFlow 根据区域选择 endpoint 且不猜币种', async () => {
  const result = await siliconFlowAdapter.load({
    config: siliconFlowAdapter.validateConfig({ region: 'global', apiKey: 'sf-key' }),
    signal: new AbortController().signal,
    now: Date.now(),
    fetch: fixtureFetch((url) => {
      assert.equal(url, 'https://api.siliconflow.com/v1/user/info')
      return jsonResponse({ data: { balance: '0', chargeBalance: '2.5', totalBalance: '2.5' } })
    })
  })
  assert.equal(result.resources.length, 3)
  assert.ok(result.resources.every((resource) => resource.unit.kind === 'custom'))
  const balance = result.resources.find((resource) => resource.key === 'balance')
  assert.deepEqual(balance?.kind === 'balance' ? balance.available : null, {
    state: 'known',
    value: 0
  })
})

test('智谱 Coding Plan 将 used percentage 转成统一额度并解析秒时间戳', async () => {
  const result = await zhipuCodingPlanAdapter.load({
    config: zhipuCodingPlanAdapter.validateConfig({ endpoint: 'bigmodel', apiKey: 'zhipu-key' }),
    signal: new AbortController().signal,
    now: Date.now(),
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
  const quota = result.resources[0]
  assert.equal(quota?.kind, 'quota')
  if (quota?.kind !== 'quota') return
  assert.deepEqual(quota.values.used, { state: 'known', value: 25 })
  assert.deepEqual(quota.values.remaining, { state: 'known', value: 75 })
  assert.equal(quota.window.durationSeconds, 18_000)
  assert.equal(quota.window.resetAt, 1_800_000_000_000)
})

test('OpenCode Go 解析三窗口百分比、ISO 重置时间和限流提示', async () => {
  const result = await openCodeGoAdapter.load({
    config: openCodeGoAdapter.validateConfig({ apiKey: 'opencode-key' }),
    signal: new AbortController().signal,
    now: 1_700_000_000_000,
    fetch: fixtureFetch((url, init) => {
      assert.equal(url, 'https://opencode.ai/zen/go/v1/usage')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer opencode-key')
      assert.equal(headers.get('accept'), 'application/json')
      return jsonResponse({
        usage: {
          rolling: { percent: 25, resetsAt: '2027-01-02T03:04:05.000Z', status: 'rate-limited' },
          weekly: { percent: 40, resetsAt: '2027-01-09T03:04:05.000Z' },
          monthly: { percent: 75, resetsAt: '2027-02-01T03:04:05.000Z' }
        }
      })
    })
  })

  assert.deepEqual(
    result.resources.map((resource) => resource.key),
    ['five-hour-quota', 'weekly-quota', 'monthly-quota']
  )
  assert.match(result.warning ?? '', /5 小时额度已达上限/)
  for (const [key, used, resetAt] of [
    ['five-hour-quota', 25, Date.parse('2027-01-02T03:04:05.000Z')],
    ['weekly-quota', 40, Date.parse('2027-01-09T03:04:05.000Z')],
    ['monthly-quota', 75, Date.parse('2027-02-01T03:04:05.000Z')]
  ] as const) {
    const resource = result.resources.find((item) => item.key === key)
    assert.equal(resource?.kind, 'quota')
    if (resource?.kind !== 'quota') continue
    assert.deepEqual(resource.values, {
      limit: { state: 'known', value: 100 },
      used: { state: 'known', value: used },
      remaining: { state: 'known', value: 100 - used }
    })
    assert.equal(resource.window.resetAt, resetAt)
  }
})

test('OpenCode Go 401 返回友好 API Key 错误', async () => {
  await assert.rejects(
    openCodeGoAdapter.load({
      config: openCodeGoAdapter.validateConfig({ apiKey: 'invalid-key' }),
      signal: new AbortController().signal,
      now: 1_700_000_000_000,
      fetch: fixtureFetch(() => jsonResponse({}, 401))
    }),
    (error: unknown) => error instanceof Error && error.message === 'OpenCode Go API Key 无效'
  )
})

test('CommandCode 解析账号套餐、Credits 和滚动额度', async () => {
  const calls: string[] = []
  const result = await commandCodeAdapter.load({
    config: commandCodeAdapter.validateConfig({ apiKey: 'commandcode-key' }),
    signal: new AbortController().signal,
    now: 1_700_000_000_000,
    fetch: fixtureFetch((url, init) => {
      calls.push(url)
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer commandcode-key')
      assert.equal(headers.get('accept'), 'application/json')
      assert.equal(headers.get('x-command-code-version'), '1.0.0')
      assert.equal(headers.get('x-cli-environment'), 'production')
      if (url.endsWith('/alpha/whoami')) {
        return jsonResponse({
          success: true,
          user: { userName: 'alice' },
          org: { id: 'org-123', name: 'Acme' }
        })
      }
      if (url.endsWith('/alpha/billing/credits')) {
        return jsonResponse({
          success: true,
          credits: { monthlyCredits: 0, purchasedCredits: 12.5, freeCredits: 3 },
          windowLimits: {
            fiveHour: { used: 1.25, cap: 5, resetAt: 1_800_000_000 },
            weekly: { used: '2', cap: '20', resetAt: 1_800_003_600 }
          }
        })
      }
      assert.equal(url, 'https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-123')
      return jsonResponse({
        success: true,
        data: { planId: 'individual-pro', currentPeriodEnd: 1_800_010_000 }
      })
    })
  })

  assert.deepEqual(
    calls.map((url) => new URL(url).pathname),
    ['/alpha/whoami', '/alpha/billing/credits', '/alpha/billing/subscriptions']
  )
  assert.equal(calls.length, 3)
  assert.equal(result.warning, null)
  for (const [key, value] of [
    ['monthly-credits', 0],
    ['purchased-credits', 12.5],
    ['free-credits', 3]
  ] as const) {
    const resource = result.resources.find((item) => item.key === key)
    assert.equal(resource?.kind, 'balance')
    if (resource?.kind !== 'balance') continue
    assert.deepEqual(resource.available, { state: 'known', value })
    assert.deepEqual(resource.scope, {
      account: 'alice',
      organization: 'Acme',
      plan: 'Pro'
    })
    assert.equal(resource.expiresAt, key === 'monthly-credits' ? 1_800_010_000_000 : null)
  }
  for (const [key, used, limit, resetAt] of [
    ['five-hour-quota', 1.25, 5, 1_800_000_000_000],
    ['weekly-quota', 2, 20, 1_800_003_600_000]
  ] as const) {
    const resource = result.resources.find((item) => item.key === key)
    assert.equal(resource?.kind, 'quota')
    if (resource?.kind !== 'quota') continue
    assert.deepEqual(resource.values, {
      used: { state: 'known', value: used },
      limit: { state: 'known', value: limit },
      remaining: { state: 'known', value: limit - used }
    })
    assert.equal(resource.window.resetAt, resetAt)
    assert.deepEqual(resource.scope, {
      account: 'alice',
      organization: 'Acme',
      plan: 'Pro'
    })
  }
})

test('CommandCode 订阅失败仍保留 Credits 并返回 warning', async () => {
  const result = await commandCodeAdapter.load({
    config: commandCodeAdapter.validateConfig({ apiKey: 'commandcode-key' }),
    signal: new AbortController().signal,
    now: 1_700_000_000_000,
    fetch: fixtureFetch((url) => {
      if (url.endsWith('/alpha/whoami')) {
        return jsonResponse({ success: true, user: { email: 'fallback@example.com' } })
      }
      if (url.endsWith('/alpha/billing/credits')) {
        return jsonResponse({
          success: true,
          credits: { monthlyCredits: 0 },
          windowLimits: { fiveHour: { used: 0, cap: 1, resetAt: 1_800_000_000 } }
        })
      }
      return jsonResponse({ success: false, error: { message: '订阅服务暂不可用' } }, 503)
    })
  })

  assert.ok(result.resources.some((resource) => resource.key === 'monthly-credits'))
  assert.ok(result.resources.some((resource) => resource.key === 'five-hour-quota'))
  assert.match(result.warning ?? '', /HTTP 503/)
  assert.deepEqual(result.resources[0]?.scope, { account: 'fallback@example.com' })
})

test('CommandCode Credits 429 保留 Retry-After', async () => {
  const requestStartedAt = Date.now()
  await assert.rejects(
    commandCodeAdapter.load({
      config: commandCodeAdapter.validateConfig({ apiKey: 'commandcode-key' }),
      signal: new AbortController().signal,
      now: 1_700_000_000_000,
      fetch: fixtureFetch((url) => {
        if (url.endsWith('/alpha/whoami')) return jsonResponse({ success: true })
        if (url.endsWith('/alpha/billing/credits')) {
          return jsonResponse({}, 429, { 'retry-after': '45' })
        }
        return jsonResponse({ success: true, data: { planId: 'individual-go' } })
      })
    }),
    (error: unknown) =>
      error instanceof QuotaHttpError &&
      error.status === 429 &&
      error.retryAt !== null &&
      error.retryAt >= requestStartedAt + 45_000 &&
      error.retryAt <= Date.now() + 45_000
  )
})

test('CPA Codex 按 ChatGPT 账户查询额度，保留各账号剩余重置次数和零值', async () => {
  const accounts = [
    {
      email: 'one@example.com',
      accountId: 'account-one',
      usedPercent: 45,
      remaining: 55,
      resets: 2
    },
    {
      email: 'two@example.com',
      accountId: 'account-two',
      usedPercent: 41,
      remaining: 59,
      resets: 3
    },
    {
      email: 'zero@example.com',
      accountId: 'account-zero',
      usedPercent: 0,
      remaining: 100,
      resets: 0
    }
  ]
  const result = await cpaCodexAdapter.load({
    config: cpaCodexAdapter.validateConfig({
      managementUrl: 'https://cpa.example.test',
      managementKey: 'management-key'
    }),
    signal: new AbortController().signal,
    now: 1_700_000_000_000,
    fetch: fixtureFetch((url, init) => {
      if (url.endsWith('/auth-files')) {
        return jsonResponse({
          files: accounts.map((account, index) => ({
            provider: 'codex',
            auth_index: String(index),
            email: account.email,
            ...(index === 2
              ? { chatgptAccountId: account.accountId }
              : { id_token: { chatgpt_account_id: account.accountId } })
          }))
        })
      }
      const body = JSON.parse(String(init?.body)) as {
        authIndex: string
        method: string
        url: string
        header: Record<string, string>
      }
      const account = accounts[Number(body.authIndex)]
      assert.ok(account)
      assert.equal(body.method, 'GET')
      assert.equal(body.url, 'https://chatgpt.com/backend-api/wham/usage')
      assert.equal(body.header['Chatgpt-Account-Id'], account.accountId)
      return jsonResponse({
        body: {
          plan_type: 'pro',
          rate_limit: {
            primary_window: {
              limit_window_seconds: 604800,
              used_percent: account.usedPercent,
              reset_at: 1_700_000_500
            }
          },
          rate_limit_reset_credits: {
            available_count: account.resets,
            applicable_available_count: 0
          }
        }
      })
    })
  })

  assert.equal(result.warning, null)
  assert.equal(result.resources.length, 6)
  for (const [index, account] of accounts.entries()) {
    const weekly = result.resources.find((resource) => resource.key === `${index}/codex/primary`)
    assert.equal(weekly?.kind, 'quota')
    if (weekly?.kind === 'quota') {
      assert.deepEqual(weekly.values.remaining, { state: 'known', value: account.remaining })
    }
    const resets = result.resources.find(
      (resource) => resource.key === `${index}/reset-credits/primary`
    )
    assert.equal(resets?.kind, 'balance')
    if (resets?.kind === 'balance') {
      assert.deepEqual(resets.available, { state: 'known', value: account.resets })
      assert.deepEqual(resets.unit, { kind: 'custom', label: '次' })
      assert.equal(resets.scope.account, account.email)
    }
  }
})

test('CPA Codex 自动发现账号并区分 Plus、Pro 5X 与 Pro 20X', async () => {
  const now = 1_700_000_000_000
  const requestStartedAt = Date.now()
  const result = await cpaCodexAdapter.load({
    config: cpaCodexAdapter.validateConfig({
      managementUrl: 'https://cpa.example.test',
      managementKey: 'management-key',
      accounts: 'legacy@example.com'
    }),
    signal: new AbortController().signal,
    now,
    fetch: fixtureFetch((url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer management-key')
      if (url.endsWith('/auth-files')) {
        return jsonResponse({
          files: [
            {
              email: 'one@example.com',
              provider: 'codex',
              authIndex: 'one-index',
              disabled: false
            },
            {
              email: 'two@example.com',
              type: 'codex',
              auth_index: 'two-index',
              disabled: false
            },
            {
              email: 'lite@example.com',
              type: 'codex',
              auth_index: 'lite-index',
              id_token: { plan_type: 'pro_lite' },
              disabled: false
            },
            {
              email: 'limited@example.com',
              type: 'codex',
              auth_index: 'limited-index',
              disabled: false
            },
            {
              email: 'disabled@example.com',
              type: 'codex',
              auth_index: 'disabled-index',
              disabled: true
            },
            {
              email: 'other@example.com',
              type: 'claude',
              auth_index: 'other-index',
              disabled: false
            }
          ]
        })
      }
      assert.equal(url, 'https://cpa.example.test/v0/management/api-call')
      const body = JSON.parse(String(init?.body)) as {
        authIndex: string
        url: string
        method: string
        header: Record<string, string>
      }
      assert.equal(body.url, 'https://chatgpt.com/backend-api/wham/usage')
      assert.equal(body.method, 'GET')
      assert.equal(body.header.Authorization, 'Bearer $TOKEN$')
      assert.equal(body.header['User-Agent'], 'Codex CLI')
      assert.equal(body.header['Chatgpt-Account-Id'], undefined)
      if (body.authIndex === 'limited-index') {
        return jsonResponse({}, 429, { 'retry-after': '120' })
      }
      if (body.authIndex === 'lite-index') {
        return jsonResponse({
          body: {
            rate_limit: {
              primary_window: {
                limit_window_seconds: 18000,
                used_percent: 15,
                reset_after_seconds: 1200
              }
            }
          }
        })
      }
      if (body.authIndex === 'one-index') {
        return jsonResponse({
          body: {
            plan_type: 'plus',
            rate_limit: {
              primary_window: {
                limit_window_seconds: 18000,
                used_percent: 20,
                reset_at: 1_700_000_500
              },
              secondary_window: {
                limit_window_seconds: 604800,
                used_percent: 30,
                reset_after_seconds: 3600
              }
            },
            code_review_rate_limit: {
              primary_window: { used_percent: 40, reset_after_seconds: 7200 }
            }
          }
        })
      }
      return jsonResponse({
        bodyText: JSON.stringify({
          planType: 'pro',
          rateLimit: {
            primaryWindow: {
              limitWindowSeconds: 18000,
              usedPercent: 10,
              resetAfterSeconds: 1800
            }
          },
          additionalRateLimits: [
            {
              limitName: 'Search',
              rateLimit: {
                secondaryWindow: { usedPercent: 50, resetAfterSeconds: 900 }
              }
            }
          ]
        })
      })
    })
  })
  assert.equal(result.resources.length, 6)
  assert.match(result.warning ?? '', /HTTP 429/)
  assert.ok(
    result.retryAt !== null &&
      result.retryAt !== undefined &&
      result.retryAt >= requestStartedAt + 120_000 &&
      result.retryAt <= Date.now() + 120_000
  )
  const fiveHour = result.resources.find(
    (resource) => resource.scope.account === 'one@example.com' && resource.label === '5 小时额度'
  )
  assert.equal(fiveHour?.kind, 'quota')
  if (fiveHour?.kind === 'quota') {
    assert.equal(fiveHour.window.resetAt, 1_700_000_500_000)
    assert.equal(fiveHour.scope.plan, 'Plus')
  }
  const relative = result.resources.find(
    (resource) =>
      resource.scope.account === 'two@example.com' && resource.scope.feature === 'Search'
  )
  assert.equal(relative?.kind, 'quota')
  if (relative?.kind === 'quota') {
    assert.equal(relative.window.resetAt, now + 900_000)
    assert.equal(relative.scope.plan, 'Pro 20X')
  }
  const lite = result.resources.find((resource) => resource.scope.account === 'lite@example.com')
  assert.equal(lite?.scope.plan, 'Pro 5X')
  assert.deepEqual(
    cpaCodexAdapter.validateConfig({
      managementUrl: 'https://cpa.example.test',
      managementKey: 'management-key',
      accounts: 'legacy@example.com'
    }),
    {
      managementUrl: 'https://cpa.example.test',
      managementKey: 'management-key'
    }
  )
})
