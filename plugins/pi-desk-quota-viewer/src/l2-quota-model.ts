import type {
  QuotaAccount,
  QuotaBalanceResource,
  QuotaLimitResource,
  QuotaResource,
  QuotaScope,
  QuotaSourceSnapshot,
  QuotaUnit,
  QuotaValue
} from './protocol.js'
import { quotaText, type QuotaLocale, type QuotaRegion } from './l2-quota-locale.js'
import { quotaVisibilityKey } from './l2-quota-display-key.js'

export const QUOTA_PAGE_SIZE = 10

export interface QuotaRecord {
  key: string
  source: QuotaSourceSnapshot
  account: QuotaAccount | null
  resources: QuotaResource[]
}

const accountOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const TYPE_LABELS: Readonly<Record<string, string>> = {
  codex: 'Codex',
  devin: 'Devin',
  antigravity: 'Antigravity',
  openrouter: 'OpenRouter',
  moonshot: 'Moonshot / Kimi API',
  siliconflow: 'SiliconFlow',
  'opencode-go': 'OpenCode Go',
  commandcode: 'CommandCode',
  'zhipu-coding-plan': '智谱 Coding Plan'
}

export function quotaTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

export function groupChannels<T extends { adapter: string }>(items: readonly T[]): T[][] {
  const channels = new Map<string, T[]>()
  for (const item of items) {
    const group = channels.get(item.adapter)
    if (group) group.push(item)
    else channels.set(item.adapter, [item])
  }
  return [...channels.values()]
}

export function groupQuotaTypes<T extends { type: string }>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(item.type)
    if (group) group.push(item)
    else groups.set(item.type, [item])
  }
  return [...groups.values()]
}

export function resourceVisibilityKey(type: string, resource: QuotaResource): string {
  return quotaVisibilityKey(type, resource)
}

export function displayItems(sources: readonly QuotaSourceSnapshot[]): Array<{
  key: string
  type: string
  typeLabel: string
  resource: QuotaResource
}> {
  const items = new Map<
    string,
    { key: string; type: string; typeLabel: string; resource: QuotaResource }
  >()
  for (const source of sources) {
    for (const account of source.accounts) {
      for (const resource of account.resources) {
        const key = quotaVisibilityKey(account.type, resource)
        if (!items.has(key)) {
          items.set(key, {
            key,
            type: account.type,
            typeLabel: quotaTypeLabel(account.type),
            resource
          })
        }
      }
    }
  }
  return [...items.values()]
}

export function quotaRecords(
  sources: readonly QuotaSourceSnapshot[],
  hiddenKeys: ReadonlySet<string> = new Set()
): QuotaRecord[] {
  return groupChannels(sources).flatMap((channel) =>
    channel.flatMap((source) => {
      const records: QuotaRecord[] = []
      for (const account of source.accounts) {
        const resources = account.resources.filter(
          (resource) => !hiddenKeys.has(quotaVisibilityKey(account.type, resource))
        )
        // 主动隐藏正常账号的全部额度时，保留隐藏语义；异常账号仍需可见。
        if (
          account.resources.length > 0 &&
          resources.length === 0 &&
          account.status === 'active' &&
          !account.error
        ) {
          continue
        }
        records.push({
          key: JSON.stringify([source.sourceId, account.key]),
          source,
          account,
          resources
        })
      }
      if (source.accounts.length === 0) {
        return [{ key: JSON.stringify([source.sourceId]), source, account: null, resources: [] }]
      }
      return records.sort(
        (left, right) =>
          accountOrder.compare(recordLabel(left), recordLabel(right)) ||
          accountOrder.compare(left.key, right.key)
      )
    })
  )
}

export function recordLabel(record: QuotaRecord): string {
  return record.account?.name ?? record.source.name
}

export function recordIndex(record: QuotaRecord): string | null {
  return record.account?.key ?? null
}

export function recordPlan(record: QuotaRecord): string | null {
  return record.account?.plan ?? null
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
      matchesSearch(
        query,
        recordLabel(record),
        record.account?.key ?? null,
        record.account ? quotaTypeLabel(record.account.type) : null,
        record.source.name,
        record.source.adapterLabel
      )
  )
}

const SUMMARY_KEYS: Record<string, readonly string[]> = {
  codex: ['codex/primary', 'codex/secondary'],
  devin: ['daily', 'weekly'],
  openrouter: ['account-credits', 'api-key-quota'],
  moonshot: ['available-balance'],
  siliconflow: ['total-balance'],
  'opencode-go': ['five-hour-quota', 'weekly-quota', 'monthly-quota'],
  commandcode: ['five-hour-quota', 'weekly-quota', 'monthly-credits']
}

