import type {
  QuotaDataSource,
  QuotaLimitResource,
  QuotaResource,
  QuotaSourceSnapshot,
  QuotaUnit,
  QuotaValue
} from './protocol.js'
import { quotaText, type QuotaLocale, type QuotaRegion } from './l2-quota-locale.js'

export const QUOTA_PAGE_SIZE = 10

export interface QuotaRecord {
  key: string
  source: QuotaSourceSnapshot
  account: string | null
  resources: QuotaResource[]
}

const accountOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export function groupChannels<T extends { adapter: string }>(items: readonly T[]): T[][] {
  const channels = new Map<string, T[]>()
  for (const item of items) {
    const group = channels.get(item.adapter)
    if (group) group.push(item)
    else channels.set(item.adapter, [item])
  }
  return [...channels.values()]
}

export function resourceVisibilityKey(adapter: string, resource: QuotaResource): string {
  return `${adapter}:${JSON.stringify([resource.kind, resource.label, resource.scope.feature ?? ''])}`
}

export function displayItems(sources: readonly QuotaSourceSnapshot[]): Array<{
  key: string
  adapter: string
  adapterLabel: string
  resource: QuotaResource
}> {
  const items = new Map<
    string,
    { key: string; adapter: string; adapterLabel: string; resource: QuotaResource }
  >()
  for (const source of sources) {
    for (const resource of source.resources) {
      const key = resourceVisibilityKey(source.adapter, resource)
      if (!items.has(key))
        items.set(key, {
          key,
          adapter: source.adapter,
          adapterLabel: source.adapterLabel,
          resource
        })
    }
  }
  return [...items.values()]
}

function cpaAccountKey(resource: QuotaResource): string | null {
  // CPA Adapter 的资源键是三个已编码片段；账号显示名可能重复，不能作为身份。
  const parts = resource.key.split('/')
  return parts.length === 3 && parts[0] && ['primary', 'secondary'].includes(parts[2])
    ? parts[0]
    : null
}

export function quotaRecords(
  sources: readonly QuotaSourceSnapshot[],
  hiddenKeys: ReadonlySet<string> = new Set()
): QuotaRecord[] {
  return groupChannels(sources).flatMap((channel) =>
    channel.flatMap((source) => {
      const groups = new Map<string, QuotaRecord>()
      for (const resource of source.resources) {
        if (hiddenKeys.has(resourceVisibilityKey(source.adapter, resource))) continue
        const account = resource.scope.account?.trim() || null
        const identity =
          source.adapter === 'cpa-codex'
            ? `cpa:${cpaAccountKey(resource) ?? resource.key}`
            : (account ?? 'source')
        const key = JSON.stringify([source.sourceId, identity])
        const current = groups.get(key)
        if (current) current.resources.push(resource)
        else groups.set(key, { key, source, account, resources: [resource] })
      }
      // 没有返回资源的来源仍占一条状态记录；主动隐藏全部资源则不生成假账号。
      if (source.resources.length === 0) {
        return [{ key: JSON.stringify([source.sourceId]), source, account: null, resources: [] }]
      }
      return [...groups.values()].sort(
        (left, right) =>
          accountOrder.compare(recordLabel(left), recordLabel(right)) ||
          accountOrder.compare(left.key, right.key)
      )
    })
  )
}

export function recordLabel(record: QuotaRecord): string {
  return record.account ?? record.source.name
}

export function recordIndex(record: QuotaRecord): string | null {
  if (record.source.adapter !== 'cpa-codex' || !record.resources[0]) return null
  const key = cpaAccountKey(record.resources[0])
  return key === null ? null : decodeURIComponent(key)
}

export function recordPlan(record: QuotaRecord): string | null {
  return record.resources.find((resource) => resource.scope.plan)?.scope.plan ?? null
}

export function matchesSearch(query: string, ...values: Array<string | null>): boolean {
  const search = query.trim().toLocaleLowerCase()
  return !search || values.some((value) => value?.toLocaleLowerCase().includes(search))
}

export function filterRecords(
  records: readonly QuotaRecord[],
  adapter: string,
  query: string
): QuotaRecord[] {
  return records.filter(
    (record) =>
      (!adapter || record.source.adapter === adapter) &&
      matchesSearch(query, record.account, record.source.name, record.source.adapterLabel)
  )
}

