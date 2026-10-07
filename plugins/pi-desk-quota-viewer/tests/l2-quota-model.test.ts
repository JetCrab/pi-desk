import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatCountdown,
  formatTimestamp,
  formatValue,
  groupChannels,
  resourceVisibilityKey,
  quotaRecords,
  quotaPrimaryValue,
  summaryResources,
  summarySlots
} from '../src/l2-quota-model.js'
import type { QuotaResource, QuotaSourceSnapshot } from '../src/protocol.js'

const sourceIds = {
  openrouterA: '11111111-1111-4111-8111-111111111111',
  openrouterB: '22222222-2222-4222-8222-222222222222',
  cpa: '33333333-3333-4333-8333-333333333333',
  empty: '44444444-4444-4444-8444-444444444444'
} as const

function balance(key: string, label: string, account?: string): QuotaResource {
  return {
    key,
    kind: 'balance',
    label,
    scope: account ? { account } : {},
    unit: { kind: 'currency', code: 'USD' },
    available: { state: 'known', value: 0 },
    expiresAt: null
  }
}

function quota(key: string, label: string, account?: string): QuotaResource {
  return {
    key,
    kind: 'quota',
    label,
    scope: account ? { account } : {},
    unit: { kind: 'percentage' },
    values: {
      limit: { state: 'known', value: 100 },
      used: { state: 'known', value: 0 },
      remaining: { state: 'known', value: 0 }
    },
    window: { kind: 'rolling', durationSeconds: 3600, resetAt: null }
  }
}

function source(
  sourceId: string,
  adapter: string,
  name: string,
  resources: QuotaResource[]
): QuotaSourceSnapshot {
  return {
    sourceId,
    adapter,
    adapterLabel: adapter,
    name,
    dataSource: 'official_api',
    refreshing: false,
    observedAt: null,
    staleAt: null,
    error: null,
    resources
  }
}

test('渠道按首次出现顺序分组，source 顺序和账号排序稳定', () => {
  const sources = [
    source(sourceIds.openrouterA, 'openrouter', '第二来源', [balance('a', 'A', 'z@example.com')]),
    source(sourceIds.cpa, 'cpa-codex', 'CPA', [
      balance('x/codex/primary', 'Codex', 'same@example.com')
    ]),
    source(sourceIds.openrouterB, 'openrouter', '第一来源', [balance('b', 'B', 'a@example.com')])
  ]

  assert.deepEqual(
    groupChannels(sources).map((channel) => channel.map((item) => item.name)),
    [['第二来源', '第一来源'], ['CPA']]
  )
  assert.deepEqual(
    quotaRecords(sources).map((record) => [record.source.name, record.account]),
    [
      ['第二来源', 'z@example.com'],
      ['第一来源', 'a@example.com'],
      ['CPA', 'same@example.com']
    ]
  )
})

test('CPA 使用资源 key 第一段作为账号身份，不按邮箱或 source 合并', () => {
  const records = quotaRecords([
    source(sourceIds.cpa, 'cpa-codex', 'CPA', [
      balance('auth-a/codex/primary', '主功能', 'same@example.com'),
      balance('auth-a/codex/secondary', '备用功能', 'same@example.com'),
      balance('auth-b/codex/primary', '主功能', 'same@example.com')
    ]),
    source(sourceIds.openrouterA, 'cpa-codex', '另一个 CPA', [
      balance('auth-a/codex/primary', '主功能', 'same@example.com')
    ])
  ])

  assert.equal(records.length, 3)
  assert.deepEqual(
    records.map((record) => record.resources.length),
    [2, 1, 1]
  )
  assert.deepEqual(
    records.map((record) => record.source.name),
    ['CPA', 'CPA', '另一个 CPA']
  )
})

test('没有账号的来源按来源展示，resource key fallback 不丢数据', () => {
  const resources = [balance('custom-balance', '自定义余额'), quota('custom-quota', '自定义额度')]
  const records = quotaRecords([source(sourceIds.empty, 'openrouter', '无账号来源', resources)])

  assert.equal(records.length, 1)
  assert.equal(records[0]?.account, null)
  assert.deepEqual(
    records[0]?.resources.map((resource) => resource.key),
    ['custom-balance', 'custom-quota']
  )
})

test('摘要遵循渠道优先级且最多三项，不跨周期求和', () => {
  const resources = [
    balance('other', '其他'),
    balance('account-credits', 'Credits'),
    quota('api-key-quota', 'Key'),
    quota('weekly-quota', '周'),
    quota('monthly-quota', '月')
  ]
  const openrouter = summaryResources({
    key: 'openrouter',
    source: source(sourceIds.openrouterA, 'openrouter', 'OpenRouter', resources),
    account: null,
    resources
  })
  assert.deepEqual(
    openrouter.map((resource) => resource.key),
    ['account-credits', 'api-key-quota']
  )

  const cpaResources = [
    balance('auth/codex/primary', 'Codex'),
    balance('auth/other/primary', 'Other')
  ]
  const cpa = summaryResources({
    key: 'cpa',
    source: source(sourceIds.cpa, 'cpa-codex', 'CPA', cpaResources),
    account: null,
    resources: cpaResources
  })
  assert.deepEqual(
    cpa.map((resource) => resource.key),
    ['auth/codex/primary', 'auth/other/primary']
  )
})