export function summaryResources(record: QuotaRecord): QuotaResource[] {
  const type = record.account?.type ?? ''
  const resources = record.resources
  if (type === 'antigravity') {
    const groups = resources.filter((resource) => resource.key.startsWith('bucket/'))
    if (groups.length > 0) {
      const byGroup = new Map<string, QuotaResource[]>()
      for (const resource of groups) {
        const name = resource.scope.feature ?? ''
        const values = byGroup.get(name) ?? []
        values.push(resource)
        byGroup.set(name, values)
      }
      const preferred = ['Gemini Models', 'Claude and GPT models', 'Claude / GPT']
      const columns = [...byGroup]
        .sort(([left, a], [right, b]) => {
          const rank = (name: string): number => {
            const index = preferred.indexOf(name)
            return index < 0 ? preferred.length : index
          }
          return (
            b.length - a.length || rank(left) - rank(right) || accountOrder.compare(left, right)
          )
        })
        .map(([, values]) =>
          values.sort((left, right) => {
            const leftWindow = left.kind === 'quota' ? left.window.durationSeconds : null
            const rightWindow = right.kind === 'quota' ? right.window.durationSeconds : null
            return (
              (leftWindow ?? Infinity) - (rightWindow ?? Infinity) ||
              accountOrder.compare(left.key, right.key)
            )
          })
        )
      const ordered: QuotaResource[] = []
      for (let index = 0; index < columns.length; index += 2) {
        const left = columns[index]
        const right = columns[index + 1] ?? []
        for (let row = 0; row < Math.max(left.length, right.length); row += 1) {
          if (left[row]) ordered.push(left[row])
          if (right[row]) ordered.push(right[row])
        }
      }
      return ordered
    }
    return [...resources]
      .sort((left, right) =>
        accountOrder.compare(left.scope.model ?? left.label, right.scope.model ?? right.label)
      )
      .slice(0, 3)
  }
  const keys = SUMMARY_KEYS[type]
  if (keys) {
    const preferred = keys.flatMap((key) => resources.filter((resource) => resource.key === key))
    // 代码审查等独立额度留在详情，不填入主周期的空位。
    if (type === 'codex' || type === 'devin') return preferred
    const assigned = new Set(preferred.map((resource) => resource.key))
    return [...preferred, ...resources.filter((resource) => !assigned.has(resource.key))].slice(
      0,
      keys.length
    )
  }
  const preferred = resources.filter(
    (resource) => resource.kind === 'quota' && resource.window.durationSeconds !== null
  )
  const assigned = new Set(preferred.map((resource) => resource.key))
  return [...preferred, ...resources.filter((resource) => !assigned.has(resource.key))].slice(0, 3)
}