const SUMMARY_KEYS: Record<string, readonly string[]> = {
  openrouter: ['account-credits', 'api-key-quota'],
  moonshot: ['available-balance'],
  siliconflow: ['total-balance'],
  'opencode-go': ['five-hour-quota', 'weekly-quota', 'monthly-quota'],
  commandcode: ['five-hour-quota', 'weekly-quota', 'monthly-credits']
}

export function summaryResources(record: QuotaRecord): QuotaResource[] {
  const resources = record.resources.filter(
    (resource) =>
      record.source.adapter !== 'cpa-codex' || resource.key.split('/')[1] !== 'reset-credits'
  )
  const keys = SUMMARY_KEYS[record.source.adapter]
  let preferred: QuotaResource[]
  let count: number
  if (keys) {
    preferred = keys.flatMap((key) => resources.filter((resource) => resource.key === key))
    count = keys.length
  } else if (record.source.adapter === 'cpa-codex') {
    preferred = resources.filter((resource) => resource.key.split('/')[1] === 'codex')
    count = 2
  } else {
    preferred = resources.filter(
      (resource) => resource.kind === 'quota' && resource.window.durationSeconds !== null
    )
    count = 3
  }
  const preferredKeys = new Set(preferred.map((resource) => resource.key))
  return [...preferred, ...resources.filter((resource) => !preferredKeys.has(resource.key))].slice(
    0,
    Math.min(3, count)
  )
}

export function summarySlots(record: QuotaRecord): Array<QuotaResource | null> {
  const summary = summaryResources(record)
  const keys = SUMMARY_KEYS[record.source.adapter]
  let slots: Array<QuotaResource | null>
  if (keys) {
    slots = keys.map((key) => summary.find((resource) => resource.key === key) ?? null)
  } else if (record.source.adapter === 'cpa-codex') {
    slots = ['primary', 'secondary'].map(
      (position) =>
        summary.find((resource) => {
          const parts = resource.key.split('/')
          return parts[1] === 'codex' && parts[2] === position
        }) ?? null
    )
  } else if (record.source.adapter === 'zhipu-coding-plan') {
    slots = [
      summary.find(
        (resource) =>
          resource.kind === 'quota' &&
          resource.window.durationSeconds !== null &&
          resource.window.durationSeconds < 86_400
      ) ?? null,
      summary.find(isWeeklyResource) ?? null,
      null
    ]
  } else {
    return summary
  }
  // 保留核心列的位置，缺项可由其他可见资源补位，但不把已存在的核心项挪到另一列。
  const assigned = new Set(slots.flatMap((resource) => (resource ? [resource.key] : [])))
  const fallback = summary.filter((resource) => !assigned.has(resource.key))
  return slots.map((resource) => resource ?? fallback.shift() ?? null)
}

export function resourceLabel(resource: QuotaResource, locale: QuotaLocale = 'zh-CN'): string {
  const feature = resource.scope.feature?.trim()
  const label = quotaText(locale, resource.label)
  return feature ? `${feature} · ${label}` : label
}

export function isWeeklyResource(resource: QuotaResource): boolean {
  if (resource.kind !== 'quota') return false
  const seconds = resource.window.durationSeconds
  return seconds !== null && seconds >= 6 * 86_400 && seconds <= 8 * 86_400
}

