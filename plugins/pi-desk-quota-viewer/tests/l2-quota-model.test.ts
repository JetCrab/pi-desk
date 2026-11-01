import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detailResources,
  formatCompactCountdown,
  formatTimestamp,
  formatValue,
  groupChannels,
  quotaRecords,
  quotaPrimaryValue,
  recordLabel,
  resourceVisibilityKey,
  summaryResources,
  summarySlots
} from '../src/l2-quota-model.js'
import { account, balance, quota, source } from './fixtures.js'

const secondId = '22222222-2222-4222-8222-222222222222'

test('同类型跨渠道使用相同摘要布局，身份不按同名或邮箱合并', () => {
  const resources = [
    quota('codex/secondary'),
    quota('codex/primary', '5 小时额度', 18000),
    balance('reset-credits', 0, '剩余重置次数')
  ]
  const records = quotaRecords([
    source('cpa', [account(resources), account(resources, { key: 'other' })]),
    source('another-channel', [account(structuredClone(resources))], { sourceId: secondId })
  ])
  assert.equal(records.length, 3)
  assert.equal(new Set(records.map((r) => r.key)).size, 3)
  for (const record of records) {
    assert.deepEqual(
      summarySlots(record).map((r) => r?.key ?? null),
      ['codex/primary', 'codex/secondary']
    )
    assert.deepEqual(detailResources(record), [])
  }
})

test('按渠道首次出现分组，来源顺序及账号名排序稳定', () => {
  const sources = [
    source('other', [
      account([balance('balance')], { key: 'z', type: 'other', name: 'z@example.com' }),
      account([balance('balance')], { key: 'a', type: 'other', name: 'a@example.com' })
    ]),
    source('cpa', [account([quota('codex/primary')])], { sourceId: secondId }),
    source('other', [account([balance('balance')], { type: 'other', name: null })], {
      sourceId: '33333333-3333-4333-8333-333333333333',
      name: '无账号名来源'
    })
  ]
  assert.deepEqual(
    groupChannels(sources).map((items) => items.map((item) => item.name)),
    [['other', '无账号名来源'], ['cpa']]
  )
  assert.deepEqual(quotaRecords(sources).map(recordLabel), [
    'a@example.com',
    'z@example.com',
    '无账号名来源',
    'sample@example.com'
  ])
})

test('Codex 详情只包含额外额度，不重复主周期和主行重置次数', () => {
  const primary = quota('codex/primary', '5 小时额度', 18000)
  const secondary = quota('codex/secondary')
  const review = quota('code-review/primary')
  review.scope.feature = 'Code Review'
  const [record] = quotaRecords([
    source('cpa', [
      account([primary, secondary, review, balance('reset-credits', 2, '剩余重置次数')])
    ])
  ])
  assert.deepEqual(
    summaryResources(record).map((r) => r.key),
    ['codex/primary', 'codex/secondary']
  )
  assert.deepEqual(
    detailResources(record).map((r) => r.key),
    ['code-review/primary']
  )
})

test('Devin 日周固定顺序，按类型隐藏跨渠道生效且不影响其他类型', () => {
  const daily = quota('daily', '日额度', 86400)
  const weekly = quota('weekly')
  const hidden = new Set([resourceVisibilityKey('devin', daily)])
  const records = quotaRecords(
    [
      source('cpa', [
        account([weekly, daily], { type: 'devin' }),
        account([quota('codex/primary', '日额度', 86400)], { key: 'codex' })
      ]),
      source('another-channel', [account([weekly, daily], { type: 'devin' })], {
        sourceId: secondId
      })
    ],
    hidden
  )
  assert.equal(records.length, 3)
  for (const record of records.filter((r) => r.account?.type === 'devin')) {
    assert.deepEqual(
      record.resources.map((r) => r.key),
      ['weekly']
    )
    assert.deepEqual(
      summarySlots(record).map((r) => r?.key ?? null),
      [null, 'weekly']
    )
  }
  assert.ok(records.some((r) => r.resources.some((resource) => resource.key === 'codex/primary')))
})

