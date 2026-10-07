import { z } from 'zod'
import type { QuotaResource } from '../protocol.js'
import { QuotaHttpError, requestJson } from './http.js'
import {
  errorMessage,
  field,
  known,
  numberValue,
  objectValue,
  optionalObject,
  resourceKey,
  stringValue,
  timestampMs,
  unknown
} from './resources.js'
import type { QuotaAdapter } from './types.js'

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const MIN_REFRESH_INTERVAL_MS = 10 * 1000

const configSchema = z
  .object({
    managementUrl: z.string().trim().url('Management URL 必须是有效 URL'),
    managementKey: z.string().trim().min(1, 'Management Key 不能为空'),
    /** 仅用于兼容旧配置，读取后不再参与账号筛选。 */
    accounts: z.string().max(10_000, '账号列表过长').optional()
  })
  .strict()

function managementBaseUrl(value: string): string {
  const url = new URL(value)
  url.search = ''
  url.hash = ''
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v0/management') ? path : `${path}/v0/management`
  return url.toString().replace(/\/$/, '')
}

function isCodex(file: Record<string, unknown>): boolean {
  const provider = stringValue(file.provider)?.toLowerCase()
  const type = stringValue(file.type)?.toLowerCase()
  return provider === 'codex' || type === 'codex'
}

function accountDisplay(file: Record<string, unknown>, fallback: string): string {
  return stringValue(file.email) ?? stringValue(file.account) ?? stringValue(file.name) ?? fallback
}

function authFileAccountId(file: Record<string, unknown>): string | null {
  const token = optionalObject(field(file, 'id_token', 'idToken'))
  return (
    stringValue(field(file, 'chatgpt_account_id', 'chatgptAccountId')) ??
    (token ? stringValue(field(token, 'chatgpt_account_id', 'chatgptAccountId')) : null)
  )
}

const PLAN_LABELS: Readonly<Record<string, string>> = {
  free: 'Free',
  plus: 'Plus',
  prolite: 'Pro 5X',
  'pro-lite': 'Pro 5X',
  pro_lite: 'Pro 5X',
  pro: 'Pro 20X',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu'
}

function planType(record: Record<string, unknown>): string | null {
  return stringValue(
    field(
      record,
      'plan_type',
      'planType',
      'subscription_plan',
      'subscriptionPlan',
      'chatgpt_plan_type',
      'chatgptPlanType'
    )
  )
}

function planLabel(value: string | null): string | null {
  if (!value) return null
  return PLAN_LABELS[value.toLowerCase()] ?? value
}

function authFilePlan(file: Record<string, unknown>): string | null {
  const records = [file, optionalObject(file.metadata), optionalObject(file.attributes)]
  for (const record of records) {
    if (!record) continue
    const direct = planLabel(planType(record))
    if (direct) return direct
    for (const key of ['id_token', 'idToken'] as const) {
      const token = optionalObject(record[key])
      const nested = token ? planLabel(planType(token)) : null
      if (nested) return nested
    }
  }
  return null
}

function windowPresentation(
  seconds: number | null,
  position: 'primary' | 'secondary'
): { label: string; durationSeconds: number | null } {
  if (seconds === 18_000) return { label: '5 小时额度', durationSeconds: seconds }
  if (seconds === 604_800) return { label: '周额度', durationSeconds: seconds }
  if (seconds !== null && seconds >= 28 * 86_400 && seconds <= 31 * 86_400) {
    return { label: '月额度', durationSeconds: seconds }
  }
  return {
    label: position === 'primary' ? '主额度' : '次额度',
    durationSeconds: seconds
  }
}

function resetAt(window: Record<string, unknown>, now: number): number | null {
  const absolute = timestampMs(field(window, 'reset_at', 'resetAt'))
  if (absolute !== null) return absolute
  const afterSeconds = numberValue(field(window, 'reset_after_seconds', 'resetAfterSeconds'))
  return afterSeconds !== null && afterSeconds >= 0 ? now + afterSeconds * 1000 : null
}