test('已知渠道摘要槽位固定，缺项由fallback补位但不移动核心列', () => {
  const resources = [
    quota('api-key-quota', 'Key'),
    balance('other', '其他'),
    quota('monthly-quota', '月')
  ]
  const slots = summarySlots({
    key: 'openrouter',
    source: source(sourceIds.openrouterA, 'openrouter', 'OpenRouter', resources),
    account: null,
    resources
  })
  assert.deepEqual(
    slots.map((resource) => resource?.key ?? null),
    ['other', 'api-key-quota']
  )

  const cpaResources = [
    balance('auth/codex/secondary', '备用'),
    balance('auth/other/primary', '其他')
  ]
  const cpaSlots = summarySlots({
    key: 'cpa',
    source: source(sourceIds.cpa, 'cpa-codex', 'CPA', cpaResources),
    account: null,
    resources: cpaResources
  })
  assert.deepEqual(
    cpaSlots.map((resource) => resource?.key ?? null),
    ['auth/other/primary', 'auth/codex/secondary']
  )
})

test('CPA 重置次数归属原账号，不占用周期额度摘要且支持隐藏', () => {
  const cpa = source(sourceIds.cpa, 'cpa-codex', 'CPA', [
    quota('auth-a/codex/primary', '周额度', 'one@example.com'),
    balance('auth-a/reset-credits/primary', '剩余重置次数', 'one@example.com'),
    quota('auth-b/codex/primary', '周额度', 'two@example.com'),
    balance('auth-b/reset-credits/primary', '剩余重置次数', 'two@example.com')
  ])
  const records = quotaRecords([cpa])
  assert.equal(records.length, 2)
  assert.deepEqual(
    records.map((record) => record.resources.length),
    [2, 2]
  )
  assert.deepEqual(
    records.map((record) => summarySlots(record).map((resource) => resource?.key ?? null)),
    [
      ['auth-a/codex/primary', null],
      ['auth-b/codex/primary', null]
    ]
  )

  const hidden = quotaRecords(
    [cpa],
    new Set([resourceVisibilityKey('cpa-codex', cpa.resources[1])])
  )
  assert.deepEqual(
    hidden.map((record) => record.resources.map((resource) => resource.key)),
    [['auth-a/codex/primary'], ['auth-b/codex/primary']]
  )
})

test('渠道级显示规则覆盖多个来源、新账号和不同窗口，不影响其他渠道或功能', () => {
  const hiddenWeekly = quota('old/codex/primary', '周额度', 'old@example.com')
  const newWeekly = quota('new/codex/secondary', '周额度', 'new@example.com')
  const reviewWeekly = quota('new/review/secondary', '周额度', 'new@example.com')
  reviewWeekly.scope.feature = 'Code Review'
  const hidden = new Set([resourceVisibilityKey('cpa-codex', hiddenWeekly)])
  const records = quotaRecords(
    [
      source(sourceIds.cpa, 'cpa-codex', '旧来源', [hiddenWeekly]),
      source(sourceIds.openrouterA, 'cpa-codex', '新来源', [newWeekly, reviewWeekly]),
      source(sourceIds.openrouterB, 'opencode-go', '另一渠道', [quota('weekly-quota', '周额度')])
    ],
    hidden
  )
  assert.deepEqual(
    records.map((record) => record.resources.map((resource) => resource.key)),
    [['new/review/secondary'], ['weekly-quota']]
  )
})

test('倒计时按天小时和小时分钟分解，不将不足一天进位为整天', () => {
  const now = 1_700_000_000_000
  assert.equal(formatCountdown(now + 77 * 3600_000, now, 'zh-CN'), '3 天 5 小时后重置')
  assert.equal(
    formatCountdown(now + 71 * 3600_000 + 59 * 60_000, now, 'zh-CN'),
    '2 天 23 小时后重置'
  )
  assert.equal(formatCountdown(now + 3600_000 + 5 * 60_000, now, 'zh-CN'), '1 小时 5 分钟后重置')
  assert.equal(formatCountdown(now + 10_000, now, 'zh-CN'), '1 分钟内重置')
  assert.equal(formatCountdown(now, now, 'en'), 'Reset expected')
  assert.equal(formatCountdown(now + 77 * 3600_000, now, 'en'), 'Resets in 3d 5h')
  assert.equal(formatCountdown(null, now, 'zh-CN'), null)
})

test('具体时间使用传入的语言和时区，保留半小时及跨日时差', () => {
  const timestamp = Date.UTC(2026, 9, 4, 0, 19)
  assert.equal(
    formatTimestamp(timestamp, { locale: 'zh-CN', timeZone: 'Asia/Shanghai' }),
    '10/04 08:19'
  )
  assert.equal(
    formatTimestamp(timestamp, { locale: 'zh-CN', timeZone: 'Asia/Kolkata' }),
    '10/04 05:49'
  )
  assert.equal(
    formatTimestamp(timestamp, { locale: 'zh-CN', timeZone: 'Pacific/Honolulu' }),
    '10/03 14:19'
  )
  assert.equal(formatTimestamp(null, { locale: 'en', timeZone: 'UTC' }), '—')
})

test('额度主值和状态文案保留 known 0、unknown、unlimited 语义', () => {
  const zero = quota('zero', '零额度') as Extract<QuotaResource, { kind: 'quota' }>
  assert.equal(quotaPrimaryValue(zero).label, '剩余')
  assert.equal(formatValue({ state: 'known', value: 0 }, { kind: 'percentage' }), '0%')
  assert.equal(formatValue({ state: 'unknown' }, { kind: 'currency', code: 'USD' }), '未知')
  assert.equal(formatValue({ state: 'unlimited' }, { kind: 'currency', code: 'USD' }), '无限')
})