test('CommandCode 核心额度完整则无额外资源，购买余额才增加详情', () => {
  const core = [
    quota('five-hour-quota', '5 小时额度', 18000),
    quota('weekly-quota'),
    balance('monthly-credits', 30, '月度 Credits 余额')
  ]
  const [record] = quotaRecords([
    source('commandcode', [
      account(
        [
          ...core,
          balance('purchased-credits', 0, '购买 Credits 余额'),
          balance('free-credits', 0, '赠送 Credits 余额')
        ],
        { type: 'commandcode' }
      )
    ])
  ])
  assert.equal(summaryResources(record).length, 3)
  assert.deepEqual(detailResources(record), [])
  const [withExtra] = quotaRecords([
    source('other-channel', [
      account([...core, balance('purchased-credits', 12, '购买 Credits 余额')], {
        type: 'commandcode'
      })
    ])
  ])
  assert.deepEqual(
    detailResources(withExtra).map((r) => r.key),
    ['purchased-credits']
  )
})

test('Google 明确分组全部保留周期，不合计不同窗口或不同组', () => {
  const resources = [
    quota('bucket/gemini-weekly'),
    quota('bucket/gemini-5h', '5 小时额度', 18000),
    quota('bucket/3p-weekly'),
    quota('bucket/3p-5h', '5 小时额度', 18000),
    quota('bucket/argon-weekly')
  ]
  resources.forEach((r, i) => {
    r.scope.feature = i < 2 ? 'Gemini' : i < 4 ? 'Claude / GPT' : 'Argon'
  })
  const [record] = quotaRecords([
    source('antigravity-manager', [account(resources, { type: 'antigravity' })])
  ])
  assert.equal(summaryResources(record).length, 5)
  assert.deepEqual(detailResources(record), [])
  assert.equal(new Set(summaryResources(record).map((r) => r.key)).size, 5)
})

test('Google 两组额度各占一列，同周期同行，独立单窗口放最后', () => {
  const resources = [
    quota('bucket/gemini-weekly'),
    quota('bucket/gemini-5h', '5 小时额度', 18000),
    quota('bucket/third-weekly'),
    quota('bucket/third-5h', '5 小时额度', 18000),
    quota('bucket/argon-weekly')
  ]
  resources.forEach((r, i) => {
    r.scope.feature = i < 2 ? 'Gemini Models' : i < 4 ? 'Claude and GPT models' : 'Gemini Argon'
  })
  const [record] = quotaRecords([
    source('manager', [account([...resources].reverse(), { type: 'antigravity' })])
  ])
  assert.deepEqual(
    summaryResources(record).map((r) => r.key),
    [
      'bucket/gemini-5h',
      'bucket/third-5h',
      'bucket/gemini-weekly',
      'bucket/third-weekly',
      'bucket/argon-weekly'
    ]
  )
})

test('逐模型额度只展开未展示项，不丢任何模型', () => {
  const resources = Array.from({ length: 8 }, (_, i) => {
    const resource = quota(`model/model-${i}`, `model-${i}`)
    resource.scope.model = `model-${i}`
    return resource
  })
  const [record] = quotaRecords([
    source('antigravity-manager', [account(resources, { type: 'antigravity' })])
  ])
  const main = summaryResources(record).map((r) => r.key)
  const details = detailResources(record).map((r) => r.key)
  assert.ok(main.length > 0 && details.length > 0)
  assert.equal(
    main.some((key) => details.includes(key)),
    false
  )
  assert.deepEqual(new Set([...main, ...details]), new Set(resources.map((r) => r.key)))
})

test('空额度、查询失败与暂停账号保留，正常账号全部隐藏不制造空记录', () => {
  const resource = quota('codex/primary')
  const records = quotaRecords(
    [
      source('cpa', [
        account([], { key: 'empty' }),
        account([], { key: 'failed', error: 'HTTP 401' }),
        account([resource], { key: 'paused', status: 'paused' }),
        account([resource], { key: 'hidden' })
      ])
    ],
    new Set([resourceVisibilityKey('codex', resource)])
  )
  assert.deepEqual(
    new Set(records.map((r) => r.account?.key)),
    new Set(['empty', 'failed', 'paused'])
  )
})