export function summarySlots(record: QuotaRecord): Array<QuotaResource | null> {
  const summary = summaryResources(record)
  const type = record.account?.type ?? ''
  const keys = SUMMARY_KEYS[type]
  let slots: Array<QuotaResource | null>
  if (keys) {
    slots = keys.map((key) => summary.find((resource) => resource.key === key) ?? null)
  } else if (type === 'zhipu-coding-plan') {
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
  // 保留核心列的位置，缺项可由其他可见资源补位。
  const assigned = new Set(slots.flatMap((resource) => (resource ? [resource.key] : [])))
  const fallback = summary.filter((resource) => !assigned.has(resource.key))
  return slots.map((resource) => resource ?? fallback.shift() ?? null)
}

export function recordResetCredits(record: QuotaRecord): QuotaBalanceResource | null {
  if (record.account?.type !== 'codex') return null
  return (
    record.resources.find(
      (resource): resource is QuotaBalanceResource =>
        resource.key === 'reset-credits' && resource.kind === 'balance'
    ) ?? null
  )
}

export function detailResources(record: QuotaRecord): QuotaResource[] {
  const shown = new Set(summaryResources(record).map((resource) => resource.key))
  const resetCredits = recordResetCredits(record)
  if (resetCredits) shown.add(resetCredits.key)
  return record.resources.filter((resource) => {
    if (shown.has(resource.key)) return false
    return !(
      record.account?.type === 'commandcode' &&
      ['purchased-credits', 'free-credits'].includes(resource.key) &&
      resource.kind === 'balance' &&
      resource.available.state === 'known' &&
      resource.available.value === 0 &&
      resource.expiresAt === null
    )
  })
}

export interface QuotaSupplementaryDetail {
  resource: QuotaResource
  scope: QuotaScope
  expiresAt: number | null
}

function supplementaryScope(resource: QuotaResource): QuotaScope {
  return Object.fromEntries(
    Object.entries(resource.scope).filter(
      ([key, value]) =>
        ['organization', 'project', 'region', 'key', 'description'].includes(key) && value.trim()
    )
  )
}

export function supplementaryDetails(record: QuotaRecord): QuotaSupplementaryDetail[] {
  const shown = new Set<string>()
  return summaryResources(record).flatMap((resource) => {
    const group = resource.scope.feature ?? resource.scope.model ?? ''
    const scope = Object.fromEntries(
      Object.entries(supplementaryScope(resource)).filter(([key, value]) => {
        const identity = JSON.stringify([group, key, value])
        if (shown.has(identity)) return false
        shown.add(identity)
        return true
      })
    )
    const expiresAt = resource.kind === 'balance' ? resource.expiresAt : null
    return expiresAt !== null || Object.keys(scope).length > 0
      ? [{ resource, scope, expiresAt }]
      : []
  })
}

export interface QuotaRecordDetails {
  resources: QuotaResource[]
  supplements: QuotaSupplementaryDetail[]
  source: string
  type: string | null
  observedAt: number | null
  errors: string[]
  hasDetails: boolean
}

export function recordDetails(record: QuotaRecord): QuotaRecordDetails {
  const resources = detailResources(record)
  const supplements = supplementaryDetails(record)
  const { source, account } = record
  const observedAt = account ? account.observedAt : source.observedAt
  const errors = [
    ...new Set([account?.error, source.error].filter((error): error is string => Boolean(error)))
  ]
  const customSource =
    source.name !== source.adapterLabel &&
    source.name !== recordLabel(record) &&
    source.name !== (account ? quotaTypeLabel(account.type) : null)
  return {
    resources,
    supplements,
    source: source.name,
    type: account ? quotaTypeLabel(account.type) : null,
    observedAt,
    errors,
    hasDetails:
      resources.length > 0 ||
      supplements.length > 0 ||
      observedAt !== null ||
      errors.length > 0 ||
      customSource
  }
}

export function shortResourceLabel(resource: QuotaResource, locale: QuotaLocale = 'zh-CN'): string {
  const model = resource.scope.model?.trim()
  if (model) return model
  const shortLabels: Readonly<Record<string, string>> = {
    '5 小时额度': '5h',
    日额度: quotaText(locale, '日', 'Daily'),
    周额度: quotaText(locale, '周', 'Weekly'),
    月额度: quotaText(locale, '月', 'Monthly'),
    '月度 Credits': quotaText(locale, '月余额', 'Monthly'),
    '月度 Credits 余额': quotaText(locale, '月余额', 'Monthly'),
    可用余额: quotaText(locale, '余额', 'Balance'),
    '可用 Credits': 'Credits',
    'API Key 额度': 'API Key',
    主额度: quotaText(locale, '主', 'Primary'),
    次额度: quotaText(locale, '次', 'Secondary')
  }
  let label = shortLabels[resource.label]
  if (!label && resource.kind === 'quota') {
    const seconds = resource.window.durationSeconds
    if (seconds === 86_400) label = quotaText(locale, '日', 'Daily')
    else if (isWeeklyResource(resource)) label = quotaText(locale, '周', 'Weekly')
    else if (seconds !== null && seconds > 0 && seconds < 86_400) label = `${seconds / 3600}h`
    else if (seconds !== null && seconds >= 28 * 86_400 && seconds <= 31 * 86_400)
      label = quotaText(locale, '月', 'Monthly')
  }
  label ??= quotaText(locale, resource.label)
  const feature = resource.scope.feature?.trim()
  const group =
    feature === 'Gemini Models'
      ? 'Gemini'
      : feature === 'Claude and GPT models'
        ? 'Claude/GPT'
        : feature
  return group ? `${group} ${label}` : label
}

export function formatCompactCountdown(
  value: number | null,
  now: number,
  locale: QuotaLocale = 'zh-CN',
  quotaType?: string
): string | null {
  if (value === null) return null
  const difference = value - now
  if (difference <= 0) return quotaText(locale, '待重置', 'Due')
  const minutes = Math.floor(difference / 60_000)
  if (minutes === 0) return '<1m'
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${hours % 24 || quotaType === 'codex' ? `${hours % 24}h` : ''}`
  return `${hours ? `${hours}h` : ''}${minutes % 60 ? `${minutes % 60}m` : ''}`
}

export function resourceLabel(resource: QuotaResource, locale: QuotaLocale = 'zh-CN'): string {
  const names = [
    resource.scope.feature?.trim(),
    resource.scope.model?.trim(),
    quotaText(locale, resource.label)
  ]
  return [...new Set(names.filter((value): value is string => Boolean(value)))].join(' · ')
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

export function quotaPrimaryValue(resource: QuotaLimitResource): {
  label: string
  value: QuotaValue
} {
  const { remaining, used, limit } = resource.values
  if (remaining.state === 'known' || remaining.state === 'unlimited') {
    return { label: '剩余', value: remaining }
  }
  if (used.state === 'known' || used.state === 'unlimited') return { label: '已用', value: used }
  if (
    resource.unit.kind !== 'percentage' &&
    (limit.state === 'known' || limit.state === 'unlimited')
  ) {
    return { label: '总额', value: limit }
  }
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

export function scopeText(resource: QuotaResource, locale: QuotaLocale = 'zh-CN'): string | null {
  const labels: Record<string, string> = {
    organization: '组织',
    project: '项目',
    model: '模型',
    feature: '功能',
    region: '区域',
    key: '密钥',
    description: '说明'
  }
  const parts = Object.entries(resource.scope).flatMap(([key, value]) =>
    ['account', 'plan'].includes(key) || !value.trim()
      ? []
      : [`${quotaText(locale, labels[key] ?? key)}：${value}`]
  )
  return parts.join(' · ') || null
}