function rateGroupResources(input: {
  accountKey: string
  account: string
  plan: string | null
  feature: string | null
  featureKey: string
  group: unknown
  now: number
}): QuotaResource[] {
  const group = optionalObject(input.group)
  if (!group) return []
  const limitReached = field(group, 'limit_reached', 'limitReached') === true
  const allowed = group.allowed
  const resources: QuotaResource[] = []

  for (const position of ['primary', 'secondary'] as const) {
    const window = optionalObject(field(group, `${position}_window`, `${position}Window`))
    if (!window) continue
    const seconds = numberValue(field(window, 'limit_window_seconds', 'limitWindowSeconds'))
    let usedPercent = numberValue(field(window, 'used_percent', 'usedPercent'))
    if (usedPercent === null && (limitReached || allowed === false)) usedPercent = 100
    const nextResetAt = resetAt(window, input.now)
    if (usedPercent === null && seconds === null && nextResetAt === null) continue
    const presentation = windowPresentation(seconds, position)
    resources.push({
      key: resourceKey(input.accountKey, input.featureKey, position),
      kind: 'quota',
      label: presentation.label,
      scope: {
        account: input.account,
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.feature ? { feature: input.feature } : {})
      },
      unit: { kind: 'percentage' },
      values: {
        limit: known(100),
        used: usedPercent === null ? unknown() : known(usedPercent),
        remaining: usedPercent === null ? unknown() : known(Math.max(0, 100 - usedPercent))
      },
      window: {
        kind: 'rolling',
        durationSeconds: presentation.durationSeconds,
        resetAt: nextResetAt
      }
    })
  }
  return resources
}

function parseUsageResources(
  payload: unknown,
  accountKey: string,
  account: string,
  fallbackPlan: string | null,
  now: number
): QuotaResource[] {
  const root = objectValue(payload, 'Codex usage 响应')
  const plan = planLabel(planType(root)) ?? fallbackPlan
  const resources: QuotaResource[] = []
  resources.push(
    ...rateGroupResources({
      accountKey,
      account,
      plan,
      feature: null,
      featureKey: 'codex',
      group: field(root, 'rate_limit', 'rateLimit'),
      now
    })
  )
  resources.push(
    ...rateGroupResources({
      accountKey,
      account,
      plan,
      feature: 'Code Review',
      featureKey: 'code-review',
      group: field(
        root,
        'code_review_rate_limit',
        'codeReviewRateLimit',
        'code_review',
        'codeReview'
      ),
      now
    })
  )

  const additional = field(root, 'additional_rate_limits', 'additionalRateLimits')
  if (Array.isArray(additional)) {
    for (const [index, raw] of additional.entries()) {
      const item = optionalObject(raw)
      if (!item) continue
      const label =
        stringValue(field(item, 'limit_name', 'limitName', 'metered_feature', 'meteredFeature')) ??
        `附加额度 ${index + 1}`
      resources.push(
        ...rateGroupResources({
          accountKey,
          account,
          plan,
          feature: label,
          featureKey: `additional-${index}-${label}`,
          group: field(item, 'rate_limit', 'rateLimit') ?? item,
          now
        })
      )
    }
  }
  const resetCredits = optionalObject(
    field(root, 'rate_limit_reset_credits', 'rateLimitResetCredits')
  )
  if (resetCredits) {
    const availableCount = numberValue(field(resetCredits, 'available_count', 'availableCount'))
    resources.push({
      key: resourceKey(accountKey, 'reset-credits', 'primary'),
      kind: 'balance',
      label: '剩余重置次数',
      scope: { account, ...(plan ? { plan } : {}) },
      unit: { kind: 'custom', label: '次' },
      available: availableCount === null ? unknown() : known(availableCount),
      expiresAt: null
    })
  }
  return resources
}

function unwrapUsageBody(envelopeValue: unknown): unknown {
  const envelope = objectValue(envelopeValue, 'CPA api-call 响应')
  const body = envelope.body ?? envelope.bodyText
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      throw new Error('CPA 返回的 Codex usage body 不是有效 JSON')
    }
  }
  return body ?? envelope
}