export function formatTimestamp(value: number | null, region: QuotaRegion): string {
  if (value === null) return '—'
  return new Intl.DateTimeFormat(region.locale === 'en' ? 'en-US' : region.locale, {
    timeZone: region.timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(value)
}

export function formatCountdown(
  value: number | null,
  now: number,
  locale: QuotaLocale
): string | null {
  if (value === null) return null
  const difference = value - now
  if (difference <= 0) return quotaText(locale, '预计已重置', 'Reset expected')
  const minutes = Math.floor(difference / 60_000)
  if (minutes === 0) return quotaText(locale, '1 分钟内重置', 'Resets in less than 1m')
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const parts =
    days > 0
      ? [
          quotaText(locale, `${days} 天`, `${days}d`),
          hours % 24 ? quotaText(locale, `${hours % 24} 小时`, `${hours % 24}h`) : ''
        ]
      : [
          hours ? quotaText(locale, `${hours} 小时`, `${hours}h`) : '',
          minutes % 60 ? quotaText(locale, `${minutes % 60} 分钟`, `${minutes % 60}m`) : ''
        ]
  const duration = parts.filter(Boolean).join(' ')
  return quotaText(locale, `${duration}后重置`, `Resets in ${duration}`)
}

function formatNumber(value: number, locale: QuotaLocale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value)
}

export function formatValue(
  value: QuotaValue,
  unit: QuotaUnit,
  locale: QuotaLocale = 'zh-CN'
): string {
  if (value.state === 'unknown') return quotaText(locale, '未知')
  if (value.state === 'unlimited') return quotaText(locale, '无限')
  if (value.state === 'not_applicable') return '—'
  if (unit.kind === 'currency') {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: unit.code,
        maximumFractionDigits: 4
      }).format(value.value)
    } catch {
      return `${formatNumber(value.value, locale)} ${unit.code}`
    }
  }
  if (unit.kind === 'percentage') return `${formatNumber(value.value, locale)}%`
  if (unit.kind === 'tokens') return `${formatNumber(value.value, locale)} Tokens`
  if (unit.kind === 'requests')
    return `${formatNumber(value.value, locale)} ${quotaText(locale, '请求')}`
  return `${formatNumber(value.value, locale)} ${quotaText(locale, unit.label)}`
}

export function formatRatio(value: number, locale: QuotaLocale = 'zh-CN'): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(value)
}

export function quotaPrimaryValue(resource: QuotaLimitResource): {
  label: string
  value: QuotaValue
} {
  const { remaining, used, limit } = resource.values
  if (remaining.state === 'known' || remaining.state === 'unlimited') {
    return { label: '剩余', value: remaining }
  }
  if (used.state === 'known' || used.state === 'unlimited') return { label: '已用', value: used }
  if (limit.state === 'known' || limit.state === 'unlimited') return { label: '总额', value: limit }
  return { label: '额度', value: remaining }
}

export function remainingRatio(resource: QuotaLimitResource): number | null {
  const { remaining, limit } = resource.values
  if (remaining.state !== 'known' || limit.state !== 'known' || limit.value <= 0) return null
  return Math.max(0, Math.min(1, remaining.value / limit.value))
}

export function quotaTone(ratio: number | null): 'neutral' | 'warning' | 'error' {
  if (ratio === null || ratio >= 0.5) return 'neutral'
  return ratio >= 0.2 ? 'warning' : 'error'
}

export function dataSourceLabel(source: QuotaDataSource): string {
  const labels: Record<QuotaDataSource, string> = {
    official_api: '官方 API',
    official_product: '官方产品',
    internal_api: '内部 API',
    local_estimate: '本地估算'
  }
  return labels[source]
}

export function windowLabel(resource: QuotaLimitResource, locale: QuotaLocale = 'zh-CN'): string {
  const { kind, durationSeconds } = resource.window
  if (kind === 'concurrent') return quotaText(locale, '并发额度')
  if (kind === 'billing') return quotaText(locale, '账期额度')
  if (durationSeconds === null) {
    return quotaText(
      locale,
      kind === 'rolling' ? '滚动窗口' : kind === 'fixed' ? '固定窗口' : '窗口未知'
    )
  }
  const hours = durationSeconds / 3600
  const duration =
    hours < 24
      ? quotaText(
          locale,
          `${formatNumber(hours, locale)} 小时`,
          `${formatNumber(hours, locale)} hours`
        )
      : quotaText(
          locale,
          `${formatNumber(hours / 24, locale)} 天`,
          `${formatNumber(hours / 24, locale)} days`
        )
  return quotaText(
    locale,
    `${duration}${kind === 'rolling' ? '滚动窗口' : '窗口'}`,
    `${duration} ${kind === 'rolling' ? 'rolling window' : 'window'}`
  )
}

export function scopeText(resource: QuotaResource, locale: QuotaLocale = 'zh-CN'): string | null {
  const labels: Record<string, string> = {
    organization: '组织',
    project: '项目',
    model: '模型',
    feature: '功能',
    region: '区域',
    key: '密钥'
  }
  const parts = Object.entries(resource.scope).flatMap(([key, value]) =>
    ['account', 'plan'].includes(key) || !value.trim()
      ? []
      : [`${quotaText(locale, labels[key] ?? key)}：${value}`]
  )
  return parts.join(' · ') || null
}
