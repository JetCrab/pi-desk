import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuotaRecordRow } from '../src/views/l2-quota-record.js'
import { quotaRecords, resourceVisibilityKey, supplementaryDetails } from '../src/l2-quota-model.js'
import type { QuotaAccount } from '../src/protocol.js'
import { account, balance, quota, source } from './fixtures.js'

function render(
  value: QuotaAccount,
  expanded: boolean,
  hidden: ReadonlySet<string> = new Set()
): string {
  const [record] = quotaRecords([source('cpa', [value])], hidden)
  return renderToStaticMarkup(
    createElement(QuotaRecordRow, {
      record,
      now: 1_800_000_000_000,
      expanded,
      duplicateName: false,
      region: { locale: 'zh-CN', timeZone: 'UTC' },
      resetTimeFormat: 'countdown',
      onToggle() {}
    })
  )
}

test('主行已完整表达的账号不渲染详情按钮或空展开区', () => {
  const html = render(
    account([quota('daily', '日额度', 86400), quota('weekly')], {
      type: 'devin',
      observedAt: null
    }),
    true
  )
  assert.equal(html.includes('<button'), false)
  assert.equal(html.includes('data-quota-detail-resource'), false)
  assert.equal(html.includes('data-quota-supplement'), false)
  assert.equal((html.match(/data-quota-resource=/g) ?? []).length, 2)
})

test('Codex 重置次数紧跟套餐，快照按需展开且不重复次数', () => {
  const value = account([quota('codex/primary'), balance('reset-credits', 1, '剩余重置次数')])
  const collapsed = render(value, false)
  assert.equal(collapsed.includes('额度快照更新于'), false)
  assert.ok(collapsed.includes('剩余重置1'))
  assert.match(collapsed, />Pro<\/span><span[^>]*data-quota-resource="reset-credits"/)
  const expanded = render(value, true)
  assert.ok(expanded.includes('额度快照更新于'))
  assert.equal((expanded.match(/剩余重置1/g) ?? []).length, 1)
  assert.equal(expanded.includes('data-quota-detail-resource="reset-credits"'), false)
  assert.equal((expanded.match(/data-quota-resource="codex\/primary"/g) ?? []).length, 1)
})

test('重置次数保留0和未知，缺失或主动隐藏时不显示', () => {
  const resets = balance('reset-credits', 0, '剩余重置次数')
  assert.ok(resets.kind === 'balance')
  const value = account([quota('codex/primary'), resets])
  assert.ok(render(value, false).includes('剩余重置0'))
  resets.available = { state: 'unknown' }
  assert.ok(render(value, false).includes('剩余重置未知'))
  const hidden = new Set([resourceVisibilityKey('codex', resets)])
  assert.equal(render(value, true, hidden).includes('剩余重置'), false)
  assert.equal(render(account([quota('codex/primary')]), false).includes('剩余重置'), false)
  const onlyResets = render(account([balance('reset-credits', 1, '剩余重置次数')]), false)
  assert.ok(onlyResets.includes('剩余重置1'))
  assert.equal(onlyResets.includes('当前额度已全部隐藏'), false)
})

test('Codex 主行应用完整天小时，其他类型保留原倒计时', () => {
  const resource = quota('codex/primary')
  assert.ok(resource.kind === 'quota')
  resource.window.resetAt = 1_800_000_000_000 + 72 * 3600_000
  assert.ok(render(account([resource]), false).includes('3d0h'))
  const devin = render(account([{ ...resource, key: 'weekly' }], { type: 'devin' }), false)
  assert.equal(devin.includes('3d0h'), false)
  assert.ok(devin.includes('>3d</span>'))
})

test('展开额外额度时主行仍只有一份，详情不重复账号名称', () => {
  const review = quota('code-review/primary')
  review.scope.feature = 'Code Review'
  const html = render(account([quota('codex/primary'), review]), true)
  assert.equal((html.match(/data-quota-resource="codex\/primary"/g) ?? []).length, 1)
  assert.equal((html.match(/data-quota-detail-resource=/g) ?? []).length, 1)
  assert.ok(html.includes('data-quota-detail-resource="code-review/primary"'))
  assert.equal(html.includes('data-quota-detail-resource="codex/primary"'), false)
})

test('主余额到期信息可补充，但不重画余额；重复组织说明仅保留一次', () => {
  const monthly = balance('monthly-credits', 49.5, '月度 Credits 余额')
  assert.ok(monthly.kind === 'balance')
  monthly.expiresAt = 1_800_100_000_000
  const resources = [quota('five-hour-quota'), quota('weekly-quota'), monthly]
  resources.forEach((r) => {
    r.scope.organization = 'Example organization'
  })
  const value = account(resources, { type: 'commandcode' })
  const [record] = quotaRecords([source('commandcode', [value])])
  const supplements = supplementaryDetails(record)
  assert.equal(supplements.filter((item) => item.scope.organization).length, 1)
  assert.equal(supplements.filter((item) => item.expiresAt !== null).length, 1)
  const html = render(value, true)
  assert.equal((html.match(/data-quota-resource="monthly-credits"/g) ?? []).length, 1)
  assert.ok(html.includes('到期'))
  assert.equal(html.includes('data-quota-detail-resource="monthly-credits"'), false)
})

test('受限与暂停账号直接表达状态，不误称额度归零或封禁', () => {
  const blocked = render(account([], { status: 'blocked', observedAt: null }), false)
  assert.ok(blocked.includes('访问受限'))
  assert.equal(blocked.includes('已封禁'), false)
  assert.equal(blocked.includes('额度快照更新于'), false)
  const paused = render(account([quota('codex/primary')], { status: 'paused' }), false)
  assert.ok(paused.includes('已暂停'))
  assert.ok(paused.includes('75%'))
})