test('Google 主项不随服务端返回顺序变化，分组内按周期排序', () => {
  const models = ['model-z', 'model-a', 'model-c', 'model-b'].map((name) => {
    const resource = quota(`model/${name}`, '模型额度')
    resource.scope.model = name
    return resource
  })
  const records = quotaRecords([
    source('first', [account(models, { type: 'antigravity' })]),
    source('second', [account([...models].reverse(), { type: 'antigravity' })], {
      sourceId: secondId
    })
  ])
  assert.deepEqual(
    summaryResources(records[0]).map((r) => r.key),
    ['model/model-a', 'model/model-b', 'model/model-c']
  )
  assert.deepEqual(summaryResources(records[1]), summaryResources(records[0]))
  const weekly = quota('bucket/week')
  const short = quota('bucket/short', '5 小时额度', 18000)
  weekly.scope.feature = short.scope.feature = 'Google group'
  const [grouped] = quotaRecords([
    source('manager', [account([weekly, short], { type: 'antigravity' })])
  ])
  assert.deepEqual(
    summaryResources(grouped).map((r) => r.key),
    ['bucket/short', 'bucket/week']
  )
})

test('未知百分比不使用分母100伪装为主额度', () => {
  const resource = quota('weekly')
  assert.ok(resource.kind === 'quota')
  resource.values.remaining = { state: 'unknown' }
  resource.values.used = { state: 'unknown' }
  assert.deepEqual(quotaPrimaryValue(resource).value, { state: 'unknown' })
})

test('Codex 有天数始终保留小时，不改变不足一天或其他类型', () => {
  const now = 1_800_000_000_000
  for (const [duration, expected] of [
    [72 * 3600_000, '3d0h'],
    [72 * 3600_000 + 45 * 60_000, '3d0h'],
    [71 * 3600_000, '2d23h'],
    [24 * 3600_000, '1d0h'],
    [5 * 3600_000 + 20 * 60_000, '5h20m'],
    [40 * 60_000, '40m'],
    [10_000, '<1m']
  ] as const) {
    assert.equal(formatCompactCountdown(now + duration, now, 'zh-CN', 'codex'), expected)
  }
  assert.equal(formatCompactCountdown(now + 72 * 3600_000, now, 'zh-CN', 'devin'), '3d')
  assert.equal(formatCompactCountdown(now + 72 * 3600_000, now, 'en', 'codex'), '3d0h')
  assert.equal(formatCompactCountdown(now, now, 'zh-CN', 'codex'), '待重置')
  assert.equal(formatCompactCountdown(null, now, 'zh-CN', 'codex'), null)
})

test('倒计时、时区与数值状态保持既有语义', () => {
  const now = 1_700_000_000_000
  assert.equal(formatCompactCountdown(now + 77 * 3600_000, now, 'zh-CN'), '3d5h')
  assert.equal(formatCompactCountdown(now + 71 * 3600_000 + 59 * 60_000, now, 'zh-CN'), '2d23h')
  assert.equal(formatCompactCountdown(now + 3600_000 + 5 * 60_000, now, 'zh-CN'), '1h5m')
  assert.equal(formatCompactCountdown(now + 10_000, now, 'zh-CN'), '<1m')
  assert.equal(formatCompactCountdown(now, now, 'en'), 'Due')
  assert.equal(formatCompactCountdown(null, now, 'zh-CN'), null)
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
  const zero = quota('zero')
  assert.ok(zero.kind === 'quota')
  zero.values.remaining = { state: 'known', value: 0 }
  assert.equal(quotaPrimaryValue(zero).label, '剩余')
  assert.equal(formatValue(zero.values.remaining, zero.unit), '0%')
  assert.equal(formatValue({ state: 'unknown' }, { kind: 'currency', code: 'USD' }), '未知')
  assert.equal(formatValue({ state: 'unlimited' }, { kind: 'currency', code: 'USD' }), '无限')
})