async function loadAccount(input: {
  fetch: typeof fetch
  baseUrl: string
  managementKey: string
  authIndex: string | number
  accountId: string | null
  accountKey: string
  account: string
  fallbackPlan: string | null
  signal: AbortSignal
  now: number
}): Promise<QuotaResource[]> {
  const envelope = await requestJson({
    fetch: input.fetch,
    url: `${input.baseUrl}/api-call`,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.managementKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        authIndex: input.authIndex,
        method: 'GET',
        url: CODEX_USAGE_URL,
        header: {
          Authorization: 'Bearer $TOKEN$',
          'Content-Type': 'application/json',
          'User-Agent': 'Codex CLI',
          ...(input.accountId ? { 'Chatgpt-Account-Id': input.accountId } : {})
        }
      })
    },
    signal: input.signal,
    label: `CPA Codex 账号 ${input.account} 额度查询`
  })
  const resources = parseUsageResources(
    unwrapUsageBody(envelope),
    input.accountKey,
    input.account,
    input.fallbackPlan,
    input.now
  )
  if (resources.length === 0) throw new Error(`账号 ${input.account} 未返回可识别额度`)
  return resources
}

export const cpaCodexAdapter: QuotaAdapter = {
  descriptor: {
    adapter: 'cpa-codex',
    label: 'Codex（通过 CPA）',
    description: '自动读取 CPA 中启用的 Codex 账号并查询当前 usage。',
    dataSource: 'internal_api',
    resourceKinds: ['quota', 'balance'],
    fields: [
      {
        key: 'managementUrl',
        kind: 'url',
        label: 'Management URL',
        required: true,
        placeholder: 'https://example.com'
      },
      {
        key: 'managementKey',
        kind: 'secret',
        label: 'Management Key',
        required: true
      }
    ]
  },
  cacheTtlMs: 5 * 60 * 1000,
  minRefreshIntervalMs: MIN_REFRESH_INTERVAL_MS,
  timeoutMs: 20 * 1000,
  validateConfig(input) {
    const parsed = configSchema.parse(input)
    return {
      managementUrl: parsed.managementUrl,
      managementKey: parsed.managementKey
    }
  },
  async load({ config, signal, fetch, now }) {
    const parsed = configSchema.parse(config)
    const baseUrl = managementBaseUrl(parsed.managementUrl)
    const authPayload = await requestJson({
      fetch,
      url: `${baseUrl}/auth-files`,
      init: { headers: { Authorization: `Bearer ${parsed.managementKey}` } },
      signal,
      label: 'CPA Codex 账号列表查询'
    })
    const authRoot = objectValue(authPayload, 'CPA auth-files 响应')
    const files = Array.isArray(authRoot.files)
      ? authRoot.files.flatMap((value) => {
          const item = optionalObject(value)
          return item ? [item] : []
        })
      : []
    const codexFiles = files.filter((file) => file.disabled !== true && isCodex(file))
    if (codexFiles.length === 0) throw new Error('CPA 未发现启用的 Codex 账号')

    const jobs = codexFiles.map(async (file, index) => {
      const account = accountDisplay(file, `Codex 账号 ${index + 1}`)
      const authIndex = field(file, 'authIndex', 'auth_index')
      if (typeof authIndex !== 'string' && typeof authIndex !== 'number') {
        throw new Error(`CPA 账号 ${account} 缺少 authIndex`)
      }
      return loadAccount({
        fetch,
        baseUrl,
        managementKey: parsed.managementKey,
        authIndex,
        accountId: authFileAccountId(file),
        accountKey: String(authIndex),
        account,
        fallbackPlan: authFilePlan(file),
        signal,
        now
      })
    })
    const settled = await Promise.allSettled(jobs)
    if (signal.aborted) throw signal.reason
    const resources = settled.flatMap((item) => (item.status === 'fulfilled' ? item.value : []))
    const errors = settled.flatMap((item) =>
      item.status === 'rejected' ? [errorMessage(item.reason)] : []
    )
    const rateLimited = settled.flatMap((item) =>
      item.status === 'rejected' &&
      item.reason instanceof QuotaHttpError &&
      item.reason.status === 429
        ? [item.reason.retryAt ?? Date.now() + MIN_REFRESH_INTERVAL_MS]
        : []
    )
    const retryAt = rateLimited.length > 0 ? Math.max(...rateLimited) : null
    if (resources.length === 0) {
      const message = errors.join('；') || 'CPA Codex 没有可用额度数据'
      if (retryAt !== null) throw new QuotaHttpError(message, 429, retryAt)
      throw new Error(message)
    }
    return {
      resources,
      warning: errors.length > 0 ? errors.join('；') : null,
      retryAt
    }
  }
}
